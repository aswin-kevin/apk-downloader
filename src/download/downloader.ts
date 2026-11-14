import { createHash, randomBytes, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  AbortError,
  ApkDownloaderError,
  ChecksumMismatchError,
  NetworkError,
  SourceUnavailableError,
  TimeoutError,
} from '../errors.js';
import type { Http, Progress, ResolvedDownload } from '../types.js';
import { asFileSystemError } from '../util/fs-error.js';

/** APK and XAPK files are ZIP archives: they start with a local file header. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PROGRESS_INTERVAL_MS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface DownloadToFileArgs {
  http: Http;
  resolved: ResolvedDownload;
  /** Final path. The file only appears there once complete and verified. */
  target: string;
  verify: boolean;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: Progress) => void) | undefined;
  /** Abort when no data arrives for this long (ms). Default 60 s. */
  idleTimeout?: number | undefined;
}

export interface DownloadedFile {
  size: number;
  sha256: string;
}

/**
 * Stream a resolved download to `target`.
 *
 * Data goes to a unique `.part` file next to the target while being hashed; after the transfer
 * the size, ZIP signature and (optionally) the source's checksum are verified and the file is
 * atomically renamed into place. On any failure or abort the partial file is removed and an
 * existing file at `target` is left untouched.
 */
export async function downloadToFile(args: DownloadToFileArgs): Promise<DownloadedFile> {
  const { http, resolved, target, verify, signal, onProgress } = args;
  const idleTimeout = args.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;

  const partPath = `${target}.${randomBytes(4).toString('hex')}.part`;

  const idle = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        idle.abort(
          new TimeoutError(`Download stalled for ${idleTimeout} ms: ${resolved.url}`, {
            url: resolved.url,
          }),
        ),
      idleTimeout,
    );
  };
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;

  try {
    await mkdir(path.dirname(target), { recursive: true });
    touch();
    const response = await http.request(resolved.url, {
      timeout: false,
      signal: combined,
      // Ask for the raw bytes: with a transfer encoding, content-length would not match the file.
      headers: { 'accept-encoding': 'identity', ...resolved.headers },
    });

    // Never let a redirect downgrade an https download to plain http (integrity relies on TLS
    // whenever the source publishes no checksum).
    if (isDowngrade(resolved.url, response.url)) {
      await response.body?.cancel().catch(() => {});
      throw new SourceUnavailableError(
        `${resolved.source} redirected an https download to plain http`,
        {
          source: resolved.source,
          reason: 'insecure-redirect',
        },
      );
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new NetworkError(`HTTP ${response.status} while downloading ${resolved.url}`, {
        url: resolved.url,
        status: response.status,
        source: resolved.source,
      });
    }
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      await response.body.cancel().catch(() => {});
      throw notAnApk(resolved);
    }

    // content-length describes the file only when the body is not content-encoded.
    const encoding = response.headers.get('content-encoding');
    const headerLength = Number(response.headers.get('content-length'));
    const transportSize =
      (!encoding || encoding === 'identity') &&
      Number.isSafeInteger(headerLength) &&
      headerLength > 0
        ? headerLength
        : undefined;
    const willVerifyChecksum = verify && resolved.checksum !== undefined;
    // The size a source reports can be stale; a checksum is the stronger check when there is one.
    const expectedSize = transportSize ?? (willVerifyChecksum ? undefined : resolved.size);

    const inspector = new Inspector({
      extraAlgorithm:
        verify && resolved.checksum?.algorithm !== 'sha256'
          ? resolved.checksum?.algorithm
          : undefined,
      total: transportSize ?? resolved.size,
      onChunk: touch,
      onProgress,
      resolved,
    });

    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      inspector,
      createWriteStream(partPath),
    );
    clearTimeout(idleTimer);

    if (!inspector.isZip()) throw notAnApk(resolved);
    if (expectedSize !== undefined && inspector.transferred !== expectedSize) {
      throw new NetworkError(
        `Incomplete download: expected ${expectedSize} bytes, received ${inspector.transferred}`,
        { url: resolved.url, source: resolved.source },
      );
    }

    const sha256 = inspector.digest('sha256');
    if (verify && resolved.checksum) {
      const expected = resolved.checksum.value.toLowerCase();
      const actual = inspector.digest(resolved.checksum.algorithm);
      if (actual !== expected) {
        throw new ChecksumMismatchError({
          algorithm: resolved.checksum.algorithm,
          expected,
          actual,
          source: resolved.source,
        });
      }
    }

    inspector.reportFinal();
    await rename(partPath, target);
    return { size: inspector.transferred, sha256 };
  } catch (error) {
    clearTimeout(idleTimer);
    await rm(partPath, { force: true }).catch(() => {});
    throw normalizeError(error, { signal, idle: idle.signal, resolved });
  }
}

interface InspectorOptions {
  extraAlgorithm: string | undefined;
  total: number | undefined;
  onChunk: () => void;
  onProgress: ((progress: Progress) => void) | undefined;
  resolved: ResolvedDownload;
}

/** Pass-through stream that hashes, counts, checks the ZIP signature and reports progress. */
class Inspector extends Transform {
  transferred = 0;
  private readonly hashes = new Map<string, Hash>();
  private readonly digests = new Map<string, string>();
  private head = Buffer.alloc(0);
  private readonly startedAt = Date.now();
  private lastReport = 0;

  constructor(private readonly options: InspectorOptions) {
    super();
    this.hashes.set('sha256', createHash('sha256'));
    if (options.extraAlgorithm)
      this.hashes.set(options.extraAlgorithm, createHash(options.extraAlgorithm));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.options.onChunk();
    if (this.head.length < ZIP_MAGIC.length) {
      this.head = Buffer.concat([
        this.head,
        chunk.subarray(0, ZIP_MAGIC.length - this.head.length),
      ]);
      if (this.head.length === ZIP_MAGIC.length && !this.isZip()) {
        callback(notAnApk(this.options.resolved));
        return;
      }
    }
    for (const hash of this.hashes.values()) hash.update(chunk);
    this.transferred += chunk.length;
    const now = Date.now();
    if (now - this.lastReport >= PROGRESS_INTERVAL_MS) {
      this.lastReport = now;
      this.report(now);
    }
    callback(null, chunk);
  }

  isZip(): boolean {
    return this.head.equals(ZIP_MAGIC);
  }

  digest(algorithm: string): string {
    let value = this.digests.get(algorithm);
    if (value === undefined) {
      const hash = this.hashes.get(algorithm);
      if (!hash) throw new Error(`No running hash for ${algorithm}`);
      value = hash.digest('hex');
      this.digests.set(algorithm, value);
    }
    return value;
  }

  reportFinal(): void {
    this.report(Date.now());
  }

  private report(now: number): void {
    const { onProgress, total } = this.options;
    if (!onProgress) return;
    const seconds = Math.max((now - this.startedAt) / 1000, 0.001);
    const progress: Progress = {
      transferred: this.transferred,
      bytesPerSecond: Math.round(this.transferred / seconds),
    };
    if (total !== undefined) {
      progress.total = total;
      progress.percent = Math.min(100, Math.round((this.transferred / total) * 1000) / 10);
    }
    onProgress(progress);
  }
}

function notAnApk(resolved: ResolvedDownload): SourceUnavailableError {
  return new SourceUnavailableError(
    `${resolved.source} served something that is not an APK/XAPK file`,
    {
      source: resolved.source,
      reason: 'not-an-apk',
    },
  );
}

function isDowngrade(requested: string, final: string): boolean {
  if (!final) return false;
  try {
    return new URL(requested).protocol === 'https:' && new URL(final).protocol !== 'https:';
  } catch {
    return false;
  }
}

function normalizeError(
  error: unknown,
  ctx: { signal: AbortSignal | undefined; idle: AbortSignal; resolved: ResolvedDownload },
): ApkDownloaderError {
  if (ctx.signal?.aborted) {
    return error instanceof AbortError ? error : new AbortError(undefined, { cause: error });
  }
  if (ctx.idle.aborted && ctx.idle.reason instanceof TimeoutError) return ctx.idle.reason;
  if (error instanceof ApkDownloaderError) return error;
  const fsError = asFileSystemError(error);
  if (fsError instanceof ApkDownloaderError) return fsError;
  const message = error instanceof Error ? error.message : String(error);
  return new NetworkError(`Download failed: ${message}`, {
    url: ctx.resolved.url,
    source: ctx.resolved.source,
    cause: error,
  });
}
