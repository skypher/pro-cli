import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, splitCommand, type GateConfig, type ProCliRun } from "../scripts/pro-cli-gate";

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
  test("round-trips bash and zsh printf %q quoting", () => {
    const samples = ["plain", "two words", "it's", 'say "hi"', "a\nb", "tab\there", "dollar $HOME", "semi;colon", "*glob?", "ünïcode ✓", "back\\slash", "@file.md", "--cdp=x"];
    // bash is required; zsh is checked too where it is installed, since clients may wrap with either.
    const shells = ["bash", ...(Bun.which("zsh") ? ["zsh"] : [])];
    for (const shell of shells) {
      const quoted = spawnSync(shell, ["-c", 'printf "%q " "$@"', "_", ...samples], { encoding: "utf8" });
      expect(quoted.status).toBe(0);
      expect(splitCommand(quoted.stdout)).toEqual(samples);
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
    expect(calls[0].argv).toEqual(["/fake/bun", "/fake/cli.ts", "ask", "--model=gpt-5-5", "--chat-only", "--json", "--", "what is 2+2", "--cdp=x"]);
    expect(calls[0].cwd).toBe(inbox());
    expect(calls[0].env).toEqual(cfg.env);

    await gate("pro-cli limits --json");
    expect(calls[1].argv).toEqual(["/fake/bun", "/fake/cli.ts", "limits", "--json"]);
    await gate("pro-cli daemon status");
    expect(calls[2].argv).toEqual(["/fake/bun", "/fake/cli.ts", "daemon", "status", "--json"]);
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
  test("ask, odds and job create always carry --chat-only", async () => {
    for (const line of ["pro-cli ask --model image 'a cat'", "pro-cli odds 'will it rain'", "pro-cli job create --model deep-research hello"]) {
      await gate(line);
    }
    expect(calls.map((call) => call.argv.includes("--chat-only"))).toEqual([true, true, true]);
    await gate("pro-cli job list");
    expect(calls[3].argv).not.toContain("--chat-only");
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
