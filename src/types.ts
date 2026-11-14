/** Package file formats a source can serve. */
export type ApkFormat = 'apk' | 'xapk';

/** Requested format. `auto` prefers a complete single APK and falls back to XAPK. */
export type FormatOption = ApkFormat | 'auto';

/** What to do when the target file already exists. */
export type IfExists = 'skip' | 'overwrite' | 'error';

export type ChecksumAlgorithm = 'md5' | 'sha1' | 'sha256';

export interface Checksum {
  algorithm: ChecksumAlgorithm;
  /** Lower-case hex digest. */
  value: string;
}

/** Metadata about an app, as reported by a source. Fields a source cannot provide are omitted. */
export interface AppInfo {
  packageName: string;
  name?: string;
  versionName?: string;
  versionCode?: number;
  /** Size in bytes of the file the source would serve. */
  size?: number;
  format?: ApkFormat;
  developer?: string;
  iconUrl?: string;
  minSdk?: number;
  architectures?: string[];
  signature?: { sha1?: string; owner?: string };
  /** Trust/malware rating reported by the source (e.g. Aptoide's `TRUSTED`, `UNKNOWN`, `WARNING`, `CRITICAL`). */
  trust?: string;
  /** Id of the source that produced this info. */
  source: string;
}

export interface AppVersion {
  versionName: string;
  versionCode?: number;
  size?: number;
  /** When the source published this version (as reported by the source). */
  added?: string;
  trust?: string;
}

/**
 * Minimal HTTP client handed to sources. It already applies the user agent, proxy,
 * timeouts and retries configured on the {@link ApkDownloader}.
 */
export interface HttpRequestInit extends RequestInit {
  /** Per-request timeout in ms, or `false` to disable it. Defaults to the client timeout. */
  timeout?: number | false;
}

export interface Http {
  /** Perform a request. Resolves with the response for any non-retryable status (including 4xx). */
  request(url: string, init?: HttpRequestInit): Promise<Response>;
  /** Perform a request and parse the JSON body. Rejects with `NetworkError` on non-2xx status. */
  json<T = unknown>(url: string, init?: HttpRequestInit): Promise<T>;
}

export interface ResolveOptions {
  /** A versionName, a versionCode (as string), or `'latest'`. */
  version: string;
  format: FormatOption;
  /**
   * Accept files the source does not consider trusted (Aptoide: `UNKNOWN` / `WARNING`).
   * Files flagged as malicious are never accepted. Default `false`.
   */
  allowUntrusted?: boolean | undefined;
  signal?: AbortSignal | undefined;
  http: Http;
}

export interface LookupOptions {
  signal?: AbortSignal | undefined;
  http: Http;
}

/** Everything needed to download one file. */
export interface ResolvedDownload {
  source: string;
  url: string;
  format: ApkFormat;
  /** Filename suggested by the upstream. */
  fileName?: string;
  size?: number;
  checksum?: Checksum;
  info: AppInfo;
  /** Extra request headers required by the upstream. */
  headers?: Record<string, string>;
}

/**
 * An upstream that can resolve package names to downloadable files.
 *
 * Implementations must throw:
 * - `AppNotFoundError` when the app does not exist on this source,
 * - `VersionNotFoundError` when the requested version does not exist,
 * - `SourceUnavailableError` when the source cannot serve the request (blocked, unsupported format, ...).
 * Network failures from `http` propagate as-is.
 */
export interface Source {
  readonly id: string;
  /** Human-friendly description shown by the CLI. */
  readonly description?: string;
  getInfo(packageName: string, options: LookupOptions): Promise<AppInfo>;
  resolve(packageName: string, options: ResolveOptions): Promise<ResolvedDownload>;
  listVersions?(packageName: string, options: LookupOptions): Promise<AppVersion[]>;
}

export interface Progress {
  /** Bytes written so far. */
  transferred: number;
  /** Total bytes, when the server reports it. */
  total?: number;
  /** 0–100, when `total` is known. */
  percent?: number;
  bytesPerSecond: number;
}

export interface ClientOptions {
  /** Download sources in fallback order: built-in ids or custom `Source` objects. Default `['apkpure', 'aptoide']`. */
  sources?: Array<string | Source>;
  /** Sources used by `getInfo` / `listVersions`, in order. Default `['aptoide', 'apkpure']`. */
  infoSources?: Array<string | Source>;
  /** Per-request timeout in ms (also the download idle timeout). Default `30000`. */
  timeout?: number;
  /** Retries for transient failures. Default `3`. */
  retries?: number;
  /** HTTP(S) proxy URL. Defaults to the `HTTPS_PROXY` / `HTTP_PROXY` environment variables. */
  proxy?: string;
  userAgent?: string;
  /** Custom fetch implementation (mainly for testing). */
  fetch?: typeof fetch;
}

export interface DownloadOptions {
  /** Destination directory, created if missing. Default: current working directory. */
  outDir?: string;
  /** Filename template. Default `'{package}-{version}.{ext}'`. */
  fileName?: string;
  /** versionName, versionCode, or `'latest'` (default). */
  version?: string;
  /** Default `'auto'`. */
  format?: FormatOption;
  /** Extract `.apk` / OBB files when the result is an XAPK. Default `false`. */
  extract?: boolean;
  /** Default `'skip'`. */
  ifExists?: IfExists;
  /** Verify the checksum published by the source. Default `true`. */
  verify?: boolean;
  /** Use only this source (no fallback). */
  source?: string;
  /** Accept files the source does not mark as trusted (never ones flagged as malicious). Default `false`. */
  allowUntrusted?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export interface DownloadResult {
  packageName: string;
  filePath: string;
  format: ApkFormat;
  size: number;
  /** SHA-256 of the file, lower-case hex. */
  sha256: string;
  source: string;
  info: AppInfo;
  /** `true` when the file already existed and `ifExists` was `'skip'`. */
  skipped: boolean;
  /** Absolute paths of extracted files when `extract` was requested and the result is an XAPK. */
  extractedFiles?: string[];
}

export type BatchResult =
  | { packageName: string; ok: true; result: DownloadResult }
  | { packageName: string; ok: false; error: Error };
