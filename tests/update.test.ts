import { describe, expect, test } from "bun:test";
import { updateProCli, type UpdateStep } from "../src/update";

const repoRoot = "/tmp/pro-cli";
const bun = "/home/user/.bun/bin/bun";

function fakeCheckout(origin: string) {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runCommand = (command: string, args: string[], cwd?: string): UpdateStep => {
    calls.push({ command, args, cwd });
    const rendered = [command, ...args].join(" ");
    if (rendered === `git -C ${repoRoot} remote get-url origin`) {
      return { command: rendered, output: `${origin}\n` };
    }
    if (rendered === `git -C ${repoRoot} branch --show-current`) {
      return { command: rendered, output: "main\n" };
    }
    if (rendered === `git -C ${repoRoot} status --porcelain`) {
      return { command: rendered, output: "" };
    }
    if (rendered === `git -C ${repoRoot} pull --ff-only origin main`) {
      return { command: rendered, output: "Already up to date." };
    }
    if (rendered === `${bun} install`) {
      expect(cwd).toBe(repoRoot);
      return { command: rendered, output: "installed" };
    }
    if (rendered === `${bun} link`) {
      expect(cwd).toBe(repoRoot);
      return { command: rendered, output: "linked" };
    }
    if (rendered === "pro-cli daemon restart --json") {
      return { command: rendered, output: '{"ok":true}' };
    }
    if (rendered === "pro-cli --version") {
      return { command: rendered, output: "pro-cli 0.1.0\n" };
    }
    throw new Error(`Unexpected command: ${rendered}`);
  };
  return { calls, runCommand };
}

describe("updateProCli", () => {
  test("fast-forwards, relinks, then restarts the daemon before reporting version", () => {
    const { calls, runCommand } = fakeCheckout("https://github.com/ratacat/pro-cli.git");

    const result = updateProCli({ repoRoot, bun, runCommand });

    expect(result.version).toBe("pro-cli 0.1.0");
    expect(result.steps.map((step) => step.command)).toEqual([
      `git -C ${repoRoot} pull --ff-only origin main`,
      `${bun} install`,
      `${bun} link`,
      "pro-cli daemon restart --json",
    ]);
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      `git -C ${repoRoot} remote get-url origin`,
      `git -C ${repoRoot} branch --show-current`,
      `git -C ${repoRoot} status --porcelain`,
      `git -C ${repoRoot} pull --ff-only origin main`,
      `${bun} install`,
      `${bun} link`,
      "pro-cli daemon restart --json",
      "pro-cli --version",
    ]);
  });

  test("installs with the bun running pro-cli when none is given, since PATH may not have one", () => {
    const calls: string[] = [];
    const runCommand = (command: string, args: string[]): UpdateStep => {
      calls.push(command);
      if (args.includes("get-url")) return { command, output: "https://github.com/ratacat/pro-cli.git\n" };
      if (args.includes("--show-current")) return { command, output: "main\n" };
      return { command, output: "" };
    };

    updateProCli({ repoRoot, runCommand });

    expect(calls.filter((command) => command !== "git" && command !== "pro-cli")).toEqual([
      process.execPath,
      process.execPath,
    ]);
  });

  test.each([
    "git@github.com:skypher/pro-cli.git",
    "https://github.com/skypher/pro-cli",
    "ssh://git@github.com/skypher/pro-cli.git",
    "git@github.com:ratacat/pro-cli",
    "https://github.com/Ratacat/pro-cli.git/",
  ])("accepts origin %s", (origin) => {
    const { runCommand } = fakeCheckout(origin);
    expect(updateProCli({ repoRoot, bun, runCommand }).version).toBe("pro-cli 0.1.0");
  });

  test.each([
    "git@github.com:someone/pro-cli.git",
    "https://github.com/ratacat/pro-cli-other.git",
    "https://gitlab.com/ratacat/pro-cli.git",
  ])("refuses origin %s before touching the checkout", (origin) => {
    const { calls, runCommand } = fakeCheckout(origin);
    expect(() => updateProCli({ repoRoot, bun, runCommand })).toThrow(`Refusing to update checkout with origin ${origin}.`);
    expect(calls).toHaveLength(1);
  });
});
