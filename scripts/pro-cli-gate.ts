#!/usr/bin/env bun
// SSH forced-command gate: lets one authorized_keys entry run a fixed subset of
// pro-cli, confined to its own inbox directory and its own jobs.
//
// authorized_keys (absolute paths; sshd does not expand ~):
//   restrict,command="/home/<user>/.bun/bin/bun /home/<user>/.local/share/pro-cli-gate/pro-cli-gate.ts <key>" ssh-ed25519 ...
//
// Run an installed copy outside the checkout so a git pull cannot change the gate under a live key.
// It expects bun at ~/.bun/bin/bun and the checkout at ~/pro-cli; adjust the main block otherwise.
// Each <key> gets its own inbox (~/pro-cli-inbox/<key>), job list and audit log (~/.local/state/pro-cli-gate/<key>).
//
// Client verbs (SSH_ORIGINAL_COMMAND):
//   pro-cli <ask|odds|job|models|limits|daemon status> ...   output is always JSON; chat models only
//   put <name>          upload stdin into the inbox
//   ls                  list inbox files
//   rm <name>           delete an inbox file
//   help

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GateConfig {
  key: string;
  inboxRoot: string;
  stateRoot: string;
  proCli: string[];
  env: Record<string, string>;
  maxUploadBytes: number;
  maxInboxBytes: number;
  maxInboxFiles: number;
  /** pro-cli's job database, read to pause requests while ChatGPT refuses them for a usage limit. */
  jobsDb?: string;
  usageLimitPauseMs?: number;
}

export interface GateIO {
  stdin: AsyncIterable<Uint8Array>;
  stdout: (chunk: Uint8Array | string) => void | Promise<void>;
  stderr: (chunk: string) => void;
  /** Aborted once the SSH client is gone, so nothing written reaches anyone. */
  clientGone?: AbortSignal;
}

export interface ProCliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** signal, when given, stops pro-cli early. */
export type ProCliRunner = (argv: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal) => Promise<ProCliRun>;

export class GateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// Once the account's usage limit is hit, ChatGPT refuses every request (error_code usage_limit)
// without saying when the limit resets. After a refusal, new requests wait this long instead of
// each reaching ChatGPT; the first one after the pause shows whether the limit is over.
const USAGE_LIMIT_PAUSE_MS = 30 * 60_000;

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const KEY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const JOB_ID = /^(?:job|ask)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Mirrors BOOLEAN_FLAGS in src/args.ts so flag values and positionals split the same way.
const BOOLEAN_FLAGS = new Set([
  "json",
  "no-json",
  "dry-run",
  "include-expired",
  "no-start",
  "save",
  "temporary",
  "no-temporary",
  "keep-conversation",
  "delete-conversation",
  "chat-only",
  "pro-only",
  "wait",
  "help",
  "version",
  "allow-fifty",
  "no-launch",
  "no-backup",
  "force",
  "legacy",
  "github",
]);

// Gate-only flag for ask and job create. ChatGPT turns connectors off in temporary chats,
// so --github runs the request as a saved chat, puts GITHUB_PREAMBLE ahead of it, and has
// pro-cli delete the chat when the job ends. The preamble asks the model to keep the account
// owner's memory and custom instructions out of the answer; it is a request, not a guarantee.
const GITHUB_PREAMBLE =
  "This request comes from a collaborator using this account through an automated tool, not from the account owner. " +
  "Do not use, mention, or reveal anything about the account owner that comes from memory, custom instructions, or earlier chats. " +
  "Base the answer only on this request and the sources you consult for it. " +
  "If it involves a GitHub repository, read it with the GitHub connector.";

const REQUEST_FLAGS = [
  "json",
  "model",
  "reasoning",
  "verbosity",
  "reasoning-summary",
  "tool-choice",
  "parallel-tools",
  "citations",
  "timeout",
  "retries",
  "retry-delay",
  "temporary",
];
const ASK_FLAGS = new Set([
  ...REQUEST_FLAGS,
  "github",
  "instructions",
  "instructions-file",
  "condensed-response",
  "condensed_response",
  "attach",
  "schema",
  "format",
  "schema-retries",
]);
const WAIT_FLAGS = ["wait-timeout", "soft-timeout", "poll-ms"];
const JOB_CREATE_FLAGS = new Set([...ASK_FLAGS, "wait", ...WAIT_FLAGS]);
const ODDS_FLAGS = new Set([...REQUEST_FLAGS, "context", "samples", "aggregate", "parse-retries", "allow-fifty"]);

// Flags that read a local file by path rather than by @name.
const PATH_FLAGS = new Set(["attach", "instructions-file"]);

type ProCommand =
  | { kind: "ask" | "odds" | "job create"; flags: Set<string>; maxPositionals: number }
  | { kind: "job id"; flags: Set<string> }
  | { kind: "job list" | "plain"; flags: Set<string> };

function proCommandFor(command: string, subcommand: string | undefined): ProCommand | null {
  if (command === "ask") return { kind: "ask", flags: ASK_FLAGS, maxPositionals: Number.POSITIVE_INFINITY };
  if (command === "odds") return { kind: "odds", flags: ODDS_FLAGS, maxPositionals: Number.POSITIVE_INFINITY };
  if (command === "models" && subcommand === undefined) return { kind: "plain", flags: new Set(["json"]) };
  if (command === "limits" && subcommand === undefined) return { kind: "plain", flags: new Set(["json"]) };
  if (command === "daemon" && subcommand === "status") return { kind: "plain", flags: new Set(["json"]) };
  if (command !== "job") return null;
  if (subcommand === "create") return { kind: "job create", flags: JOB_CREATE_FLAGS, maxPositionals: Number.POSITIVE_INFINITY };
  if (subcommand === "status" || subcommand === "result" || subcommand === "cancel") {
    return { kind: "job id", flags: new Set(["json"]) };
  }
  if (subcommand === "wait") return { kind: "job id", flags: new Set(["json", ...WAIT_FLAGS]) };
  if (subcommand === "list") return { kind: "job list", flags: new Set(["json", "limit"]) };
  return null;
}

/**
 * Splits an SSH command line into words the way a POSIX shell would for quoted
 * literals, without performing any expansion. Anything that would make a shell
 * expand, redirect, chain, or glob is rejected instead of interpreted.
 */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let index = 0;
  const fail = (message: string): never => {
    throw new GateError("BAD_COMMAND_LINE", message);
  };
  // \x and octal escapes in $'...' are bytes. printf %q outside a UTF-8 locale writes ü as
  // $'\303\274' (bash) or $'\303'$'\274' (zsh), so a run of them is decoded as UTF-8 together.
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    try {
      word += UTF8.decode(new Uint8Array(bytes));
    } catch {
      fail("Escaped bytes in $'...' quotes are not valid UTF-8.");
    }
    bytes = [];
  };
  const add = (text: string) => {
    flushBytes();
    word += text;
  };
  const endWord = () => {
    flushBytes();
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };

  while (index < line.length) {
    const char = line[index];
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(char)) fail("Control characters are not allowed.");
    if (char === " " || char === "\t" || char === "\n") {
      endWord();
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) fail("Unterminated single quote.");
      add(line.slice(index + 1, end));
      inWord = true;
      index = end + 1;
      continue;
    }
    if (char === "$" && line[index + 1] === "'") {
      index += 2;
      for (;;) {
        if (index >= line.length) fail("Unterminated $'...' quote.");
        const c = line[index];
        if (c === "'") break;
        if (c !== "\\") {
          add(c);
          index += 1;
          continue;
        }
        const e = line[index + 1];
        const simple: Record<string, string> = {
          n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v",
          "\\": "\\", "'": "'", '"': '"', "?": "?",
        };
        if (e !== undefined && e in simple) {
          add(simple[e]);
          index += 2;
        } else if (e === "x" && /^[0-9a-fA-F]{1,2}/.test(line.slice(index + 2))) {
          const hex = line.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)![0];
          bytes.push(Number.parseInt(hex, 16));
          index += 2 + hex.length;
        } else if (e !== undefined && /[0-7]/.test(e)) {
          const oct = line.slice(index + 1).match(/^[0-7]{1,3}/)![0];
          bytes.push(Number.parseInt(oct, 8) & 0xff);
          index += 1 + oct.length;
        } else {
          fail(`Unsupported escape \\${e ?? ""} in $'...' quote.`);
        }
      }
      inWord = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      for (;;) {
        if (index >= line.length) fail("Unterminated double quote.");
        const c = line[index];
        if (c === '"') break;
        if (c === "$" || c === "`") fail("Expansion inside double quotes is not allowed.");
        if (c === "\\" && index + 1 < line.length && '$`"\\\n'.includes(line[index + 1])) {
          if (line[index + 1] !== "\n") add(line[index + 1]);
          index += 2;
          continue;
        }
        add(c);
        index += 1;
      }
      inWord = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= line.length) fail("Trailing backslash.");
      if (line[index + 1] !== "\n") add(line[index + 1]);
      inWord = true;
      index += 2;
      continue;
    }
    if (";&|<>()$`*?[]{}".includes(char)) fail(`Unquoted shell metacharacter ${JSON.stringify(char)} is not allowed.`);
    if (!inWord && (char === "#" || char === "~")) fail(`Unquoted ${JSON.stringify(char)} at word start is not allowed.`);
    add(char);
    inWord = true;
    index += 1;
  }
  endWord();
  return words;
}

export function validateFileName(name: string | undefined): string {
  if (name === undefined || !FILE_NAME.test(name)) {
    throw new GateError(
      "BAD_FILE_NAME",
      `Invalid file name ${JSON.stringify(name ?? "")}; use letters, digits, '.', '_', '-' (no '/', not starting with '.' or '-').`,
    );
  }
  return name;
}

function validateJobId(id: string | undefined): string {
  if (id === undefined || !JOB_ID.test(id)) throw new GateError("BAD_JOB_ID", `Invalid job id ${JSON.stringify(id ?? "")}.`);
  return id;
}

interface ParsedProArgs {
  positionals: string[];
  flags: Array<{ name: string; value: string | true }>;
}

function parseProArgs(argv: string[]): ParsedProArgs {
  const positionals: string[] = [];
  const flags: ParsedProArgs["flags"] = [];
  let flagsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flagsEnded || !token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      flagsEnded = true;
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags.push({ name: raw.slice(0, eq), value: raw.slice(eq + 1) });
    } else if (BOOLEAN_FLAGS.has(raw)) {
      flags.push({ name: raw, value: true });
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new GateError("BAD_ARGS", `Missing value for --${raw}.`);
      flags.push({ name: raw, value: next });
      index += 1;
    }
  }
  return { positionals, flags };
}

async function requireInboxFile(cfg: GateConfig, name: string): Promise<void> {
  validateFileName(name);
  const inbox = inboxDir(cfg);
  const path = join(inbox, name);
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile()) throw new GateError("FILE_NOT_IN_INBOX", `${name} is not a file in your inbox; upload it with put.`, 1);
  const real = await realpath(path);
  if (real !== join(await realpath(inbox), name)) throw new GateError("FILE_NOT_IN_INBOX", `${name} resolves outside your inbox.`);
}

/** Validates pro-cli argv against the allowlist; returns the argv to execute. */
export async function checkProCliArgs(
  cfg: GateConfig,
  args: string[],
): Promise<{ argv: string[]; command: ProCommand; jobId?: string; github: boolean }> {
  const [command, maybeSub] = args;
  if (!command) throw new GateError("COMMAND_DENIED", "Missing pro-cli command.");
  const subcommand = maybeSub !== undefined && !maybeSub.startsWith("--") && (command === "job" || command === "daemon") ? maybeSub : undefined;
  const spec = proCommandFor(command, subcommand);
  if (!spec) {
    throw new GateError("COMMAND_DENIED", `pro-cli ${[command, subcommand].filter(Boolean).join(" ")} is not allowed through this key.`);
  }
  const rest = args.slice(subcommand === undefined ? 1 : 2);
  const parsed = parseProArgs(rest);

  for (const flag of parsed.flags) {
    if (!spec.flags.has(flag.name)) throw new GateError("FLAG_DENIED", `--${flag.name} is not allowed for pro-cli ${command}.`);
    if (typeof flag.value !== "string") continue;
    if (PATH_FLAGS.has(flag.name)) {
      await requireInboxFile(cfg, flag.value);
    } else if (flag.value.startsWith("@") && !flag.value.includes(" ")) {
      await requireInboxFile(cfg, flag.value.slice(1));
    }
  }

  const github = parsed.flags.some((flag) => flag.name === "github");
  if (github) {
    if (parsed.flags.some((flag) => flag.name === "github" && flag.value !== true)) {
      throw new GateError("BAD_ARGS", "--github takes no value.");
    }
    if (parsed.flags.some((flag) => flag.name === "temporary")) {
      throw new GateError("BAD_ARGS", "--github runs a saved chat, because connectors are off in temporary chats; drop --temporary.");
    }
  }

  let jobId: string | undefined;
  if (spec.kind === "ask" || spec.kind === "odds" || spec.kind === "job create") {
    const prompt = parsed.positionals.join(" ").trim();
    if (prompt.startsWith("@") && !prompt.includes(" ")) await requireInboxFile(cfg, prompt.slice(1));
  } else if (spec.kind === "job id") {
    if (parsed.positionals.length !== 1) throw new GateError("BAD_ARGS", `pro-cli job ${subcommand} takes exactly one job id.`);
    jobId = validateJobId(parsed.positionals[0]);
    if (!(await ownedJobs(cfg)).has(jobId)) throw new GateError("JOB_NOT_FOUND", `No job ${jobId} for this key.`, 1);
  } else if (parsed.positionals.length > 0) {
    throw new GateError("BAD_ARGS", `Unexpected arguments for pro-cli ${command}.`);
  }

  // Rebuild argv from the parsed form so the child sees exactly what was checked.
  const argv = [command, ...(subcommand === undefined ? [] : [subcommand])];
  for (const flag of parsed.flags) {
    if (flag.name === "json" || flag.name === "github") continue;
    argv.push(flag.value === true ? `--${flag.name}` : `--${flag.name}=${flag.value}`);
  }
  if (github) argv.push("--save", "--delete-conversation", `--preamble=${GITHUB_PREAMBLE}`);
  // Only Pro chat models are offered through the gate: no cheaper models, Deep Research or images.
  if (spec.kind === "ask" || spec.kind === "odds" || spec.kind === "job create") argv.push("--chat-only", "--pro-only");
  argv.push("--json");
  if (spec.kind === "job list") {
    // Fetch the newest jobs and filter to this key afterwards.
    const limitIndex = argv.findIndex((arg) => arg.startsWith("--limit="));
    if (limitIndex >= 0) argv.splice(limitIndex, 1);
    argv.push("--limit=200");
  }
  if (parsed.positionals.length > 0) argv.push("--", ...parsed.positionals);
  return { argv, command: spec, jobId, github };
}

function inboxDir(cfg: GateConfig): string {
  return join(cfg.inboxRoot, cfg.key);
}

function stateDir(cfg: GateConfig): string {
  return join(cfg.stateRoot, cfg.key);
}

async function ownedJobs(cfg: GateConfig): Promise<Set<string>> {
  const text = await readFile(join(stateDir(cfg), "jobs"), "utf8").catch(() => "");
  return new Set(text.split("\n").filter((line) => JOB_ID.test(line)));
}

async function recordJobs(cfg: GateConfig, ids: string[]): Promise<void> {
  const valid = ids.filter((id) => JOB_ID.test(id));
  if (valid.length > 0) await appendFile(join(stateDir(cfg), "jobs"), `${valid.join("\n")}\n`, { mode: 0o600 });
}

/** Job ids pro-cli generated for this request; never taken from free text such as model output. */
function createdJobIds(output: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const data = (payload as { data?: unknown; error?: { details?: unknown } } | null) ?? {};
  const ids: string[] = [];
  const collect = (source: unknown) => {
    if (!source || typeof source !== "object") return;
    const record = source as { job?: { id?: unknown }; jobId?: unknown; jobIds?: unknown };
    if (typeof record.job?.id === "string") ids.push(record.job.id);
    if (typeof record.jobId === "string") ids.push(record.jobId);
    if (Array.isArray(record.jobIds)) ids.push(...record.jobIds.filter((id): id is string => typeof id === "string"));
  };
  collect(data.data);
  collect(data.error?.details);
  return ids;
}

async function ensureDirs(cfg: GateConfig): Promise<void> {
  for (const dir of [cfg.inboxRoot, inboxDir(cfg), cfg.stateRoot, stateDir(cfg)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stats = await lstat(dir);
    if (!stats.isDirectory()) throw new GateError("GATE_MISCONFIGURED", `${dir} is not a directory.`, 7);
  }
}

async function inboxEntries(cfg: GateConfig): Promise<Array<{ name: string; bytes: number; modifiedAt: string }>> {
  const entries = [];
  for (const name of await readdir(inboxDir(cfg))) {
    if (!FILE_NAME.test(name)) continue;
    const stats = await lstat(join(inboxDir(cfg), name)).catch(() => null);
    if (stats?.isFile()) entries.push({ name, bytes: stats.size, modifiedAt: stats.mtime.toISOString() });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function putFile(cfg: GateConfig, name: string, io: GateIO): Promise<Record<string, unknown>> {
  validateFileName(name);
  const existing = await inboxEntries(cfg);
  const others = existing.filter((entry) => entry.name !== name);
  if (others.length >= cfg.maxInboxFiles) throw new GateError("INBOX_FULL", `Inbox holds at most ${cfg.maxInboxFiles} files; rm some first.`);
  const used = others.reduce((sum, entry) => sum + entry.bytes, 0);
  const limit = Math.min(cfg.maxUploadBytes, cfg.maxInboxBytes - used);

  const tmp = join(inboxDir(cfg), `.put-${randomBytes(8).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of io.stdin) {
      bytes += chunk.length;
      if (bytes > limit) {
        throw new GateError("UPLOAD_TOO_LARGE", `Upload exceeds the ${limit}-byte limit (per-file ${cfg.maxUploadBytes}, inbox ${cfg.maxInboxBytes}).`);
      }
      await handle.write(chunk);
    }
    await handle.close();
    await rename(tmp, join(inboxDir(cfg), name));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return { name, bytes };
}

/**
 * The pause after the account's latest usage-limit refusal, if it still runs. A job on the refused
 * model, created after that refusal, that succeeds ends it early; a cheaper model working says
 * nothing about a Pro limit. A missing or unreadable database never pauses requests.
 */
export function usageLimitPause(cfg: GateConfig, now = Date.now()): { refusedAt: string; retryAfter: string } | null {
  if (!cfg.jobsDb) return null;
  let db: Database | null = null;
  try {
    db = new Database(cfg.jobsDb, { readonly: true });
    const refused = db
      .query(
        `SELECT updated_at AS at, model FROM jobs
         WHERE status = 'failed' AND json_extract(error_json, '$.details.errorCode') = 'usage_limit'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { at: string; model: string } | null;
    if (!refused) return null;
    const succeeded = db
      .query("SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded' AND model = ? AND created_at > ?")
      .get(refused.model, refused.at) as { n: number };
    if (succeeded.n > 0) return null;
    const retryAt = Date.parse(refused.at) + (cfg.usageLimitPauseMs ?? USAGE_LIMIT_PAUSE_MS);
    return retryAt > now ? { refusedAt: refused.at, retryAfter: new Date(retryAt).toISOString() } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function runProCli(
  cfg: GateConfig,
  args: string[],
  io: GateIO,
  runner: ProCliRunner,
): Promise<{ code: number; errorCode?: string; github: boolean }> {
  const checked = await checkProCliArgs(cfg, args);
  const kind = checked.command.kind;
  if (kind === "ask" || kind === "odds" || kind === "job create") {
    const pause = usageLimitPause(cfg);
    if (pause) {
      throw new GateError(
        "USAGE_LIMIT_PAUSED",
        `ChatGPT refused this account's last request at ${pause.refusedAt} because its usage limit is reached ` +
          `("You've hit your limit"). New requests are paused until ${pause.retryAfter}; nothing was sent. Retry after that.`,
        4,
        pause,
      );
    }
  }
  // Clients drop long `job wait` calls; a wait only reads, so an orphaned one stops. Requests run
  // on without the client, so their jobs are still recorded as this key's and --github chats deleted.
  const stoppable = args[0] === "job" && args[1] === "wait";
  const result = await runner([...cfg.proCli, ...checked.argv], inboxDir(cfg), cfg.env, stoppable ? io.clientGone : undefined);
  if (kind === "ask" || kind === "odds" || kind === "job create") {
    await recordJobs(cfg, [...createdJobIds(result.stdout), ...createdJobIds(result.stderr)]);
  }
  if (io.clientGone?.aborted) throw clientGoneError();
  if (kind === "job list" && result.code === 0) {
    const owned = await ownedJobs(cfg);
    const limitArg = args.find((arg, i) => args[i - 1] === "--limit") ?? args.find((arg) => arg.startsWith("--limit="))?.slice(8);
    const limit = Math.min(200, Math.max(1, Number(limitArg ?? "20") || 20));
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { jobs: Array<{ id: string }> } };
    payload.data.jobs = payload.data.jobs.filter((job) => owned.has(job.id)).slice(0, limit);
    await io.stdout(`${JSON.stringify(payload)}\n`);
  } else if (args[0] === "limits" && result.code === 0) {
    // Until requestsPausedUntil, ask, odds and job create fail here with USAGE_LIMIT_PAUSED.
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { usageLimit?: Record<string, unknown> } };
    if (payload.data.usageLimit) payload.data.usageLimit.requestsPausedUntil = usageLimitPause(cfg)?.retryAfter ?? null;
    await io.stdout(`${JSON.stringify(payload)}\n`);
  } else {
    await io.stdout(result.stdout);
  }
  if (result.stderr) io.stderr(result.stderr);
  return { code: result.code, errorCode: result.code === 0 ? undefined : errorCodeOf(result.stderr), github: checked.github };
}

/** The error code from pro-cli's JSON error line; messages can quote prompt or answer text, so they are not kept. */
function errorCodeOf(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    try {
      const code = (JSON.parse(line) as { error?: { code?: unknown } }).error?.code;
      if (typeof code === "string" && ERROR_CODE.test(code)) return code;
    } catch {
      // not a JSON line
    }
  }
  return undefined;
}

/** Command and subcommand only; prompt words never reach the audit log. */
function auditVerb(args: string[]): string {
  const [command, subcommand] = args;
  if (!command || !/^[a-z][a-z-]{0,31}$/.test(command)) return "pro-cli";
  const hasSubcommands = ["job", "daemon", "auth", "conversations", "config"].includes(command);
  return hasSubcommands && subcommand && /^[a-z][a-z-]{0,31}$/.test(subcommand) ? `pro-cli ${command} ${subcommand}` : `pro-cli ${command}`;
}

const HELP = `pro-cli gate. Commands:
  pro-cli ask|odds ...                 query ChatGPT (output is JSON)
  pro-cli job create|status|result|wait|cancel|list ...
  pro-cli models | limits | daemon status
  --github (ask, job create)           let Pro read GitHub repos through the account's GitHub
                                       connector; runs as a saved chat that is deleted afterwards
  put <name> < file                    upload into your inbox
  ls                                   list inbox files
  rm <name>                            delete an inbox file
Files for --attach, --instructions-file and @name must be uploaded with put first.
Pro chat models only: ask, odds and job create refuse other models (INVALID_ARGS);
Deep Research and image generation are not available.
When ChatGPT refuses a request because the account's usage limit is reached, ask, odds and
job create fail with USAGE_LIMIT_PAUSED for 30 minutes (until details.retryAfter) without
reaching ChatGPT.
pro-cli limits tells whether the usage limit is still in effect, without spending quota:
data.usageLimit.limited, model, since, lastRefusedAt (the last time a request found it in
effect), liftedAt, and requestsPausedUntil (null when requests are let through).
Not available: auth, update, config, setup, doctor, conversations, daemon control,
--cdp, --port, --conversation, --parent, --save, --store, --no-temporary, --keep-conversation.
`;

export async function runGate(cfg: GateConfig, commandLine: string | undefined, io: GateIO, runner: ProCliRunner): Promise<number> {
  let verb = "invalid";
  let code = 2;
  let errorCode: string | undefined;
  let internalErrno: string | undefined;
  let github = false;
  try {
    if (!KEY_NAME.test(cfg.key)) throw new GateError("GATE_MISCONFIGURED", "Invalid gate key name.", 7);
    await ensureDirs(cfg);
    if (!commandLine || !commandLine.trim()) throw new GateError("NO_COMMAND", `Interactive login is disabled.\n${HELP}`);
    const words = splitCommand(commandLine);
    verb = words[0] ?? "";
    const argsOf = (count: number) => {
      if (words.length - 1 !== count) throw new GateError("BAD_ARGS", `${verb} takes ${count} argument(s).`);
      return words.slice(1);
    };
    switch (verb) {
      case "help":
        await io.stdout(HELP);
        code = 0;
        break;
      case "pro-cli":
        verb = auditVerb(words.slice(1));
        ({ code, errorCode, github } = await runProCli(cfg, words.slice(1), io, runner));
        break;
      case "put":
        await io.stdout(`${JSON.stringify({ ok: true, data: await putFile(cfg, argsOf(1)[0], io) })}\n`);
        code = 0;
        break;
      case "ls":
        argsOf(0);
        await io.stdout(`${JSON.stringify({ ok: true, data: { files: await inboxEntries(cfg) } })}\n`);
        code = 0;
        break;
      case "rm": {
        const name = validateFileName(argsOf(1)[0]);
        const stats = await lstat(join(inboxDir(cfg), name)).catch(() => null);
        if (!stats || stats.isDirectory()) throw new GateError("FILE_NOT_FOUND", `No file ${name} in your inbox.`, 1);
        await unlink(join(inboxDir(cfg), name));
        await io.stdout(`${JSON.stringify({ ok: true, data: { removed: name } })}\n`);
        code = 0;
        break;
      }
      default:
        throw new GateError("COMMAND_DENIED", `Unknown command ${JSON.stringify(verb)}.\n${HELP}`);
    }
  } catch (error) {
    // A write fails with EPIPE once the client has hung up.
    const errno = (error as NodeJS.ErrnoException)?.code;
    const gateError = error instanceof GateError
      ? error
      : errno === "EPIPE" || io.clientGone?.aborted
        ? clientGoneError()
        : new GateError("GATE_INTERNAL", String((error as Error)?.message ?? error), 7);
    if (gateError.code !== "CLIENT_GONE") {
      io.stderr(
        `${JSON.stringify({
          ok: false,
          error: { code: gateError.code, message: gateError.message, ...(gateError.details ? { details: gateError.details } : {}) },
        })}\n`,
      );
    }
    code = gateError.exitCode;
    errorCode = gateError.code;
    // The system error code (e.g. ENOSPC) says what broke; the message may quote request text.
    if (errorCode === "GATE_INTERNAL" && typeof errno === "string" && /^E[A-Z0-9]{1,15}$/.test(errno)) internalErrno = errno;
  }
  await appendFile(
    join(stateDir(cfg), "audit.log"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      verb: verb.slice(0, 64),
      code,
      ...(errorCode ? { error: errorCode } : {}),
      ...(internalErrno ? { errno: internalErrno } : {}),
      ...(github ? { github: true } : {}),
    })}\n`,
    { mode: 0o600 },
  ).catch(() => undefined);
  return code;
}

function clientGoneError(): GateError {
  return new GateError("CLIENT_GONE", "The SSH client went away before the output could be written.", 7);
}

async function spawnProCli(argv: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<ProCliRun> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = () => child.kill();
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// sshd's session process is the gate's parent and exits when the client disconnects, so a changed
// parent means the client is gone.
function watchClient(everyMs = 2_000): AbortSignal {
  const parent = process.ppid;
  const gone = new AbortController();
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    gone.abort();
    clearInterval(timer);
  }, everyMs);
  timer.unref();
  return gone.signal;
}

if (import.meta.main) {
  // Writes to a hung-up client fail; runGate records that, so the pipes' error events are not fatal.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const home = homedir();
  const bun = join(home, ".bun", "bin", "bun");
  const cfg: GateConfig = {
    key: process.argv[2] ?? "",
    inboxRoot: join(home, "pro-cli-inbox"),
    stateRoot: join(home, ".local", "state", "pro-cli-gate"),
    proCli: [bun, join(home, "pro-cli", "src", "cli.ts")],
    env: { HOME: home, PATH: `${join(home, ".bun", "bin")}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" },
    maxUploadBytes: 50 * 1024 * 1024,
    maxInboxBytes: 500 * 1024 * 1024,
    maxInboxFiles: 200,
    jobsDb: join(home, ".pro-cli", "jobs.sqlite"),
  };
  // process.exit drops output still queued for a pipe, so stderr goes out through Bun.write too.
  let stderrWritten: Promise<unknown> = Promise.resolve();
  const code = await runGate(
    cfg,
    process.env.SSH_ORIGINAL_COMMAND,
    {
      stdin: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
      stdout: async (chunk) => {
        await Bun.write(Bun.stdout, chunk);
      },
      stderr: (chunk) => {
        stderrWritten = stderrWritten.then(() => Bun.write(Bun.stderr, chunk)).catch(() => undefined);
      },
      clientGone: watchClient(),
    },
    spawnProCli,
  );
  await stderrWritten;
  process.exit(code);
}
