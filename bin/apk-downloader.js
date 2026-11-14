#!/usr/bin/env node
import { run } from '../dist/cli/main.js';

const controller = new AbortController();
let interrupted = false;

// The reader went away (e.g. `apk-downloader sources | head -1`): stop quietly like other CLIs.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
    controller.abort();
    process.exit(process.exitCode ?? 0);
  });
}

process.on('SIGINT', () => {
  if (interrupted) process.exit(130); // second Ctrl-C: give up immediately
  interrupted = true;
  process.stderr.write('\nCancelling… (press Ctrl-C again to force)\n');
  controller.abort();
});

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTTY: Boolean(process.stderr.isTTY),
  env: process.env,
  signal: controller.signal,
});

process.exitCode = interrupted ? 130 : code;
