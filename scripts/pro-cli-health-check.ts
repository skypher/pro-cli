#!/usr/bin/env bun
// Health check. Run it twice a day, for example with the units in scripts/systemd/. It looks at
// what happened since its last run and at the current state, and sends a notice by email and/or
// ntfy (the usage-limit watch's settings, ~/.pro-cli/limit-watch.json) only when there is a new
// problem:
// - Chrome's CDP port does not answer, or the ChatGPT page is logged out or missing;
// - the stored session token is missing, expired, or expires within 48 hours while the page
//   holds no longer-lived token for the same account (jobs refresh it from the page only then);
// - gate calls failed inside the gate, or for a login, Chrome, token or daemon reason;
// - jobs failed for a reason other than a usage-limit refusal (the limit watch reports those);
// - answers turned up later in kept chats, so a gate key should fetch those jobs again;
// - the usage-limit watch timer is not active.
// A lasting problem (port down, logged out, token expiring) is announced once, and again only
// after it cleared. Each run prints one line. It never reads prompt or answer text.
//
//   bun scripts/pro-cli-health-check.ts [--dry-run] [--config PATH]

import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateInCdpPage } from "../src/cdp";
import { resolvePaths } from "../src/config";
import { PAGE_SESSION_TOKEN_EXPRESSION, toSessionTokenExport, type SessionTokenExport } from "../src/session-token";
import { loadConfig, mailOrigin, type LimitWatchConfig } from "./pro-cli-limit-watch";

export interface HealthPaths {
  db: string;
  token: string;
  gateStateRoot: string;
  recovered: string;
  state: string;
}

export interface PageSession {
  status: "present" | "logged_out" | "unavailable";
  expiresAt?: string;
  accountId?: string;
}

export interface HealthDeps {
  now: () => Date;
  log: (line: string) => void;
  cdpUp: () => Promise<boolean>;
  pageSession: () => Promise<PageSession>;
  timerActive: (unit: string) => Promise<boolean>;
  sendMail: (message: string) => Promise<boolean>;
  postNtfy: (body: string, headers: Record<string, string>) => Promise<boolean>;
  timers?: string[];
  dryRun?: boolean;
}

export const TOKEN_WARNING_MS = 48 * 60 * 60_000;

// Gate errors that are the client's own (a bad flag, a job not done yet) or expected states.
const EXPECTED_GATE_ERRORS = new Set([
  "JOB_NOT_READY", "JOB_NOT_FOUND", "COMMAND_DENIED", "FLAG_DENIED", "BAD_ARGS", "BAD_JOB_ID",
  "BAD_COMMAND_LINE", "NO_COMMAND", "FILE_NOT_FOUND", "FILE_NOT_IN_INBOX", "UPLOAD_TOO_LARGE",
  "INBOX_FULL", "CLIENT_GONE", "USAGE_LIMIT_PAUSED", "WAIT_TIMEOUT", "INVALID_ARGS", "CANCELLED",
]);
// Failures of the setup rather than of one request.
const SETUP_ERROR = /^(GATE_INTERNAL|GATE_MISCONFIGURED|INTERNAL_ERROR|ACCOUNT_ID_MISSING|SESSION_TOKEN_|CHATGPT_PAGE_|CHATGPT_PROBE_|CDP_|DAEMON_)/;

interface HealthState {
  lastRunAt?: string;
  /** Lasting problems already announced, by key. */
  announced?: string[];
  /** Notices a channel failed to deliver, sent again next run. */
  pendingMail?: string | null;
  pendingNtfy?: { body: string; headers: Record<string, string> } | null;
}

interface Problem {
  key: string | null;
  line: string;
}

export async function runHealthCheck(config: LimitWatchConfig, paths: HealthPaths, deps: HealthDeps): Promise<void> {
  const state = await loadState(paths.state);
  const now = deps.now();
  // The first run only sets the starting point for events; it still reports lasting problems.
  const since = state.lastRunAt ?? now.toISOString();
  const lasting: Problem[] = [];
  const events: Problem[] = [];
  const facts: string[] = [];

  // Chrome and the ChatGPT page.
  const cdpUp = await deps.cdpUp().catch(() => false);
  const page = cdpUp ? await deps.pageSession().catch((): PageSession => ({ status: "unavailable" })) : null;
  if (!cdpUp) lasting.push({ key: "cdp-down", line: "Chrome's CDP port does not answer: no job can run. Start the pro-cli Chrome." });
  else if (page?.status === "logged_out") {
    lasting.push({ key: "page-logged-out", line: "The ChatGPT page is logged out: no job can run. Log in in the pro-cli Chrome, then run pro-cli auth capture --json." });
  } else if (page?.status === "unavailable") {
    lasting.push({ key: "page-unavailable", line: "The ChatGPT page could not be read over CDP (no chatgpt.com tab, or it did not answer)." });
  }
  facts.push(`CDP ${cdpUp ? "up" : "DOWN"}, page ${page?.status ?? "not checked"}`);

  // The stored session token.
  const token = await readFile(paths.token, "utf8").then((raw) => JSON.parse(raw) as SessionTokenExport).catch(() => null);
  const tokenProblem = checkToken(token, page, now);
  if (tokenProblem) lasting.push(tokenProblem);
  facts.push(`token ${token?.expiresAt ? `valid until ${utc(token.expiresAt)}` : token ? "present" : "missing"}`
    + (page?.expiresAt ? `, page token until ${utc(page.expiresAt)}` : ""));

  // Jobs and gate calls since the last run.
  const db = new Database(paths.db, { readonly: true });
  try {
    const counts = db.query(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE updated_at > ? AND status IN ('succeeded', 'failed') GROUP BY status`,
    ).all(since) as Array<{ status: string; n: number }>;
    const failed = db.query(
      `SELECT id, json_extract(error_json, '$.code') AS code FROM jobs
       WHERE status = 'failed' AND updated_at > ?
         AND COALESCE(json_extract(error_json, '$.details.errorCode'), '') <> 'usage_limit'
         AND COALESCE(json_extract(error_json, '$.code'), '') <> 'CANCELLED'`,
    ).all(since) as Array<{ id: string; code: string | null }>;
    const owners = await gateOwners(config, paths);
    if (failed.length > 0) {
      const owned = config.gateKeys.map((key) => [key, failed.filter((job) => owners.get(job.id) === key).length] as const)
        .filter(([, n]) => n > 0).map(([key, n]) => `${n} of gate key ${key}`);
      events.push({
        key: null,
        line: `${failed.length} jobs failed: ${tally(failed.map((job) => job.code ?? "unknown"))}`
          + (owned.length > 0 ? ` (${owned.join(", ")})` : "") + ".",
      });
    }
    facts.push(`jobs ${counts.map((row) => `${row.n} ${row.status}`).join(", ") || "none ended"}`);

    for (const key of config.gateKeys) {
      const audit = await readJsonLines(join(paths.gateStateRoot, key, "audit.log"));
      const recent = audit.filter((entry) => typeof entry.at === "string" && entry.at > since);
      const broken = recent.filter((entry) => typeof entry.error === "string" && isGateProblem(entry.error, String(entry.verb ?? "")));
      if (broken.length > 0) {
        events.push({
          key: null,
          line: `${broken.length} gate calls of key ${key} failed: `
            + tally(broken.map((entry) => `${entry.verb} ${entry.error}${typeof entry.errno === "string" ? `/${entry.errno}` : ""}`)) + ".",
        });
      }
      facts.push(`gate key ${key}: ${recent.length} calls`);
    }

    const recovered = (await readJsonLines(paths.recovered)).filter((entry) => typeof entry.recordedAt === "string" && entry.recordedAt > since);
    for (const entry of recovered) {
      const jobId = String(entry.jobId ?? "");
      const owner = owners.get(jobId);
      const change = entry.reason === "failed" ? "failed and now has its answer" : "had an unchecked answer, now replaced by the stored one";
      events.push({
        key: null,
        line: `Job ${jobId.slice(0, 12)} ${change}${owner ? `; tell gate key ${owner} to fetch it again with job result` : ""}.`,
      });
    }
  } finally {
    db.close();
  }

  for (const unit of deps.timers ?? []) {
    if (!(await deps.timerActive(unit).catch(() => false))) lasting.push({ key: `timer-off:${unit}`, line: `The ${unit} unit is not active.` });
  }

  // Announce events, and lasting problems not announced while they lasted.
  const announced = new Set(state.announced ?? []);
  const fresh = lasting.filter((problem) => problem.key && !announced.has(problem.key));
  const problems = [...fresh, ...events];
  state.announced = lasting.map((problem) => problem.key as string);
  state.lastRunAt = now.toISOString();

  if (problems.length > 0) {
    deps.log(`PROBLEMS: ${problems.map((problem) => problem.line).join(" | ")}`);
    const subject = problems.length === 1 ? `pro-cli health: ${problems[0].line.split(":")[0]}` : `pro-cli health: ${problems.length} problems`;
    const lines = [
      ...problems.map((problem) => `- ${problem.line}`),
      ...(lasting.length > fresh.length ? ["", "Still open from earlier notices:", ...lasting.filter((p) => !fresh.includes(p)).map((p) => `- ${p.line}`)] : []),
      "",
      `Since ${utc(since)}: ${facts.join("; ")}.`,
    ];
    if (config.mail.to) state.pendingMail = mailMessage(subject, lines, config);
    if (config.ntfy.url) {
      state.pendingNtfy = {
        body: `pro-cli health: ${problems.map((problem) => problem.line).join(" ")}`,
        headers: { Tags: "warning", ...(config.ntfy.title ? { Title: config.ntfy.title } : {}) },
      };
    }
  } else {
    deps.log(`ok: ${facts.join("; ")}${lasting.length > 0 ? `; still open: ${lasting.map((p) => p.key).join(", ")}` : ""}`);
  }

  if (deps.dryRun) {
    if (state.pendingMail) deps.log(`DRY RUN would mail:\n${state.pendingMail}`);
    if (state.pendingNtfy) deps.log(`DRY RUN would post to ntfy: ${state.pendingNtfy.body}`);
    return;
  }
  if (state.pendingMail) {
    if (await deps.sendMail(state.pendingMail)) {
      deps.log(`mailed ${config.mail.to}`);
      state.pendingMail = null;
    } else deps.log("mail failed; will retry next run");
  }
  if (state.pendingNtfy) {
    if (await deps.postNtfy(state.pendingNtfy.body, state.pendingNtfy.headers)) {
      deps.log("posted to ntfy");
      state.pendingNtfy = null;
    } else deps.log("ntfy post failed; will retry next run");
  }
  await saveState(paths.state, state);
}

function checkToken(token: SessionTokenExport | null, page: PageSession | null, now: Date): Problem | null {
  if (!token) {
    return { key: "token-missing", line: "No stored session token: every job fails. Run pro-cli auth capture --json." };
  }
  if (!token.expiresAt) return null;
  const left = Date.parse(token.expiresAt) - now.getTime();
  if (left > TOKEN_WARNING_MS) return null;
  const pageLonger = page?.status === "present" && page.accountId === token.accountId && page.expiresAt
    && Date.parse(page.expiresAt) > Date.parse(token.expiresAt);
  // A job near or past expiry takes the page's longer-lived token by itself.
  if (pageLonger) return null;
  const advice = "Reload the ChatGPT page in the pro-cli Chrome (log in again if asked), then run pro-cli auth capture --json.";
  return left <= 0
    ? { key: `token-expired:${token.expiresAt}`, line: `The stored session token expired at ${utc(token.expiresAt)}: every job fails. ${advice}` }
    : {
      key: `token-expiring:${token.expiresAt}`,
      line: `The stored session token expires at ${utc(token.expiresAt)} and the page holds no newer one: jobs fail after that. ${advice}`,
    };
}

function isGateProblem(error: string, verb: string): boolean {
  if (EXPECTED_GATE_ERRORS.has(error)) return false;
  if (SETUP_ERROR.test(error)) return true;
  // One-off asks keep no job record, so their failures show only here. A refused ask is an
  // UPSTREAM_ERROR, left to the limit watch.
  return (verb === "pro-cli ask" || verb === "pro-cli odds") && error !== "UPSTREAM_ERROR";
}

async function gateOwners(config: LimitWatchConfig, paths: HealthPaths): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const key of config.gateKeys) {
    const ids = await readFile(join(paths.gateStateRoot, key, "jobs"), "utf8").catch(() => "");
    for (const id of ids.split("\n")) if (id) owners.set(id, key);
  }
  return owners;
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([value, n]) => `${n} × ${value}`).join(", ");
}

function utc(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

function mailMessage(subject: string, lines: string[], config: LimitWatchConfig): string {
  const origin = mailOrigin();
  return [
    `To: ${config.mail.to}`,
    ...(config.mail.from ? [`From: ${config.mail.from}`] : []),
    `Subject: [${origin}] ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...lines,
    "",
    `Sent by the pro-cli health check (scripts/pro-cli-health-check.ts) as ${origin}.`,
    "",
  ].join("\n");
}

async function loadState(path: string): Promise<HealthState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HealthState;
  } catch {
    return {};
  }
}

async function saveState(path: string, state: HealthState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}

async function run(argv: string[], input?: string): Promise<number> {
  const child = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const proPaths = resolvePaths(process.env);
  const configIndex = args.indexOf("--config");
  const config = await loadConfig(configIndex >= 0 ? args[configIndex + 1] : join(proPaths.home, "limit-watch.json"));
  const cdpBase = "http://127.0.0.1:9222";
  await runHealthCheck(
    config,
    {
      db: proPaths.dbPath,
      token: proPaths.sessionTokenPath,
      gateStateRoot: join(homedir(), ".local", "state", "pro-cli-gate"),
      recovered: join(proPaths.home, "diagnostics", "recovered-answers.jsonl"),
      state: join(homedir(), ".local", "state", "pro-cli-health-check", "state.json"),
    },
    {
      now: () => new Date(),
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      dryRun: args.includes("--dry-run"),
      timers: ["pro-cli-limit-watch.timer"],
      cdpUp: () => fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.ok),
      // The same session read every job starts with; the token itself is never printed.
      pageSession: async () => {
        const result = await evaluateInCdpPage<{ status: number; accessToken?: string }>(cdpBase, PAGE_SESSION_TOKEN_EXPRESSION, 10_000);
        if (result.status !== 200 || !result.accessToken) return { status: result.status === 401 || result.status === 200 ? "logged_out" : "unavailable" };
        const token = toSessionTokenExport(result.accessToken);
        return { status: "present", expiresAt: token.expiresAt, accountId: token.accountId };
      },
      timerActive: async (unit) => (await run(["systemctl", "--user", "is-active", "--quiet", unit])) === 0,
      sendMail: async (message) => (await run(config.mail.command, message)) === 0,
      postNtfy: async (body, headers) =>
        fetch(config.ntfy.url, { method: "POST", body, headers, signal: AbortSignal.timeout(20_000) })
          .then((response) => response.ok)
          .catch(() => false),
    },
  );
}
