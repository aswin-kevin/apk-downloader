/**
 * Live tests against the real upstreams. Opt-in: `APKDL_LIVE=1 npm run test:live`.
 * They download real files (tens of MB) into a temporary directory and delete them afterwards.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApkDownloader,
  AppNotFoundError,
  apkpure,
  aptoide,
  fdroid,
  HttpClientForTests,
  SourceUnavailableError,
} from './live-helpers.js';

const LIVE = process.env.APKDL_LIVE === '1';
const TIMEOUT = 180_000;

const SMALL_TRUSTED_APTOIDE = 'org.videolan.vlc';
const FDROID_APP = 'org.fdroid.fdroid';
const MISSING = 'com.nonexistent.zzzz';

let out: string;
const http = HttpClientForTests();

beforeAll(async () => {
  out = await mkdtemp(path.join(process.env.APKDL_OUT ?? tmpdir(), 'apkdl-live-'));
});
afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

async function isZip(file: string): Promise<boolean> {
  const head = (await readFile(file)).subarray(0, 4);
  return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

describe.skipIf(!LIVE)('live: aptoide', () => {
  it('getInfo returns rich metadata', { timeout: TIMEOUT }, async () => {
    const info = await aptoide.getInfo(SMALL_TRUSTED_APTOIDE, { http });
    expect(info).toMatchObject({
      packageName: SMALL_TRUSTED_APTOIDE,
      source: 'aptoide',
      trust: 'TRUSTED',
    });
    expect(info.versionName).toBeTruthy();
    expect(info.signature?.sha1).toMatch(/^[0-9A-F:]+$/);
  });

  it('listVersions is non-empty', { timeout: TIMEOUT }, async () => {
    const versions = await aptoide.listVersions!(SMALL_TRUSTED_APTOIDE, { http });
    expect(versions.length).toBeGreaterThan(1);
  });

  it('unknown package → AppNotFoundError', { timeout: TIMEOUT }, async () => {
    await expect(aptoide.getInfo(MISSING, { http })).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('downloads the latest trusted APK with a verified md5', { timeout: TIMEOUT }, async () => {
    const client = new ApkDownloader({ sources: ['aptoide'] });
    const result = await client.download(SMALL_TRUSTED_APTOIDE, { outDir: out });
    expect(result).toMatchObject({ source: 'aptoide', format: 'apk', skipped: false });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await isZip(result.filePath)).toBe(true);

    const again = await client.download(SMALL_TRUSTED_APTOIDE, { outDir: out });
    expect(again).toMatchObject({ skipped: true, sha256: result.sha256 });
  });

  it('downloads a specific older version by versionCode', { timeout: TIMEOUT }, async () => {
    const versions = await aptoide.listVersions!(SMALL_TRUSTED_APTOIDE, { http });
    const older = versions.find((v, i) => i > 0 && v.trust === 'TRUSTED');
    expect(older).toBeDefined();
    const result = await new ApkDownloader({ sources: ['aptoide'] }).download(
      SMALL_TRUSTED_APTOIDE,
      {
        outDir: out,
        version: String(older!.versionCode),
      },
    );
    expect(result.info.versionCode).toBe(older!.versionCode);
    expect(await isZip(result.filePath)).toBe(true);
  });
});

describe.skipIf(!LIVE)('live: apkpure', () => {
  it('is either reachable or cleanly reported as blocked', { timeout: TIMEOUT }, async () => {
    try {
      const info = await apkpure.getInfo(FDROID_APP, { http });
      expect(info.source).toBe('apkpure');
    } catch (error) {
      expect(error).toBeInstanceOf(SourceUnavailableError);
      expect((error as SourceUnavailableError).reason).toBe('blocked');
    }
  });
});

describe.skipIf(!LIVE)('live: fdroid', () => {
  it('getInfo and listVersions work', { timeout: TIMEOUT }, async () => {
    const info = await fdroid.getInfo(FDROID_APP, { http });
    expect(info).toMatchObject({ packageName: FDROID_APP, source: 'fdroid' });
    expect((await fdroid.listVersions!(FDROID_APP, { http })).length).toBeGreaterThan(0);
  });

  it('unknown package → AppNotFoundError', { timeout: TIMEOUT }, async () => {
    await expect(fdroid.getInfo('com.whatsapp', { http })).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('refuses to guess between per-ABI builds', { timeout: TIMEOUT }, async () => {
    const err = await fdroid
      .resolve('org.videolan.vlc', { http, version: 'latest', format: 'auto' })
      .catch((e: unknown) => e);
    expect((err as SourceUnavailableError).reason).toBe('ambiguous-abi');
  });
});

describe.skipIf(!LIVE)('live: fallback through the default source order', () => {
  it(
    'an app Aptoide does not trust and APKPure blocks still arrives from F-Droid',
    { timeout: TIMEOUT },
    async () => {
      const result = await new ApkDownloader().download(FDROID_APP, { outDir: out });
      expect(result.source).toBe('fdroid');
      expect(await isZip(result.filePath)).toBe(true);
    },
  );

  it('a package no source has → AppNotFoundError', { timeout: TIMEOUT }, async () => {
    const err = await new ApkDownloader()
      .download(MISSING, { outDir: out })
      .catch((e: unknown) => e);
    // APKPure may report "blocked" instead of "not found", which turns the summary into AllSourcesFailed.
    expect(err).toSatisfy(
      (e: unknown) =>
        e instanceof AppNotFoundError || (e as Error).name === 'AllSourcesFailedError',
    );
  });
});
