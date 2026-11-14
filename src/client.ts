import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadToFile } from './download/downloader.js';
import { extractXapk } from './download/xapk.js';
import {
  AbortError,
  AllSourcesFailedError,
  ApkDownloaderError,
  AppNotFoundError,
  FileExistsError,
  InvalidOptionError,
  NetworkError,
  SourceUnavailableError,
  TimeoutError,
  VersionNotFoundError,
} from './errors.js';
import { DEFAULT_USER_AGENT, HttpClient } from './http/client.js';
import { builtinSources, DEFAULT_INFO_SOURCES, DEFAULT_SOURCES } from './sources/index.js';
import type {
  AppInfo,
  AppVersion,
  BatchResult,
  ClientOptions,
  DownloadOptions,
  DownloadResult,
  ResolvedDownload,
  Source,
} from './types.js';
import { pLimit } from './util/concurrency.js';
import { renderFileName } from './util/filename.js';
import { assertPackageName } from './util/package-name.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_FILE_NAME = '{package}-{version}.{ext}';
const DEFAULT_CONCURRENCY = 2;

/** Errors after which the next source is tried. Everything else stops the operation. */
const FALLBACK_ERRORS = [AppNotFoundError, VersionNotFoundError, SourceUnavailableError, NetworkError, TimeoutError];

export interface LookupCallOptions {
  /** Use only this source. */
  source?: string;
  signal?: AbortSignal;
}

export interface DownloadManyOptions extends DownloadOptions {
  /** Parallel downloads. Default 2. */
  concurrency?: number;
}

/**
 * Downloads Android apps from a prioritized list of sources, falling back to the next source
 * when one does not have the app or cannot serve it.
 *
 * @example
 * const client = new ApkDownloader({ timeout: 20_000 });
 * const { filePath } = await client.download('org.videolan.vlc', { outDir: './apks' });
 */
export class ApkDownloader {
  private readonly registry = new Map<string, Source>(Object.entries(builtinSources));
  private readonly downloadOrder: string[];
  private readonly infoOrder: string[];
  private readonly http: HttpClient;

  constructor(options: ClientOptions = {}) {
    this.downloadOrder = this.register(options.sources ?? DEFAULT_SOURCES, 'sources');
    this.infoOrder = this.register(
      options.infoSources ?? (options.sources ? options.sources : DEFAULT_INFO_SOURCES),
      'infoSources',
    );
    this.http = new HttpClient({
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      retries: options.retries ?? DEFAULT_RETRIES,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      proxy: options.proxy,
      fetch: options.fetch,
    });
  }

  /** Source ids used for downloads, in fallback order. */
  get sources(): string[] {
    return [...this.downloadOrder];
  }

  /** Add a custom source. It is appended to the download and metadata fallback orders. */
  registerSource(source: Source): void {
    if (!source.id || this.registry.has(source.id)) {
      throw new InvalidOptionError(`Source id must be unique and non-empty: ${JSON.stringify(source.id)}`);
    }
    this.registry.set(source.id, source);
    this.downloadOrder.push(source.id);
    this.infoOrder.push(source.id);
  }

  /** Download one app. Resolves with where the file was written (or found, when skipped). */
  async download(packageName: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    assertPackageName(packageName);
    const candidates = this.pick(options.source, this.downloadOrder);
    return this.tryEach(packageName, candidates, options.source !== undefined, options.signal, (source) =>
      this.downloadFrom(source, packageName, options),
    );
  }

  /**
   * Download several apps with limited parallelism. Never rejects for individual failures:
   * every (deduplicated) package gets an `ok` or error entry, in input order.
   */
  async downloadMany(packageNames: string[], options: DownloadManyOptions = {}): Promise<BatchResult[]> {
    const { concurrency = DEFAULT_CONCURRENCY, ...downloadOptions } = options;
    const limit = pLimit(concurrency);
    const unique = [...new Set(packageNames)];
    return Promise.all(
      unique.map((packageName) =>
        limit(async (): Promise<BatchResult> => {
          try {
            return { packageName, ok: true, result: await this.download(packageName, downloadOptions) };
          } catch (error) {
            return { packageName, ok: false, error: error instanceof Error ? error : new Error(String(error)) };
          }
        }),
      ),
    );
  }

  /** Look up app metadata without downloading. */
  async getInfo(packageName: string, options: LookupCallOptions = {}): Promise<AppInfo> {
    assertPackageName(packageName);
    const candidates = this.pick(options.source, this.infoOrder);
    return this.tryEach(packageName, candidates, options.source !== undefined, options.signal, (source) =>
      source.getInfo(packageName, { http: this.http, signal: options.signal }),
    );
  }

  /** List versions known to the first source that supports listing. */
  async listVersions(packageName: string, options: LookupCallOptions = {}): Promise<AppVersion[]> {
    assertPackageName(packageName);
    const candidates = this.pick(options.source, this.infoOrder).filter((s) => s.listVersions);
    if (candidates.length === 0) {
      throw new InvalidOptionError(
        options.source ? `Source ${options.source} cannot list versions` : 'No configured source can list versions',
      );
    }
    return this.tryEach(packageName, candidates, options.source !== undefined, options.signal, (source) =>
      (source.listVersions as NonNullable<Source['listVersions']>)(packageName, {
        http: this.http,
        signal: options.signal,
      }),
    );
  }

  private async downloadFrom(source: Source, packageName: string, options: DownloadOptions): Promise<DownloadResult> {
    const resolved = await source.resolve(packageName, {
      version: options.version ?? 'latest',
      format: options.format ?? 'auto',
      allowUntrusted: options.allowUntrusted ?? false,
      signal: options.signal,
      http: this.http,
    });

    const outDir = path.resolve(options.outDir ?? process.cwd());
    const fileName = renderFileName(options.fileName ?? DEFAULT_FILE_NAME, {
      package: packageName,
      version: resolved.info.versionName,
      versionCode: resolved.info.versionCode,
      source: resolved.source,
      ext: resolved.format,
    });
    const filePath = path.join(outDir, fileName);

    const existing = await stat(filePath).catch(() => undefined);
    if (existing) {
      const ifExists = options.ifExists ?? 'skip';
      if (ifExists === 'error') throw new FileExistsError(filePath);
      if (ifExists === 'skip') {
        return result(packageName, filePath, resolved, existing.size, await sha256File(filePath), true);
      }
    }

    const { size, sha256 } = await downloadToFile({
      http: this.http,
      resolved,
      target: filePath,
      verify: options.verify ?? true,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    const downloaded = result(packageName, filePath, resolved, size, sha256, false);
    if (options.extract && resolved.format === 'xapk') {
      downloaded.extractedFiles = await extractXapk(filePath, path.join(outDir, packageName));
    }
    return downloaded;
  }

  /** Try `operation` against each source until one succeeds; aggregate failures sensibly. */
  private async tryEach<T>(
    packageName: string,
    sources: Source[],
    pinned: boolean,
    signal: AbortSignal | undefined,
    operation: (source: Source) => Promise<T>,
  ): Promise<T> {
    const failures: ApkDownloaderError[] = [];
    for (const source of sources) {
      if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
      try {
        return await operation(source);
      } catch (error) {
        const normalized = normalize(error, source.id);
        if (pinned || !FALLBACK_ERRORS.some((type) => normalized instanceof type)) throw normalized;
        failures.push(normalized);
      }
    }
    throw summarize(packageName, failures);
  }

  private pick(sourceId: string | undefined, order: string[]): Source[] {
    const ids = sourceId === undefined ? order : [sourceId];
    return ids.map((id) => {
      const source = this.registry.get(id);
      if (!source) throw new InvalidOptionError(`Unknown source: ${JSON.stringify(id)}. Known: ${[...this.registry.keys()].join(', ')}`);
      return source;
    });
  }

  private register(list: ReadonlyArray<string | Source>, option: string): string[] {
    if (list.length === 0) throw new InvalidOptionError(`${option} must list at least one source`);
    return list.map((entry) => {
      if (typeof entry === 'string') {
        if (!this.registry.has(entry)) {
          throw new InvalidOptionError(`Unknown source in ${option}: ${JSON.stringify(entry)}`);
        }
        return entry;
      }
      if (!entry.id) throw new InvalidOptionError(`Custom sources need a non-empty id`);
      const known = this.registry.get(entry.id);
      if (known && known !== entry) throw new InvalidOptionError(`Duplicate source id: ${entry.id}`);
      this.registry.set(entry.id, entry);
      return entry.id;
    });
  }
}

function result(
  packageName: string,
  filePath: string,
  resolved: ResolvedDownload,
  size: number,
  sha256: string,
  skipped: boolean,
): DownloadResult {
  return { packageName, filePath, format: resolved.format, size, sha256, source: resolved.source, info: resolved.info, skipped };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Make every failure an ApkDownloaderError tagged with the source it came from. */
function normalize(error: unknown, sourceId: string): ApkDownloaderError {
  if (error instanceof ApkDownloaderError) {
    error.source ??= sourceId;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SourceUnavailableError(`Source ${sourceId} failed: ${message}`, {
    source: sourceId,
    reason: 'source-error',
    cause: error,
  });
}

function summarize(packageName: string, failures: ApkDownloaderError[]): ApkDownloaderError {
  const notFound = failures.every((e) => e instanceof AppNotFoundError || e instanceof VersionNotFoundError);
  if (failures.length > 0 && notFound) {
    const versionError = failures.find((e): e is VersionNotFoundError => e instanceof VersionNotFoundError);
    return versionError
      ? new VersionNotFoundError(packageName, versionError.version)
      : new AppNotFoundError(packageName);
  }
  return new AllSourcesFailedError(packageName, failures);
}
