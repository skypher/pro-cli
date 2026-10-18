#!/usr/bin/env bun
// Usage-limit watch. Once ChatGPT refuses this account's requests for a usage limit, it sends
// one probe an hour to see when the limit lifts. It sends a notice by email and/or ntfy when a
// limit is hit and again when it lifts, once per limit.
//
//   bun scripts/pro-cli-limit-watch.ts [--dry-run] [--config PATH]
//
// Config: ~/.pro-cli/limit-watch.json, shaped like scripts/limit-watch.example.json. A blank
// field turns that channel off. Run it every 10 minutes, for example with the units in
// scripts/systemd/. It prints one line per event (probe sent or ended, limit hit or lifted,
// notice sent) and never reads prompt or answer text. --dry-run sends no probe and no notice,
// writes no state, and prints what it would do.
//
// When a limit is hit and when it lifts:
// - Hit: the newest job that failed with details.errorCode = usage_limit has no job on the
//   same model created after it that succeeded. ChatGPT gives no reset time. The limit can
//   cover only one model (Pro) while cheaper models still work, so only a success on the
//   refused model counts.
// - Probe: once an hour has passed with no newer refusal and no probe, the watch sends one
//   ("Reply with OK only.", temporary chat, the refused job's model and effort). ChatGPT
//   refuses it at once while the limit lasts.
// - Lifted: a job on the refused model, created after the latest refusal, succeeds, whether a
//   probe or not.
// A limit episode runs from its first refusal to that success. Each episode gets a "hit"
// notice and, once announced, a "lifted" notice. Each channel is tracked separately, so a
// failed send is retried on the next run and a delivered one is never repeated.

import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePaths } from "../src/config";

export interface LimitWatchConfig {
  mail: { to: string; from: string; command: string[] };
  ntfy: { url: string; title: string };
  /** pro-cli gate keys whose failed jobs the mail counts, so they can be resent. */
  gateKeys: string[];
  probeEveryMinutes: number;
  probePrompt: string;
}

export interface LimitWatchPaths {
  db: string;
  state: string;
  gateStateRoot: string;
}

export interface LimitWatchDeps {
  now: () => Date;
  log: (line: string) => void;
  createProbe: (model: string, reasoning: string, prompt: string) => Promise<string | null>;
  sendMail: (message: string) => Promise<boolean>;
  postNtfy: (body: string, headers: Record<string, string>) => Promise<boolean>;
  dryRun?: boolean;
}

export const DEFAULT_CONFIG: LimitWatchConfig = {
  mail: { to: "", from: "", command: ["sendmail", "-t"] },
  ntfy: { url: "", title: "" },
  gateKeys: [],
  probeEveryMinutes: 60,
  probePrompt: "Reply with OK only.",
};

// A probe still queued or running after this long no longer holds back the next one.
const PROBE_STALE_MS = 45 * 60_000;
const REFUSED = "status = 'failed' AND json_extract(error_json, '$.details.errorCode') = 'usage_limit'";

interface Delivery {
  episode: string;
  mail: boolean;
  ntfy: boolean;
}

interface WatchState {
  imposed?: Delivery | null;
  lifted?: Delivery | null;
  probe?: { jobId: string; createdAt: string } | null;
  lastProbeAt?: string | null;
}

interface Episode {
  start: string;
  lastSuccess: string | null;
  refusals: number;
  gateFailed: Array<{ key: string; failed: number }>;
}

interface Notice {
  subject: string;
  lines: string[];
  ntfy: string;
  tags: string;
}

export async function runLimitWatch(config: LimitWatchConfig, paths: LimitWatchPaths, deps: LimitWatchDeps): Promise<void> {
  const db = new Database(paths.db, { readonly: true });
  try {
    await watch(db, config, paths, deps);
  } finally {
    db.close();
  }
}

async function watch(db: Database, config: LimitWatchConfig, paths: LimitWatchPaths, deps: LimitWatchDeps): Promise<void> {
  const latest = db
    .query(`SELECT updated_at AS at, model, reasoning FROM jobs WHERE ${REFUSED} ORDER BY updated_at DESC LIMIT 1`)
    .get() as { at: string; model: string; reasoning: string } | null;
  if (!latest) return;
  const state = await loadState(paths.state);
  const episode = await episodeOf(db, latest.at, latest.model, config, paths);
  const imposed = state.imposed ?? null;
  const lifted = state.lifted ?? null;
  if (lifted?.episode === episode.start && lifted.mail && lifted.ntfy) return;
  const save = () => (deps.dryRun ? Promise.resolve() : saveState(paths.state, state));

  const succeeded = db
    .query("SELECT id, updated_at AS at FROM jobs WHERE status = 'succeeded' AND model = ? AND created_at > ? ORDER BY updated_at LIMIT 1")
    .get(latest.model, latest.at) as { id: string; at: string } | null;
  if (succeeded) {
    // Only an announced episode gets a "lifted" notice, so old episodes stay quiet.
    if (imposed?.episode !== episode.start) return;
    const by = `${succeeded.id === state.probe?.jobId ? "probe job" : "job"} ${succeeded.id.slice(0, 12)} succeeded`;
    if (lifted?.episode !== episode.start) deps.log(`LIFTED: ${by} at ${succeeded.at}; limited since ${episode.start}`);
    state.lifted = await deliver(lifted, episode.start, liftedNotice(episode, by, succeeded.at, config), "lifted", config, deps);
    state.probe = null;
    await save();
    return;
  }

  if (!(imposed?.episode === episode.start && imposed.mail && imposed.ntfy)) {
    if (imposed?.episode !== episode.start) deps.log(`IMPOSED: usage_limit refusals since ${episode.start}`);
    state.imposed = await deliver(imposed, episode.start, imposedNotice(episode, config), "imposed", config, deps);
  }

  const now = deps.now().getTime();
  if (state.probe) {
    const status = (db.query("SELECT status FROM jobs WHERE id = ?").get(state.probe.jobId) as { status: string } | null)?.status
      ?? "missing";
    if ((status === "queued" || status === "running") && now - Date.parse(state.probe.createdAt) < PROBE_STALE_MS) {
      await save();
      return;
    }
    deps.log(`probe ${state.probe.jobId.slice(0, 12)} ended ${status}`);
    state.probe = null;
  }
  const everyMs = config.probeEveryMinutes * 60_000;
  const lastEvidence = Math.max(Date.parse(latest.at), state.lastProbeAt ? Date.parse(state.lastProbeAt) : 0);
  if (everyMs <= 0 || now - lastEvidence < everyMs) {
    if (deps.dryRun && everyMs > 0) {
      deps.log(`DRY RUN limited since ${episode.start}; next probe after ${new Date(lastEvidence + everyMs).toISOString()}`);
    }
    await save();
    return;
  }
  const jobId = deps.dryRun ? null : await deps.createProbe(latest.model, latest.reasoning, config.probePrompt);
  if (deps.dryRun) deps.log(`DRY RUN would probe with ${latest.model}/${latest.reasoning}`);
  if (jobId) {
    state.probe = { jobId, createdAt: deps.now().toISOString() };
    deps.log(`probe ${jobId.slice(0, 12)} sent (${latest.model}/${latest.reasoning}); limited since ${episode.start}`);
  } else if (!deps.dryRun) {
    deps.log("probe could not be created; next try in an hour");
  }
  state.lastProbeAt = deps.now().toISOString();
  await save();
}

/** On the refused model: the first refusal since the last success before the latest refusal, and what failed since. */
async function episodeOf(
  db: Database,
  refusedAt: string,
  model: string,
  config: LimitWatchConfig,
  paths: LimitWatchPaths,
): Promise<Episode> {
  const lastSuccess = (db.query("SELECT MAX(updated_at) AS at FROM jobs WHERE status = 'succeeded' AND model = ? AND updated_at <= ?")
    .get(model, refusedAt) as { at: string | null }).at;
  const refused = db.query(`SELECT MIN(updated_at) AS start, COUNT(*) AS n FROM jobs WHERE ${REFUSED} AND model = ? AND updated_at > ?`)
    .get(model, lastSuccess ?? "") as { start: string; n: number };
  const failed = (db.query("SELECT id FROM jobs WHERE status = 'failed' AND created_at > ?").all(lastSuccess ?? "") as Array<{ id: string }>)
    .map((row) => row.id);
  const gateFailed = [];
  for (const key of config.gateKeys) {
    const owned = new Set((await readFile(join(paths.gateStateRoot, key, "jobs"), "utf8").catch(() => "")).split("\n"));
    gateFailed.push({ key, failed: failed.filter((id) => owned.has(id)).length });
  }
  return { start: refused.start, lastSuccess, refusals: refused.n, gateFailed };
}

async function deliver(
  previous: Delivery | null,
  episode: string,
  notice: Notice,
  kind: string,
  config: LimitWatchConfig,
  deps: LimitWatchDeps,
): Promise<Delivery> {
  // A channel with a blank config counts as delivered.
  const record = previous?.episode === episode
    ? { ...previous }
    : { episode, mail: !config.mail.to, ntfy: !config.ntfy.url };
  if (!record.mail) {
    const message = mailMessage(notice, config);
    if (deps.dryRun) deps.log(`DRY RUN would mail:\n${message}`);
    if (deps.dryRun || (await deps.sendMail(message))) {
      record.mail = true;
      deps.log(`${kind}: ${deps.dryRun ? "DRY RUN would have mailed" : "mailed"} ${config.mail.to}`);
    } else {
      deps.log(`${kind}: mail failed; will retry next run`);
    }
  }
  if (!record.ntfy) {
    const headers: Record<string, string> = { Tags: notice.tags, ...(config.ntfy.title ? { Title: config.ntfy.title } : {}) };
    if (deps.dryRun) deps.log(`DRY RUN would post to ntfy (${JSON.stringify(headers)}): ${notice.ntfy}`);
    if (deps.dryRun || (await deps.postNtfy(notice.ntfy, headers))) {
      record.ntfy = true;
      deps.log(`${kind}: ${deps.dryRun ? "DRY RUN would have posted" : "posted"} to ntfy`);
    } else {
      deps.log(`${kind}: ntfy post failed; will retry next run`);
    }
  }
  return record;
}

function utc(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

function shown(at: string): string {
  const local = new Date(at).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  return `${utc(at)} (${local} local)`;
}

function imposedNotice(episode: Episode, config: LimitWatchConfig): Notice {
  return {
    subject: "ChatGPT usage limit hit",
    lines: [
      "ChatGPT refuses requests from the account behind pro-cli: usage limit reached",
      "(\"You've hit your limit. Please try again later.\"; no reset time given).",
      "",
      `Limited since: ${shown(episode.start)} (first usage_limit refusal)`,
      ...(episode.lastSuccess ? [`Last success:  ${shown(episode.lastSuccess)}`] : []),
      "",
      config.probeEveryMinutes > 0
        ? `The watch probes every ${config.probeEveryMinutes} minutes and sends another notice when the limit lifts.`
        : "Probing is off; a notice follows when a job succeeds again.",
      ...(config.gateKeys.length > 0
        ? ["The pro-cli gate refuses new requests for 30 minutes after each refusal (USAGE_LIMIT_PAUSED)."]
        : []),
    ],
    ntfy: `ChatGPT usage limit hit at ${utc(episode.start)}: requests are refused, no reset time given. `
      + "Another notice follows when it lifts.",
    tags: "warning",
  };
}

function liftedNotice(episode: Episode, by: string, at: string, config: LimitWatchConfig): Notice {
  return {
    subject: "ChatGPT usage limit lifted",
    lines: [
      "The usage limit on the ChatGPT account behind pro-cli is over.",
      "",
      `Limited since:   ${shown(episode.start)} (first usage_limit refusal)`,
      `Lifted, seen at: ${shown(at)} (${by})`,
      `Refusals:        ${episode.refusals} usage_limit refusals in this episode`,
      ...(episode.lastSuccess ? [`Last success before the limit: ${shown(episode.lastSuccess)}`] : []),
      ...episode.gateFailed.map(
        ({ key, failed }) => `Gate key ${key}: ${failed} failed jobs since then (resends included; they can be sent again now)`,
      ),
    ],
    ntfy: `ChatGPT usage limit lifted (seen at ${utc(at)}; limited since ${utc(episode.start)}). `
      + "Requests work again; failed jobs can be resent.",
    tags: "white_check_mark",
  };
}

function mailMessage(notice: Notice, config: LimitWatchConfig): string {
  return [
    `To: ${config.mail.to}`,
    ...(config.mail.from ? [`From: ${config.mail.from}`] : []),
    `Subject: ${notice.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...notice.lines,
    "",
    "Sent by the pro-cli usage-limit watch (scripts/pro-cli-limit-watch.ts).",
    "",
  ].join("\n");
}

async function loadState(path: string): Promise<WatchState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as WatchState;
  } catch {
    return {};
  }
}

async function saveState(path: string, state: WatchState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}

export async function loadConfig(path: string): Promise<LimitWatchConfig> {
  const raw = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Partial<LimitWatchConfig>;
  return {
    mail: { ...DEFAULT_CONFIG.mail, ...raw.mail },
    ntfy: { ...DEFAULT_CONFIG.ntfy, ...raw.ntfy },
    gateKeys: raw.gateKeys ?? DEFAULT_CONFIG.gateKeys,
    probeEveryMinutes: raw.probeEveryMinutes ?? DEFAULT_CONFIG.probeEveryMinutes,
    probePrompt: raw.probePrompt || DEFAULT_CONFIG.probePrompt,
  };
}

async function run(argv: string[], input?: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const home = resolvePaths(process.env).home;
  const configIndex = args.indexOf("--config");
  const config = await loadConfig(configIndex >= 0 ? args[configIndex + 1] : join(home, "limit-watch.json"));
  const cli = join(dirname(import.meta.dir), "src", "cli.ts");
  await runLimitWatch(
    config,
    {
      db: resolvePaths(process.env).dbPath,
      state: join(homedir(), ".local", "state", "pro-cli-limit-watch", "state.json"),
      gateStateRoot: join(homedir(), ".local", "state", "pro-cli-gate"),
    },
    {
      now: () => new Date(),
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      dryRun: args.includes("--dry-run"),
      createProbe: async (model, reasoning, prompt) => {
        const created = await run([
          process.execPath, cli, "job", "create", "--model", model, "--reasoning", reasoning,
          "--temporary", "--timeout", "1800000", "--chat-only", "--json", prompt,
        ]);
        try {
          return (JSON.parse(created.stdout) as { data: { job: { id: string } } }).data.job.id;
        } catch {
          return null;
        }
      },
      sendMail: async (message) => (await run(config.mail.command, message)).code === 0,
      postNtfy: async (body, headers) =>
        fetch(config.ntfy.url, { method: "POST", body, headers, signal: AbortSignal.timeout(20_000) })
          .then((response) => response.ok)
          .catch(() => false),
    },
  );
}
