import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, ProError } from "./errors";

// Upstream, and the fork that deployments of it track.
const ALLOWED_REPOS = new Set(["github.com/ratacat/pro-cli", "github.com/skypher/pro-cli"]);

export interface UpdateStep {
  command: string;
  output: string;
}

export interface UpdateResult {
  repoRoot: string;
  branch: string;
  version: string;
  steps: UpdateStep[];
}

export interface UpdateOptions {
  repoRoot?: string;
  /** The bun to install with; defaults to the one running pro-cli, which need not be on PATH. */
  bun?: string;
  runCommand?: (command: string, args: string[], cwd?: string) => UpdateStep;
}

export function updateProCli(options: UpdateOptions = {}): UpdateResult {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bun = options.bun ?? process.execPath;
  const runCommand = options.runCommand ?? run;
  const origin = runCommand("git", ["-C", repoRoot, "remote", "get-url", "origin"]).output.trim();
  if (!ALLOWED_REPOS.has(repoKey(origin))) {
    throw new ProError("UPDATE_WRONG_ORIGIN", `Refusing to update checkout with origin ${origin}.`, {
      exitCode: EXIT.invalidArgs,
      suggestions: [`Expected ${[...ALLOWED_REPOS].map((repo) => `https://${repo}.git`).join(" or ")}.`],
    });
  }

  const branch = runCommand("git", ["-C", repoRoot, "branch", "--show-current"]).output.trim();
  if (!branch) {
    throw new ProError("UPDATE_DETACHED_HEAD", "Refusing to update a detached checkout.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Check out main, then rerun pro-cli update."],
    });
  }
  if (branch !== "main") {
    throw new ProError("UPDATE_WRONG_BRANCH", `Refusing to update branch ${branch}.`, {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Switch to main, then rerun pro-cli update."],
    });
  }

  const dirty = runCommand("git", ["-C", repoRoot, "status", "--porcelain"]).output.trim();
  if (dirty) {
    throw new ProError("UPDATE_DIRTY_WORKTREE", "Refusing to update with uncommitted changes.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Commit or stash changes, then rerun pro-cli update."],
    });
  }

  const steps = [
    runCommand("git", ["-C", repoRoot, "pull", "--ff-only", "origin", "main"]),
    runCommand(bun, ["install"], repoRoot),
    runCommand(bun, ["link"], repoRoot),
    runCommand("pro-cli", ["daemon", "restart", "--json"]),
  ];
  const version = runCommand("pro-cli", ["--version"]).output.trim();

  return { repoRoot, branch, version, steps };
}

/** Reduce a GitHub https or ssh URL to host/owner/repo, so every spelling of one repo compares equal. */
function repoKey(url: string): string {
  return url
    .replace(/^(?:https:\/\/|ssh:\/\/git@|git@)/, "")
    .replace(/^github\.com:/, "github.com/")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function run(command: string, args: string[], cwd?: string): UpdateStep {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  const renderedCommand = [command, ...args].join(" ");
  if (result.error || result.status !== 0) {
    throw new ProError("UPDATE_COMMAND_FAILED", `${renderedCommand} failed.`, {
      exitCode: EXIT.internal,
      suggestions: ["Inspect the command output, fix the checkout, then rerun pro-cli update."],
      details: {
        command: renderedCommand,
        status: result.status,
        stderr: compact(result.stderr || result.error?.message || ""),
        stdout: compact(result.stdout || ""),
      },
      cause: result.error,
    });
  }
  return {
    command: renderedCommand,
    output: compact(result.stdout || result.stderr || ""),
  };
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}
