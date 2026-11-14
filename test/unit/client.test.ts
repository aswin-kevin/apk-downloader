import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApkDownloader } from '../../src/client.js';
import {
  AbortError,
  AllSourcesFailedError,
  AppNotFoundError,
  ChecksumMismatchError,
  FileExistsError,
  InvalidOptionError,
  InvalidPackageError,
  SourceUnavailableError,
  VersionNotFoundError,
} from '../../src/errors.js';
import { builtinSources, DEFAULT_INFO_SOURCES, DEFAULT_SOURCES } from '../../src/sources/index.js';
import type {
  ApkFormat,
  AppInfo,
  ResolvedDownload,
  ResolveOptions,
  Source,
} from '../../src/types.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { makeZip } from '../helpers/zip.js';

const PKG = 'com.example.app';
const APK = Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(4096)]);
const XAPK = makeZip([
  { name: 'com.example.app.apk', data: 'base' },
  { name: 'config.arm64_v8a.apk', data: 'abi' },
  { name: 'Android/obb/com.example.app/main.1.obb', data: 'obb' },
]);

let server: TestServer;
let dir: string;
let fileHits: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'apkdl-client-'));
  fileHits = [];
  server = await startServer((req, res) => {
    fileHits.push(req.url ?? '');
    const body = req.url?.endsWith('.xapk') ? XAPK : APK;
    res.setHeader('content-length', String(body.length));
    res.end(body);
  });
});
afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

interface FakeSourceOptions {
  fail?: Error | ((pkg: string, opts: ResolveOptions) => Error | undefined);
  format?: ApkFormat;
  version?: string;
  info?: Partial<AppInfo>;
  listVersions?: boolean;
  checksum?: ResolvedDownload['checksum'];
}

function fakeSource(
  id: string,
  options: FakeSourceOptions = {},
): Source & { calls: ResolveOptions[] } {
  const calls: ResolveOptions[] = [];
  const format = options.format ?? 'apk';
  const info = (pkg: string): AppInfo => ({
    packageName: pkg,
    versionName: options.version ?? '1.0',
    versionCode: 10,
    source: id,
    ...options.info,
  });
  const failure = (pkg: string, opts: ResolveOptions) =>
    typeof options.fail === 'function' ? options.fail(pkg, opts) : options.fail;
  const source: Source & { calls: ResolveOptions[] } = {
    id,
    calls,
    async getInfo(pkg, opts) {
      const err = failure(pkg, { ...opts, version: 'latest', format: 'auto' });
      if (err) throw err;
      return info(pkg);
    },
    async resolve(pkg, opts) {
      calls.push(opts);
      const err = failure(pkg, opts);
      if (err) throw err;
      return {
        source: id,
        url: `${server.url}/${id}/${pkg}.${format}`,
        format,
        info: info(pkg),
        ...(options.checksum ? { checksum: options.checksum } : {}),
      };
    },
  };
  if (options.listVersions) {
    source.listVersions = async () => [{ versionName: '1.0', versionCode: 10 }];
  }
  return source;
}

const notFound = (id: string) => new AppNotFoundError(PKG, { source: id });
const unavailable = (id: string) =>
  new SourceUnavailableError('down', { source: id, reason: 'blocked' });

function client(
  sources: Array<string | Source>,
  extra: ConstructorParameters<typeof ApkDownloader>[0] = {},
) {
  return new ApkDownloader({ sources, infoSources: sources, retries: 0, timeout: 2000, ...extra });
}

describe('source registry defaults', () => {
  it('ships aptoide, apkpure and fdroid with the amended default orders', () => {
    expect(Object.keys(builtinSources).sort()).toEqual(['apkpure', 'aptoide', 'fdroid']);
    expect(DEFAULT_SOURCES).toEqual(['aptoide', 'apkpure', 'fdroid']);
    expect(DEFAULT_INFO_SOURCES).toEqual(['aptoide', 'fdroid', 'apkpure']);
    expect(new ApkDownloader().sources).toEqual(['aptoide', 'apkpure', 'fdroid']);
  });
});

describe('ApkDownloader.download', () => {
  it('downloads to outDir with the default file name and reports the result', async () => {
    const result = await client([fakeSource('one')]).download(PKG, { outDir: dir });
    expect(result).toEqual({
      packageName: PKG,
      filePath: path.join(dir, 'com.example.app-1.0.apk'),
      format: 'apk',
      size: APK.length,
      sha256: createHash('sha256').update(APK).digest('hex'),
      source: 'one',
      info: expect.objectContaining({ packageName: PKG, versionName: '1.0' }),
      skipped: false,
    });
    expect((await readFile(result.filePath)).equals(APK)).toBe(true);
  });

  it('passes version, format, allowUntrusted and signal to the source', async () => {
    const source = fakeSource('one');
    const controller = new AbortController();
    await client([source]).download(PKG, {
      outDir: dir,
      version: '2.0',
      format: 'apk',
      allowUntrusted: true,
      signal: controller.signal,
    });
    expect(source.calls[0]).toMatchObject({
      version: '2.0',
      format: 'apk',
      allowUntrusted: true,
      signal: controller.signal,
    });
  });

  it('uses the filename template', async () => {
    const result = await client([fakeSource('one')]).download(PKG, {
      outDir: dir,
      fileName: '{source}-{versionCode}.{ext}',
    });
    expect(path.basename(result.filePath)).toBe('one-10.apk');
  });

  it('falls back to next source on SourceUnavailableError', async () => {
    const first = fakeSource('first', { fail: unavailable('first') });
    const result = await client([first, fakeSource('second')]).download(PKG, { outDir: dir });
    expect(result.source).toBe('second');
    expect(first.calls).toHaveLength(1);
  });

  it('falls back when the transfer itself fails with a fallback-eligible error', async () => {
    const broken: Source = {
      ...fakeSource('broken'),
      resolve: async (pkg) => ({
        source: 'broken',
        url: `${server.url.replace(/:\d+$/, ':1')}/x.apk`,
        format: 'apk',
        info: { packageName: pkg, source: 'broken' },
      }),
    };
    const result = await client([broken, fakeSource('good')]).download(PKG, { outDir: dir });
    expect(result.source).toBe('good');
  });

  it('all not-found → AppNotFoundError', async () => {
    const err = await client([
      fakeSource('a', { fail: notFound('a') }),
      fakeSource('b', { fail: notFound('b') }),
    ])
      .download(PKG, { outDir: dir })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppNotFoundError);
  });

  it('not-found mixed with version-not-found → VersionNotFoundError', async () => {
    const err = await client([
      fakeSource('a', { fail: notFound('a') }),
      fakeSource('b', { fail: new VersionNotFoundError(PKG, '9', { source: 'b' }) }),
    ])
      .download(PKG, { outDir: dir, version: '9' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionNotFoundError);
  });

  it('mixed failures → AllSourcesFailedError with errors[]', async () => {
    const err = await client([
      fakeSource('a', { fail: notFound('a') }),
      fakeSource('b', { fail: unavailable('b') }),
    ])
      .download(PKG, { outDir: dir })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllSourcesFailedError);
    expect((err as AllSourcesFailedError).errors.map((e) => e.source)).toEqual(['a', 'b']);
  });

  it('pinned source does not fall back and rethrows its own error', async () => {
    const second = fakeSource('second');
    const err = await client([fakeSource('first', { fail: unavailable('first') }), second])
      .download(PKG, { outDir: dir, source: 'first' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(second.calls).toHaveLength(0);
  });

  it('unknown source id → InvalidOptionError', async () => {
    await expect(
      client([fakeSource('one')]).download(PKG, { source: 'nope' }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    expect(() => new ApkDownloader({ sources: ['nope'] })).toThrow(InvalidOptionError);
    expect(() => new ApkDownloader({ sources: [] })).toThrow(InvalidOptionError);
  });

  it('invalid package → InvalidPackageError before any request', async () => {
    const source = fakeSource('one');
    await expect(
      client([source]).download('not a package', { outDir: dir }),
    ).rejects.toBeInstanceOf(InvalidPackageError);
    expect(source.calls).toHaveLength(0);
  });

  it('ifExists skip returns skipped:true without transferring the file', async () => {
    const target = path.join(dir, 'com.example.app-1.0.apk');
    await writeFile(target, APK);
    const result = await client([fakeSource('one')]).download(PKG, { outDir: dir });
    expect(result).toMatchObject({ skipped: true, filePath: target, size: APK.length });
    expect(result.sha256).toBe(createHash('sha256').update(APK).digest('hex'));
    expect(fileHits).toEqual([]);
  });

  it('ifExists error → FileExistsError (no fallback)', async () => {
    await writeFile(path.join(dir, 'com.example.app-1.0.apk'), 'old');
    const second = fakeSource('second');
    await expect(
      client([fakeSource('one'), second]).download(PKG, { outDir: dir, ifExists: 'error' }),
    ).rejects.toBeInstanceOf(FileExistsError);
    expect(second.calls).toHaveLength(0);
  });

  it('ifExists overwrite replaces the file', async () => {
    const target = path.join(dir, 'com.example.app-1.0.apk');
    await writeFile(target, 'old');
    const result = await client([fakeSource('one')]).download(PKG, {
      outDir: dir,
      ifExists: 'overwrite',
    });
    expect(result.skipped).toBe(false);
    expect((await readFile(target)).equals(APK)).toBe(true);
  });

  it('checksum mismatch stops without trying other sources', async () => {
    const second = fakeSource('second');
    const err = await client([
      fakeSource('one', { checksum: { algorithm: 'md5', value: '0'.repeat(32) } }),
      second,
    ])
      .download(PKG, { outDir: dir })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecksumMismatchError);
    expect(second.calls).toHaveLength(0);
  });

  it('abort stops immediately with AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const second = fakeSource('second');
    const first = fakeSource('first', {
      fail: (_p, o) => (o.signal?.aborted ? new AbortError() : undefined),
    });
    await expect(
      client([first, second]).download(PKG, { outDir: dir, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(second.calls).toHaveLength(0);
  });

  it('extract:true on xapk returns extractedFiles under <outDir>/<package>/', async () => {
    const result = await client([fakeSource('one', { format: 'xapk' })]).download(PKG, {
      outDir: dir,
      extract: true,
    });
    expect(result.format).toBe('xapk');
    expect(path.basename(result.filePath)).toBe('com.example.app-1.0.xapk');
    const base = path.join(dir, PKG);
    expect(result.extractedFiles?.map((f) => path.relative(base, f)).sort()).toEqual([
      'Android/obb/com.example.app/main.1.obb',
      'com.example.app.apk',
      'config.arm64_v8a.apk',
    ]);
  });

  it('extract is ignored for plain APKs', async () => {
    const result = await client([fakeSource('one')]).download(PKG, { outDir: dir, extract: true });
    expect(result.extractedFiles).toBeUndefined();
  });

  it('reports progress', async () => {
    const onProgress = vi.fn();
    await client([fakeSource('one')]).download(PKG, { outDir: dir, onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ transferred: APK.length }),
    );
  });
});

describe('ApkDownloader.downloadMany', () => {
  it('never rejects, returns ok/error per item, honours concurrency', async () => {
    let running = 0;
    let peak = 0;
    const slow: Source = {
      ...fakeSource('slow'),
      async resolve(pkg, opts) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        if (pkg === 'com.missing.app') throw new AppNotFoundError(pkg, { source: 'slow' });
        return fakeSource('slow').resolve(pkg, opts);
      },
    };
    const results = await client([slow]).downloadMany(['a.b', 'com.missing.app', 'c.d', 'e.f'], {
      outDir: dir,
      concurrency: 2,
    });
    expect(results.map((r) => [r.packageName, r.ok])).toEqual([
      ['a.b', true],
      ['com.missing.app', false],
      ['c.d', true],
      ['e.f', true],
    ]);
    const failed = results[1];
    expect(failed?.ok === false && failed.error).toBeInstanceOf(AppNotFoundError);
    expect(peak).toBe(2);
  });

  it('reports progress and completion per package', async () => {
    const progress = new Set<string>();
    const done: string[] = [];
    await client([fakeSource('one')]).downloadMany(['a.b', 'com.missing.app'], {
      outDir: dir,
      onItemProgress: (pkg, p) => {
        expect(p.transferred).toBeGreaterThan(0);
        progress.add(pkg);
      },
      onItemDone: (r) => done.push(`${r.packageName}:${r.ok}`),
    });
    expect([...progress]).toEqual(['a.b', 'com.missing.app']);
    expect(done.sort()).toEqual(['a.b:true', 'com.missing.app:true']);
  });

  it('dedupes packages', async () => {
    const source = fakeSource('one');
    const results = await client([source]).downloadMany(['a.b', 'a.b', 'c.d'], { outDir: dir });
    expect(results.map((r) => r.packageName)).toEqual(['a.b', 'c.d']);
    expect(source.calls).toHaveLength(2);
  });

  it('reports invalid package names as failed items', async () => {
    const results = await client([fakeSource('one')]).downloadMany(['bad name'], { outDir: dir });
    expect(results[0]).toMatchObject({ ok: false, error: expect.any(InvalidPackageError) });
  });
});

describe('ApkDownloader.getInfo / listVersions', () => {
  it('getInfo uses the info order and falls back', async () => {
    const info = await new ApkDownloader({
      sources: [fakeSource('dl')],
      infoSources: [
        fakeSource('first', { fail: unavailable('first') }),
        fakeSource('second', { version: '3.0' }),
      ],
    }).getInfo(PKG);
    expect(info).toMatchObject({ source: 'second', versionName: '3.0' });
  });

  it('getInfo can be pinned to a source', async () => {
    const c = client([fakeSource('a', { version: '1' }), fakeSource('b', { version: '2' })]);
    expect((await c.getInfo(PKG, { source: 'b' })).versionName).toBe('2');
  });

  it('getInfo validates the package name', async () => {
    await expect(client([fakeSource('a')]).getInfo('nope')).rejects.toBeInstanceOf(
      InvalidPackageError,
    );
  });

  it('listVersions skips sources without it', async () => {
    const versions = await client([
      fakeSource('a'),
      fakeSource('b', { listVersions: true }),
    ]).listVersions(PKG);
    expect(versions).toEqual([{ versionName: '1.0', versionCode: 10 }]);
  });

  it('listVersions on a pinned source without support → InvalidOptionError', async () => {
    await expect(
      client([fakeSource('a')]).listVersions(PKG, { source: 'a' }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
  });
});

describe('ApkDownloader.registerSource', () => {
  it('registerSource then pin it', async () => {
    const c = client([fakeSource('one')]);
    c.registerSource(fakeSource('custom'));
    expect(c.sources).toEqual(['one', 'custom']);
    const result = await c.download(PKG, { outDir: dir, source: 'custom' });
    expect(result.source).toBe('custom');
  });

  it('rejects duplicate or invalid ids', () => {
    const c = client([fakeSource('one')]);
    expect(() => c.registerSource(fakeSource('one'))).toThrow(InvalidOptionError);
    expect(() => c.registerSource(fakeSource(''))).toThrow(InvalidOptionError);
  });

  it('accepts custom Source objects in the constructor', async () => {
    const c = new ApkDownloader({ sources: ['aptoide', fakeSource('mine')] });
    expect(c.sources).toEqual(['aptoide', 'mine']);
  });
});

describe('module exports', () => {
  it('exposes the public API from the package entry point', async () => {
    const api = await import('../../src/index.js');
    for (const name of [
      'ApkDownloader',
      'download',
      'downloadMany',
      'getInfo',
      'listVersions',
      'downloadAPK',
      'builtinSources',
      'aptoide',
      'apkpure',
      'fdroid',
      'createAptoideSource',
      'createApkpureSource',
      'createFdroidSource',
      'ApkDownloaderError',
      'AppNotFoundError',
      'VERSION',
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  it('downloadAPK downloads into ./Downloads and warns once', async () => {
    const api = await import('../../src/index.js');
    const cwd = process.cwd();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const download = vi
      .spyOn(api.ApkDownloader.prototype, 'download')
      .mockResolvedValue({} as never);
    try {
      process.chdir(dir);
      await api.downloadAPK(PKG);
      await api.downloadAPK(PKG);
      expect(download).toHaveBeenCalledWith(PKG, { outDir: path.join(dir, 'Downloads') });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ type: 'DeprecationWarning' });
    } finally {
      process.chdir(cwd);
      warn.mockRestore();
      download.mockRestore();
    }
    expect(await readdir(dir)).toEqual([]);
  });
});
