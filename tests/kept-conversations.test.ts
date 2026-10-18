import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import { JobStore, type KeptConversationReason } from "../src/jobs";
import { sweepKeptConversations } from "../src/kept-conversations";
import { conversationReadPauseMs, DEFAULT_CDP_BASE, type PageEvaluator } from "../src/transport";

async function withStore<T>(fn: (store: JobStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-kept-test-"));
  const store = await JobStore.open(join(dir, "jobs.sqlite"));
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function finishedJob(store: JobStore, outcome: { result: string } | "failed"): string {
  const { id } = store.create({ prompt: "question", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
  store.markRunning(id);
  if (outcome === "failed") store.markFailed(id, new ProError("STREAM_INCOMPLETE", "cut off"));
  else store.markSucceeded(id, outcome.result);
  return id;
}

function keep(store: JobStore, jobId: string, reason: KeptConversationReason, conversationId = "conv_kept"): void {
  store.keepConversation({ conversationId, jobId, reason }, 0);
}

// Answers stored-answer reads with `answers` in turn (repeating the last) and chat deletions
// with `patch`; records the calls.
function fakeBrowser(answers: unknown[], patch: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: string[] = [];
  let reads = 0;
  const evaluate = (async <T>(_base: string, script: string): Promise<T> => {
    const conversation = /"(conv_[a-z]+)"/.exec(script)?.[1] ?? "?";
    if (script.includes("is_visible")) {
      calls.push(`delete ${conversation}`);
      return patch as T;
    }
    calls.push(`read ${conversation}`);
    reads += 1;
    return answers[Math.min(reads, answers.length) - 1] as T;
  }) as PageEvaluator;
  return { evaluate, calls };
}

const done = (text: string) => ({ ok: true, status: 200, state: "done", text, message: null });
const pending = { ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" };

describe("kept chats", () => {
  test("puts a failed job's answer into the job, then deletes the chat", async () => {
    await withStore(async (store, dir) => {
      const jobId = finishedJob(store, "failed");
      keep(store, jobId, "failed");
      const browser = fakeBrowser([done("Recovered answer")]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate, diagnosticsDir: dir });

      expect(browser.calls).toEqual(["read conv_kept", "delete conv_kept"]);
      const job = store.get(jobId);
      expect(job.status).toBe("succeeded");
      expect(job.result).toBe("Recovered answer");
      expect(job.error).toBeNull();
      expect(store.keptConversations()).toEqual([]);
      const recovered = await readFile(join(dir, "recovered-answers.jsonl"), "utf8");
      expect(JSON.parse(recovered.trim())).toMatchObject({ jobId, conversationId: "conv_kept", reason: "failed", chars: 16 });
      expect(recovered).not.toContain("Recovered answer");
      const deleted = await readFile(join(dir, "deleted-conversations.jsonl"), "utf8");
      expect(JSON.parse(deleted.trim())).toMatchObject({ jobId, conversationId: "conv_kept" });
    });
  });

  test("replaces an unchecked answer that differs from the stored one and keeps one that matches", async () => {
    await withStore(async (store, dir) => {
      const differs = finishedJob(store, { result: "Note text. The answer." });
      const matches = finishedJob(store, { result: "The answer." });
      keep(store, differs, "unverified", "conv_differs");
      keep(store, matches, "unverified", "conv_matches");
      const browser = fakeBrowser([done("The answer.")]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate, diagnosticsDir: dir });

      expect(store.get(differs).result).toBe("The answer.");
      expect(store.get(matches).result).toBe("The answer.");
      expect(browser.calls.filter((call) => call.startsWith("delete"))).toHaveLength(2);
      const recovered = (await readFile(join(dir, "recovered-answers.jsonl"), "utf8")).trim().split("\n");
      expect(recovered.map((line) => JSON.parse(line).jobId)).toEqual([differs]);
    });
  });

  test("does not overwrite a job that a retry has since finished", async () => {
    await withStore(async (store) => {
      const jobId = finishedJob(store, { result: "Answer from the retry." });
      keep(store, jobId, "failed");
      const browser = fakeBrowser([done("Answer from the first try.")]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate });

      expect(store.get(jobId).result).toBe("Answer from the retry.");
      expect(browser.calls).toEqual(["read conv_kept", "delete conv_kept"]);
    });
  });

  test("looks again later while the answer is pending, and deletes the chat once it is too old", async () => {
    await withStore(async (store) => {
      const jobId = finishedJob(store, "failed");
      keep(store, jobId, "failed");
      const browser = fakeBrowser([pending]);
      let now = Date.now();

      await sweepKeptConversations(store, { evaluate: browser.evaluate, now: () => now, checkMs: 60_000, maxAgeMs: 3_600_000 });

      expect(browser.calls).toEqual(["read conv_kept"]);
      const [kept] = store.keptConversations();
      expect(Date.parse(kept.nextCheckAt) - now).toBe(60_000);
      expect(kept.checks).toBe(1);

      now += 3_600_000;
      await sweepKeptConversations(store, { evaluate: browser.evaluate, now: () => now, checkMs: 60_000, maxAgeMs: 3_600_000 });

      expect(browser.calls).toEqual(["read conv_kept", "read conv_kept", "delete conv_kept"]);
      expect(store.get(jobId).status).toBe("failed");
      expect(store.keptConversations()).toEqual([]);
    });
  });

  test("deletes a chat whose stored answer is empty", async () => {
    await withStore(async (store) => {
      const jobId = finishedJob(store, "failed");
      keep(store, jobId, "failed");
      const browser = fakeBrowser([{ ok: true, status: 200, state: "empty", text: null, message: null }]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate });

      expect(browser.calls).toEqual(["read conv_kept", "delete conv_kept"]);
      expect(store.get(jobId).status).toBe("failed");
      expect(store.keptConversations()).toEqual([]);
    });
  });

  test("forgets a chat that no longer exists", async () => {
    await withStore(async (store) => {
      keep(store, finishedJob(store, "failed"), "failed");
      const browser = fakeBrowser([{ ok: false, status: 404, state: "pending", text: null, message: null }]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate });

      expect(browser.calls).toEqual(["read conv_kept"]);
      expect(store.keptConversations()).toEqual([]);
    });
  });

  test("a rate-limited read holds back the other kept chats until its Retry-After", async () => {
    await withStore(async (store) => {
      keep(store, finishedJob(store, "failed"), "failed", "conv_first");
      keep(store, finishedJob(store, "failed"), "failed", "conv_second");
      const browser = fakeBrowser([{ ok: false, status: 429, state: "pending", text: null, message: null, retryAfterMs: 1_800_000 }]);
      const now = Date.now();

      await sweepKeptConversations(store, { evaluate: browser.evaluate, now: () => now, checkMs: 60_000 });

      expect(browser.calls).toEqual(["read conv_first"]);
      expect(conversationReadPauseMs(browser.evaluate, DEFAULT_CDP_BASE)).toBeGreaterThan(1_700_000);
      for (const kept of store.keptConversations()) {
        expect(Date.parse(kept.nextCheckAt) - now).toBeGreaterThan(1_700_000);
      }
    });
  });

  test("keeps the chat on the list when deleting it fails, and settles it on a later look", async () => {
    await withStore(async (store) => {
      const jobId = finishedJob(store, "failed");
      keep(store, jobId, "failed");
      const failing = fakeBrowser([done("Recovered answer")], { ok: false, status: 500 });
      let now = Date.now();

      await sweepKeptConversations(store, { evaluate: failing.evaluate, now: () => now, checkMs: 60_000 });

      expect(store.get(jobId).result).toBe("Recovered answer");
      expect(store.keptConversations()).toHaveLength(1);

      now += 60_000;
      const working = fakeBrowser([done("Recovered answer")]);
      await sweepKeptConversations(store, { evaluate: working.evaluate, now: () => now, checkMs: 60_000 });

      expect(working.calls).toEqual(["read conv_kept", "delete conv_kept"]);
      expect(store.keptConversations()).toEqual([]);
    });
  });

  test("leaves chats alone until they are due", async () => {
    await withStore(async (store) => {
      store.keepConversation({ conversationId: "conv_later", jobId: finishedJob(store, "failed"), reason: "failed" }, 60_000);
      const browser = fakeBrowser([done("Recovered answer")]);

      await sweepKeptConversations(store, { evaluate: browser.evaluate });

      expect(browser.calls).toEqual([]);
      expect(store.keptConversations()).toHaveLength(1);
    });
  });
});
