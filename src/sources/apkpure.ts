/**
 * APKPure source — https://d.apkpure.com (anonymous direct-download endpoint).
 *
 * Findings (verified 2026-11-14):
 * - `GET /b/{APK|XAPK}/<pkg>?version=latest` answers `302` to a CDN URL (`data.winudf.com`).
 *   No browser or cookies are needed. Unknown apps → `404`.
 * - Both endpoints serve what the app actually is: split apps redirect to `/XAPK/...` even on
 *   the APK endpoint, single-APK apps redirect to `/APK/...` even on the XAPK endpoint.
 * - The redirect query carries `filename` (`<App name>_<versionName>_APKPure.<ext>`) and
 *   `full_size` (bytes). The last path segment is base64url of `<pkg>_<versionCode>_<hash>`.
 * - Specific versions: only `?versionCode=<code>` works. An unknown code redirects to
 *   `https://apkpure.com/<slug>/<pkg>/versions`; `?version=<name>` redirects to the home page.
 * - No checksum is published; the downloader still reports SHA-256.
 * - The endpoint sits behind Cloudflare bot protection. Requests from curl pass, but Node's
 *   HTTP stack (fetch and https alike, any user agent, HTTP/1.1 or HTTP/2) receives
 *   `403` with `cf-mitigated: challenge`. This is reported as `reason: 'blocked'` so the
 *   client falls back to the next source; this library does not attempt to evade it.
 */
import { AppNotFoundError, SourceUnavailableError, VersionNotFoundError } from '../errors.js';
import type {
  ApkFormat,
  AppInfo,
  LookupOptions,
  ResolvedDownload,
  ResolveOptions,
  Source,
} from '../types.js';

const ID = 'apkpure';
const DEFAULT_BASE_URL = 'https://d.apkpure.com';
const FILENAME_PATTERN = /^(.*)_([^_]+)_APKPure\.(x?apk)$/i;

export interface ApkpureSourceOptions {
  /** Download endpoint base URL. Default `https://d.apkpure.com`. */
  baseUrl?: string;
}

/** Create an APKPure source (exported for custom base URLs; most users want {@link apkpure}). */
export function createApkpureSource(options: ApkpureSourceOptions = {}): Source {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function lookup(
    packageName: string,
    query: string,
    endpoint: 'APK' | 'XAPK',
    version: string,
    opts: LookupOptions,
  ): Promise<ResolvedDownload> {
    const url = `${baseUrl}/b/${endpoint}/${encodeURIComponent(packageName)}?${query}`;
    const response = await opts.http.request(url, { redirect: 'manual', signal: opts.signal ?? null });
    await response.body?.cancel().catch(() => {});

    if (response.status === 404) throw new AppNotFoundError(packageName, { source: ID });
    if (response.headers.get('cf-mitigated') === 'challenge') {
      throw new SourceUnavailableError('APKPure refused the request (bot protection challenge)', {
        source: ID,
        reason: 'blocked',
      });
    }
    if (response.status < 300 || response.status >= 400) {
      const reason = response.ok ? 'unexpected-response' : `http-${response.status}`;
      throw new SourceUnavailableError(`APKPure returned HTTP ${response.status}`, { source: ID, reason });
    }

    const location = response.headers.get('location');
    const target = location ? safeUrl(location, url) : undefined;
    if (target && isApkpureSite(target) && target.pathname.endsWith('/versions')) {
      throw new VersionNotFoundError(packageName, version, { source: ID });
    }
    if (!target || isApkpureSite(target)) {
      throw new SourceUnavailableError('APKPure did not redirect to a download', {
        source: ID,
        reason: 'unexpected-redirect',
      });
    }
    return toResolved(packageName, target);
  }

  async function resolve(packageName: string, opts: ResolveOptions): Promise<ResolvedDownload> {
    const endpoint = opts.format === 'xapk' ? 'XAPK' : 'APK';
    const isVersionCode = /^\d+$/.test(opts.version);
    const query =
      opts.version !== 'latest' && isVersionCode
        ? `versionCode=${opts.version}`
        : 'version=latest';

    const resolved = await lookup(packageName, query, endpoint, opts.version, opts);

    // APKPure cannot look up versionNames; accept one only when it is the latest version.
    if (opts.version !== 'latest' && !isVersionCode && resolved.info.versionName !== opts.version) {
      throw new VersionNotFoundError(packageName, opts.version, { source: ID });
    }
    if (opts.format === 'apk' && resolved.format === 'xapk') {
      throw new SourceUnavailableError(`${packageName} is only available as a split APK bundle (XAPK)`, {
        source: ID,
        reason: 'split-unsupported',
      });
    }
    if (opts.format === 'xapk' && resolved.format === 'apk') {
      throw new SourceUnavailableError(`${packageName} is only available as a single APK`, {
        source: ID,
        reason: 'format-unavailable',
      });
    }
    return resolved;
  }

  return {
    id: ID,
    description: 'APKPure (APK and XAPK bundles for split apps)',

    resolve,

    async getInfo(packageName: string, opts: LookupOptions): Promise<AppInfo> {
      const resolved = await resolve(packageName, { ...opts, version: 'latest', format: 'auto' });
      return resolved.info;
    },
  };
}

/** The built-in APKPure source. */
export const apkpure: Source = createApkpureSource();

function toResolved(packageName: string, target: URL): ResolvedDownload {
  const fileName = target.searchParams.get('filename') ?? undefined;
  const fullSize = Number(target.searchParams.get('full_size'));
  const size = Number.isSafeInteger(fullSize) && fullSize > 0 ? fullSize : undefined;
  const format = detectFormat(target, fileName);

  const info: AppInfo = { packageName, source: ID, format };
  const match = fileName ? FILENAME_PATTERN.exec(fileName) : null;
  if (match?.[1]) info.name = match[1];
  if (match?.[2]) info.versionName = match[2];
  const versionCode = decodeVersionCode(target, packageName);
  if (versionCode !== undefined) info.versionCode = versionCode;
  if (size !== undefined) info.size = size;

  const resolved: ResolvedDownload = { source: ID, url: target.toString(), format, info };
  if (fileName) resolved.fileName = fileName;
  if (size !== undefined) resolved.size = size;
  return resolved;
}

function detectFormat(target: URL, fileName: string | undefined): ApkFormat {
  const firstSegment = target.pathname.split('/')[1]?.toUpperCase();
  if (firstSegment === 'XAPK') return 'xapk';
  if (firstSegment === 'APK') return 'apk';
  return fileName?.toLowerCase().endsWith('.xapk') ? 'xapk' : 'apk';
}

/** The last path segment is base64url(`<pkg>_<versionCode>_<hash>`). */
function decodeVersionCode(target: URL, packageName: string): number | undefined {
  const segment = target.pathname.split('/').pop();
  if (!segment) return undefined;
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');
  const prefix = `${packageName}_`;
  if (!decoded.startsWith(prefix)) return undefined;
  const code = Number(decoded.slice(prefix.length).split('_')[0]);
  return Number.isSafeInteger(code) && code > 0 ? code : undefined;
}

/** The APKPure website (as opposed to a download host): a redirect there means "no file". */
function isApkpureSite(url: URL): boolean {
  const host = url.hostname;
  return host === 'apkpure.com' || (host.endsWith('.apkpure.com') && host !== 'd.apkpure.com');
}

function safeUrl(location: string, base: string): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}
