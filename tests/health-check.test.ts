import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHealthCheck, type HealthDeps, type HealthPaths, type PageSession } from "../scripts/pro-cli-health-check";
import { DEFAULT_CONFIG, mailOrigin, type LimitWatchConfig } from "../scripts/pro-cli-limit-watch";
import { ProError } from "../src/errors";
import { JobStore } from "../src/jobs";

// Every mail subject starts with [user@hostname] of the machine sending it.
const tag = `[${mailOrigin()}] `;

const HOUR = 60 * 60_000;
let root: string;
let paths: HealthPaths;
let now: Date;
let world: { cdpUp: boolean; page: PageSession; timerActive: boolean; mailOk: boolean };
let sent: { mail: string[]; ntfy: string[]; log: string[] };

const config: LimitWatchConfig = {
  ...DEFAULT_CONFIG,
  mail: { to: "owner@example.com", from: "check@example.com", command: ["sendmail", "-t"] },
  ntfy: { url: "https://ntfy.example.com/topic", title: "check host" },
  gateKeys: ["tester"],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pro-health-check-"));
  paths = {
    db: join(root, "jobs.sqlite"),
    token: join(root, "token.json"),
    gateStateRoot: join(root, "gate"),
    recovered: join(root, "recovered-answers.jsonl"),
    state: join(root, "state", "state.json"),
  };
  now = new Date();
  world = { cdpUp: true, page: { status: "present", expiresAt: at(7 * 24), accountId: "acct_1" }, timerActive: true, mailOk: true };
  sent = { mail: [], ntfy: [], log: [] };
  await writeToken(at(7 * 24));
  (await JobStore.open(paths.db)).close();
  await mkdir(join(paths.gateStateRoot, "tester"), { recursive: true });
  // As if the last run was 12 hours ago.
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(paths.state, JSON.stringify({ lastRunAt: at(-12) }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function at(hoursFromNow: number): string {
  return new Date(now.getTime() + hoursFromNow * HOUR).toISOString();
}

async function writeToken(expiresAt: string, accountId = "acct_1") {
  await writeFile(paths.token, JSON.stringify({ version: 1, generatedAt: now.toISOString(), source: "pro-cli-cdp-page", accessToken: "header.payload.sig", accountId, expiresAt }));
}

async function check(dryRun = false) {
  const deps: HealthDeps = {
    now: () => now,
    log: (line) => sent.log.push(line),
    dryRun,
    timers: ["pro-cli-limit-watch.timer"],
    cdpUp: async () => world.cdpUp,
    pageSession: async () => world.page,
    timerActive: async () => world.timerActive,
    sendMail: async (message) => {
      sent.mail.push(message);
      return world.mailOk;
    },
    postNtfy: async (body) => {
      sent.ntfy.push(body);
      return true;
    },
  };
  await runHealthCheck(config, paths, deps);
}

// Jobs that ended `hoursAgo`, failed with the given code (or succeeded when code is null).
async function endedJobs(entries: Array<{ code: string | null; errorCode?: string; hoursAgo: number; owner?: string }>) {
  const store = await JobStore.open(paths.db);
  const ids: string[] = [];
  try {
    for (const entry of entries) {
      const { id } = store.create({ prompt: "secret question", model: "gpt-6-pro", reasoning: "standard", options: {} });
      store.markRunning(id);
      if (entry.code === null) store.markSucceeded(id, "secret answer");
      else store.markFailed(id, new ProError(entry.code, "secret message", { details: { errorCode: entry.errorCode ?? null } }));
      ids.push(id);
      if (entry.owner) await appendFile(join(paths.gateStateRoot, entry.owner, "jobs"), `${id}\n`);
    }
  } finally {
    store.close();
  }
  const db = new Database(paths.db);
  try {
    entries.forEach((entry, index) => db.query("UPDATE jobs SET updated_at = ? WHERE id = ?").run(at(-entry.hoursAgo), ids[index]));
  } finally {
    db.close();
  }
  return ids;
}

async function gateCalls(entries: Array<{ verb: string; error?: string; errno?: string; hoursAgo: number }>) {
  const lines = entries.map((entry) => JSON.stringify({
    at: at(-entry.hoursAgo),
    verb: entry.verb,
    code: entry.error ? 7 : 0,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.errno ? { errno: entry.errno } : {}),
  }));
  await appendFile(join(paths.gateStateRoot, "tester", "audit.log"), lines.map((line) => `${line}\n`).join(""));
}

const subjects = () => sent.mail.map((mail) => mail.match(/Subject: .*/)?.[0]);

describe("health check", () => {
  test("stays quiet when all is well", async () => {
    await endedJobs([{ code: null, hoursAgo: 2 }]);
    await gateCalls([{ verb: "pro-cli job wait", hoursAgo: 1 }, { verb: "pro-cli job result", error: "JOB_NOT_READY", hoursAgo: 1 }]);
    await check();
    expect(sent.mail).toEqual([]);
    expect(sent.ntfy).toEqual([]);
    expect(sent.log[0]).toStartWith("ok: CDP up, page present");
    expect(sent.log[0]).toContain("gate key tester: 2 calls");
  });

  test("the first run reports lasting problems but no earlier events", async () => {
    await rm(paths.state);
    await endedJobs([{ code: "EMPTY_RESPONSE", hoursAgo: 2 }]);
    world.cdpUp = false;
    await check();
    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain("Chrome's CDP port does not answer");
    expect(sent.mail[0]).not.toContain("jobs failed");
  });

  test("announces a lasting problem once, and again after it cleared and came back", async () => {
    world.cdpUp = false;
    await check();
    now = new Date(now.getTime() + 12 * HOUR);
    await check();
    expect(subjects()).toEqual([`Subject: ${tag}pro-cli health: Chrome's CDP port does not answer`]);
    expect(sent.mail[0]).toContain(`(scripts/pro-cli-health-check.ts) as ${mailOrigin()}.`);
    expect(sent.ntfy).toHaveLength(1);

    world.cdpUp = true;
    now = new Date(now.getTime() + 12 * HOUR);
    await check();
    world.cdpUp = false;
    now = new Date(now.getTime() + 12 * HOUR);
    await check();
    expect(sent.mail).toHaveLength(2);
  });

  test("warns about a token within 48 hours of expiry unless the page holds a longer-lived one", async () => {
    await writeToken(at(30));
    world.page = { status: "present", expiresAt: at(30), accountId: "acct_1" };
    await check();
    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain("The stored session token expires at");
    expect(sent.mail[0]).toContain("the page holds no newer one");

    await writeFile(paths.state, JSON.stringify({ lastRunAt: at(-12) }));
    sent.mail = [];
    world.page = { status: "present", expiresAt: at(9 * 24), accountId: "acct_1" };
    await check();
    expect(sent.mail).toEqual([]);

    world.page = { status: "present", expiresAt: at(9 * 24), accountId: "acct_other" };
    await check();
    expect(sent.mail).toHaveLength(1);
  });

  test("reports a missing token and a logged-out page", async () => {
    await rm(paths.token);
    world.page = { status: "logged_out" };
    await check();
    expect(subjects()).toEqual([`Subject: ${tag}pro-cli health: 2 problems`]);
    expect(sent.mail[0]).toContain("The ChatGPT page is logged out");
    expect(sent.mail[0]).toContain("No stored session token");
  });

  test("reports failed jobs since the last run, but not usage-limit refusals, and not twice", async () => {
    await endedJobs([
      { code: "EMPTY_RESPONSE", hoursAgo: 3, owner: "tester" },
      { code: "EMPTY_RESPONSE", hoursAgo: 2 },
      { code: "UPSTREAM_ERROR", errorCode: "usage_limit", hoursAgo: 1, owner: "tester" },
      { code: "STREAM_INCOMPLETE", hoursAgo: 20 },
    ]);
    await check();
    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain("2 jobs failed: 2 × EMPTY_RESPONSE (1 of gate key tester).");
    expect(sent.mail[0]).not.toContain("secret");

    now = new Date(now.getTime() + 12 * HOUR);
    await check();
    expect(sent.mail).toHaveLength(1);
  });

  test("reports gate calls that broke inside the gate or the setup, and asks that failed", async () => {
    await gateCalls([
      { verb: "pro-cli job wait", error: "GATE_INTERNAL", errno: "ENOSPC", hoursAgo: 2 },
      { verb: "pro-cli job wait", error: "CLIENT_GONE", hoursAgo: 2 },
      { verb: "pro-cli job wait", error: "EMPTY_RESPONSE", hoursAgo: 2 },
      { verb: "pro-cli ask", error: "SESSION_TOKEN_EXPIRED", hoursAgo: 1 },
      { verb: "pro-cli ask", error: "STREAM_INCOMPLETE", hoursAgo: 1 },
      { verb: "pro-cli ask", error: "UPSTREAM_ERROR", hoursAgo: 1 },
      { verb: "pro-cli job create", error: "USAGE_LIMIT_PAUSED", hoursAgo: 1 },
      { verb: "pro-cli ask", error: "USAGE_LIMIT_PAUSED", hoursAgo: 1 },
      { verb: "pro-cli ask", error: "FLAG_DENIED", hoursAgo: 1 },
    ]);
    await check();
    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toContain(
      "3 gate calls of key tester failed: 1 × pro-cli job wait GATE_INTERNAL/ENOSPC, 1 × pro-cli ask SESSION_TOKEN_EXPIRED, 1 × pro-cli ask STREAM_INCOMPLETE.",
    );
  });

  test("names recovered answers so the gate key can fetch them again", async () => {
    const [id] = await endedJobs([{ code: null, hoursAgo: 1, owner: "tester" }]);
    await writeFile(paths.recovered, `${JSON.stringify({ jobId: id, reason: "failed", chars: 10, recordedAt: at(-1) })}\n`);
    await check();
    expect(sent.mail[0]).toContain(`Job ${id.slice(0, 12)} failed and now has its answer; tell gate key tester to fetch it again with job result.`);
  });

  test("reports a stopped limit-watch timer", async () => {
    world.timerActive = false;
    await check();
    expect(sent.mail[0]).toContain("The pro-cli-limit-watch.timer unit is not active.");
  });

  test("retries only the channel that failed", async () => {
    world.cdpUp = false;
    world.mailOk = false;
    await check();
    world.mailOk = true;
    now = new Date(now.getTime() + 12 * HOUR);
    await check();
    expect(sent.mail).toHaveLength(2);
    expect(sent.ntfy).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.state, "utf8"))).toMatchObject({ pendingMail: null, pendingNtfy: null });
  });

  test("a dry run sends and saves nothing", async () => {
    world.cdpUp = false;
    const before = await readFile(paths.state, "utf8");
    await check(true);
    expect(sent.mail).toEqual([]);
    expect(sent.ntfy).toEqual([]);
    expect(sent.log.some((line) => line.startsWith("DRY RUN would mail"))).toBe(true);
    expect(await readFile(paths.state, "utf8")).toBe(before);
  });
});
