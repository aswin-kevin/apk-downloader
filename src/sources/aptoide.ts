/**
 * Aptoide source — https://ws75.aptoide.com/api/7 (public JSON API, no auth).
 *
 * Findings (verified 2026-11-14):
 * - `app/getMeta?package_name=<pkg>` returns the upload with the highest versionCode across all
 *   Aptoide stores. Unknown apps → HTTP 404 with `{ info: { status: 'FAIL' }, errors: [{ code: 'APP-1' }] }`.
 * - `listAppVersions?package_name=<pkg>&limit=N` lists uploads (newest first); entries carry `id`
 *   and `file.{vername,vercode,filesize,malware.rank}` but no download path. Unknown apps → empty list.
 * - `app/getMeta?app_id=<id>` returns one specific upload, including `file.path` and `file.md5sum`.
 * - Aptoide is a user-upload store: anyone can publish under any package name. Each upload carries
 *   `file.malware.rank` (TRUSTED | UNKNOWN | WARNING | CRITICAL). Fake "apps" (e.g. 3 MB WebView
 *   wrappers for popular games, signed with random certificates) are ranked UNKNOWN, so only
 *   TRUSTED uploads are accepted unless the caller opts in with `allowUntrusted`.
 * - Only single APKs are served. Uploads that need OBB files (`obb`) or split APKs (`aab`) are refused.
 *   Some TRUSTED uploads are base-only APKs of split apps and cannot be detected from the metadata.
 */
import { AppNotFoundError, SourceUnavailableError, VersionNotFoundError } from '../errors.js';
import type {
  AppInfo,
  AppVersion,
  Http,
  LookupOptions,
  ResolvedDownload,
  ResolveOptions,
  Source,
} from '../types.js';

const ID = 'aptoide';
const DEFAULT_BASE_URL = 'https://ws75.aptoide.com/api/7';
const VERSION_LIST_LIMIT = 50;
const TRUSTED = 'TRUSTED';
const NEVER_ACCEPTED = 'CRITICAL';

interface AptoideFile {
  vername?: string;
  vercode?: number;
  md5sum?: string;
  filesize?: number;
  path?: string;
  added?: string;
  signature?: { sha1?: string; owner?: string };
  hardware?: { sdk?: number; cpus?: string[] };
  malware?: { rank?: string };
}

interface AptoideApp {
  id?: number;
  name?: string;
  package?: string;
  size?: number;
  icon?: string;
  added?: string;
  developer?: { name?: string };
  file?: AptoideFile;
  obb?: unknown;
  aab?: unknown;
}

interface AptoideEnvelope {
  info?: { status?: string };
  errors?: Array<{ code?: string; description?: string }>;
  data?: AptoideApp;
  list?: AptoideApp[];
}

export interface AptoideSourceOptions {
  /** API base URL. Default `https://ws75.aptoide.com/api/7`. */
  baseUrl?: string;
}

/** Create an Aptoide source (exported for custom base URLs; most users want {@link aptoide}). */
export function createAptoideSource(options: AptoideSourceOptions = {}): Source {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function call(
    url: string,
    packageName: string,
    { http, signal }: { http: Http; signal?: AbortSignal | undefined },
  ): Promise<AptoideEnvelope> {
    const response = await http.request(url, { signal: signal ?? null });
    const text = await response.text();
    let body: AptoideEnvelope | undefined;
    try {
      body = JSON.parse(text) as AptoideEnvelope;
    } catch {
      body = undefined;
    }

    if (body?.errors?.some((e) => e.code === 'APP-1')) {
      throw new AppNotFoundError(packageName, { source: ID });
    }
    if (!response.ok) {
      throw new SourceUnavailableError(`Aptoide returned HTTP ${response.status}`, {
        source: ID,
        reason: `http-${response.status}`,
      });
    }
    if (!body) {
      throw new SourceUnavailableError('Aptoide returned a malformed response', {
        source: ID,
        reason: 'invalid-response',
      });
    }
    if (body.info?.status !== 'OK') {
      const description = body.errors?.[0]?.description ?? 'unknown error';
      throw new SourceUnavailableError(`Aptoide API error: ${description}`, {
        source: ID,
        reason: 'api-error',
      });
    }
    return body;
  }

  async function getMeta(query: string, packageName: string, opts: LookupOptions): Promise<AptoideApp> {
    const body = await call(`${baseUrl}/app/getMeta?${query}`, packageName, opts);
    return validate(body.data);
  }

  async function getVersionList(packageName: string, opts: LookupOptions): Promise<AptoideApp[]> {
    const url = `${baseUrl}/listAppVersions?package_name=${encodeURIComponent(packageName)}&limit=${VERSION_LIST_LIMIT}`;
    const body = await call(url, packageName, opts);
    const list = body.list ?? [];
    if (list.length === 0) throw new AppNotFoundError(packageName, { source: ID });
    return list;
  }

  async function pickLatest(packageName: string, opts: ResolveOptions): Promise<AptoideApp> {
    const latest = await getMeta(`package_name=${encodeURIComponent(packageName)}`, packageName, opts);
    if (isAcceptable(latest.file?.malware?.rank, opts.allowUntrusted)) return latest;

    // The newest upload is not trusted: look for the newest one that is.
    const list = await getVersionList(packageName, opts).catch((error: unknown) => {
      if (error instanceof AppNotFoundError) return [];
      throw error;
    });
    const candidate = list.find((entry) => isAcceptable(entry.file?.malware?.rank, opts.allowUntrusted));
    if (candidate?.id === undefined) throw untrusted(packageName);
    return getMeta(`app_id=${candidate.id}`, packageName, opts);
  }

  async function pickVersion(packageName: string, opts: ResolveOptions): Promise<AptoideApp> {
    const list = await getVersionList(packageName, opts);
    const matches = list.filter(
      (entry) => entry.file?.vername === opts.version || String(entry.file?.vercode) === opts.version,
    );
    if (matches.length === 0) throw new VersionNotFoundError(packageName, opts.version, { source: ID });
    const candidate = matches.find((entry) => isAcceptable(entry.file?.malware?.rank, opts.allowUntrusted));
    if (candidate?.id === undefined) throw untrusted(packageName);
    return getMeta(`app_id=${candidate.id}`, packageName, opts);
  }

  return {
    id: ID,
    description: 'Aptoide app store (single APKs, checksums, trust ratings)',

    async getInfo(packageName: string, opts: LookupOptions): Promise<AppInfo> {
      const app = await getMeta(`package_name=${encodeURIComponent(packageName)}`, packageName, opts);
      return toInfo(app);
    },

    async resolve(packageName: string, opts: ResolveOptions): Promise<ResolvedDownload> {
      if (opts.format === 'xapk') {
        throw new SourceUnavailableError('Aptoide only serves single APK files', {
          source: ID,
          reason: 'format-unsupported',
        });
      }

      const app = opts.version === 'latest' ? await pickLatest(packageName, opts) : await pickVersion(packageName, opts);

      if (app.obb) {
        throw new SourceUnavailableError('This app needs OBB expansion files, which Aptoide downloads do not include', {
          source: ID,
          reason: 'obb-unsupported',
        });
      }
      if (app.aab) {
        throw new SourceUnavailableError('This app is distributed as split APKs, which Aptoide cannot bundle', {
          source: ID,
          reason: 'split-unsupported',
        });
      }

      const file = app.file as Required<Pick<AptoideFile, 'path'>> & AptoideFile;
      const resolved: ResolvedDownload = {
        source: ID,
        url: file.path,
        format: 'apk',
        info: toInfo(app),
      };
      if (file.filesize !== undefined) resolved.size = file.filesize;
      if (file.md5sum) resolved.checksum = { algorithm: 'md5', value: file.md5sum.toLowerCase() };
      return resolved;
    },

    async listVersions(packageName: string, opts: LookupOptions): Promise<AppVersion[]> {
      const list = await getVersionList(packageName, opts);
      return list.flatMap((entry) => {
        const file = entry.file;
        if (!file?.vername) return [];
        const version: AppVersion = { versionName: file.vername };
        if (file.vercode !== undefined) version.versionCode = file.vercode;
        const size = file.filesize ?? entry.size;
        if (size !== undefined) version.size = size;
        const added = file.added ?? entry.added;
        if (added) version.added = added;
        if (file.malware?.rank) version.trust = file.malware.rank;
        return [version];
      });
    },
  };
}

/** The built-in Aptoide source. */
export const aptoide: Source = createAptoideSource();

function isAcceptable(rank: string | undefined, allowUntrusted: boolean | undefined): boolean {
  if (rank === TRUSTED) return true;
  return allowUntrusted === true && rank !== NEVER_ACCEPTED;
}

function untrusted(packageName: string): SourceUnavailableError {
  return new SourceUnavailableError(
    `No trusted upload of ${packageName} on Aptoide (use allowUntrusted to accept unverified uploads)`,
    { source: ID, reason: 'untrusted' },
  );
}

function validate(app: AptoideApp | undefined): AptoideApp {
  if (!app?.package || !app.file?.path || !app.file.vername) {
    throw new SourceUnavailableError('Aptoide response is missing required fields', {
      source: ID,
      reason: 'invalid-response',
    });
  }
  return app;
}

function toInfo(app: AptoideApp): AppInfo {
  const file = app.file ?? {};
  const info: AppInfo = { packageName: app.package ?? '', source: ID, format: 'apk' };
  if (app.name) info.name = app.name;
  if (file.vername) info.versionName = file.vername;
  if (file.vercode !== undefined) info.versionCode = file.vercode;
  const size = file.filesize ?? app.size;
  if (size !== undefined) info.size = size;
  if (app.developer?.name) info.developer = app.developer.name;
  if (app.icon) info.iconUrl = app.icon;
  if (file.hardware?.sdk !== undefined) info.minSdk = file.hardware.sdk;
  if (file.hardware?.cpus) info.architectures = file.hardware.cpus;
  if (file.signature) {
    info.signature = {};
    if (file.signature.sha1) info.signature.sha1 = file.signature.sha1;
    if (file.signature.owner) info.signature.owner = file.signature.owner;
  }
  if (file.malware?.rank) info.trust = file.malware.rank;
  return info;
}
