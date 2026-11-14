import { describe, expect, it } from 'vitest';
import { AppNotFoundError, SourceUnavailableError, VersionNotFoundError } from '../../../src/errors.js';
import { apkpure } from '../../../src/sources/apkpure.js';
import type { ResolveOptions } from '../../../src/types.js';
import { fakeHttp, type FakeResponse } from '../../helpers/fake-http.js';

// Redirect locations recorded from d.apkpure.com on 2026-11-14 (tokens shortened).
const FDROID_LATEST =
  'https://data.winudf.com/APK/b3JnLmZkcm9pZC5mZHJvaWRfMTAyMzA1Ml9mZTNiNjMzNA?_p=b3JnLmZkcm9pZC5mZHJvaWQ%3D&filename=F-Droid_1.23.2_APKPure.apk&full_size=12426276&is_hot=true&k=abc&package_name=org.fdroid.fdroid&source=web&token=1-2-3';
const FDROID_1022050 =
  'https://data.winudf.com/APK/b3JnLmZkcm9pZC5mZHJvaWRfMTAyMjA1MF81ZjE0Y2I1YQ?_p=b3JnLmZkcm9pZC5mZHJvaWQ%3D&filename=F-Droid_1.22.0_APKPure.apk&full_size=12406541&is_hot=false&k=abc&package_name=org.fdroid.fdroid&source=web&token=1-2-3';
const SPOTIFY_LATEST =
  'https://data.winudf.com/XAPK/Y29tLnNwb3RpZnkubXVzaWNfMTQ4Mzg3ODc1XzdmMzFhNTcw?_p=Y29tLnNwb3RpZnkubXVzaWM%3D&filename=Spotify%3A+Music+and+Podcasts_9.2.0.2053_APKPure.xapk&full_size=160912131&is_hot=true&k=abc&package_name=com.spotify.music&source=web&token=1-2-3';
const VERSIONS_PAGE = 'https://apkpure.com/f-droid-3/org.fdroid.fdroid/versions';

const FDROID = 'org.fdroid.fdroid';
const SPOTIFY = 'com.spotify.music';

function redirect(location: string): FakeResponse {
  return { status: 302, headers: { location } };
}

function opts(http: ResolveOptions['http'], extra: Partial<ResolveOptions> = {}): ResolveOptions {
  return { http, version: 'latest', format: 'auto', ...extra };
}

describe('apkpure source', () => {
  it('has a stable id, a description and no version listing', () => {
    expect(apkpure.id).toBe('apkpure');
    expect(apkpure.description).toBeTruthy();
    expect(apkpure.listVersions).toBeUndefined();
  });

  it('resolves the latest APK from the redirect without following it', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(FDROID_LATEST)]]);
    const resolved = await apkpure.resolve(FDROID, opts(http));

    expect(http.calls[0]?.url).toBe('https://d.apkpure.com/b/APK/org.fdroid.fdroid?version=latest');
    expect(http.calls[0]?.init?.redirect).toBe('manual');
    expect(resolved).toEqual({
      source: 'apkpure',
      url: FDROID_LATEST,
      format: 'apk',
      fileName: 'F-Droid_1.23.2_APKPure.apk',
      size: 12426276,
      info: {
        packageName: FDROID,
        name: 'F-Droid',
        versionName: '1.23.2',
        versionCode: 1023052,
        size: 12426276,
        format: 'apk',
        source: 'apkpure',
      },
    });
  });

  it('auto returns the XAPK bundle for split apps', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(SPOTIFY_LATEST)]]);
    const resolved = await apkpure.resolve(SPOTIFY, opts(http));
    expect(resolved.format).toBe('xapk');
    expect(resolved.fileName).toBe('Spotify: Music and Podcasts_9.2.0.2053_APKPure.xapk');
    expect(resolved.info).toMatchObject({
      name: 'Spotify: Music and Podcasts',
      versionName: '9.2.0.2053',
      versionCode: 148387875,
      format: 'xapk',
    });
  });

  it('format apk refuses split apps', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(SPOTIFY_LATEST)]]);
    const err = await apkpure.resolve(SPOTIFY, opts(http, { format: 'apk' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('split-unsupported');
  });

  it('format xapk uses the XAPK endpoint and refuses single-APK apps', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(FDROID_LATEST)]]);
    const err = await apkpure.resolve(FDROID, opts(http, { format: 'xapk' })).catch((e: unknown) => e);
    expect(http.calls[0]?.url).toBe('https://d.apkpure.com/b/XAPK/org.fdroid.fdroid?version=latest');
    expect((err as SourceUnavailableError).reason).toBe('format-unavailable');
  });

  it('unknown package (404) throws AppNotFoundError', async () => {
    const http = fakeHttp([['d.apkpure.com', { status: 404 }]]);
    const err = await apkpure.resolve('com.nonexistent.zzzz', opts(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppNotFoundError);
    expect((err as AppNotFoundError).source).toBe('apkpure');
  });

  it('resolves a specific versionCode', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(FDROID_1022050)]]);
    const resolved = await apkpure.resolve(FDROID, opts(http, { version: '1022050' }));
    expect(http.calls[0]?.url).toBe('https://d.apkpure.com/b/APK/org.fdroid.fdroid?versionCode=1022050');
    expect(resolved.info).toMatchObject({ versionName: '1.22.0', versionCode: 1022050 });
  });

  it('unknown versionCode (redirect to the versions page) throws VersionNotFoundError', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(VERSIONS_PAGE)]]);
    await expect(apkpure.resolve(FDROID, opts(http, { version: '999' }))).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });

  it('a versionName is served only when it is the latest version', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(FDROID_LATEST)]]);
    const resolved = await apkpure.resolve(FDROID, opts(http, { version: '1.23.2' }));
    expect(resolved.info.versionName).toBe('1.23.2');
    expect(http.calls[0]?.url).toContain('version=latest');

    await expect(apkpure.resolve(FDROID, opts(http, { version: '1.20.0' }))).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });

  it.each<[string, FakeResponse, string]>([
    ['403', { status: 403, body: 'blocked' }, 'http-403'],
    ['200 page instead of a redirect', { status: 200, body: '<html>' }, 'unexpected-response'],
    ['redirect to the home page', redirect('https://apkpure.com/'), 'unexpected-redirect'],
    ['redirect without location', { status: 302 }, 'unexpected-redirect'],
  ])('%s → SourceUnavailableError', async (_name, response, reason) => {
    const http = fakeHttp([['d.apkpure.com', response]]);
    const err = await apkpure.resolve(FDROID, opts(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe(reason);
  });

  it('a Cloudflare challenge is reported as blocked', async () => {
    const http = fakeHttp([
      ['d.apkpure.com', { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<title>Just a moment...</title>' }],
    ]);
    const err = await apkpure.resolve(FDROID, opts(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('blocked');
    expect((err as SourceUnavailableError).message).toMatch(/bot protection/i);
  });

  it('getInfo returns the metadata derived from the latest download', async () => {
    const http = fakeHttp([['d.apkpure.com', redirect(FDROID_LATEST)]]);
    const info = await apkpure.getInfo(FDROID, { http });
    expect(info).toEqual({
      packageName: FDROID,
      name: 'F-Droid',
      versionName: '1.23.2',
      versionCode: 1023052,
      size: 12426276,
      format: 'apk',
      source: 'apkpure',
    });
  });

  it('tolerates unexpected filename and path formats', async () => {
    const odd = 'https://cdn.example.com/file?filename=weird.apk';
    const http = fakeHttp([['d.apkpure.com', redirect(odd)]]);
    const resolved = await apkpure.resolve(FDROID, opts(http));
    expect(resolved.format).toBe('apk');
    expect(resolved.info).toEqual({ packageName: FDROID, format: 'apk', source: 'apkpure' });
  });
});
