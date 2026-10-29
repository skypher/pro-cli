#!/usr/bin/env bun
import { runCli } from "./app";

// process.exit drops output still queued for a pipe: a reader slower than pro-cli got only the
// first 64 KiB. Writes go out in order and are awaited before exiting. They use process.stdout,
// not Bun.write: once process.stdout exists, Bun 1.4.4's Bun.write sent the first 64 KiB of a
// 64-270 KiB output twice.
let written: Promise<unknown> = Promise.resolve();
const write = (stream: NodeJS.WriteStream, text: string) => {
  // A reader that is gone cannot be written to; that must not change the exit code.
  written = written.then(() => new Promise<void>((resolve) => stream.write(text, () => resolve())));
};
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

const exitCode = await runCli(Bun.argv.slice(2), {
  stdout: (text) => write(process.stdout, text),
  stderr: (text) => write(process.stderr, text),
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  cwd: process.cwd(),
});

await written;
process.exit(exitCode);
