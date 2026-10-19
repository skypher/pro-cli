#!/usr/bin/env bun
import { runCli } from "./app";

// process.exit drops output still queued for a pipe: a reader slower than pro-cli got only the
// first 64 KiB. Writes go out in order through Bun.write and are awaited before exiting.
let written: Promise<unknown> = Promise.resolve();
const write = (sink: typeof Bun.stdout, text: string) => {
  // A reader that is gone cannot be written to; that must not change the exit code.
  written = written.then(() => Bun.write(sink, text)).catch(() => undefined);
};

const exitCode = await runCli(Bun.argv.slice(2), {
  stdout: (text) => write(Bun.stdout, text),
  stderr: (text) => write(Bun.stderr, text),
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  cwd: process.cwd(),
});

await written;
process.exit(exitCode);
