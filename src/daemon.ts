import { spawn } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimePaths } from "./config";
import { ensurePrivateDir, writePrivateFile } from "./config";
import { EXIT, ProError, type ErrorPayload, type ExitCode, toProError } from "./errors";
import { executeClaimedJob, waitForJob, waitTimeoutError, type ExecutorTransports, type JobWaitOutcome } from "./executor";
import { JobStore, redactJob, type CreateJobInput, type JobRecord } from "./jobs";
import type { CliIO } from "./output";

const DEFAULT_DAEMON_START_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_POLL_MS = 500;
const HEARTBEAT_MS = 2_000;
export const DEFAULT_DAEMON_CONCURRENCY = 3;
export const MAX_DAEMON_CONCURRENCY = 16;
// Endpoints written by this daemon carry protocol 2; the legacy serial daemon writes none.
const DAEMON_PROTOCOL = 2;
const RESEARCH_LEASE_MS = 120_000;
const LEASE_RENEW_MS = 30_000;
const ORPHAN_SWEEP_MS = 30_000;
const DRAIN_GRACE_MS = 1_000;

export interface DaemonEndpoint {
  version: 1;
  protocol?: number;
  concurrency?: number;
  pid: number;
  port: number;
  token: string;
  home: string;
  startedAt: string;
  updatedAt: string;
  logPath: string;
}

export interface DaemonStatus {
  state: "running" | "stopped" | "stale";
  endpointPath: string;
  logPath: string;
  pid?: number;
  port?: number;
  home: string;
  updatedAt?: string;
  processAlive?: boolean;
  message?: string;
  concurrency?: number;
  activeJobs?: number;
  legacy?: LegacyDaemonStatus;
}

/** The pre-concurrency daemon, found through the old daemon.json endpoint. */
export interface LegacyDaemonStatus {
  state: "running" | "stopped";
  endpointPath: string;
  pid?: number;
  port?: number;
}

export interface LegacyStopResult {
  stopped: boolean;
  pid?: number;
  waitedMs: number;
  requeued: string[];
  message?: string;
}

export interface DaemonStartResult {
  started: boolean;
  status: DaemonStatus;
  client: DaemonClient;
}

interface DaemonRuntimePaths {
  dir: string;
  endpointPath: string;
  logPath: string;
  legacyEndpointPath: string;
}

interface DaemonControl {
  pumpQueue: () => void;
  shutdown: (force: boolean) => void;
  info: () => { protocol: number; concurrency: number; activeJobs: number; draining: boolean };
}

export class DaemonClient {
  constructor(private readonly endpoint: DaemonEndpoint) {}

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health");
  }

  async createJob(input: CreateJobInput): Promise<Record<string, unknown>> {
    return this.request("POST", "/jobs", input);
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  async result(jobId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}/result`);
  }

  async wait(
    jobId: string,
    timeoutMs: number,
    pollMs: number,
    softTimeout = false,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/wait`, {
      timeoutMs,
      pollMs,
      softTimeout,
    });
  }

  async cancel(jobId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async jobs(limit: number): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  async shutdown(force = false): Promise<Record<string, unknown>> {
    return this.request("POST", "/shutdown", force ? { force: true } : undefined);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.endpoint.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new ProError("DAEMON_UNAVAILABLE", "Cannot reach the pro-cli daemon.", {
        exitCode: EXIT.network,
        suggestions: ["Run pro-cli daemon start --json.", "Inspect the daemon log path from pro-cli daemon status --json."],
        cause: error,
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | { ok: true; data: Record<string, unknown> }
      | { ok: false; error: ErrorPayload }
      | null;
    if (payload?.ok) return payload.data;
    if (payload?.ok === false) {
      throw new ProError(payload.error.code, payload.error.message, {
        exitCode: response.ok ? EXIT.internal : exitCodeForStatus(response.status),
        suggestions: payload.error.suggestions,
        details: payload.error.details,
      });
    }
    throw new ProError("DAEMON_BAD_RESPONSE", `pro-cli daemon returned HTTP ${response.status}.`, {
      exitCode: exitCodeForStatus(response.status),
      suggestions: ["Run pro-cli daemon restart --json."],
    });
  }
}

export async function ensureDaemonRunning(paths: RuntimePaths, io: CliIO): Promise<DaemonStartResult> {
  const connected = await connectDaemon(paths);
  if (connected) {
    return { started: false, status: connected.status, client: connected.client };
  }

  const before = await getDaemonStatus(paths);
  if (before.pid && before.processAlive) {
    try {
      process.kill(before.pid, "SIGTERM");
    } catch {
      // The process may have exited between status and restart.
    }
  }
  await startDaemonProcess(paths, io);

  const deadline = Date.now() + DEFAULT_DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const next = await connectDaemon(paths);
    if (next) return { started: true, status: next.status, client: next.client };
    await sleep(100);
  }

  const status = await getDaemonStatus(paths);
  throw new ProError("DAEMON_START_FAILED", "pro-cli daemon did not become ready.", {
    exitCode: EXIT.internal,
    suggestions: [
      "Run pro-cli daemon status --json.",
      `Inspect the daemon log: ${status.logPath}`,
    ],
    details: { status },
  });
}

export async function getDaemonStatus(paths: RuntimePaths): Promise<DaemonStatus> {
  return { ...(await getConcurrentDaemonStatus(paths)), legacy: await getLegacyDaemonStatus(paths) };
}

async function getConcurrentDaemonStatus(paths: RuntimePaths): Promise<DaemonStatus> {
  const runtime = daemonRuntimePaths(paths.home);
  const endpoint = await readEndpoint(runtime.endpointPath).catch(() => null);
  if (!endpoint) {
    return { state: "stopped", endpointPath: runtime.endpointPath, logPath: runtime.logPath, home: paths.home };
  }
  if (endpoint.home !== paths.home) {
    return {
      state: "stale",
      endpointPath: runtime.endpointPath,
      logPath: runtime.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive: true,
      message: "Daemon endpoint belongs to a different PRO_CLI_HOME.",
    };
  }
  const client = new DaemonClient(endpoint);
  try {
    const health = await client.health();
    return {
      state: "running",
      endpointPath: runtime.endpointPath,
      logPath: endpoint.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive: true,
      ...(typeof health.concurrency === "number" ? { concurrency: health.concurrency } : {}),
      ...(typeof health.activeJobs === "number" ? { activeJobs: health.activeJobs } : {}),
    };
  } catch (error) {
    const processAlive = isProcessAlive(endpoint.pid);
    if (!processAlive) {
      return {
        state: "stopped",
        endpointPath: runtime.endpointPath,
        logPath: endpoint.logPath,
        home: paths.home,
        pid: endpoint.pid,
        port: endpoint.port,
        updatedAt: endpoint.updatedAt,
        processAlive,
        message: "Daemon pid is not running.",
      };
    }
    return {
      state: "stale",
      endpointPath: runtime.endpointPath,
      logPath: endpoint.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getLegacyDaemonStatus(paths: RuntimePaths): Promise<LegacyDaemonStatus> {
  const runtime = daemonRuntimePaths(paths.home);
  const holder = await readLegacyHolder(paths);
  if (!holder) return { state: "stopped", endpointPath: runtime.legacyEndpointPath };
  return { state: "running", endpointPath: runtime.legacyEndpointPath, pid: holder.pid, port: holder.port };
}

/**
 * Retire the legacy serial daemon without cutting off its work: wait until it has no job in flight and
 * nothing is queued for it to pick up, then ask it to shut down. Once it is gone the concurrent daemon
 * takes over daemon.json, so legacy clients keep working against the new daemon.
 */
export async function stopLegacyDaemon(
  paths: RuntimePaths,
  options: { force?: boolean; timeoutMs?: number; pollMs?: number } = {},
): Promise<LegacyStopResult> {
  const runtime = daemonRuntimePaths(paths.home);
  const holder = await readLegacyHolder(paths);
  if (!holder) return { stopped: false, waitedMs: 0, requeued: [], message: "No legacy daemon is running." };

  const start = Date.now();
  const store = await JobStore.open(paths.dbPath);
  try {
    let idleSince = new Date().toISOString();
    while (!options.force) {
      idleSince = new Date().toISOString();
      const busy = legacyInFlightJobs(store).map((job) => job.id);
      const queued = store.countQueued();
      if (busy.length === 0 && queued === 0) break;
      if (options.timeoutMs && Date.now() - start >= options.timeoutMs) {
        throw new ProError("LEGACY_DAEMON_BUSY", "The legacy daemon still has work in flight.", {
          exitCode: EXIT.timeout,
          suggestions: [
            "Retry later, or wait without --wait-timeout.",
            "Use --force to stop it now; its in-flight jobs are put back in the queue.",
          ],
          details: { pid: holder.pid, runningJobIds: busy, queuedJobs: queued },
        });
      }
      await sleep(options.pollMs ?? DEFAULT_DAEMON_POLL_MS);
    }

    const busyAtStop = new Set(options.force ? legacyInFlightJobs(store).map((job) => job.id) : []);
    await new DaemonClient(holder).shutdown().catch(() => {
      try {
        process.kill(holder.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    });
    const deadline = Date.now() + 10_000;
    while (isProcessAlive(holder.pid) && Date.now() < deadline) await sleep(100);
    if (isProcessAlive(holder.pid)) {
      throw new ProError("LEGACY_DAEMON_STOP_FAILED", `Legacy daemon ${holder.pid} did not exit.`, {
        exitCode: EXIT.internal,
        suggestions: [`Inspect it with ps -p ${holder.pid}, then kill ${holder.pid}.`],
      });
    }

    // The legacy daemon exits mid-request, leaving jobs it had claimed stuck in "running". Put back the
    // ones it was running when forced, or that it grabbed in the moment between the idle check and exit.
    // Research tasks need no help: with the legacy daemon gone their NULL marker makes them resumable.
    const requeued: string[] = [];
    for (const claim of legacyInFlightJobs(store)) {
      if (claim.hasResearchTask) continue;
      if (busyAtStop.has(claim.id) || store.get(claim.id).updatedAt >= idleSince) {
        if (store.requeueRunning(claim.id)) requeued.push(claim.id);
      }
    }

    // Point legacy clients at the concurrent daemon right away instead of waiting for its heartbeat.
    const current = await readEndpoint(runtime.endpointPath).catch(() => null);
    if (current && current.home === paths.home && isProcessAlive(current.pid)) {
      await writeEndpointFile(runtime.legacyEndpointPath, current);
    }
    return { stopped: true, pid: holder.pid, waitedMs: Date.now() - start, requeued };
  } finally {
    store.close();
  }
}

export async function stopDaemon(paths: RuntimePaths, options: { force?: boolean } = {}): Promise<DaemonStatus> {
  const connected = await connectDaemon(paths);
  if (connected) {
    await connected.client.shutdown(options.force === true);
    await sleep(100);
  } else {
    const status = await getDaemonStatus(paths);
    if (status.pid && status.processAlive) {
      try {
        process.kill(status.pid, "SIGTERM");
      } catch {
        // The process may have exited between status and stop.
      }
    }
  }
  return getDaemonStatus(paths);
}

export async function runDaemonServer(
  paths: RuntimePaths,
  options: {
    port?: number;
    pollMs?: number;
    idleTimeoutMs?: number;
    concurrency?: number;
    transports?: ExecutorTransports;
  } = {},
): Promise<void> {
  await ensurePrivateDir(paths.home);
  const runtime = daemonRuntimePaths(paths.home);
  await ensurePrivateDir(runtime.dir);
  await assertPrivateRuntimeDir(runtime.dir);
  touchPrivateFile(runtime.logPath);
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const startedAt = new Date().toISOString();
  const concurrency = options.concurrency ?? DEFAULT_DAEMON_CONCURRENCY;
  const owner = `${process.pid}:${randomUUID()}`;
  const store = await JobStore.open(paths.dbPath);
  const active = new Map<string, Promise<void>>();
  let draining = false;
  let stopped = false;
  let legacyAlive = (await readLegacyHolder(paths)) !== null;
  let lastActivityAt = Date.now();
  let lastLeaseRenewal = Date.now();
  let lastOrphanSweep = 0;
  let publishing: Promise<void> = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let queuePoll: ReturnType<typeof setInterval> | undefined;
  let idleCheck: ReturnType<typeof setInterval> | undefined;
  let signals = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      if (!isAuthorized(request, token)) return jsonError(new ProError("DAEMON_UNAUTHORIZED", "Invalid daemon token."), 401);
      try {
        lastActivityAt = Date.now();
        const response = await routeDaemonRequest(request, store, paths, {
          pumpQueue,
          shutdown: (force) => {
            setTimeout(() => void shutdown(force), 10);
          },
          info: () => ({ protocol: DAEMON_PROTOCOL, concurrency, activeJobs: active.size, draining }),
        });
        return jsonOk(response);
      } catch (error) {
        const proError = toProError(error);
        return jsonError(proError, httpStatusForError(proError));
      }
    },
  });

  function endpointRecord(): DaemonEndpoint {
    return {
      version: 1,
      protocol: DAEMON_PROTOCOL,
      concurrency,
      pid: process.pid,
      port: server.port ?? 0,
      token,
      home: paths.home,
      startedAt,
      updatedAt: new Date().toISOString(),
      logPath: runtime.logPath,
    };
  }

  async function publishEndpoints(): Promise<void> {
    if (draining) return;
    await writeEndpointFile(runtime.endpointPath, endpointRecord());
    if (draining) return;
    legacyAlive = await syncLegacyEndpoint();
  }

  // daemon.json belongs to whichever daemon legacy clients should reach. Leave it to a live legacy
  // daemon; otherwise advertise this daemon there too (same HTTP API, same endpoint fields).
  async function syncLegacyEndpoint(): Promise<boolean> {
    const current = await readEndpoint(runtime.legacyEndpointPath).catch(() => null);
    const ours = current?.pid === process.pid && current.token === token;
    if (current && !ours && isProcessAlive(current.pid)) {
      return current.home === paths.home && current.protocol !== DAEMON_PROTOCOL;
    }
    await writeEndpointFile(runtime.legacyEndpointPath, endpointRecord());
    return false;
  }

  async function withdrawEndpoints(): Promise<void> {
    await publishing.catch(() => undefined);
    for (const path of [runtime.endpointPath, runtime.legacyEndpointPath]) {
      const current = await readEndpoint(path).catch(() => null);
      if (current?.pid === process.pid && current.token === token) await unlink(path).catch(() => undefined);
    }
  }

  function pumpQueue(): void {
    while (!draining && active.size < concurrency) {
      let claimed: JobRecord | null;
      try {
        claimed = store.claimNextRunnable({
          owner,
          exclude: new Set(active.keys()),
          leaseMs: RESEARCH_LEASE_MS,
          legacyAlive,
        });
      } catch (error) {
        logDaemonError("claiming the next job failed", error);
        return;
      }
      if (!claimed) return;
      startJob(claimed);
    }
  }

  function startJob(job: JobRecord): void {
    lastActivityAt = Date.now();
    const run = executeClaimedJob(store, job, paths, options.transports, { researchLeaseMs: RESEARCH_LEASE_MS })
      .then(() => undefined)
      .catch((error) => logDaemonError(`job ${job.id} could not record its outcome`, error))
      .finally(() => {
        active.delete(job.id);
        lastActivityAt = Date.now();
        if (!draining) pumpQueue();
        else if (active.size === 0) setTimeout(finish, DRAIN_GRACE_MS);
      });
    active.set(job.id, run);
  }

  function maintain(): void {
    if (stopped) return;
    const now = Date.now();
    try {
      if (active.size > 0 && now - lastLeaseRenewal >= LEASE_RENEW_MS) {
        lastLeaseRenewal = now;
        store.renewResearchLeases(active.keys(), new Date(now + RESEARCH_LEASE_MS).toISOString());
      }
      if (!draining && now - lastOrphanSweep >= ORPHAN_SWEEP_MS) {
        lastOrphanSweep = now;
        failOrphanedJobs(store, owner);
      }
    } catch (error) {
      logDaemonError("daemon maintenance failed", error);
    }
  }

  // Graceful by default: stop taking work and stop advertising, so the next client starts a fresh
  // daemon, while jobs already running here finish and record their results. force exits now.
  async function shutdown(force = false): Promise<void> {
    if (!draining) {
      draining = true;
      clearInterval(queuePoll);
      clearInterval(idleCheck);
      await withdrawEndpoints();
    }
    if (force || active.size === 0) finish();
  }

  function finish(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearInterval(maintenance);
    clearInterval(queuePoll);
    clearInterval(idleCheck);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    store.close();
    server.stop();
  }

  function onSignal(): void {
    signals += 1;
    void shutdown(signals > 1);
  }

  await publishEndpoints();
  heartbeat = setInterval(() => {
    publishing = publishing
      .then(publishEndpoints)
      .catch((error) => logDaemonError("publishing the daemon endpoint failed", error));
  }, HEARTBEAT_MS);
  maintenance = setInterval(maintain, HEARTBEAT_MS);
  queuePoll = setInterval(pumpQueue, options.pollMs ?? DEFAULT_DAEMON_POLL_MS);
  idleCheck = setInterval(() => {
    if (!options.idleTimeoutMs || draining || active.size > 0) return;
    if (Date.now() - lastActivityAt >= options.idleTimeoutMs) void shutdown();
  }, 1_000);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  maintain();
  pumpQueue();
  while (!stopped) await sleep(250);
}

/** Fail running jobs whose claiming daemon process is gone; they would otherwise stay "running" forever. */
function failOrphanedJobs(store: JobStore, owner: string): void {
  for (const job of store.runningClaims()) {
    // Research tasks recover on their own once the dead owner's lease expires.
    if (!job.claimedBy || job.claimedBy === owner || job.hasResearchTask) continue;
    const pid = Number.parseInt(job.claimedBy, 10);
    if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
    store.markFailed(
      job.id,
      new ProError("DAEMON_INTERRUPTED", "The daemon running this job exited before it finished.", {
        exitCode: EXIT.internal,
        suggestions: ["Submit the prompt again with pro-cli job create."],
      }),
    );
  }
}

function legacyInFlightJobs(store: JobStore): ReturnType<JobStore["runningClaims"]> {
  // The legacy daemon records no owner; a NULL next_poll_at is its marker for a research task it is polling.
  return store.runningClaims().filter((job) => job.claimedBy === null && (!job.hasResearchTask || job.nextPollAt === null));
}

async function readLegacyHolder(paths: RuntimePaths): Promise<DaemonEndpoint | null> {
  const runtime = daemonRuntimePaths(paths.home);
  const endpoint = await readEndpoint(runtime.legacyEndpointPath).catch(() => null);
  if (!endpoint || endpoint.home !== paths.home || endpoint.protocol === DAEMON_PROTOCOL) return null;
  return isProcessAlive(endpoint.pid) ? endpoint : null;
}

async function writeEndpointFile(path: string, endpoint: DaemonEndpoint): Promise<void> {
  // Write then rename, so a client never reads a half-written endpoint and decides the daemon is gone.
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writePrivateFile(temp, `${JSON.stringify(endpoint, null, 2)}\n`);
  await rename(temp, path);
}

function logDaemonError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${new Date().toISOString()}] ${context}: ${message}`);
}

async function connectDaemon(paths: RuntimePaths): Promise<{ client: DaemonClient; status: DaemonStatus } | null> {
  const runtime = daemonRuntimePaths(paths.home);
  const endpoint = await readEndpoint(runtime.endpointPath).catch(() => null);
  if (!endpoint || endpoint.home !== paths.home) return null;
  const client = new DaemonClient(endpoint);
  try {
    await client.health();
    return {
      client,
      status: {
        state: "running",
        endpointPath: runtime.endpointPath,
        logPath: endpoint.logPath,
        home: paths.home,
        pid: endpoint.pid,
        port: endpoint.port,
        updatedAt: endpoint.updatedAt,
        processAlive: true,
      },
    };
  } catch {
    return null;
  }
}

async function startDaemonProcess(paths: RuntimePaths, io: CliIO): Promise<void> {
  const runtime = daemonRuntimePaths(paths.home);
  await ensurePrivateDir(runtime.dir);
  await assertPrivateRuntimeDir(runtime.dir);
  const logFd = openSync(runtime.logPath, "a", 0o600);
  const cliPath = new URL("./cli.ts", import.meta.url).pathname;
  const env = { ...process.env };
  for (const [key, value] of Object.entries(io.env)) {
    if (value !== undefined) env[key] = value;
  }
  const child = spawn(process.execPath, [cliPath, "daemon", "serve", "--json"], {
    cwd: io.cwd,
    detached: true,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

function touchPrivateFile(path: string): void {
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
}

async function routeDaemonRequest(
  request: Request,
  store: JobStore,
  paths: RuntimePaths,
  control: DaemonControl,
): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/health") {
    const info = control.info();
    return {
      state: info.draining ? "draining" : "running",
      pid: process.pid,
      home: paths.home,
      protocol: info.protocol,
      concurrency: info.concurrency,
      activeJobs: info.activeJobs,
    };
  }
  if (request.method === "POST" && url.pathname === "/shutdown") {
    const body = await readJsonBody(request);
    const force = body.force === true;
    control.shutdown(force);
    return { state: "stopping", force, activeJobs: control.info().activeJobs };
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    const input = createJobInputFromPayload(await readJsonBody(request));
    const job = store.create(input);
    queueMicrotask(() => control.pumpQueue());
    return { job, daemon: { accepted: true } };
  }
  if (request.method === "GET" && url.pathname === "/jobs") {
    const limit = parseLimit(url.searchParams.get("limit"));
    return { jobs: store.list(limit) };
  }
  if (parts[0] !== "jobs" || !parts[1]) {
    throw new ProError("DAEMON_ROUTE_NOT_FOUND", `No daemon route for ${request.method} ${url.pathname}.`, {
      exitCode: EXIT.notFound,
    });
  }

  const jobId = decodeURIComponent(parts[1]);
  if (request.method === "GET" && parts.length === 2) {
    return { job: redactJob(store.get(jobId)) };
  }
  if (request.method === "GET" && parts[2] === "result") {
    const job = store.get(jobId);
    if (job.status !== "succeeded") {
      throw new ProError("JOB_NOT_READY", `Job ${jobId} is ${job.status}.`, {
        exitCode: EXIT.notFound,
        suggestions: ["Run pro-cli job wait <job-id> or pro-cli job status <job-id>."],
      });
    }
    return { jobId, result: job.result };
  }
  if (request.method === "POST" && parts[2] === "cancel") {
    return { job: store.cancel(jobId) };
  }
  if (request.method === "POST" && parts[2] === "wait") {
    const body = await readJsonBody(request);
    queueMicrotask(() => control.pumpQueue());
    const outcome = await waitForJob(
      store,
      jobId,
      numberFromPayload(body.timeoutMs, 0),
      numberFromPayload(body.pollMs, DEFAULT_DAEMON_POLL_MS),
    );
    if (outcome.timedOut && body.softTimeout !== true) throw waitTimeoutError(outcome);
    return waitPayload(outcome);
  }

  throw new ProError("DAEMON_ROUTE_NOT_FOUND", `No daemon route for ${request.method} ${url.pathname}.`, {
    exitCode: EXIT.notFound,
  });
}

function daemonRuntimePaths(home: string): DaemonRuntimePaths {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 12);
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = join(root, `pro-cli-${uid}-${hash}`);
  return {
    dir,
    endpointPath: join(dir, "daemon-v2.json"),
    logPath: join(dir, "daemon-v2.log"),
    // Read by pre-concurrency clients; shared with a legacy daemon while one is alive.
    legacyEndpointPath: join(dir, "daemon.json"),
  };
}

async function readEndpoint(path: string): Promise<DaemonEndpoint> {
  await assertPrivateRuntimeDir(dirname(path));
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as DaemonEndpoint;
}

// The runtime dir has a predictable name under /tmp. Another local user who creates it first could swap in
// their own endpoint and receive prompts, so only trust a real directory we own that nobody else can write.
async function assertPrivateRuntimeDir(dir: string): Promise<void> {
  if (typeof process.getuid !== "function") return;
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
    throw new ProError("DAEMON_DIR_UNSAFE", `Daemon runtime directory ${dir} is not a private directory owned by this user.`, {
      exitCode: EXIT.internal,
      suggestions: [`Inspect ${dir}; remove it if you did not create it, then retry.`],
      details: { dir },
    });
  }
}

function isAuthorized(request: Request, token: string): boolean {
  const presented = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(presented, expected);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProError("INVALID_JSON", "Daemon request body must be a JSON object.", {
      exitCode: EXIT.invalidArgs,
    });
  }
  return parsed as Record<string, unknown>;
}

function createJobInputFromPayload(payload: Record<string, unknown>): CreateJobInput {
  if (
    typeof payload.prompt !== "string" ||
    typeof payload.model !== "string" ||
    typeof payload.reasoning !== "string" ||
    !isRecord(payload.options)
  ) {
    throw new ProError("INVALID_DAEMON_JOB", "Daemon job payload is missing prompt, model, reasoning, or options.", {
      exitCode: EXIT.invalidArgs,
    });
  }
  return {
    prompt: payload.prompt,
    model: payload.model,
    reasoning: payload.reasoning,
    options: payload.options,
  };
}

function parseLimit(raw: string | null): number {
  const limit = Number(raw ?? "20");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ProError("INVALID_ARGS", "Invalid --limit.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Use --limit between 1 and 200."],
    });
  }
  return limit;
}

function numberFromPayload(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function waitPayload(outcome: JobWaitOutcome): Record<string, unknown> {
  return {
    job: redactJob(outcome.job),
    wait: {
      status: outcome.status,
      timedOut: outcome.timedOut,
      elapsedMs: outcome.elapsedMs,
      timeoutMs: outcome.timeoutMs,
      pollMs: outcome.pollMs,
    },
    ...(outcome.timedOut
      ? {
          next: {
            command: `pro-cli job wait ${outcome.job.id} --json`,
            reason: "The job is still running. Wait again without a timeout, or use another soft timeout poll.",
          },
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonOk(data: Record<string, unknown>): Response {
  return Response.json({ ok: true, data });
}

function jsonError(error: ProError, status: number): Response {
  return Response.json({ ok: false, error: error.toPayload() }, { status });
}

function httpStatusForError(error: ProError): number {
  if (error.exitCode === EXIT.invalidArgs) return 400;
  if (error.exitCode === EXIT.notFound) return 404;
  if (error.exitCode === EXIT.auth) return 401;
  if (error.exitCode === EXIT.timeout) return 408;
  return 500;
}

function exitCodeForStatus(status: number): ExitCode {
  if (status === 400) return EXIT.invalidArgs;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 408) return EXIT.timeout;
  if (status >= 500) return EXIT.internal;
  return EXIT.network;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
