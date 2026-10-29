import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, splitCommand, type GateConfig, type ProCliRun } from "../scripts/pro-cli-gate";
import { Database } from "bun:sqlite";
import { ProError } from "../src/errors";
import { JobStore } from "../src/jobs";

const JOB_A = "job_11111111-1111-4111-8111-111111111111";
const JOB_B = "job_22222222-2222-4222-8222-222222222222";
const FOREIGN = "job_99999999-9999-4999-8999-999999999999";

let root: string;
let cfg: GateConfig;
let calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }>;
let nextRun: ProCliRun;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pro-cli-gate-test-"));
  cfg = {
    key: "tester",
    inboxRoot: join(root, "inbox"),
    stateRoot: join(root, "state"),
    proCli: ["/fake/bun", "/fake/cli.ts"],
    env: { HOME: "/fake-home", PATH: "/usr/bin" },
    maxUploadBytes: 1024,
    maxInboxBytes: 2048,
    maxInboxFiles: 3,
  };
  calls = [];
  nextRun = { code: 0, stdout: '{"ok":true,"data":{}}\n', stderr: "" };
  await mkdir(join(root, "secret"), { recursive: true });
  await writeFile(join(root, "secret", "token.json"), "SECRET");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function gate(line: string | undefined, stdin: Uint8Array[] = []) {
  let stdout = "";
  const stdoutBytes: Uint8Array[] = [];
  let stderr = "";
  const code = await runGate(
    cfg,
    line,
    {
      stdin: (async function* () {
        yield* stdin;
      })(),
      stdout: (chunk) => {
        if (typeof chunk === "string") stdout += chunk;
        else {
          stdoutBytes.push(chunk);
          stdout += new TextDecoder().decode(chunk);
        }
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    },
    async (argv, cwd, env) => {
      calls.push({ argv, cwd, env });
      return nextRun;
    },
  );
  const first = stderr.split("\n")[0];
  const error = first.startsWith("{") ? (JSON.parse(first) as { error?: { code: string } }).error?.code : undefined;
  return { code, stdout, stdoutBytes, stderr, error };
}

const inbox = () => join(cfg.inboxRoot, cfg.key);

async function seedOwned(...ids: string[]) {
  await mkdir(join(cfg.stateRoot, cfg.key), { recursive: true });
  await writeFile(join(cfg.stateRoot, cfg.key, "jobs"), ids.map((id) => `${id}\n`).join(""));
}

describe("splitCommand", () => {
  test("round-trips bash and zsh printf %q quoting in UTF-8 and C locales", () => {
    const samples = ["plain", "two words", "it's", 'say "hi"', "a\nb", "tab\there", "dollar $HOME", "semi;colon", "*glob?", "ünïcode ✓", "emoji 😀", "a\nb😀", "back\\slash", "@file.md", "--cdp=x"];
    // bash is required; zsh is checked too where it is installed, since clients may wrap with either.
    const shells = ["bash", ...(Bun.which("zsh") ? ["zsh"] : [])];
    for (const shell of shells) {
      for (const locale of ["C.UTF-8", "C"]) {
        const quoted = spawnSync(shell, ["-c", 'printf "%q " "$@"', "_", ...samples], { encoding: "utf8", env: { ...process.env, LC_ALL: locale } });
        expect(quoted.status).toBe(0);
        // Outside a UTF-8 locale both shells write non-ASCII text as octal byte escapes.
        if (locale === "C") expect(quoted.stdout).toContain("\\303");
        expect(splitCommand(quoted.stdout)).toEqual(samples);
      }
    }
  });

  test("decodes escaped bytes as UTF-8 and rejects bytes that are not", () => {
    expect(splitCommand("ask $'\\x41\\102' $'\\303'$'\\274'ber")).toEqual(["ask", "AB", "über"]);
    for (const line of ["ask $'\\303'", "ask $'\\303'x", "ask $'\\xff'"]) {
      expect(() => splitCommand(line)).toThrow("not valid UTF-8");
    }
  });

  test("handles quotes and escapes without expansion", () => {
    expect(splitCommand(`pro-cli ask 'a b' "c \\"d\\"" e\\ f $'g\\nh'`)).toEqual(["pro-cli", "ask", "a b", 'c "d"', "e f", "g\nh"]);
  });

  test("rejects shell syntax instead of interpreting it", () => {
    for (const line of [
      "ls; id",
      "ls && id",
      "ls | id",
      "ls > /tmp/x",
      "ls < /etc/passwd",
      "echo $(id)",
      "echo `id`",
      'echo "$HOME"',
      'echo "`id`"',
      "ls *",
      "ls ~/x",
      "ls #x",
      "echo {a,b}",
      "echo 'unterminated",
      'echo "unterminated',
      "echo \x01",
    ]) {
      expect(() => splitCommand(line)).toThrow();
    }
  });
});

describe("gate commands", () => {
  test("refuses interactive login and unknown commands", async () => {
    expect((await gate(undefined)).error).toBe("NO_COMMAND");
    expect((await gate("   ")).error).toBe("NO_COMMAND");
    for (const line of ["bash", "sh -c id", "cat /etc/passwd", "scp -t .", "rsync --server .", "internal-sftp", "/usr/lib/openssh/sftp-server"]) {
      expect((await gate(line)).error).toBe("COMMAND_DENIED");
    }
    expect(calls).toHaveLength(0);
  });

  test("denies pro-cli commands outside the allowlist", async () => {
    for (const line of [
      "pro-cli auth capture --out /tmp/x",
      "pro-cli auth status",
      "pro-cli auth reset",
      "pro-cli update",
      "pro-cli config get",
      "pro-cli setup",
      "pro-cli doctor",
      "pro-cli conversations list",
      "pro-cli conversations delete abc",
      "pro-cli daemon stop",
      "pro-cli daemon serve",
      "pro-cli daemon restart",
      "pro-cli daemon",
      "pro-cli job",
      "pro-cli job --json status",
      "pro-cli models extra",
      "pro-cli",
      "pro-cli --version",
    ]) {
      const result = await gate(line);
      expect(result.code).not.toBe(0);
      expect(["COMMAND_DENIED", "BAD_ARGS"]).toContain(result.error ?? "");
    }
    expect(calls).toHaveLength(0);
  });

  test("denies flags that reach the browser, conversations, or local files", async () => {
    for (const flag of [
      "--cdp http://evil:9222",
      "--cdp=http://evil:9222",
      "--port 9333",
      "--conversation abc",
      "--parent abc",
      "--save",
      "--store true",
      "--no-temporary",
      "--keep-conversation",
      "--delete-conversation",
      "--preamble hi",
      "--no-json",
      "--no-start",
      "--out /tmp/x",
      "--token-out /tmp/x",
      "--jar /tmp/x",
      "--home /tmp",
    ]) {
      const result = await gate(`pro-cli ask ${flag} hello`);
      expect(result.error).toBe("FLAG_DENIED");
    }
    expect((await gate("pro-cli odds --attach x.png question")).error).toBe("FLAG_DENIED");
    expect(calls).toHaveLength(0);
  });

  test("runs allowed commands with a rebuilt argv, inbox cwd, and fixed env", async () => {
    const result = await gate("pro-cli ask --model gpt-5-5 'what is 2+2' -- --cdp=x");
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["/fake/bun", "/fake/cli.ts", "ask", "--model=gpt-5-5", "--chat-only", "--pro-only", "--json", "--", "what is 2+2", "--cdp=x"]);
    expect(calls[0].cwd).toBe(inbox());
    expect(calls[0].env).toEqual(cfg.env);

    await gate("pro-cli limits --json");
    expect(calls[1].argv).toEqual(["/fake/bun", "/fake/cli.ts", "limits", "--json"]);
    await gate("pro-cli daemon status");
    expect(calls[2].argv).toEqual(["/fake/bun", "/fake/cli.ts", "daemon", "status", "--json"]);
  });

  test("passes --citations through for ask, job create and odds", async () => {
    for (const line of ["pro-cli ask --citations raw hello", "pro-cli job create --citations=strip hello", "pro-cli odds --citations numbered question"]) {
      expect((await gate(line)).code).toBe(0);
    }
    expect(calls.map((call) => call.argv.find((arg) => arg.startsWith("--citations")))).toEqual([
      "--citations=raw",
      "--citations=strip",
      "--citations=numbered",
    ]);
  });
});

describe("--github", () => {
  const preambleArg = (argv: string[]) => argv.find((arg) => arg.startsWith("--preamble=")) ?? "";

  test("runs job create and ask as a saved chat with the preamble, deleted afterwards", async () => {
    expect((await gate("pro-cli job create --github --model gpt-6-pro 'read owner/repo'")).code).toBe(0);
    expect(calls[0].argv.slice(2)).toEqual([
      "job",
      "create",
      "--model=gpt-6-pro",
      "--save",
      "--delete-conversation",
      preambleArg(calls[0].argv),
      "--chat-only",
      "--pro-only",
      "--json",
      "--",
      "read owner/repo",
    ]);
    expect(preambleArg(calls[0].argv)).toContain("not from the account owner");
    expect(preambleArg(calls[0].argv)).toContain("GitHub connector");

    expect((await gate("pro-cli ask --github hello")).code).toBe(0);
    expect(calls[1].argv).toContain("--save");
    expect(calls[1].argv).toContain("--delete-conversation");
    expect(calls[1].argv).not.toContain("--github");
  });

  test("is refused with --temporary, with a value, and for odds", async () => {
    expect((await gate("pro-cli job create --github --temporary hello")).error).toBe("BAD_ARGS");
    expect((await gate("pro-cli ask --github=yes hello")).error).toBe("BAD_ARGS");
    expect((await gate("pro-cli odds --github 'will it rain'")).error).toBe("FLAG_DENIED");
    expect(calls).toHaveLength(0);
  });

  test("is marked in the audit log", async () => {
    await gate("pro-cli job create --github hello");
    await gate("pro-cli job create hello");
    const lines = (await readFile(join(cfg.stateRoot, cfg.key, "audit.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ verb: "pro-cli job create", code: 0, github: true });
    expect(lines[1]).not.toHaveProperty("github");
  });
});

describe("file confinement", () => {
  beforeEach(async () => {
    await mkdir(inbox(), { recursive: true });
    await writeFile(join(inbox(), "pic.png"), "PNG");
    await writeFile(join(inbox(), "prompt.md"), "hello");
  });

  test("allows inbox files by plain name", async () => {
    expect((await gate("pro-cli ask --attach pic.png 'describe'")).code).toBe(0);
    expect((await gate("pro-cli job create @prompt.md")).code).toBe(0);
    expect((await gate("pro-cli ask --instructions-file prompt.md hi")).code).toBe(0);
    expect((await gate("pro-cli ask --instructions @prompt.md hi")).code).toBe(0);
    expect((await gate("pro-cli ask --schema @prompt.md hi")).code).toBe(0);
    expect((await gate("pro-cli odds --context @prompt.md will it rain")).code).toBe(0);
    expect(calls[0].argv).toContain("--attach=pic.png");
  });

  test("rejects paths, traversal, hidden names, and encoded tricks", async () => {
    const secret = join(root, "secret", "token.json");
    for (const ref of [
      `--attach ${secret}`,
      "--attach ../../secret/token.json",
      "--attach ./pic.png",
      "--attach .hidden",
      "--attach -rf",
      "--attach %2e%2e",
      "--attach=../x",
      `--instructions-file ${secret}`,
      `--instructions @${secret}`,
      "--instructions @../x",
      "--schema @../../secret/token.json",
      "--context @%2e%2e/x",
    ]) {
      const result = await gate(`pro-cli ask ${ref} hi`);
      if (ref.startsWith("--context")) expect(result.error).toBe("FLAG_DENIED");
      else expect(result.error).toBe("BAD_FILE_NAME");
    }
    expect((await gate(`pro-cli ask @${secret}`)).error).toBe("BAD_FILE_NAME");
    expect((await gate("pro-cli job create @../secret/token.json")).error).toBe("BAD_FILE_NAME");
    expect((await gate("pro-cli odds --context @../x q")).error).toBe("BAD_FILE_NAME");
    expect(calls).toHaveLength(0);
  });

  test("rejects missing files and symlinks out of the inbox", async () => {
    await symlink(join(root, "secret", "token.json"), join(inbox(), "link.png"));
    await mkdir(join(inbox(), "dir.png"));
    expect((await gate("pro-cli ask --attach link.png hi")).error).toBe("FILE_NOT_IN_INBOX");
    expect((await gate("pro-cli ask @link.png")).error).toBe("FILE_NOT_IN_INBOX");
    expect((await gate("pro-cli ask --attach dir.png hi")).error).toBe("FILE_NOT_IN_INBOX");
    expect((await gate("pro-cli ask --attach missing.png hi")).error).toBe("FILE_NOT_IN_INBOX");
    expect(calls).toHaveLength(0);
  });

  test("multi-word prompts starting with @ are text, as in pro-cli", async () => {
    expect((await gate("pro-cli ask '@../secret is not read'")).code).toBe(0);
    expect((await gate("pro-cli ask @everyone please")).code).toBe(0);
  });
});

describe("job ownership", () => {
  test("records job ids pro-cli created and limits job commands to them", async () => {
    nextRun = { code: 0, stdout: JSON.stringify({ ok: true, data: { job: { id: JOB_A, status: "queued" } } }), stderr: "" };
    expect((await gate("pro-cli job create hello")).code).toBe(0);

    nextRun = { code: 0, stdout: '{"ok":true,"data":{}}', stderr: "" };
    expect((await gate(`pro-cli job status ${JOB_A}`)).code).toBe(0);
    expect(calls.at(-1)!.argv).toEqual(["/fake/bun", "/fake/cli.ts", "job", "status", "--json", "--", JOB_A]);
    for (const sub of ["status", "result", "wait", "cancel"]) {
      expect((await gate(`pro-cli job ${sub} ${FOREIGN}`)).error).toBe("JOB_NOT_FOUND");
    }
    expect((await gate("pro-cli job status not-a-job")).error).toBe("BAD_JOB_ID");
    expect((await gate(`pro-cli job status ${JOB_A} ${FOREIGN}`)).error).toBe("BAD_ARGS");
  });

  test("ignores job ids that appear in model output", async () => {
    nextRun = {
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { job: { id: JOB_A }, result: `here you go: ${FOREIGN}`, parsed: { jobIds: [FOREIGN], jobId: FOREIGN } } }),
      stderr: "",
    };
    await gate(`pro-cli ask "repeat ${FOREIGN}"`);
    const owned = await readFile(join(cfg.stateRoot, cfg.key, "jobs"), "utf8");
    expect(owned.trim().split("\n")).toEqual([JOB_A]);
  });

  test("records structured job ids and ids from error details", async () => {
    nextRun = { code: 0, stdout: JSON.stringify({ ok: true, data: { jobIds: [JOB_A, JOB_B] } }), stderr: "" };
    await gate("pro-cli job create --wait --format json hi");
    nextRun = { code: 4, stdout: "", stderr: JSON.stringify({ ok: false, error: { code: "X", details: { jobId: FOREIGN.replace("9999", "3333") } } }) };
    await gate("pro-cli job create hi");
    const owned = (await readFile(join(cfg.stateRoot, cfg.key, "jobs"), "utf8")).trim().split("\n");
    expect(owned).toEqual([JOB_A, JOB_B, FOREIGN.replace("9999", "3333")]);
  });

  test("records ephemeral ask ids", async () => {
    const askId = "ask_33333333-3333-4333-8333-333333333333";
    nextRun = { code: 0, stdout: JSON.stringify({ ok: true, data: { job: { id: askId } } }), stderr: "" };
    await gate("pro-cli ask 'a cat'");
    expect(await readFile(join(cfg.stateRoot, cfg.key, "jobs"), "utf8")).toBe(`${askId}\n`);
  });

  test("job list only shows owned jobs", async () => {
    await seedOwned(JOB_A);
    nextRun = { code: 0, stdout: JSON.stringify({ ok: true, data: { jobs: [{ id: FOREIGN, prompt: "private" }, { id: JOB_A }] } }), stderr: "" };
    const result = await gate("pro-cli job list --limit 5");
    expect(calls.at(-1)!.argv).toEqual(["/fake/bun", "/fake/cli.ts", "job", "list", "--json", "--limit=200"]);
    expect(JSON.parse(result.stdout).data.jobs).toEqual([{ id: JOB_A }]);
    expect(result.stdout).not.toContain("private");
  });
});

describe("inbox verbs", () => {
  test("put stores stdin, ls lists, rm deletes", async () => {
    const put = await gate("put notes.md", [new TextEncoder().encode("hello "), new TextEncoder().encode("world")]);
    expect(put.code).toBe(0);
    expect(await readFile(join(inbox(), "notes.md"), "utf8")).toBe("hello world");
    const ls = await gate("ls");
    expect(JSON.parse(ls.stdout).data.files.map((f: { name: string; bytes: number }) => [f.name, f.bytes])).toEqual([["notes.md", 11]]);
    expect((await gate("rm notes.md")).code).toBe(0);
    expect(await readdir(inbox())).toEqual([]);
  });

  test("put rejects bad names and oversize uploads without leaving files", async () => {
    for (const name of ["../x", "a/b", ".bashrc", "-rf", "..", "x%2fy", "'a b'"]) {
      expect((await gate(`put ${name}`)).error).toBe("BAD_FILE_NAME");
    }
    const big = await gate("put big.bin", [new Uint8Array(800), new Uint8Array(800)]);
    expect(big.error).toBe("UPLOAD_TOO_LARGE");
    expect(await readdir(inbox())).toEqual([]);
  });

  test("put enforces inbox file count and byte quota", async () => {
    for (const name of ["a", "b"]) expect((await gate(`put ${name}`, [new Uint8Array(900)])).code).toBe(0);
    expect((await gate("put c", [new Uint8Array(300)])).error).toBe("UPLOAD_TOO_LARGE");
    expect((await gate("put c", [new Uint8Array(10)])).code).toBe(0);
    expect((await gate("put d", [new Uint8Array(1)])).error).toBe("INBOX_FULL");
    expect((await gate("put a", [new Uint8Array(5)])).code).toBe(0);
  });

  test("put replaces a symlink rather than writing through it", async () => {
    await mkdir(inbox(), { recursive: true });
    await symlink(join(root, "secret", "token.json"), join(inbox(), "evil"));
    expect((await gate("put evil", [new TextEncoder().encode("x")])).code).toBe(0);
    expect(await readFile(join(root, "secret", "token.json"), "utf8")).toBe("SECRET");
  });

  test("rm cannot leave the inbox", async () => {
    expect((await gate("rm ../state")).error).toBe("BAD_FILE_NAME");
    expect((await gate("rm missing")).error).toBe("FILE_NOT_FOUND");
    expect((await gate("rm a b")).error).toBe("BAD_ARGS");
  });
});

describe("chat models only", () => {
  test("ask, odds and job create always carry --chat-only and --pro-only", async () => {
    for (const line of ["pro-cli ask --model image 'a cat'", "pro-cli odds 'will it rain'", "pro-cli job create --model gpt-5-6-thinking hello"]) {
      await gate(line);
    }
    expect(calls.map((call) => call.argv.includes("--chat-only") && call.argv.includes("--pro-only"))).toEqual([true, true, true]);
    await gate("pro-cli job list");
    expect(calls[3].argv).not.toContain("--chat-only");
    expect(calls[3].argv).not.toContain("--pro-only");
  });

  test("get is not a command", async () => {
    expect((await gate(`get ${JOB_A} image-1.png`)).error).toBe("COMMAND_DENIED");
  });
});

test("audit log records verbs and exit codes, not prompts", async () => {
  await gate("pro-cli ask 'my private prompt'");
  await gate("pro-cli auth capture");
  const log = await readFile(join(cfg.stateRoot, cfg.key, "audit.log"), "utf8");
  expect(log).not.toContain("private");
  const lines = log.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => [line.verb, line.code])).toEqual([
    ["pro-cli ask", 0],
    ["pro-cli auth capture", 2],
  ]);
});

test("audit log records error codes of failed calls, not messages", async () => {
  await seedOwned(JOB_A);
  nextRun = {
    code: 7,
    stdout: "",
    stderr: `warning first\n${JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "quoted private text", suggestions: [] } })}\n`,
  };
  await gate(`pro-cli job wait ${JOB_A}`);
  nextRun = { code: 7, stdout: "", stderr: `${JSON.stringify({ ok: false, error: { code: "private words", message: "x" } })}\n` };
  await gate(`pro-cli job wait ${JOB_A}`);
  nextRun = { code: 1, stdout: "", stderr: "Segmentation fault\n" };
  await gate(`pro-cli job status ${JOB_A}`);
  nextRun = { code: 0, stdout: '{"ok":true,"data":{}}\n', stderr: "" };
  await gate(`pro-cli job wait ${JOB_A}`);
  await gate(`pro-cli job wait ${FOREIGN}`);
  const log = await readFile(join(cfg.stateRoot, cfg.key, "audit.log"), "utf8");
  expect(log).not.toContain("private");
  const lines = log.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map(({ verb, code, error }) => ({ verb, code, error }))).toEqual([
    { verb: "pro-cli job wait", code: 7, error: "INTERNAL_ERROR" },
    { verb: "pro-cli job wait", code: 7, error: undefined },
    { verb: "pro-cli job status", code: 1, error: undefined },
    { verb: "pro-cli job wait", code: 0, error: undefined },
    { verb: "pro-cli job wait", code: 1, error: "JOB_NOT_FOUND" },
  ]);
  expect(lines[3]).not.toHaveProperty("error");
});

describe("usage-limit pause", () => {
  // A job database whose jobs failed or succeeded at the given times (ISO strings).
  async function jobsDb(
    jobs: Array<{ status: "failed" | "succeeded"; errorCode?: string; createdAt: string; updatedAt: string; model?: string }>,
  ) {
    const path = join(root, "jobs.sqlite");
    const store = await JobStore.open(path);
    const ids: string[] = [];
    try {
      for (const entry of jobs) {
        const { id } = store.create({ prompt: "question", model: entry.model ?? "gpt-5-5-pro", reasoning: "standard", options: {} });
        store.markRunning(id);
        if (entry.status === "failed") {
          store.markFailed(id, new ProError("UPSTREAM_ERROR", "You've hit your limit.", { details: { errorCode: entry.errorCode ?? null } }));
        } else {
          store.markSucceeded(id, "answer");
        }
        ids.push(id);
      }
    } finally {
      store.close();
    }
    const db = new Database(path);
    try {
      jobs.forEach((entry, index) => {
        db.query("UPDATE jobs SET created_at = ?, updated_at = ? WHERE id = ?").run(entry.createdAt, entry.updatedAt, ids[index]);
      });
    } finally {
      db.close();
    }
    cfg.jobsDb = path;
  }
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  test("refuses new requests without running pro-cli while a usage-limit refusal is recent", async () => {
    await jobsDb([{ status: "failed", errorCode: "usage_limit", createdAt: ago(6), updatedAt: ago(5) }]);

    for (const line of ["pro-cli job create --json hello", "pro-cli ask --json hello", "pro-cli job create --github --json hello"]) {
      const result = await gate(line);
      expect(result.code).toBe(4);
      expect(result.error).toBe("USAGE_LIMIT_PAUSED");
      const details = (JSON.parse(result.stderr.split("\n")[0]) as { error: { details: { refusedAt: string; retryAfter: string } } }).error.details;
      expect(Date.parse(details.retryAfter) - Date.parse(details.refusedAt)).toBe(30 * 60_000);
    }
    expect(calls).toHaveLength(0);
    const audit = (await readFile(join(root, "state", "tester", "audit.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit[0]).toMatchObject({ verb: "pro-cli job create", code: 4, error: "USAGE_LIMIT_PAUSED" });
  });

  test("still answers job status, wait and result during the pause", async () => {
    await jobsDb([{ status: "failed", errorCode: "usage_limit", createdAt: ago(6), updatedAt: ago(5) }]);
    await mkdir(join(root, "state", "tester"), { recursive: true });
    await writeFile(join(root, "state", "tester", "jobs"), `${JOB_A}\n`);

    for (const verb of ["status", "wait", "result"]) {
      expect((await gate(`pro-cli job ${verb} ${JOB_A} --json`)).code).toBe(0);
    }
    expect(calls).toHaveLength(3);
  });

  test("lets requests through once the pause is over, after other errors, or when a later job succeeded", async () => {
    for (const jobs of [
      [{ status: "failed" as const, errorCode: "usage_limit", createdAt: ago(32), updatedAt: ago(31) }],
      [{ status: "failed" as const, errorCode: "something_else", createdAt: ago(3), updatedAt: ago(2) }],
      [
        { status: "failed" as const, errorCode: "usage_limit", createdAt: ago(11), updatedAt: ago(10) },
        { status: "succeeded" as const, createdAt: ago(9), updatedAt: ago(1) },
      ],
    ]) {
      await rm(join(root, "jobs.sqlite"), { force: true });
      await jobsDb(jobs);
      const before = calls.length;
      expect((await gate("pro-cli job create --json hello")).code).toBe(0);
      expect(calls).toHaveLength(before + 1);
    }
  });

  test("a success on a cheaper model does not end the pause", async () => {
    await jobsDb([
      { status: "failed", errorCode: "usage_limit", createdAt: ago(6), updatedAt: ago(5) },
      { status: "succeeded", createdAt: ago(4), updatedAt: ago(1), model: "gpt-5-5" },
    ]);
    expect((await gate("pro-cli job create --json hello")).error).toBe("USAGE_LIMIT_PAUSED");
  });

  test("a job that started before the refusal and succeeds later does not end the pause", async () => {
    await jobsDb([
      { status: "succeeded", createdAt: ago(20), updatedAt: ago(1) },
      { status: "failed", errorCode: "usage_limit", createdAt: ago(6), updatedAt: ago(5) },
    ]);
    expect((await gate("pro-cli job create --json hello")).error).toBe("USAGE_LIMIT_PAUSED");
  });

  test("pro-cli limits says until when requests are paused", async () => {
    const refusedAt = ago(5);
    await jobsDb([{ status: "failed", errorCode: "usage_limit", createdAt: ago(6), updatedAt: refusedAt }]);
    nextRun = { code: 0, stdout: `${JSON.stringify({ ok: true, data: { account: {}, usageLimit: { limited: true } } })}\n`, stderr: "" };
    const paused = await gate("pro-cli limits --json");
    expect(paused.code).toBe(0);
    expect(JSON.parse(paused.stdout).data.usageLimit).toEqual({
      limited: true,
      requestsPausedUntil: new Date(Date.parse(refusedAt) + 30 * 60_000).toISOString(),
    });

    await rm(join(root, "jobs.sqlite"), { force: true });
    await jobsDb([{ status: "failed", errorCode: "usage_limit", createdAt: ago(32), updatedAt: ago(31) }]);
    expect(JSON.parse((await gate("pro-cli limits --json")).stdout).data.usageLimit).toEqual({ limited: true, requestsPausedUntil: null });

    nextRun = { code: 0, stdout: '{"ok":true,"data":{"account":{}}}\n', stderr: "" };
    expect(JSON.parse((await gate("pro-cli limits --json")).stdout)).toEqual({ ok: true, data: { account: {} } });
    expect(calls).toHaveLength(3);
  });

  test("a missing job database never pauses requests", async () => {
    cfg.jobsDb = join(root, "missing.sqlite");
    expect((await gate("pro-cli job create --json hello")).code).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("client gone", () => {
  const audit = async () =>
    (await readFile(join(cfg.stateRoot, cfg.key, "audit.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  // Runs the gate with a client that hangs up: its writes fail like a closed SSH channel's.
  async function gateAfterHangUp(line: string, runner: Parameters<typeof runGate>[3], gone = new AbortController()) {
    let stderr = "";
    const code = await runGate(
      cfg,
      line,
      {
        stdin: (async function* () {})(),
        stdout: () => {
          throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
        },
        stderr: (chunk) => {
          stderr += chunk;
        },
        clientGone: gone.signal,
      },
      runner,
    );
    return { code, stderr };
  }

  test("a write to a client that hung up is recorded as CLIENT_GONE, not an internal error", async () => {
    const result = await gateAfterHangUp("pro-cli daemon status --json", async () => nextRun);
    expect(result.code).toBe(7);
    expect(result.stderr).toBe("");
    expect(await audit()).toMatchObject([{ verb: "pro-cli daemon status", code: 7, error: "CLIENT_GONE" }]);
  });

  test("an orphaned job wait is stopped once the client is gone", async () => {
    await seedOwned(JOB_A);
    const gone = new AbortController();
    let signalled: AbortSignal | undefined;
    const result = await gateAfterHangUp(
      `pro-cli job wait ${JOB_A} --json`,
      async (_argv, _cwd, _env, signal) => {
        signalled = signal;
        setTimeout(() => gone.abort(), 5);
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return { code: 143, stdout: "", stderr: "" };
      },
      gone,
    );
    expect(signalled).toBe(gone.signal);
    expect(result.code).toBe(7);
    expect(await audit()).toMatchObject([{ verb: "pro-cli job wait", error: "CLIENT_GONE" }]);
  });

  test("a request runs on without the client, so its job is still recorded as this key's", async () => {
    const gone = new AbortController();
    gone.abort();
    let signalled: AbortSignal | undefined = gone.signal;
    const result = await gateAfterHangUp(
      "pro-cli job create --wait --json hello",
      async (_argv, _cwd, _env, signal) => {
        signalled = signal;
        return { code: 0, stdout: `{"ok":true,"data":{"job":{"id":"${JOB_B}"}}}\n`, stderr: "" };
      },
      gone,
    );
    expect(signalled).toBeUndefined();
    expect(result.code).toBe(7);
    expect(await readFile(join(cfg.stateRoot, cfg.key, "jobs"), "utf8")).toBe(`${JOB_B}\n`);
    expect(await audit()).toMatchObject([{ verb: "pro-cli job create", error: "CLIENT_GONE" }]);
  });

  test("another internal error keeps GATE_INTERNAL and records only its system error code", async () => {
    const code = await runGate(
      cfg,
      "pro-cli daemon status --json",
      {
        stdin: (async function* () {})(),
        stdout: () => {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        },
        stderr: () => undefined,
      },
      async () => nextRun,
    );
    expect(code).toBe(7);
    const [entry] = await audit();
    expect(entry).toMatchObject({ error: "GATE_INTERNAL", errno: "ENOSPC" });
    expect(JSON.stringify(entry)).not.toContain("no space");
  });
});

describe("gate output", () => {
  const gate = join(import.meta.dir, "..", "scripts", "pro-cli-gate.ts");
  // A script against the gate's writeStream. Its child runs with stdout on a pipe, as under sshd
  // (Bun.spawn alone would give it a socket).
  const script = (body: string) =>
    `import { writeStream } from ${JSON.stringify(gate)};\nprocess.stdout.on("error", () => undefined);\n${body}`;

  test("a reader slower than the gate gets a 150 KB answer once, not its first 64 KiB twice", async () => {
    const body = `await writeStream(process.stdout, "word ".repeat(30_000));\nprocess.exit(0);`;
    // The reader starts late: the gate has filled the pipe by then.
    const child = Bun.spawn(["sh", "-c", '"$0" -e "$1" | { sleep 0.5; cat; }', process.execPath, script(body)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("word ".repeat(30_000));
  });

  test("a write to a client that hung up fails with EPIPE, which the gate records as CLIENT_GONE", async () => {
    const body = `const error = await writeStream(process.stdout, "word ".repeat(400_000)).then(() => null, (e) => e);
process.stderr.write(String(error?.code), () => process.exit(0));`;
    const child = Bun.spawn(["sh", "-c", '"$0" -e "$1" | head -c 5 > /dev/null', process.execPath, script(body)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("EPIPE");
  });
});
