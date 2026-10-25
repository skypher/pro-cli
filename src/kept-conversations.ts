import { evaluateInCdpPage } from "./cdp";
import type { JobStore, KeptConversationRecord } from "./jobs";
import {
  appendConversationRecord,
  conversationReadPauseMs,
  DEFAULT_CDP_BASE,
  deleteSavedConversation,
  formatAnswerCitations,
  pauseConversationReads,
  readStoredAnswer,
  storedSources,
  type ConversationAnswerFetchResult,
  type PageEvaluator,
} from "./transport";

/** A kept chat is deleted after this long, whether or not its answer turned up. */
export const KEPT_CONVERSATION_MAX_AGE_MS = 6 * 60 * 60_000;
/** The wait before the first look at a kept chat, and between looks while its answer is pending. */
export const KEPT_CONVERSATION_CHECK_MS = 10 * 60_000;

export interface KeptConversationSweepOptions {
  evaluate?: PageEvaluator;
  diagnosticsDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  checkMs?: number;
  /** Checked before each chat; false stops the sweep (the daemon is draining). */
  shouldContinue?: () => boolean;
}

/**
 * Settles the chats that --delete-conversation jobs kept because they failed or could not check
 * their answer. A stored answer that has turned up goes into the job first: a failed job becomes
 * succeeded with it, and an unchecked answer that differs is replaced (recovered-answers.jsonl).
 * Only then is the chat deleted. A chat whose answer is empty, or that is older than the maximum
 * age, is deleted as it is; a pending or unreadable one is looked at again later.
 */
export async function sweepKeptConversations(store: JobStore, options: KeptConversationSweepOptions = {}): Promise<void> {
  const context = {
    evaluate: options.evaluate ?? evaluateInCdpPage,
    diagnosticsDir: options.diagnosticsDir,
    now: options.now ?? Date.now,
    maxAgeMs: options.maxAgeMs ?? KEPT_CONVERSATION_MAX_AGE_MS,
    checkMs: options.checkMs ?? KEPT_CONVERSATION_CHECK_MS,
  };
  for (const kept of store.dueKeptConversations(new Date(context.now()).toISOString())) {
    if (options.shouldContinue && !options.shouldContinue()) return;
    await settleKeptConversation(store, kept, context);
  }
}

async function settleKeptConversation(
  store: JobStore,
  kept: KeptConversationRecord,
  context: Required<Omit<KeptConversationSweepOptions, "diagnosticsDir" | "shouldContinue">> & { diagnosticsDir?: string },
): Promise<void> {
  const cdpBase = kept.cdpBase ?? DEFAULT_CDP_BASE;
  const expired = context.now() - Date.parse(kept.keptAt) >= context.maxAgeMs;
  const lookAgain = (): void => {
    const waitMs = Math.max(context.checkMs, conversationReadPauseMs(context.evaluate, cdpBase));
    store.rescheduleKeptConversation(kept.conversationId, new Date(context.now() + waitMs).toISOString());
  };
  let job: ReturnType<JobStore["get"]> | null = null;
  try {
    job = store.get(kept.jobId);
  } catch {
    // the job is gone; its chat is still settled
  }
  // A job still running reads its answer from this chat itself (an answer task); deleting the chat
  // now would lose it.
  if (job?.status === "running" && !expired) {
    lookAgain();
    return;
  }

  let answer: ConversationAnswerFetchResult | null = null;
  if (conversationReadPauseMs(context.evaluate, cdpBase) === 0) {
    answer = await readStoredAnswer(kept.conversationId, context.evaluate, cdpBase).catch(() => null);
  }
  if (answer && !answer.ok && answer.status === 404) {
    store.forgetKeptConversation(kept.conversationId);
    return;
  }
  if (answer && !answer.ok && answer.status === 429) {
    pauseConversationReads(context.evaluate, cdpBase, answer.retryAfterMs ?? context.checkMs);
  }
  const stored = answer?.ok === true && answer.state === "done" && answer.text ? answer.text : null;
  // The job's answer had its citations formatted; the stored copy gets the same before comparing.
  const found = stored === null
    ? null
    : await formatAnswerCitations(kept.jobId, job?.options.citations, stored, () => storedSources(answer?.sources), context.diagnosticsDir);
  const noAnswer = answer?.ok === true && (answer.state === "empty" || answer.state === "incomplete");
  if (found) {
    if (store.recordRecoveredAnswer(kept.jobId, found, kept.reason)) {
      await appendConversationRecord(context.diagnosticsDir, "recovered-answers.jsonl", kept.jobId, kept.conversationId, {
        reason: kept.reason,
        chars: found.length,
      });
    }
  } else if (!noAnswer && !expired) {
    lookAgain();
    return;
  }

  const deleted = await deleteSavedConversation(kept.conversationId, context.evaluate, cdpBase).catch(() => null);
  if (deleted?.ok || deleted?.status === 404) {
    store.forgetKeptConversation(kept.conversationId);
    if (deleted.ok) {
      await appendConversationRecord(context.diagnosticsDir, "deleted-conversations.jsonl", kept.jobId, kept.conversationId);
    }
    return;
  }
  lookAgain();
}
