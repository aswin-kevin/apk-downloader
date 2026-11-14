/** End-to-end CLI tests against the built package. Opt-in: `APKDL_LIVE=1`, requires `npm run build`. */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.APKDL_LIVE === '1';
const TIMEOUT = 180_000;
const BIN = path.resolve('bin/apk-downloader.js');
const exec = promisify(execFile);

let out: string;
beforeAll(async () => {
  out = await mkdtemp(path.join(process.env.APKDL_OUT ?? tmpdir(), 'apkdl-cli-'));
});
afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe.skipIf(!LIVE)('live: CLI process behaviour', () => {
  it(
    'exits quietly when stdout is closed early (e.g. piped to head)',
    { timeout: TIMEOUT },
    async () => {
      // `true` exits without reading, so every write the CLI makes hits a closed pipe.
      const script = `(sleep 0.3; "${process.execPath}" "${BIN}" sources) | true`;
      const { stderr } = await exec('sh', ['-c', script]);
      expect(stderr).not.toMatch(/EPIPE|Unhandled|throw/);
    },
  );
});

describe.skipIf(!LIVE)('live: CLI', () => {
  it('downloads with --json and exits 0', { timeout: TIMEOUT }, async () => {
    const { code, stdout, stderr } = await cli(['org.fdroid.fdroid', '-o', out, '--json']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const doc = JSON.parse(stdout) as {
      results: Array<{ ok: boolean; result: { filePath: string; source: string } }>;
    };
    expect(doc.results[0]).toMatchObject({ ok: true, result: { source: 'fdroid' } });
    expect(doc.results[0]?.result.filePath.startsWith(out)).toBe(true);
  });

  it('info exits 0 and prints metadata', { timeout: TIMEOUT }, async () => {
    const { code, stdout } = await cli(['info', 'org.videolan.vlc']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/VLC/);
  });

  it('an unknown app exits 1', { timeout: TIMEOUT }, async () => {
    const { code, stderr } = await cli(['com.nonexistent.zzzz', '-o', out]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/com\.nonexistent\.zzzz/);
  });
});
