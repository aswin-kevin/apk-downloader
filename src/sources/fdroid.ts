/**
 * F-Droid source — https://f-droid.org (official repository of free and open-source apps).
 *
 * Findings (verified 2026-11-14):
 * - `GET /api/v1/packages/<pkg>` → `{ packageName, suggestedVersionCode, packages: [{ versionName, versionCode }] }`
 *   (newest first). Unknown apps → `404 {"error":"NOT_FOUND"}`.
 * - Files live at `/repo/<pkg>_<versionCode>.apk`. Not every listed version is still hosted:
 *   the suggested version can be gone (404), so files are confirmed with a HEAD request.
 * - Some apps publish one APK per CPU architecture with the same versionName and different
 *   versionCodes (e.g. VLC). The API does not say which code is which ABI, so the source refuses
 *   to guess and asks for an exact versionCode instead.
 * - APKs are built and signed by F-Droid (so their signature differs from Play Store builds).
 *   The full index with SHA-256 hashes is ~70 MB, so no checksum is fetched; the downloader still
 *   reports SHA-256 and the transfer is HTTPS from f-droid.org.
 */
import { AppNotFoundError, SourceUnavailableError, VersionNotFoundError } from '../errors.js';
import type {
  AppInfo,
  AppVersion,
  LookupOptions,
  ResolvedDownload,
  ResolveOptions,
  Source,
} from '../types.js';

const ID = 'fdroid';
const DEFAULT_BASE_URL = 'https://f-droid.org';
const MAX_LATEST_CANDIDATES = 3;

interface FdroidPackage {
  versionName: string;
  versionCode: number;
}

interface FdroidApp {
  packageName: string;
  suggestedVersionCode?: number;
  packages: FdroidPackage[];
}

export interface FdroidSourceOptions {
  /** Repository base URL. Default `https://f-droid.org`. */
  baseUrl?: string;
}

/** Create an F-Droid source (exported for custom base URLs; most users want {@link fdroid}). */
export function createFdroidSource(options: FdroidSourceOptions = {}): Source {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function getApp(packageName: string, opts: LookupOptions): Promise<FdroidApp> {
    const url = `${baseUrl}/api/v1/packages/${encodeURIComponent(packageName)}`;
    const response = await opts.http.request(url, {
      headers: { accept: 'application/json' },
      signal: opts.signal ?? null,
    });
    const text = await response.text();
    if (response.status === 404) throw new AppNotFoundError(packageName, { source: ID });
    if (!response.ok) {
      throw new SourceUnavailableError(`F-Droid returned HTTP ${response.status}`, {
        source: ID,
        reason: `http-${response.status}`,
      });
    }
    let app: Partial<FdroidApp> | undefined;
    try {
      app = JSON.parse(text) as Partial<FdroidApp>;
    } catch {
      app = undefined;
    }
    const packages = Array.isArray(app?.packages)
      ? app.packages.filter(
          (p) => typeof p?.versionName === 'string' && Number.isSafeInteger(p?.versionCode),
        )
      : [];
    if (!app || packages.length === 0) {
      throw new SourceUnavailableError('F-Droid returned an unexpected response', {
        source: ID,
        reason: 'invalid-response',
      });
    }
    const result: FdroidApp = { packageName, packages };
    if (Number.isSafeInteger(app.suggestedVersionCode))
      result.suggestedVersionCode = app.suggestedVersionCode as number;
    return result;
  }

  function fileUrl(packageName: string, versionCode: number): string {
    return `${baseUrl}/repo/${encodeURIComponent(packageName)}_${versionCode}.apk`;
  }

  /** HEAD the file: its size when hosted, `undefined` when gone. */
  async function probe(url: string, opts: LookupOptions): Promise<{ size?: number } | undefined> {
    const response = await opts.http.request(url, { method: 'HEAD', signal: opts.signal ?? null });
    await response.body?.cancel().catch(() => {});
    if (response.status === 404 || response.status === 410) return undefined;
    if (!response.ok) {
      throw new SourceUnavailableError(`F-Droid returned HTTP ${response.status} for ${url}`, {
        source: ID,
        reason: `http-${response.status}`,
      });
    }
    const length = Number(response.headers.get('content-length'));
    return Number.isSafeInteger(length) && length > 0 ? { size: length } : {};
  }

  function assertSingleBuild(app: FdroidApp, pkg: FdroidPackage): void {
    const builds = app.packages.filter((p) => p.versionName === pkg.versionName);
    if (builds.length > 1) {
      const codes = builds
        .map((p) => p.versionCode)
        .sort((a, b) => a - b)
        .join(', ');
      throw new SourceUnavailableError(
        `F-Droid has one build per CPU architecture for ${app.packageName} ${pkg.versionName} ` +
          `(versionCodes ${codes}); request an exact versionCode`,
        { source: ID, reason: 'ambiguous-abi' },
      );
    }
  }

  function toResolved(
    app: FdroidApp,
    pkg: FdroidPackage,
    url: string,
    size: number | undefined,
  ): ResolvedDownload {
    const info = toInfo(app.packageName, pkg);
    const resolved: ResolvedDownload = {
      source: ID,
      url,
      format: 'apk',
      fileName: `${app.packageName}_${pkg.versionCode}.apk`,
      info,
    };
    if (size !== undefined) {
      resolved.size = size;
      info.size = size;
    }
    return resolved;
  }

  async function resolveLatest(app: FdroidApp, opts: ResolveOptions): Promise<ResolvedDownload> {
    const newestFirst = [...app.packages].sort((a, b) => b.versionCode - a.versionCode);
    const suggested = newestFirst.find((p) => p.versionCode === app.suggestedVersionCode);
    const candidates = (
      suggested ? [suggested, ...newestFirst.filter((p) => p !== suggested)] : newestFirst
    ).slice(0, MAX_LATEST_CANDIDATES);

    for (const pkg of candidates) {
      assertSingleBuild(app, pkg);
      const url = fileUrl(app.packageName, pkg.versionCode);
      const file = await probe(url, opts);
      if (file) return toResolved(app, pkg, url, file.size);
    }
    throw new SourceUnavailableError(
      `F-Droid no longer hosts recent versions of ${app.packageName}`,
      {
        source: ID,
        reason: 'not-hosted',
      },
    );
  }

  async function resolveVersion(app: FdroidApp, opts: ResolveOptions): Promise<ResolvedDownload> {
    const byCode = /^\d+$/.test(opts.version)
      ? app.packages.find((p) => String(p.versionCode) === opts.version)
      : undefined;
    let pkg = byCode;
    if (!pkg) {
      const byName = app.packages.filter((p) => p.versionName === opts.version);
      if (byName.length === 0)
        throw new VersionNotFoundError(app.packageName, opts.version, { source: ID });
      pkg = byName[0] as FdroidPackage;
      assertSingleBuild(app, pkg);
    }
    const url = fileUrl(app.packageName, pkg.versionCode);
    const file = await probe(url, opts);
    if (!file) throw new VersionNotFoundError(app.packageName, opts.version, { source: ID });
    return toResolved(app, pkg, url, file.size);
  }

  return {
    id: ID,
    description: 'F-Droid (official builds of open-source apps only)',

    async getInfo(packageName: string, opts: LookupOptions): Promise<AppInfo> {
      const app = await getApp(packageName, opts);
      const pkg =
        app.packages.find((p) => p.versionCode === app.suggestedVersionCode) ??
        [...app.packages].sort((a, b) => b.versionCode - a.versionCode)[0];
      return toInfo(packageName, pkg as FdroidPackage);
    },

    async resolve(packageName: string, opts: ResolveOptions): Promise<ResolvedDownload> {
      if (opts.format === 'xapk') {
        throw new SourceUnavailableError('F-Droid only serves single APK files', {
          source: ID,
          reason: 'format-unsupported',
        });
      }
      const app = await getApp(packageName, opts);
      return opts.version === 'latest' ? resolveLatest(app, opts) : resolveVersion(app, opts);
    },

    async listVersions(packageName: string, opts: LookupOptions): Promise<AppVersion[]> {
      const app = await getApp(packageName, opts);
      return app.packages.map((p) => ({ versionName: p.versionName, versionCode: p.versionCode }));
    },
  };
}

/** The built-in F-Droid source. */
export const fdroid: Source = createFdroidSource();

function toInfo(packageName: string, pkg: FdroidPackage): AppInfo {
  return {
    packageName,
    versionName: pkg.versionName,
    versionCode: pkg.versionCode,
    format: 'apk',
    source: ID,
  };
}
