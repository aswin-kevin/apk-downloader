import { describe, expect, it } from 'vitest';
import {
  AppNotFoundError,
  NetworkError,
  SourceUnavailableError,
  VersionNotFoundError,
} from '../../../src/errors.js';
import { aptoide } from '../../../src/sources/aptoide.js';
import type { ResolveOptions } from '../../../src/types.js';
import { fakeHttp, fixture, type FakeResponse } from '../../helpers/fake-http.js';

const PKG = 'org.videolan.vlc';
const meta = fixture('aptoide/getMeta-vlc.json');
const metaOld = fixture('aptoide/getMeta-vlc-old.json');
const versions = fixture('aptoide/listAppVersions-vlc.json');
const notFound = fixture('aptoide/getMeta-notfound.json');
const untrusted = fixture('aptoide/getMeta-untrusted.json');

const latestRoute: [RegExp, FakeResponse] = [
  /getMeta\?package_name=org\.videolan\.vlc$/,
  { json: meta },
];
const versionsRoute: [string, FakeResponse] = ['listAppVersions', { json: versions }];
const oldRoute: [string, FakeResponse] = ['getMeta?app_id=77139186', { json: metaOld }];

function opts(http: ResolveOptions['http'], extra: Partial<ResolveOptions> = {}): ResolveOptions {
  return { http, version: 'latest', format: 'auto', ...extra };
}

/** Same as `data` but with a different trust rank. */
function withRank(source: unknown, rank: string): unknown {
  const copy = structuredClone(source) as { data: { file: { malware: { rank: string } } } };
  copy.data.file.malware.rank = rank;
  return copy;
}

describe('aptoide source', () => {
  it('has a stable id and description', () => {
    expect(aptoide.id).toBe('aptoide');
    expect(aptoide.description).toBeTruthy();
  });

  it('getInfo maps fields', async () => {
    const http = fakeHttp([latestRoute]);
    const info = await aptoide.getInfo(PKG, { http });
    expect(info).toEqual({
      packageName: PKG,
      name: 'VLC for Android',
      versionName: '1.9.9',
      versionCode: 21090905,
      size: 17762455,
      format: 'apk',
      developer: 'Videolabs',
      iconUrl: expect.stringMatching(/^https:\/\/pool\.img\.aptoide\.com\//),
      minSdk: expect.any(Number),
      architectures: expect.any(Array),
      signature: {
        sha1: 'EE:FB:C9:81:42:83:43:BB:DD:FF:F6:B2:3B:6B:D8:71:73:51:41:0C',
        owner: 'CN=Jean-Baptiste Kempf, O=VideoLAN Mobile, L=Paris, C=FR',
      },
      trust: 'TRUSTED',
      source: 'aptoide',
    });
    expect(http.calls[0]?.url).toBe(
      'https://ws75.aptoide.com/api/7/app/getMeta?package_name=org.videolan.vlc',
    );
  });

  it('getInfo throws AppNotFoundError for an unknown package (HTTP 404, APP-1)', async () => {
    const http = fakeHttp([['getMeta', { status: 404, json: notFound }]]);
    const err = await aptoide.getInfo('com.nonexistent.zzzz', { http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppNotFoundError);
    expect((err as AppNotFoundError).source).toBe('aptoide');
  });

  it('other API failures become SourceUnavailableError', async () => {
    const http = fakeHttp([
      [
        'getMeta',
        { json: { info: { status: 'FAIL' }, errors: [{ code: 'SYS-1', description: 'oops' }] } },
      ],
    ]);
    await expect(aptoide.getInfo(PKG, { http })).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('unexpected HTTP statuses become SourceUnavailableError', async () => {
    const http = fakeHttp([['getMeta', { status: 403, body: 'blocked' }]]);
    const err = await aptoide.getInfo(PKG, { http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('http-403');
  });

  it('malformed payloads become SourceUnavailableError', async () => {
    const http = fakeHttp([['getMeta', { body: '<html>' }]]);
    await expect(aptoide.getInfo(PKG, { http })).rejects.toBeInstanceOf(SourceUnavailableError);
    const http2 = fakeHttp([['getMeta', { json: { info: { status: 'OK' }, data: { file: {} } } }]]);
    await expect(aptoide.getInfo(PKG, { http: http2 })).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  it('propagates network errors unchanged', async () => {
    const http = fakeHttp([]);
    http.request = async (url) => {
      throw new NetworkError('down', { url });
    };
    await expect(aptoide.getInfo(PKG, { http })).rejects.toBeInstanceOf(NetworkError);
  });

  it('resolve latest returns the file path, md5 checksum and size', async () => {
    const http = fakeHttp([latestRoute]);
    const resolved = await aptoide.resolve(PKG, opts(http));
    expect(resolved).toMatchObject({
      source: 'aptoide',
      url: 'https://pool.apk.aptoide.com/mark8/org-videolan-vlc-21090905-18835772-6829e4ed025f7d87df45fa91c868ab97.apk',
      format: 'apk',
      size: 17762455,
      checksum: { algorithm: 'md5', value: '6829e4ed025f7d87df45fa91c868ab97' },
      info: { packageName: PKG, versionName: '1.9.9', source: 'aptoide' },
    });
  });

  it.each([['3.7.2 Beta 3'], ['13070136']])(
    'resolve version %s by name or code via app_id',
    async (version) => {
      const http = fakeHttp([versionsRoute, oldRoute]);
      const resolved = await aptoide.resolve(PKG, opts(http, { version }));
      expect(resolved.info.versionCode).toBe(13070136);
      expect(resolved.info.versionName).toBe('3.7.2 Beta 3');
      expect(http.calls.map((c) => c.url)).toEqual([
        'https://ws75.aptoide.com/api/7/listAppVersions?package_name=org.videolan.vlc&limit=50',
        'https://ws75.aptoide.com/api/7/app/getMeta?app_id=77139186',
      ]);
    },
  );

  it('unknown version throws VersionNotFoundError', async () => {
    const http = fakeHttp([versionsRoute]);
    await expect(aptoide.resolve(PKG, opts(http, { version: '9.9.9' }))).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });

  it('specific version of an unknown app throws AppNotFoundError', async () => {
    const http = fakeHttp([
      ['listAppVersions', { json: fixture('aptoide/listAppVersions-empty.json') }],
    ]);
    await expect(
      aptoide.resolve('com.nonexistent.zzzz', opts(http, { version: '1.0' })),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('format xapk is unsupported', async () => {
    const http = fakeHttp([latestRoute]);
    const err = await aptoide.resolve(PKG, opts(http, { format: 'xapk' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('format-unsupported');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses untrusted uploads by default', async () => {
    const http = fakeHttp([
      ['getMeta', { json: untrusted }],
      ['listAppVersions', { json: { info: { status: 'OK' }, list: [] } }],
    ]);
    const err = await aptoide
      .resolve('com.miHoYo.GenshinImpact', opts(http))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('untrusted');
  });

  it('falls back to the newest trusted upload when the latest one is untrusted', async () => {
    const versionsUntrustedFirst = structuredClone(versions) as {
      list: Array<{ file: { malware: { rank: string } } }>;
    };
    versionsUntrustedFirst.list[0]!.file.malware.rank = 'UNKNOWN';
    const routes = fakeHttp([
      [/getMeta\?package_name=/, { json: withRank(meta, 'UNKNOWN') }],
      ['listAppVersions', { json: versionsUntrustedFirst }],
      ['getMeta?app_id=77186992', { json: withRank(metaOld, 'TRUSTED') }],
    ]);
    const resolved = await aptoide.resolve(PKG, opts(routes));
    expect(routes.calls.at(-1)?.url).toContain('app_id=77186992');
    expect(resolved.info.trust).toBe('TRUSTED');
  });

  it('allowUntrusted accepts UNKNOWN and WARNING but never CRITICAL', async () => {
    const http = fakeHttp([['getMeta', { json: untrusted }]]);
    const resolved = await aptoide.resolve(
      'com.miHoYo.GenshinImpact',
      opts(http, { allowUntrusted: true }),
    );
    expect(resolved.info.trust).toBe('UNKNOWN');

    const critical = fakeHttp([
      ['getMeta', { json: withRank(untrusted, 'CRITICAL') }],
      ['listAppVersions', { json: { info: { status: 'OK' }, list: [] } }],
    ]);
    const err = await aptoide
      .resolve('com.miHoYo.GenshinImpact', opts(critical, { allowUntrusted: true }))
      .catch((e: unknown) => e);
    expect((err as SourceUnavailableError).reason).toBe('untrusted');
  });

  it('refuses apps that need OBB expansion files or split APKs', async () => {
    const withObb = structuredClone(meta) as { data: Record<string, unknown> };
    withObb.data.obb = { main: { path: 'https://x/main.obb' } };
    const obbHttp = fakeHttp([['getMeta', { json: withObb }]]);
    const obbErr = await aptoide.resolve(PKG, opts(obbHttp)).catch((e: unknown) => e);
    expect((obbErr as SourceUnavailableError).reason).toBe('obb-unsupported');

    const withAab = structuredClone(meta) as { data: Record<string, unknown> };
    withAab.data.aab = { splits: [{ name: 'config.arm64_v8a' }] };
    const aabHttp = fakeHttp([['getMeta', { json: withAab }]]);
    const aabErr = await aptoide.resolve(PKG, opts(aabHttp)).catch((e: unknown) => e);
    expect((aabErr as SourceUnavailableError).reason).toBe('split-unsupported');
  });

  it('listVersions maps entries', async () => {
    const http = fakeHttp([versionsRoute]);
    const list = await aptoide.listVersions!(PKG, { http });
    expect(list).toHaveLength(3);
    expect(list[1]).toEqual({
      versionName: '3.7.2',
      versionCode: 13070206,
      size: expect.any(Number),
      added: expect.any(String),
      trust: 'TRUSTED',
    });
  });

  it('listVersions throws AppNotFoundError when there are no versions', async () => {
    const http = fakeHttp([
      ['listAppVersions', { json: fixture('aptoide/listAppVersions-empty.json') }],
    ]);
    await expect(aptoide.listVersions!('com.nonexistent.zzzz', { http })).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });

  it('URL-encodes the package name', async () => {
    const http = fakeHttp([['getMeta', { status: 404, json: notFound }]]);
    await aptoide.getInfo('a.b&x=1', { http }).catch(() => {});
    expect(http.calls[0]?.url).toContain('package_name=a.b%26x%3D1');
  });
});
