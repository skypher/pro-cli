import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/jobs";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function withStoredAnswer(answer: string, run: (home: string, id: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pro-cli-output-test-"));
  try {
    const store = await JobStore.open(join(home, "jobs.sqlite"));
    let id: string;
    try {
      ({ id } = store.create({ prompt: "question", model: "gpt-6-pro", reasoning: "standard", options: {} }));
      store.markRunning(id);
      store.markSucceeded(id, answer);
    } finally {
      store.close();
    }
    await run(home, id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("cli output", () => {
  test("a reader slower than pro-cli still gets all of a large answer", async () => {
    const answer = "word ".repeat(100_000);
    await withStoredAnswer(answer, async (home, id) => {
      const child = Bun.spawn([process.execPath, CLI, "job", "result", id, "--json"], {
        env: { ...process.env, PRO_CLI_HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      // Start reading late, like a busy reader: pro-cli has filled the pipe by then, and
      // exiting without waiting would drop everything past the first 64 KiB.
      await Bun.sleep(1000);
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(stdout.length).toBeGreaterThan(500_000);
      expect(JSON.parse(stdout).data.result).toBe(answer);
    });
  });

  test("a reader behind a pipe gets a 150 KB answer once, not its first 64 KiB twice", async () => {
    // Bun.spawn gives the child a socket; sshd and shell pipelines give it a pipe, where Bun
    // 1.4.4's Bun.write sent the first 64 KiB of a 64-270 KiB output twice.
    const answer = "word ".repeat(30_000);
    await withStoredAnswer(answer, async (home, id) => {
      const child = Bun.spawn(
        ["sh", "-c", '{ "$0" "$@"; echo "exit $?" >&2; } | { sleep 0.5; cat; }', process.execPath, CLI, "job", "result", id, "--json"],
        { env: { ...process.env, PRO_CLI_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("exit 0\n");
      expect(JSON.parse(stdout).data.result).toBe(answer);
    });
  });
});
