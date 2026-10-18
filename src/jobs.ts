import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { EXIT, ProError } from "./errors";
import { ensurePrivateDir } from "./config";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface CreateJobInput {
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LimitsObservation {
  feature_name: string;
  remaining: number;
  reset_after: string | null;
}

export interface LimitsSnapshot {
  featureName: string;
  remaining: number;
  resetAfter: string | null;
  observedAt: string;
  jobId: string | null;
}

export interface ResearchTaskInput {
  taskId: string;
  title?: string;
  conversationId?: string;
}

export interface ResearchTaskRecord extends ResearchTaskInput {
  jobId: string;
  status: string;
  lastError: string | null;
  nextPollAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a --delete-conversation job kept its chat: it failed, or its answer could not be checked. */
export type KeptConversationReason = "failed" | "unverified";

export interface KeptConversationInput {
  conversationId: string;
  jobId: string;
  reason: KeptConversationReason;
  cdpBase?: string | null;
}

export interface KeptConversationRecord extends KeptConversationInput {
  cdpBase: string | null;
  keptAt: string;
  nextCheckAt: string;
  checks: number;
}

export interface ClaimOptions {
  /** Recorded in jobs.claimed_by so other daemons can tell whose running job this is. */
  owner?: string;
  /** Job ids already executing in this daemon; never handed out twice. */
  exclude?: ReadonlySet<string>;
  /** Fence resumed research tasks with next_poll_at = now + leaseMs so other daemons skip them. */
  leaseMs?: number;
  /** A live legacy daemon owns research tasks whose next_poll_at is NULL (its in-flight marker). */
  legacyAlive?: boolean;
}

export interface RunningClaim {
  id: string;
  claimedBy: string | null;
  hasResearchTask: boolean;
  nextPollAt: string | null;
}

interface JobRow {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options_json: string;
  result: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface KeptConversationRow {
  conversation_id: string;
  job_id: string;
  reason: KeptConversationReason;
  cdp_base: string | null;
  kept_at: string;
  next_check_at: string;
  checks: number;
}

interface ResearchTaskRow {
  job_id: string;
  task_id: string;
  title: string | null;
  conversation_id: string | null;
  status: string;
  last_error_json: string | null;
  next_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export class JobStore {
  private constructor(private readonly db: Database) {}

  static async open(path: string): Promise<JobStore> {
    await ensurePrivateDir(dirname(path));
    const db = new Database(path, { create: true });
    // Daemons and CLI processes share this file; wait out short write locks instead of failing.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        options_json TEXT NOT NULL,
        result TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS limits_observations (
        feature_name TEXT NOT NULL,
        remaining REAL NOT NULL,
        reset_after TEXT,
        observed_at TEXT NOT NULL,
        job_id TEXT,
        PRIMARY KEY (feature_name, observed_at)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS research_tasks (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        title TEXT,
        conversation_id TEXT,
        status TEXT NOT NULL,
        last_error_json TEXT,
        next_poll_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS research_tasks_next_poll_idx
      ON research_tasks(next_poll_at)
    `);
    // No foreign key: one-off `ask` jobs keep chats too and have no jobs row.
    db.run(`
      CREATE TABLE IF NOT EXISTS kept_conversations (
        conversation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        cdp_base TEXT,
        kept_at TEXT NOT NULL,
        next_check_at TEXT NOT NULL,
        checks INTEGER NOT NULL DEFAULT 0
      )
    `);
    addColumnIfMissing(db, "jobs", "claimed_by", "TEXT");
    return new JobStore(db);
  }

  create(input: CreateJobInput): ReturnType<typeof redactJob> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: `job_${randomUUID()}`,
      status: "queued",
      prompt: input.prompt,
      model: input.model,
      reasoning: input.reasoning,
      options: input.options,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO jobs
          (id, status, prompt, model, reasoning, options_json, result, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.status,
        job.prompt,
        job.model,
        job.reasoning,
        JSON.stringify(job.options),
        job.result,
        job.error,
        job.createdAt,
        job.updatedAt,
      );
    return redactJob(job);
  }

  get(id: string): JobRecord {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    if (!row) {
      throw new ProError("JOB_NOT_FOUND", `No job exists for ${id}.`, {
        exitCode: EXIT.notFound,
        suggestions: ["Run pro-cli job list --json to list recent jobs."],
      });
    }
    return rowToJob(row);
  }

  list(limit: number): JobRecord[] {
    const rows = this.db
      .query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(rowToJob).map(redactJob);
  }

  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return redactJob(job);
    }
    this.update(id, {
      status: "cancelled",
      error: JSON.stringify({
        code: "CANCELLED",
        message: "Job was cancelled before completion.",
      }),
    });
    return redactJob(this.get(id));
  }

  markRunning(id: string): JobRecord {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run("running", now, id, "queued");
    return this.get(id);
  }

  claimQueued(id: string, owner?: string): JobRecord | null {
    const now = new Date().toISOString();
    const result = this.db
      .query("UPDATE jobs SET status = ?, claimed_by = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run("running", owner ?? null, now, id, "queued") as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(id) : null;
  }

  claimNextQueued(owner?: string): JobRecord | null {
    const now = new Date().toISOString();
    const row = this.db
      .query(
        `UPDATE jobs SET status = ?, claimed_by = ?, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1) AND status = ?
         RETURNING id`,
      )
      .get("running", owner ?? null, now, "queued", "queued") as { id: string } | null;
    return row ? this.get(row.id) : null;
  }

  claimNextRunnable(options: ClaimOptions = {}): JobRecord | null {
    const queued = this.claimNextQueued(options.owner);
    if (queued) return queued;

    const now = new Date();
    const nowIso = now.toISOString();
    const nullIsFree = options.legacyAlive ? 0 : 1;
    const candidates = this.db
      .query(
        `SELECT jobs.id
         FROM jobs
         INNER JOIN research_tasks ON research_tasks.job_id = jobs.id
         WHERE jobs.status = ?
           AND (research_tasks.next_poll_at <= ? OR (research_tasks.next_poll_at IS NULL AND ? = 1))
         ORDER BY COALESCE(research_tasks.next_poll_at, jobs.updated_at) ASC, jobs.created_at ASC
         LIMIT 50`,
      )
      .all("running", nowIso, nullIsFree) as Array<{ id: string }>;
    for (const candidate of candidates) {
      if (options.exclude?.has(candidate.id)) continue;
      if (options.leaseMs === undefined) return this.get(candidate.id);
      const leaseUntil = new Date(now.getTime() + options.leaseMs).toISOString();
      const leased = this.db
        .query(
          `UPDATE research_tasks SET next_poll_at = ?, updated_at = ?
           WHERE job_id = ? AND (next_poll_at <= ? OR (next_poll_at IS NULL AND ? = 1))`,
        )
        .run(leaseUntil, nowIso, candidate.id, nowIso, nullIsFree) as { changes?: number };
      if (!leased.changes) continue;
      this.db.query("UPDATE jobs SET claimed_by = ? WHERE id = ?").run(options.owner ?? null, candidate.id);
      return this.get(candidate.id);
    }
    return null;
  }

  /** Extend the research-task fence for jobs this daemon is still executing. */
  renewResearchLeases(jobIds: Iterable<string>, leaseUntil: string): void {
    const renew = this.db.query("UPDATE research_tasks SET next_poll_at = ? WHERE job_id = ?");
    for (const id of jobIds) renew.run(leaseUntil, id);
  }

  runningClaims(): RunningClaim[] {
    const rows = this.db
      .query(
        `SELECT jobs.id AS id, jobs.claimed_by AS claimed_by,
                research_tasks.job_id IS NOT NULL AS has_task, research_tasks.next_poll_at AS next_poll_at
         FROM jobs LEFT JOIN research_tasks ON research_tasks.job_id = jobs.id
         WHERE jobs.status = ?`,
      )
      .all("running") as Array<{ id: string; claimed_by: string | null; has_task: number; next_poll_at: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      claimedBy: row.claimed_by,
      hasResearchTask: row.has_task === 1,
      nextPollAt: row.next_poll_at,
    }));
  }

  /** Hand a running job back to the queue after the daemon running it exited mid-run. */
  requeueRunning(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .query("UPDATE jobs SET status = ?, claimed_by = NULL, updated_at = ? WHERE id = ? AND status = ?")
      .run("queued", now, id, "running") as { changes?: number };
    return Boolean(result.changes);
  }

  countQueued(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE status = ?").get("queued") as { n: number };
    return row.n;
  }

  markSucceeded(id: string, result: string): JobRecord {
    this.finishRunning(id, { status: "succeeded", result, error: null });
    return this.get(id);
  }

  markFailed(id: string, error: ProError): JobRecord {
    this.finishRunning(id, {
      status: "failed",
      error: JSON.stringify(error.toPayload()),
    });
    return this.get(id);
  }

  recordLimits(observations: LimitsObservation[], jobId: string | null): void {
    if (observations.length === 0) return;
    const observedAt = new Date().toISOString();
    const insert = this.db.query(
      `INSERT OR REPLACE INTO limits_observations
        (feature_name, remaining, reset_after, observed_at, job_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const observation of observations) {
      insert.run(
        observation.feature_name,
        observation.remaining,
        observation.reset_after ?? null,
        observedAt,
        jobId,
      );
    }
  }

  latestLimits(): LimitsSnapshot[] {
    const rows = this.db
      .query(
        `SELECT feature_name, remaining, reset_after, observed_at, job_id
         FROM limits_observations
         WHERE (feature_name, observed_at) IN (
           SELECT feature_name, MAX(observed_at) FROM limits_observations GROUP BY feature_name
         )
         ORDER BY feature_name ASC`,
      )
      .all() as Array<{
        feature_name: string;
        remaining: number;
        reset_after: string | null;
        observed_at: string;
        job_id: string | null;
      }>;
    return rows.map((row) => ({
      featureName: row.feature_name,
      remaining: row.remaining,
      resetAfter: row.reset_after,
      observedAt: row.observed_at,
      jobId: row.job_id,
    }));
  }

  upsertResearchTask(jobId: string, task: ResearchTaskInput, leaseUntil: string | null = null): ResearchTaskRecord {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO research_tasks
          (job_id, task_id, title, conversation_id, status, last_error_json, next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
          task_id = excluded.task_id,
          title = excluded.title,
          conversation_id = excluded.conversation_id,
          status = excluded.status,
          last_error_json = NULL,
          next_poll_at = excluded.next_poll_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        jobId,
        task.taskId,
        task.title ?? null,
        task.conversationId ?? null,
        "running",
        null,
        leaseUntil,
        now,
        now,
      );
    return this.getResearchTask(jobId) as ResearchTaskRecord;
  }

  getResearchTask(jobId: string): ResearchTaskRecord | null {
    const row = this.db
      .query("SELECT * FROM research_tasks WHERE job_id = ?")
      .get(jobId) as ResearchTaskRow | null;
    return row ? rowToResearchTask(row) : null;
  }

  updateResearchTaskStatus(jobId: string, status: string, leaseUntil: string | null = null): ResearchTaskRecord | null {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE research_tasks
         SET status = ?, last_error_json = NULL, next_poll_at = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(status, leaseUntil, now, jobId);
    return this.getResearchTask(jobId);
  }

  deferResearchTask(jobId: string, error: ProError, delayMs: number): ResearchTaskRecord | null {
    const now = new Date();
    const nextPollAt = new Date(now.getTime() + delayMs).toISOString();
    this.db
      .query(
        `UPDATE research_tasks
         SET status = ?, last_error_json = ?, next_poll_at = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run("deferred", JSON.stringify(error.toPayload()), nextPollAt, now.toISOString(), jobId);
    return this.getResearchTask(jobId);
  }

  keepConversation(input: KeptConversationInput, checkAfterMs: number): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT OR REPLACE INTO kept_conversations
          (conversation_id, job_id, reason, cdp_base, kept_at, next_check_at, checks)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.conversationId,
        input.jobId,
        input.reason,
        input.cdpBase ?? null,
        new Date(now).toISOString(),
        new Date(now + checkAfterMs).toISOString(),
      );
  }

  keptConversations(): KeptConversationRecord[] {
    const rows = this.db.query("SELECT * FROM kept_conversations ORDER BY kept_at").all() as KeptConversationRow[];
    return rows.map(rowToKeptConversation);
  }

  dueKeptConversations(now: string, limit = 20): KeptConversationRecord[] {
    const rows = this.db
      .query("SELECT * FROM kept_conversations WHERE next_check_at <= ? ORDER BY next_check_at LIMIT ?")
      .all(now, limit) as KeptConversationRow[];
    return rows.map(rowToKeptConversation);
  }

  rescheduleKeptConversation(conversationId: string, nextCheckAt: string): void {
    this.db
      .query("UPDATE kept_conversations SET next_check_at = ?, checks = checks + 1 WHERE conversation_id = ?")
      .run(nextCheckAt, conversationId);
  }

  forgetKeptConversation(conversationId: string): void {
    this.db.query("DELETE FROM kept_conversations WHERE conversation_id = ?").run(conversationId);
  }

  /**
   * Stores an answer found later in a kept chat. A failed job becomes succeeded with it; a job
   * that succeeded with an unchecked streamed answer gets the stored one if they differ. Returns
   * whether the job changed.
   */
  recordRecoveredAnswer(jobId: string, result: string, reason: KeptConversationReason): boolean {
    const now = new Date().toISOString();
    const changed = reason === "failed"
      ? this.db
        .query("UPDATE jobs SET status = ?, result = ?, error_json = NULL, updated_at = ? WHERE id = ? AND status = ?")
        .run("succeeded", result, now, jobId, "failed")
      : this.db
        .query("UPDATE jobs SET result = ?, updated_at = ? WHERE id = ? AND status = ? AND result IS NOT ?")
        .run(result, now, jobId, "succeeded", result);
    return changed.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private update(
    id: string,
    patch: { status?: JobStatus; result?: string | null; error?: string | null },
  ): void {
    const job = this.get(id);
    const next = {
      status: patch.status ?? job.status,
      result: patch.result === undefined ? job.result : patch.result,
      error: patch.error === undefined ? job.error : patch.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .query("UPDATE jobs SET status = ?, result = ?, error_json = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.result, next.error, next.updatedAt, id);
  }

  private finishRunning(
    id: string,
    patch: { status: "succeeded" | "failed"; result?: string | null; error?: string | null },
  ): void {
    const job = this.get(id);
    const next = {
      status: patch.status,
      result: patch.result === undefined ? job.result : patch.result,
      error: patch.error === undefined ? job.error : patch.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .query(
        "UPDATE jobs SET status = ?, result = ?, error_json = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .run(next.status, next.result, next.error, next.updatedAt, id, "running");
  }
}

export function redactJob(
  job: JobRecord,
): Omit<JobRecord, "result"> & { result: null; promptPreview: string; resultPreview?: string; hasResult: boolean } {
  return {
    ...job,
    prompt: "",
    result: null,
    promptPreview: compact(job.prompt, 160),
    ...(job.result !== null ? { resultPreview: compact(job.result, 240) } : {}),
    hasResult: job.result !== null,
  };
}

function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    // Another process may have migrated between the check and the ALTER.
    if (!String(error).includes("duplicate column")) throw error;
  }
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    model: row.model,
    reasoning: row.reasoning,
    options: JSON.parse(row.options_json) as Record<string, unknown>,
    result: row.result,
    error: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToKeptConversation(row: KeptConversationRow): KeptConversationRecord {
  return {
    conversationId: row.conversation_id,
    jobId: row.job_id,
    reason: row.reason,
    cdpBase: row.cdp_base,
    keptAt: row.kept_at,
    nextCheckAt: row.next_check_at,
    checks: row.checks,
  };
}

function rowToResearchTask(row: ResearchTaskRow): ResearchTaskRecord {
  return {
    jobId: row.job_id,
    taskId: row.task_id,
    ...(row.title ? { title: row.title } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    status: row.status,
    lastError: row.last_error_json,
    nextPollAt: row.next_poll_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compact(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
