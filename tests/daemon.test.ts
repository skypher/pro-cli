import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  DaemonClient,
  getDaemonStatus,
  runDaemonServer,
  stopDaemon,
  stopLegacyDaemon,
  type DaemonEndpoint,
} from "../src/daemon";
import { resolvePaths, type RuntimePaths } from "../src/config";
import type { ExecutorTransports } from "../src/executor";
import { JobStore, type JobRecord } from "../src/jobs";

describe("daemon runtime files", () => {
  test("daemon serve creates the advertised log path", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const serving = runDaemonServer(paths, { idleTimeoutMs: 10_000 });
    try {
      const status = await waitForRunningDaemon(paths);

      expect(status.state).toBe("running");
      await access(status.logPath);
    } finally {
      await stopDaemon(paths).catch(() => undefined);
      await serving.catch(() => undefined);
      await cleanup(home);
    }
  });
});

describe("concurrent daemon", () => {
  test("runs up to --concurrency jobs at once and queues the rest", async () => {
    const gate = gatedTransport();
    await withDaemon({ concurrency: 2, transports: gate.transports }, async ({ paths }) => {
      const client = await clientFor(runtimeFor(paths.home).endpointPath);
      const ids: string[] = [];
      for (const prompt of ["one", "two", "three"]) {
        ids.push(String(((await client.createJob(jobInput(prompt))).job as JobRecord).id));
      }

      await until(() => gate.started.length === 2);
      await Bun.sleep(150);
      expect(gate.started).toHaveLength(2);
      expect(((await client.status(ids[2])).job as JobRecord).status).toBe("queued");
      expect((await getDaemonStatus(paths)).activeJobs).toBe(2);

      gate.release();
      for (const id of ids) {
        const waited = await client.wait(id, 5_000, 25);
        expect((waited.job as JobRecord).status).toBe("succeeded");
      }
      expect(gate.started).toHaveLength(3);
      expect((await client.result(ids[2])).result).toBe("answer three");
    });
  });

  test("advertises itself on daemon.json so legacy clients reach it", async () => {
    await withDaemon({ transports: instantTransport() }, async ({ paths }) => {
      const runtime = runtimeFor(paths.home);
      const current = await readEndpointFile(runtime.endpointPath);
      const legacy = await readEndpointFile(runtime.legacyEndpointPath);
      expect(legacy.protocol).toBe(2);
      expect(legacy.version).toBe(1);
      expect(legacy.token).toBe(current.token);
      expect(legacy.port).toBe(current.port);

      // What a pre-concurrency client does: read daemon.json and speak the same HTTP API.
      const client = new DaemonClient(legacy);
      expect((await client.health()).state).toBe("running");
      const id = String(((await client.createJob(jobInput("legacy client"))).job as JobRecord).id);
      expect(((await client.wait(id, 5_000, 25)).job as JobRecord).status).toBe("succeeded");
      expect((await getDaemonStatus(paths)).legacy?.state).toBe("stopped");
    });
  });

  test("leaves daemon.json to a live legacy daemon and takes it over once it exits", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const runtime = runtimeFor(home);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await mkdir(runtime.dir, { recursive: true, mode: 0o700 });
      await writeFile(runtime.legacyEndpointPath, JSON.stringify(legacyEndpoint(home, sleeper.pid ?? 0, 1, "legacy-token")));
      await withDaemon({ home, transports: instantTransport() }, async () => {
        const status = await getDaemonStatus(paths);
        expect(status.state).toBe("running");
        expect(status.legacy).toMatchObject({ state: "running", pid: sleeper.pid });
        await Bun.sleep(2_200);
        expect((await readEndpointFile(runtime.legacyEndpointPath)).token).toBe("legacy-token");

        sleeper.kill();
        await until(async () => (await readEndpointFile(runtime.legacyEndpointPath)).protocol === 2, 5_000);
        expect((await getDaemonStatus(paths)).legacy?.state).toBe("stopped");
      });
    } finally {
      sleeper.kill();
      await cleanup(home);
    }
  });

  test("graceful stop withdraws the endpoints but lets running jobs finish", async () => {
    const gate = gatedTransport();
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const runtime = runtimeFor(home);
    const serving = runDaemonServer(paths, { pollMs: 25, transports: gate.transports });
    try {
      await waitForRunningDaemon(paths);
      const client = await clientFor(runtime.endpointPath);
      const id = String(((await client.createJob(jobInput("long"))).job as JobRecord).id);
      await until(() => gate.started.length === 1);

      expect((await stopDaemon(paths)).state).toBe("stopped");
      expect(await exists(runtime.endpointPath)).toBe(false);
      expect(await exists(runtime.legacyEndpointPath)).toBe(false);
      expect(await jobStatus(paths, id)).toBe("running");

      gate.release();
      await serving;
      expect(await jobStatus(paths, id)).toBe("succeeded");
    } finally {
      gate.release();
      await serving.catch(() => undefined);
      await cleanup(home);
    }
  });

  test("fails jobs whose claiming daemon process is gone and leaves live owners alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const deadPid = spawnSync("true").pid;
    const store = await JobStore.open(paths.dbPath);
    let orphan = "";
    let alive = "";
    let legacyStyle = "";
    try {
      orphan = store.create(jobInput("orphan")).id;
      store.claimNextQueued(`${deadPid}:gone`);
      alive = store.create(jobInput("alive")).id;
      store.claimNextQueued(`${process.pid}:other-daemon`);
      legacyStyle = store.create(jobInput("legacy")).id;
      store.claimNextQueued();
    } finally {
      store.close();
    }
    try {
      await withDaemon({ home, transports: instantTransport() }, async () => {
        await until(async () => (await jobStatus(paths, orphan)) === "failed");
        const reopened = await JobStore.open(paths.dbPath);
        try {
          expect(JSON.parse(reopened.get(orphan).error ?? "{}").code).toBe("DAEMON_INTERRUPTED");
          expect(reopened.get(alive).status).toBe("running");
          expect(reopened.get(legacyStyle).status).toBe("running");
        } finally {
          reopened.close();
        }
      });
    } finally {
      await cleanup(home);
    }
  });
});

describe("runtime directory safety", () => {
  test("ignores an endpoint in a runtime directory that others can write", async () => {
    await withDaemon({ transports: instantTransport() }, async ({ paths }) => {
      const runtime = runtimeFor(paths.home);
      expect((await getDaemonStatus(paths)).state).toBe("running");
      await chmod(runtime.dir, 0o777);
      try {
        expect((await getDaemonStatus(paths)).state).toBe("stopped");
      } finally {
        await chmod(runtime.dir, 0o700);
      }
    });
  });

  test("refuses to start in a runtime directory that is a symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const target = join(home, "elsewhere");
    try {
      await mkdir(target, { mode: 0o700 });
      await symlink(target, runtimeFor(home).dir);
      const failed = await runDaemonServer(paths, { idleTimeoutMs: 1_000 }).catch((error) => error);
      expect(failed.code).toBe("DAEMON_DIR_UNSAFE");
      expect(await exists(join(target, "daemon-v2.json"))).toBe(false);
    } finally {
      await cleanup(home);
    }
  });
});

describe("retiring the legacy daemon", () => {
  test("waits for its in-flight job, stops it, and hands daemon.json to the concurrent daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const runtime = runtimeFor(home);
    const legacy = await startFakeLegacyDaemon(home);
    try {
      const store = await JobStore.open(paths.dbPath);
      const inFlight = store.create(jobInput("legacy job")).id;
      store.claimNextQueued();
      store.close();

      await withDaemon({ home, transports: instantTransport() }, async () => {
        expect((await getDaemonStatus(paths)).legacy).toMatchObject({ state: "running", pid: legacy.pid });
        const busy = await stopLegacyDaemon(paths, { timeoutMs: 300, pollMs: 25 }).catch((error) => error);
        expect(busy.code).toBe("LEGACY_DAEMON_BUSY");
        expect(busy.details.runningJobIds).toEqual([inFlight]);

        const finishing = await JobStore.open(paths.dbPath);
        finishing.markSucceeded(inFlight, "done by legacy");
        finishing.close();

        const result = await stopLegacyDaemon(paths, { pollMs: 25 });
        expect(result).toMatchObject({ stopped: true, pid: legacy.pid, requeued: [] });
        expect(isAlive(legacy.pid)).toBe(false);
        const handedOver = await readEndpointFile(runtime.legacyEndpointPath);
        expect(handedOver.protocol).toBe(2);
        expect(handedOver.token).toBe((await readEndpointFile(runtime.endpointPath)).token);
        expect(await jobStatus(paths, inFlight)).toBe("succeeded");
      });
    } finally {
      legacy.kill();
      await cleanup(home);
    }
  });

  test("--force stops it at once and puts its in-flight job back in the queue", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const legacy = await startFakeLegacyDaemon(home);
    try {
      const store = await JobStore.open(paths.dbPath);
      const inFlight = store.create(jobInput("cut off")).id;
      store.claimNextQueued();
      store.close();

      const result = await stopLegacyDaemon(paths, { force: true });
      expect(result).toMatchObject({ stopped: true, pid: legacy.pid, requeued: [inFlight] });
      expect(await jobStatus(paths, inFlight)).toBe("queued");
      expect((await stopLegacyDaemon(paths)).stopped).toBe(false);
    } finally {
      legacy.kill();
      await cleanup(home);
    }
  });
});

interface Runtime {
  dir: string;
  endpointPath: string;
  legacyEndpointPath: string;
}

function runtimeFor(home: string): Runtime {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 12);
  const dir = join("/tmp", `pro-cli-${uid}-${hash}`);
  return { dir, endpointPath: join(dir, "daemon-v2.json"), legacyEndpointPath: join(dir, "daemon.json") };
}

async function withDaemon(
  options: { home?: string; concurrency?: number; transports?: ExecutorTransports },
  fn: (context: { home: string; paths: RuntimePaths }) => Promise<void>,
): Promise<void> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "pro-daemon-test-")));
  const paths = resolvePaths({ PRO_CLI_HOME: home });
  const serving = runDaemonServer(paths, {
    idleTimeoutMs: 60_000,
    pollMs: 25,
    concurrency: options.concurrency,
    transports: options.transports,
  });
  try {
    await waitForRunningDaemon(paths);
    await fn({ home, paths });
  } finally {
    await stopDaemon(paths, { force: true }).catch(() => undefined);
    await serving.catch(() => undefined);
    if (!options.home) await cleanup(home);
  }
}

function gatedTransport() {
  const started: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    started,
    release: () => open(),
    transports: {
      runJob: async (job: JobRecord) => {
        started.push(job.id);
        await gate;
        return `answer ${job.prompt}`;
      },
    } satisfies ExecutorTransports,
  };
}

function instantTransport(): ExecutorTransports {
  return { runJob: async (job: JobRecord) => `answer ${job.prompt}` };
}

function jobInput(prompt: string) {
  return { prompt, model: "gpt-5-5-pro", reasoning: "standard", options: {} };
}

function legacyEndpoint(home: string, pid: number, port: number, token: string): DaemonEndpoint {
  const now = new Date().toISOString();
  return { version: 1, pid, port, token, home, startedAt: now, updatedAt: now, logPath: "/dev/null" };
}

// Stand-in for the pre-concurrency daemon: same endpoint file and /health + /shutdown routes, no protocol field.
async function startFakeLegacyDaemon(home: string): Promise<{ pid: number; kill: () => void }> {
  const runtime = runtimeFor(home);
  await mkdir(runtime.dir, { recursive: true, mode: 0o700 });
  const script = join(home, "fake-legacy-daemon.ts");
  await writeFile(
    script,
    `const [home, endpointPath] = process.argv.slice(2);
const token = "legacy-token";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer " + token) return new Response("unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true, data: { state: "running", pid: process.pid, home } });
    if (path === "/shutdown") {
      setTimeout(() => process.exit(0), 50);
      return Response.json({ ok: true, data: { state: "stopping" } });
    }
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: path, suggestions: [] } }, { status: 404 });
  },
});
const now = new Date().toISOString();
await Bun.write(endpointPath, JSON.stringify({ version: 1, pid: process.pid, port: server.port, token, home, startedAt: now, updatedAt: now, logPath: "/dev/null" }));
`,
  );
  const child = spawn(process.execPath, [script, home, runtime.legacyEndpointPath], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await until(
    async () => (await exists(runtime.legacyEndpointPath)) && (await readEndpointFile(runtime.legacyEndpointPath)).pid === pid,
  );
  return {
    pid,
    kill: () => {
      if (isAlive(pid)) process.kill(pid);
    },
  };
}

async function clientFor(endpointPath: string): Promise<DaemonClient> {
  return new DaemonClient(await readEndpointFile(endpointPath));
}

async function readEndpointFile(path: string): Promise<DaemonEndpoint> {
  return JSON.parse(await readFile(path, "utf8")) as DaemonEndpoint;
}

async function jobStatus(paths: RuntimePaths, id: string): Promise<string> {
  const store = await JobStore.open(paths.dbPath);
  try {
    return store.get(id).status;
  } finally {
    store.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not met in time");
}

async function cleanup(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
  await rm(runtimeFor(home).dir, { recursive: true, force: true });
}

async function waitForRunningDaemon(paths: ReturnType<typeof resolvePaths>) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(paths);
    if (status.state === "running") return status;
    await Bun.sleep(25);
  }
  return getDaemonStatus(paths);
}
