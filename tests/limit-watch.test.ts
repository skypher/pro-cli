import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, runLimitWatch, type LimitWatchConfig, type LimitWatchPaths } from "../scripts/pro-cli-limit-watch";
import { ProError } from "../src/errors";
import { JobStore } from "../src/jobs";

let root: string;
let paths: LimitWatchPaths;
let now: Date;
let sent: { mail: string[]; ntfy: Array<{ body: string; headers: Record<string, string> }>; probes: string[][]; log: string[] };
let outcome: { mail: boolean; ntfy: boolean; probeId: string | null };

const configured: LimitWatchConfig = {
  ...DEFAULT_CONFIG,
  mail: { to: "owner@example.com", from: "watch@example.com", command: ["sendmail", "-t"] },
  ntfy: { url: "https://ntfy.example.com/topic", title: "watch host" },
  gateKeys: ["tester"],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pro-limit-watch-"));
  paths = { db: join(root, "jobs.sqlite"), state: join(root, "state", "state.json"), gateStateRoot: join(root, "gate") };
  now = new Date();
  sent = { mail: [], ntfy: [], probes: [], log: [] };
  outcome = { mail: true, ntfy: true, probeId: "job_probe000-0000-4000-8000-000000000000" };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

// Adds jobs that ended as given; times are minutes before `now`.
async function jobs(
  entries: Array<{ status: "failed" | "succeeded" | "running"; errorCode?: string; created: number; updated: number; id?: string; model?: string }>,
) {
  const store = await JobStore.open(paths.db);
  const ids: string[] = [];
  try {
    for (const entry of entries) {
      const { id } = store.create({ prompt: "question", model: entry.model ?? "gpt-5-5-pro", reasoning: "extended", options: {} });
      if (entry.status !== "running") {
        store.markRunning(id);
        if (entry.status === "failed") {
          store.markFailed(id, new ProError("UPSTREAM_ERROR", "You've hit your limit.", { details: { errorCode: entry.errorCode ?? null } }));
        } else {
          store.markSucceeded(id, "secret answer text");
        }
      } else {
        store.markRunning(id);
      }
      ids.push(id);
    }
  } finally {
    store.close();
  }
  const db = new Database(paths.db);
  try {
    entries.forEach((entry, index) => {
      db.query("UPDATE jobs SET created_at = ?, updated_at = ?, id = ? WHERE id = ?")
        .run(ago(entry.created), ago(entry.updated), entry.id ?? ids[index], ids[index]);
    });
  } finally {
    db.close();
  }
  return entries.map((entry, index) => entry.id ?? ids[index]);
}

async function watch(config: LimitWatchConfig = configured, dryRun = false) {
  await runLimitWatch(config, paths, {
    now: () => now,
    log: (line) => sent.log.push(line),
    dryRun,
    createProbe: async (model, reasoning, prompt) => {
      sent.probes.push([model, reasoning, prompt]);
      return outcome.probeId;
    },
    sendMail: async (message) => {
      sent.mail.push(message);
      return outcome.mail;
    },
    postNtfy: async (body, headers) => {
      sent.ntfy.push({ body, headers });
      return outcome.ntfy;
    },
  });
}

describe("usage-limit watch", () => {
  test("announces a new limit once by mail and ntfy, and does not probe within the hour", async () => {
    await jobs([
      { status: "succeeded", created: 120, updated: 100 },
      { status: "failed", errorCode: "usage_limit", created: 31, updated: 30 },
    ]);

    await watch();
    await watch();

    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain("To: owner@example.com");
    expect(sent.mail[0]).toContain("From: watch@example.com");
    expect(sent.mail[0]).toContain("Subject: ChatGPT usage limit hit");
    expect(sent.mail[0]).toContain("USAGE_LIMIT_PAUSED");
    expect(sent.ntfy).toEqual([{ body: expect.stringContaining("usage limit hit"), headers: { Tags: "warning", Title: "watch host" } }]);
    expect(sent.probes).toEqual([]);
  });

  test("probes with the refused job's model and effort an hour after the last refusal, and not again while it runs", async () => {
    await jobs([{ status: "failed", errorCode: "usage_limit", created: 62, updated: 61 }]);

    await watch();
    expect(sent.probes).toEqual([["gpt-5-5-pro", "extended", "Reply with OK only."]]);

    await jobs([{ status: "running", created: 0, updated: 0, id: "job_probe000-0000-4000-8000-000000000000" }]);
    now = new Date(now.getTime() + 30 * 60_000);
    await watch();
    expect(sent.probes).toHaveLength(1);
    expect(sent.log.some((line) => /^probe \S+ ended/.test(line))).toBe(false);

    // A probe that is still running after 45 minutes no longer holds back the next one.
    now = new Date(now.getTime() + 31 * 60_000);
    await watch();
    expect(sent.probes).toHaveLength(2);
    expect(sent.log.some((line) => /^probe \S+ ended running/.test(line))).toBe(true);
  });

  test("waits an hour after a refused probe before the next one", async () => {
    const [probe] = await jobs([{ status: "failed", errorCode: "usage_limit", created: 62, updated: 61 }]);
    outcome.probeId = probe;
    await watch();
    expect(sent.probes).toHaveLength(1);

    now = new Date(now.getTime() + 30 * 60_000);
    await watch();
    expect(sent.probes).toHaveLength(1);
    now = new Date(now.getTime() + 31 * 60_000);
    await watch();
    expect(sent.probes).toHaveLength(2);
  });

  test("announces the lift once after a job created after the refusal succeeds, with the gate key's failed jobs", async () => {
    const [failedA, failedB] = await jobs([
      { status: "succeeded", created: 300, updated: 290 },
      { status: "failed", errorCode: "usage_limit", created: 200, updated: 199 },
      { status: "failed", errorCode: "usage_limit", created: 100, updated: 99 },
    ]).then((ids) => ids.slice(1));
    await mkdir(join(paths.gateStateRoot, "tester"), { recursive: true });
    await writeFile(join(paths.gateStateRoot, "tester", "jobs"), `${failedA}\n${failedB}\n`);
    await watch();
    sent.mail = [];
    sent.ntfy = [];

    await jobs([{ status: "succeeded", created: 10, updated: 5 }]);
    await watch();
    await watch();

    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain("Subject: ChatGPT usage limit lifted");
    expect(sent.mail[0]).toContain("Refusals:        2 usage_limit refusals");
    expect(sent.mail[0]).toContain("Gate key tester: 2 failed jobs since then");
    expect(sent.mail[0]).not.toContain("secret answer text");
    expect(sent.mail[0]).not.toContain("question");
    expect(sent.ntfy).toEqual([{ body: expect.stringContaining("usage limit lifted"), headers: { Tags: "white_check_mark", Title: "watch host" } }]);
    expect(sent.ntfy[0].body).not.toContain("tester");
  });

  test("a success on a cheaper model does not end a limit on the refused model", async () => {
    await jobs([{ status: "failed", errorCode: "usage_limit", created: 31, updated: 30 }]);
    await watch();

    await jobs([{ status: "succeeded", created: 10, updated: 5, model: "gpt-5-5" }]);
    await watch();
    expect(sent.mail.map((mail) => mail.match(/Subject: .*/)?.[0])).toEqual(["Subject: ChatGPT usage limit hit"]);
    expect(sent.ntfy).toHaveLength(1);

    await jobs([{ status: "succeeded", created: 4, updated: 2 }]);
    await watch();
    expect(sent.mail.map((mail) => mail.match(/Subject: .*/)?.[0])).toEqual([
      "Subject: ChatGPT usage limit hit",
      "Subject: ChatGPT usage limit lifted",
    ]);
  });

  test("stays quiet about a limit that ended before it was announced", async () => {
    await jobs([
      { status: "failed", errorCode: "usage_limit", created: 200, updated: 199 },
      { status: "succeeded", created: 100, updated: 99 },
    ]);
    await watch();
    expect(sent.mail).toEqual([]);
    expect(sent.ntfy).toEqual([]);
  });

  test("a job that started before the refusal and succeeds later does not end the limit", async () => {
    await jobs([
      { status: "succeeded", created: 120, updated: 5 },
      { status: "failed", errorCode: "usage_limit", created: 31, updated: 30 },
    ]);
    await watch();
    expect(sent.mail.map((mail) => mail.match(/Subject: .*/)?.[0])).toEqual(["Subject: ChatGPT usage limit hit"]);
  });

  test("retries only the channel that failed", async () => {
    await jobs([{ status: "failed", errorCode: "usage_limit", created: 31, updated: 30 }]);
    outcome.ntfy = false;
    await watch();
    outcome.ntfy = true;
    await watch();
    await watch();

    expect(sent.mail).toHaveLength(1);
    expect(sent.ntfy).toHaveLength(2);
    expect(JSON.parse(await readFile(paths.state, "utf8")).imposed).toMatchObject({ mail: true, ntfy: true });
  });

  test("sends nothing with a blank config but still probes", async () => {
    await jobs([{ status: "failed", errorCode: "usage_limit", created: 62, updated: 61 }]);
    await watch(await loadConfig(join(import.meta.dir, "..", "scripts", "limit-watch.example.json")));
    expect(sent.mail).toEqual([]);
    expect(sent.ntfy).toEqual([]);
    expect(sent.probes).toHaveLength(1);
  });

  test("a dry run sends, probes and saves nothing", async () => {
    await jobs([{ status: "failed", errorCode: "usage_limit", created: 62, updated: 61 }]);
    await watch(configured, true);
    expect(sent.mail).toEqual([]);
    expect(sent.ntfy).toEqual([]);
    expect(sent.probes).toEqual([]);
    expect(sent.log.some((line) => line.startsWith("DRY RUN would mail"))).toBe(true);
    expect(await readFile(paths.state, "utf8").catch(() => null)).toBeNull();
  });

  test("does nothing without a usage-limit refusal", async () => {
    await jobs([{ status: "failed", errorCode: "something_else", created: 62, updated: 61 }]);
    await watch();
    expect(sent).toMatchObject({ mail: [], ntfy: [], probes: [] });
  });
});
