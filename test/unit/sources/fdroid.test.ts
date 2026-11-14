import { describe, expect, it } from 'vitest';
import { AppNotFoundError, SourceUnavailableError, VersionNotFoundError } from '../../../src/errors.js';
import { fdroid } from '../../../src/sources/fdroid.js';
import type { ResolveOptions } from '../../../src/types.js';
import { fakeHttp, fixture, type FakeResponse } from '../../helpers/fake-http.js';

const FDROID = 'org.fdroid.fdroid';
const VLC = 'org.videolan.vlc';
const API = 'https://f-droid.org/api/v1/packages/';
const REPO = 'https://f-droid.org/repo/';

const apiFdroid: [string, FakeResponse] = [`${API}${FDROID}`, { json: fixture('fdroid/packages-fdroid.json') }];
const apiVlc: [string, FakeResponse] = [`${API}${VLC}`, { json: fixture('fdroid/packages-vlc.json') }];
const hosted = (size: number): FakeResponse => ({ status: 200, headers: { 'content-length': String(size) } });
const missing: FakeResponse = { status: 404 };

function opts(http: ResolveOptions['http'], extra: Partial<ResolveOptions> = {}): ResolveOptions {
  return { http, version: 'latest', format: 'auto', ...extra };
}

describe('fdroid source', () => {
  it('has a stable id and description', () => {
    expect(fdroid.id).toBe('fdroid');
    expect(fdroid.description).toMatch(/open-source/i);
  });

  it('getInfo reports the suggested version without touching the repo', async () => {
    const http = fakeHttp([apiFdroid]);
    expect(await fdroid.getInfo(FDROID, { http })).toEqual({
      packageName: FDROID,
      versionName: '1.23.2',
      versionCode: 1023052,
      format: 'apk',
      source: 'fdroid',
    });
    expect(http.calls.map((c) => c.url)).toEqual([`${API}${FDROID}`]);
  });

  it('unknown package (404 NOT_FOUND) throws AppNotFoundError', async () => {
    const http = fakeHttp([['api/v1', { status: 404, json: fixture('fdroid/packages-notfound.json') }]]);
    const err = await fdroid.getInfo('com.whatsapp', { http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppNotFoundError);
    expect((err as AppNotFoundError).source).toBe('fdroid');
  });

  it('other API failures become SourceUnavailableError', async () => {
    const http = fakeHttp([['api/v1', { status: 500, body: 'oops' }]]);
    expect(((await fdroid.getInfo(FDROID, { http }).catch((e: unknown) => e)) as SourceUnavailableError).reason).toBe(
      'http-500',
    );
    const bad = fakeHttp([['api/v1', { json: { packageName: FDROID } }]]);
    expect(((await fdroid.getInfo(FDROID, { http: bad }).catch((e: unknown) => e)) as SourceUnavailableError).reason).toBe(
      'invalid-response',
    );
  });

  it('resolve latest uses the suggested version when it is hosted', async () => {
    const http = fakeHttp([apiFdroid, [`${REPO}${FDROID}_1023052.apk`, hosted(12_000_000)]]);
    const resolved = await fdroid.resolve(FDROID, opts(http));
    expect(resolved).toEqual({
      source: 'fdroid',
      url: `${REPO}${FDROID}_1023052.apk`,
      format: 'apk',
      fileName: `${FDROID}_1023052.apk`,
      size: 12_000_000,
      info: { packageName: FDROID, versionName: '1.23.2', versionCode: 1023052, size: 12_000_000, format: 'apk', source: 'fdroid' },
    });
    expect(http.calls[1]?.init?.method).toBe('HEAD');
  });

  it('resolve latest falls back to the newest hosted version when the suggested file is gone', async () => {
    const http = fakeHttp([
      apiFdroid,
      [`${REPO}${FDROID}_1023052.apk`, missing],
      [`${REPO}${FDROID}_2000053.apk`, hosted(12_774_751)],
    ]);
    const resolved = await fdroid.resolve(FDROID, opts(http));
    expect(resolved.info).toMatchObject({ versionName: '2.0.3', versionCode: 2000053 });
  });

  it('gives up after three missing files', async () => {
    const http = fakeHttp([apiFdroid, [REPO, missing]]);
    const err = await fdroid.resolve(FDROID, opts(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('not-hosted');
    expect(http.calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(3);
  });

  it.each([['2.0.2', 2000052], ['2000051', 2000051]])('resolves version %s', async (version, code) => {
    const http = fakeHttp([apiFdroid, [`${REPO}${FDROID}_${code}.apk`, hosted(1)]]);
    const resolved = await fdroid.resolve(FDROID, opts(http, { version }));
    expect(resolved.info.versionCode).toBe(code);
  });

  it('unknown or no-longer-hosted versions throw VersionNotFoundError', async () => {
    const http = fakeHttp([apiFdroid, [REPO, missing]]);
    await expect(fdroid.resolve(FDROID, opts(http, { version: '9.9' }))).rejects.toBeInstanceOf(VersionNotFoundError);
    await expect(fdroid.resolve(FDROID, opts(http, { version: '2.0.2' }))).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it('refuses to guess between per-architecture builds of one version', async () => {
    const http = fakeHttp([apiVlc, [REPO, hosted(1)]]);
    const err = await fdroid.resolve(VLC, opts(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('ambiguous-abi');
    expect((err as Error).message).toContain('13070205');
    expect((err as Error).message).toContain('13070208');
    await expect(fdroid.resolve(VLC, opts(http, { version: '3.7.1' }))).rejects.toMatchObject({ reason: 'ambiguous-abi' });
  });

  it('an exact versionCode selects one per-architecture build', async () => {
    const http = fakeHttp([apiVlc, [`${REPO}${VLC}_13070206.apk`, hosted(40_000_000)]]);
    const resolved = await fdroid.resolve(VLC, opts(http, { version: '13070206' }));
    expect(resolved.url).toBe(`${REPO}${VLC}_13070206.apk`);
  });

  it('format xapk is unsupported', async () => {
    const http = fakeHttp([]);
    const err = await fdroid.resolve(FDROID, opts(http, { format: 'xapk' })).catch((e: unknown) => e);
    expect((err as SourceUnavailableError).reason).toBe('format-unsupported');
    expect(http.calls).toHaveLength(0);
  });

  it('listVersions maps the package list', async () => {
    const http = fakeHttp([apiFdroid]);
    const list = await fdroid.listVersions!(FDROID, { http });
    expect(list).toHaveLength(12);
    expect(list[0]).toEqual({ versionName: '2.0.3', versionCode: 2000053 });
  });
});
