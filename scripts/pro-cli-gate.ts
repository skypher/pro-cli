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
//   pro-cli <ask|odds|job|models|limits|daemon status> ...   output is always JSON
//   put <name>          upload stdin into the inbox
//   ls                  list inbox files
//   rm <name>           delete an inbox file
//   get <jobId> <file>  download a generated image of an owned job
//   help

import { randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GateConfig {
  key: string;
  inboxRoot: string;
  stateRoot: string;
  imagesRoot: string;
  proCli: string[];
  env: Record<string, string>;
  maxUploadBytes: number;
  maxInboxBytes: number;
  maxInboxFiles: number;
}

export interface GateIO {
  stdin: AsyncIterable<Uint8Array>;
  stdout: (chunk: Uint8Array | string) => void | Promise<void>;
  stderr: (chunk: string) => void;
}

export interface ProCliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProCliRunner = (argv: string[], cwd: string, env: Record<string, string>) => Promise<ProCliRun>;

export class GateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

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
  "wait",
  "help",
  "version",
  "allow-fifty",
  "no-launch",
  "no-backup",
  "force",
  "legacy",
]);

const REQUEST_FLAGS = [
  "json",
  "model",
  "reasoning",
  "verbosity",
  "reasoning-summary",
  "tool-choice",
  "parallel-tools",
  "timeout",
  "retries",
  "retry-delay",
  "temporary",
];
const ASK_FLAGS = new Set([
  ...REQUEST_FLAGS,
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

  while (index < line.length) {
    const char = line[index];
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(char)) fail("Control characters are not allowed.");
    if (char === " " || char === "\t" || char === "\n") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) fail("Unterminated single quote.");
      word += line.slice(index + 1, end);
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
          word += c;
          index += 1;
          continue;
        }
        const e = line[index + 1];
        const simple: Record<string, string> = {
          n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v",
          "\\": "\\", "'": "'", '"': '"', "?": "?",
        };
        if (e !== undefined && e in simple) {
          word += simple[e];
          index += 2;
        } else if (e === "x" && /^[0-9a-fA-F]{1,2}/.test(line.slice(index + 2))) {
          const hex = line.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)![0];
          word += String.fromCharCode(Number.parseInt(hex, 16));
          index += 2 + hex.length;
        } else if (e !== undefined && /[0-7]/.test(e)) {
          const oct = line.slice(index + 1).match(/^[0-7]{1,3}/)![0];
          word += String.fromCharCode(Number.parseInt(oct, 8));
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
          if (line[index + 1] !== "\n") word += line[index + 1];
          index += 2;
          continue;
        }
        word += c;
        index += 1;
      }
      inWord = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= line.length) fail("Trailing backslash.");
      if (line[index + 1] !== "\n") word += line[index + 1];
      inWord = true;
      index += 2;
      continue;
    }
    if (";&|<>()$`*?[]{}".includes(char)) fail(`Unquoted shell metacharacter ${JSON.stringify(char)} is not allowed.`);
    if (!inWord && (char === "#" || char === "~")) fail(`Unquoted ${JSON.stringify(char)} at word start is not allowed.`);
    word += char;
    inWord = true;
    index += 1;
  }
  if (inWord) words.push(word);
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
export async function checkProCliArgs(cfg: GateConfig, args: string[]): Promise<{ argv: string[]; command: ProCommand; jobId?: string }> {
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
    if (flag.name === "json") continue;
    argv.push(flag.value === true ? `--${flag.name}` : `--${flag.name}=${flag.value}`);
  }
  argv.push("--json");
  if (spec.kind === "job list") {
    // Fetch the newest jobs and filter to this key afterwards.
    const limitIndex = argv.findIndex((arg) => arg.startsWith("--limit="));
    if (limitIndex >= 0) argv.splice(limitIndex, 1);
    argv.push("--limit=200");
  }
  if (parsed.positionals.length > 0) argv.push("--", ...parsed.positionals);
  return { argv, command: spec, jobId };
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

async function getImage(cfg: GateConfig, jobIdArg: string | undefined, fileArg: string | undefined, io: GateIO): Promise<void> {
  const jobId = validateJobId(jobIdArg);
  const file = validateFileName(fileArg);
  if (!(await ownedJobs(cfg)).has(jobId)) throw new GateError("JOB_NOT_FOUND", `No job ${jobId} for this key.`, 1);
  const dir = join(cfg.imagesRoot, jobId);
  const path = join(dir, file);
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile()) throw new GateError("FILE_NOT_FOUND", `No file ${file} for job ${jobId}.`, 1);
  if ((await realpath(path)) !== join(await realpath(dir), file)) throw new GateError("FILE_NOT_FOUND", `No file ${file} for job ${jobId}.`, 1);
  for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) await io.stdout(chunk);
}

async function runProCli(cfg: GateConfig, args: string[], io: GateIO, runner: ProCliRunner): Promise<{ code: number; errorCode?: string }> {
  const checked = await checkProCliArgs(cfg, args);
  const result = await runner([...cfg.proCli, ...checked.argv], inboxDir(cfg), cfg.env);
  const kind = checked.command.kind;
  if (kind === "ask" || kind === "odds" || kind === "job create") {
    await recordJobs(cfg, [...createdJobIds(result.stdout), ...createdJobIds(result.stderr)]);
  }
  if (kind === "job list" && result.code === 0) {
    const owned = await ownedJobs(cfg);
    const limitArg = args.find((arg, i) => args[i - 1] === "--limit") ?? args.find((arg) => arg.startsWith("--limit="))?.slice(8);
    const limit = Math.min(200, Math.max(1, Number(limitArg ?? "20") || 20));
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { jobs: Array<{ id: string }> } };
    payload.data.jobs = payload.data.jobs.filter((job) => owned.has(job.id)).slice(0, limit);
    await io.stdout(`${JSON.stringify(payload)}\n`);
  } else {
    await io.stdout(result.stdout);
  }
  if (result.stderr) io.stderr(result.stderr);
  return { code: result.code, errorCode: result.code === 0 ? undefined : errorCodeOf(result.stderr) };
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
  put <name> < file                    upload into your inbox
  ls                                   list inbox files
  rm <name>                            delete an inbox file
  get <jobId> <file> > file            download a generated image
Files for --attach, --instructions-file and @name must be uploaded with put first.
Not available: auth, update, config, setup, doctor, conversations, daemon control,
--cdp, --port, --conversation, --parent, --save, --store, --no-temporary, --keep-conversation.
`;

export async function runGate(cfg: GateConfig, commandLine: string | undefined, io: GateIO, runner: ProCliRunner): Promise<number> {
  let verb = "invalid";
  let code = 2;
  let errorCode: string | undefined;
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
        ({ code, errorCode } = await runProCli(cfg, words.slice(1), io, runner));
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
      case "get": {
        const [jobId, file] = argsOf(2);
        await getImage(cfg, jobId, file, io);
        code = 0;
        break;
      }
      default:
        throw new GateError("COMMAND_DENIED", `Unknown command ${JSON.stringify(verb)}.\n${HELP}`);
    }
  } catch (error) {
    const gateError = error instanceof GateError ? error : new GateError("GATE_INTERNAL", String((error as Error)?.message ?? error), 7);
    io.stderr(`${JSON.stringify({ ok: false, error: { code: gateError.code, message: gateError.message } })}\n`);
    code = gateError.exitCode;
    errorCode = gateError.code;
  }
  await appendFile(
    join(stateDir(cfg), "audit.log"),
    `${JSON.stringify({ at: new Date().toISOString(), verb: verb.slice(0, 64), code, ...(errorCode ? { error: errorCode } : {}) })}\n`,
    { mode: 0o600 },
  ).catch(() => undefined);
  return code;
}

async function spawnProCli(argv: string[], cwd: string, env: Record<string, string>): Promise<ProCliRun> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

if (import.meta.main) {
  const home = homedir();
  const bun = join(home, ".bun", "bin", "bun");
  const cfg: GateConfig = {
    key: process.argv[2] ?? "",
    inboxRoot: join(home, "pro-cli-inbox"),
    stateRoot: join(home, ".local", "state", "pro-cli-gate"),
    imagesRoot: join(home, ".pro-cli", "images"),
    proCli: [bun, join(home, "pro-cli", "src", "cli.ts")],
    env: { HOME: home, PATH: `${join(home, ".bun", "bin")}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" },
    maxUploadBytes: 50 * 1024 * 1024,
    maxInboxBytes: 500 * 1024 * 1024,
    maxInboxFiles: 200,
  };
  const code = await runGate(
    cfg,
    process.env.SSH_ORIGINAL_COMMAND,
    {
      stdin: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
      stdout: async (chunk) => {
        await Bun.write(Bun.stdout, chunk);
      },
      stderr: (chunk) => process.stderr.write(chunk),
    },
    spawnProCli,
  );
  process.exit(code);
}
