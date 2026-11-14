import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { run, type CliIO } from '../../../src/cli/main.js';
import type { ApkDownloader, DownloadManyOptions } from '../../../src/client.js';
import { AllSourcesFailedError, AppNotFoundError, SourceUnavailableError } from '../../../src/errors.js';
import type { AppInfo, BatchResult, DownloadResult } from '../../../src/types.js';

/** SGR color/style sequences (cursor control such as clear-line is allowed). */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[\d;]*m/;

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, text: () => text };
}

const okResult = (packageName: string): DownloadResult => ({
  packageName,
  filePath: `/out/${packageName}-1.0.apk`,
  format: 'apk',
  size: 2_500_000,
  sha256: 'ab'.repeat(32),
  source: 'aptoide',
  info: { packageName, versionName: '1.0', source: 'aptoide' },
  skipped: false,
});

interface Recorded {
  batches: Array<{ packages: string[]; options: DownloadManyOptions }>;
}

function fakeClient(recorded: Recorded = { batches: [] }): ApkDownloader {
  return {
    async downloadMany(packages: string[], options: DownloadManyOptions): Promise<BatchResult[]> {
      recorded.batches.push({ packages, options });
      return packages.map((packageName): BatchResult => {
        if (packageName === 'com.missing.app') {
          return { packageName, ok: false, error: new AppNotFoundError(packageName) };
        }
        if (packageName === 'com.broken.app') {
          return {
            packageName,
            ok: false,
            error: new AllSourcesFailedError(packageName, [
              new SourceUnavailableError('blocked', { source: 'apkpure', reason: 'blocked' }),
            ]),
          };
        }
        options.onItemProgress?.(packageName, { transferred: 100, total: 200, percent: 50, bytesPerSecond: 1000 });
        return { packageName, ok: true, result: okResult(packageName) };
      }).map((r) => {
        options.onItemDone?.(r);
        return r;
      });
    },
    async getInfo(packageName: string): Promise<AppInfo> {
      if (packageName === 'com.missing.app') throw new AppNotFoundError(packageName);
      return { packageName, name: 'Example', versionName: '1.0', versionCode: 10, size: 1024, source: 'aptoide', trust: 'TRUSTED' };
    },
    async listVersions() {
      return [{ versionName: '1.0', versionCode: 10 }];
    },
  } as unknown as ApkDownloader;
}

async function cli(argv: string[], options: { stdin?: string; isTTY?: boolean; env?: NodeJS.ProcessEnv; client?: ApkDownloader } = {}) {
  const stdout = sink();
  const stderr = sink();
  const io: CliIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([options.stdin ?? '']),
    isTTY: options.isTTY ?? false,
    env: options.env ?? {},
    client: options.client ?? fakeClient(),
  };
  const code = await run(argv, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('cli run()', () => {
  it('--help prints usage to stdout and exits 0', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage:/);
    expect(stdout).toContain('--app-version');
  });

  it('-V prints the version', async () => {
    const { code, stdout } = await cli(['-V']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('2.0.0');
  });

  it('usage errors exit 2 with a hint on stderr', async () => {
    const { code, stdout, stderr } = await cli(['--bogus']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/unknown option/i);
    expect(stderr).toMatch(/--help/);
  });

  it('download with no packages is a usage error', async () => {
    const { code } = await cli(['-o', 'x']);
    expect(code).toBe(2);
  });

  it('downloads and exits 0 when everything succeeds', async () => {
    const recorded: Recorded = { batches: [] };
    const { code, stdout, stderr } = await cli(['com.a.b', '-o', 'out', '-c', '3'], { client: fakeClient(recorded) });
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('com.a.b');
    expect(stderr).toContain('/out/com.a.b-1.0.apk');
    expect(recorded.batches[0]).toMatchObject({ packages: ['com.a.b'], options: { outDir: 'out', concurrency: 3 } });
  });

  it('exits 1 if any download failed and explains why', async () => {
    const { code, stderr } = await cli(['com.a.b', 'com.missing.app']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/com\.missing\.app.*not found/i);
  });

  it('--verbose lists per-source failures', async () => {
    const { stderr } = await cli(['com.broken.app', '--verbose']);
    expect(stderr).toMatch(/apkpure.*blocked/);
  });

  it('--json writes exactly one JSON document to stdout and nothing else', async () => {
    const { code, stdout, stderr } = await cli(['com.a.b', 'com.missing.app', '--json']);
    expect(code).toBe(1);
    expect(stderr).toBe('');
    const doc = JSON.parse(stdout) as { results: Array<Record<string, unknown>> };
    expect(doc.results).toEqual([
      { packageName: 'com.a.b', ok: true, result: okResult('com.a.b') },
      {
        packageName: 'com.missing.app',
        ok: false,
        error: { name: 'AppNotFoundError', code: 'ERR_APP_NOT_FOUND', message: expect.any(String) },
      },
    ]);
  });

  it('reads packages from stdin, ignoring blank lines and comments', async () => {
    const recorded: Recorded = { batches: [] };
    await cli(['-i', '-', 'com.x.y'], { stdin: '# list\ncom.a.b\n\n  org.c.d  # trailing\n', client: fakeClient(recorded) });
    expect(recorded.batches[0]?.packages).toEqual(['com.x.y', 'com.a.b', 'org.c.d']);
  });

  it('a missing input file exits 2', async () => {
    const { code, stderr } = await cli(['-i', '/nonexistent/list.txt']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/cannot read/i);
  });

  it('info --json prints AppInfo', async () => {
    const { code, stdout } = await cli(['info', 'com.a.b', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ packageName: 'com.a.b', versionName: '1.0' });
  });

  it('info in human mode shows the key fields', async () => {
    const { stdout } = await cli(['info', 'com.a.b']);
    expect(stdout).toMatch(/Example/);
    expect(stdout).toMatch(/1\.0 \(10\)/);
    expect(stdout).toMatch(/TRUSTED/);
  });

  it('info for a missing app exits 1', async () => {
    const { code, stderr } = await cli(['info', 'com.missing.app']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/not found/i);
  });

  it('versions prints one version per line', async () => {
    const { code, stdout } = await cli(['versions', 'com.a.b']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/1\.0\s+10/);
  });

  it('sources lists the built-in sources', async () => {
    const { stdout } = await cli(['sources']);
    for (const id of ['aptoide', 'apkpure', 'fdroid']) expect(stdout).toContain(id);
    const json = JSON.parse((await cli(['sources', '--json'])).stdout) as Array<{ id: string }>;
    expect(json.map((s) => s.id)).toEqual(['aptoide', 'apkpure', 'fdroid']);
  });

  it('no ANSI colors when NO_COLOR is set or output is not a TTY', async () => {
    expect((await cli(['com.a.b'], { isTTY: true, env: { NO_COLOR: '1' } })).stderr).not.toMatch(ANSI);
    expect((await cli(['com.a.b'], { isTTY: false })).stderr).not.toMatch(ANSI);
    expect((await cli(['com.a.b'], { isTTY: true })).stderr).toMatch(ANSI);
  });

  it('progress is drawn only on a TTY and never with --quiet or --json', async () => {
    const progressLine = /50(\.0)?%/;
    expect((await cli(['com.a.b'], { isTTY: true })).stderr).toMatch(progressLine);
    expect((await cli(['com.a.b'], { isTTY: false })).stderr).not.toMatch(progressLine);
    expect((await cli(['com.a.b', '-q'], { isTTY: true })).stderr).not.toMatch(progressLine);
  });

  it('--quiet prints only failures', async () => {
    const { stderr } = await cli(['com.a.b', 'com.missing.app', '-q']);
    expect(stderr).not.toContain('com.a.b');
    expect(stderr).toContain('com.missing.app');
  });

  it('unknown --source exits 2', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await run(['com.a.b', '-s', 'nope'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: Readable.from(['']),
      isTTY: false,
      env: {},
    });
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/unknown source/i);
  });
});
