import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadToFile } from '../../src/download/downloader.js';
import {
  AbortError,
  ChecksumMismatchError,
  NetworkError,
  SourceUnavailableError,
  TimeoutError,
} from '../../src/errors.js';
import { HttpClient } from '../../src/http/client.js';
import type { Progress, ResolvedDownload } from '../../src/types.js';
import { startServer, type TestServer } from '../helpers/server.js';

const APK = Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(256 * 1024)]);
const SHA256 = createHash('sha256').update(APK).digest('hex');
const MD5 = createHash('md5').update(APK).digest('hex');

let server: TestServer | undefined;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'apkdl-test-'));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const http = new HttpClient({
  timeout: 2000,
  retries: 0,
  userAgent: 'test',
  sleep: async () => {},
});

function resolved(url: string, extra: Partial<ResolvedDownload> = {}): ResolvedDownload {
  return {
    source: 'test',
    url,
    format: 'apk',
    info: { packageName: 'a.b', source: 'test' },
    ...extra,
  };
}

/** Serve `body`, optionally chunked (no content-length) and with a delay between chunks. */
function serve(
  body: Buffer,
  { chunked = false, chunkDelay = 0, contentType = 'application/vnd.android.package-archive' } = {},
) {
  return startServer(async (_req, res) => {
    res.setHeader('content-type', contentType);
    if (!chunked) res.setHeader('content-length', String(body.length));
    const size = 16 * 1024;
    for (let offset = 0; offset < body.length; offset += size) {
      if (res.destroyed) return;
      res.write(body.subarray(offset, offset + size));
      if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay));
    }
    res.end();
  });
}

const listDir = () => readdir(dir);

describe('downloadToFile', () => {
  it('writes the file and returns its size and sha256', async () => {
    server = await serve(APK);
    const target = path.join(dir, 'app.apk');
    const result = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target,
      verify: true,
    });
    expect(result).toEqual({ size: APK.length, sha256: SHA256 });
    expect((await readFile(target)).equals(APK)).toBe(true);
  });

  it('leaves no .part file behind on success', async () => {
    server = await serve(APK);
    await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
    });
    expect(await listDir()).toEqual(['app.apk']);
  });

  it('creates the destination directory', async () => {
    server = await serve(APK);
    const target = path.join(dir, 'nested', 'deeper', 'app.apk');
    await downloadToFile({ http, resolved: resolved(server.url), target, verify: true });
    expect((await readFile(target)).length).toBe(APK.length);
  });

  it('sends the headers required by the source', async () => {
    server = await serve(APK);
    await downloadToFile({
      http,
      resolved: resolved(server.url, { headers: { referer: 'https://example.com/' } }),
      target: path.join(dir, 'app.apk'),
      verify: true,
    });
    expect(server.requests[0]?.headers.referer).toBe('https://example.com/');
  });

  it('verifies a matching md5 checksum', async () => {
    server = await serve(APK);
    const result = await downloadToFile({
      http,
      resolved: resolved(server.url, { checksum: { algorithm: 'md5', value: MD5.toUpperCase() } }),
      target: path.join(dir, 'app.apk'),
      verify: true,
    });
    expect(result.sha256).toBe(SHA256);
  });

  it('checksum mismatch → ChecksumMismatchError and no files', async () => {
    server = await serve(APK);
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url, { checksum: { algorithm: 'md5', value: '0'.repeat(32) } }),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecksumMismatchError);
    expect((err as ChecksumMismatchError).actual).toBe(MD5);
    expect(await listDir()).toEqual([]);
  });

  it('verify:false skips the checksum', async () => {
    server = await serve(APK);
    await expect(
      downloadToFile({
        http,
        resolved: resolved(server.url, { checksum: { algorithm: 'md5', value: '0'.repeat(32) } }),
        target: path.join(dir, 'app.apk'),
        verify: false,
      }),
    ).resolves.toMatchObject({ sha256: SHA256 });
  });

  it('size mismatch → NetworkError and no files', async () => {
    server = await serve(APK, { chunked: true });
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url, { size: APK.length + 10 }),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(await listDir()).toEqual([]);
  });

  it('a connection cut short → NetworkError and no files', async () => {
    server = await startServer((_req, res) => {
      res.setHeader('content-length', String(APK.length));
      res.write(APK.subarray(0, 1000));
      setTimeout(() => res.destroy(), 20);
    });
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(await listDir()).toEqual([]);
  });

  it('rejects non-zip body', async () => {
    server = await serve(Buffer.from('<!DOCTYPE html><title>Just a moment...</title>'), {
      contentType: 'application/octet-stream',
    });
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('not-an-apk');
    expect((err as SourceUnavailableError).source).toBe('test');
    expect(await listDir()).toEqual([]);
  });

  it('rejects an empty body', async () => {
    server = await serve(Buffer.alloc(0));
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect((err as SourceUnavailableError).reason).toBe('not-an-apk');
  });

  it('HTTP errors on the file URL → NetworkError with status', async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end('gone');
    });
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).status).toBe(404);
  });

  it('abort cleans up part file', async () => {
    server = await serve(APK, { chunkDelay: 20 });
    const target = path.join(dir, 'app.apk');
    await writeFile(target, 'previous version');
    const controller = new AbortController();
    const pending = downloadToFile({
      http,
      resolved: resolved(server.url),
      target,
      verify: true,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.transferred > 32 * 1024) controller.abort();
      },
    });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(await listDir()).toEqual(['app.apk']);
    expect(await readFile(target, 'utf8')).toBe('previous version');
  });

  it('progress without content-length', async () => {
    server = await serve(APK, { chunked: true });
    const events: Progress[] = [];
    await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
      onProgress: (p) => events.push(p),
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.total).toBeUndefined();
      expect(event.percent).toBeUndefined();
    }
    expect(events.at(-1)?.transferred).toBe(APK.length);
  });

  it('throttles progress and always reports completion', async () => {
    server = await serve(APK, { chunkDelay: 5 });
    const events: Progress[] = [];
    const started = Date.now();
    await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
      onProgress: (p) => events.push(p),
    });
    const seconds = (Date.now() - started) / 1000;
    expect(events.length).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 2);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ transferred: APK.length, total: APK.length, percent: 100 });
    expect(last.bytesPerSecond).toBeGreaterThan(0);
  });

  it('stalled transfer → TimeoutError and no files', async () => {
    server = await startServer((_req, res) => {
      res.setHeader('content-length', String(APK.length));
      res.write(APK.subarray(0, 1000));
      /* then stall */
    });
    const err = await downloadToFile({
      http,
      resolved: resolved(server.url),
      target: path.join(dir, 'app.apk'),
      verify: true,
      idleTimeout: 150,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(await listDir()).toEqual([]);
  });
});
