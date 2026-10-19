import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/jobs";

describe("cli output", () => {
  test("a reader slower than pro-cli still gets all of a large answer", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-cli-output-test-"));
    try {
      const answer = "word ".repeat(100_000);
      const store = await JobStore.open(join(home, "jobs.sqlite"));
      let id: string;
      try {
        ({ id } = store.create({ prompt: "question", model: "gpt-6-pro", reasoning: "standard", options: {} }));
        store.markRunning(id);
        store.markSucceeded(id, answer);
      } finally {
        store.close();
      }
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "job", "result", id, "--json"], {
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
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
