/**
 * Error hierarchy. Every error thrown by this library extends {@link ApkDownloaderError}
 * and carries a stable, machine-readable `code`.
 */

export interface ErrorDetails {
  /** Id of the source that produced the error, if any. */
  source?: string;
  cause?: unknown;
}

export class ApkDownloaderError extends Error {
  readonly code: string;
  /** Id of the source involved. Filled in by the client when a source did not set it. */
  source?: string;

  constructor(message: string, code: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.code = code;
    if (details.source !== undefined) this.source = details.source;
  }
}

/** The package name is not a syntactically valid Android application id. */
export class InvalidPackageError extends ApkDownloaderError {
  readonly packageName: string;

  constructor(packageName: string) {
    super(`Invalid Android package name: ${JSON.stringify(packageName)}`, 'ERR_INVALID_PACKAGE');
    this.packageName = packageName;
  }
}

/** An option passed to the library or CLI is invalid (e.g. an unknown source id). */
export class InvalidOptionError extends ApkDownloaderError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_OPTION');
  }
}

/** The app does not exist on the source (or on any source). */
export class AppNotFoundError extends ApkDownloaderError {
  readonly packageName: string;

  constructor(packageName: string, details: ErrorDetails = {}) {
    const where = details.source ? ` on ${details.source}` : '';
    super(`App not found${where}: ${packageName}`, 'ERR_APP_NOT_FOUND', details);
    this.packageName = packageName;
  }
}

/** The app exists but the requested version is not available. */
export class VersionNotFoundError extends ApkDownloaderError {
  readonly packageName: string;
  readonly version: string;

  constructor(packageName: string, version: string, details: ErrorDetails = {}) {
    const where = details.source ? ` on ${details.source}` : '';
    super(
      `Version ${version} of ${packageName} not found${where}`,
      'ERR_VERSION_NOT_FOUND',
      details,
    );
    this.packageName = packageName;
    this.version = version;
  }
}

/**
 * The source cannot serve this request right now, or cannot serve it at all
 * (blocked, changed its API, unsupported format, split app it cannot bundle, ...).
 */
export class SourceUnavailableError extends ApkDownloaderError {
  /** Short machine-readable reason, e.g. `http-403`, `split-unsupported`, `not-an-apk`. */
  readonly reason?: string;

  constructor(message: string, details: ErrorDetails & { reason?: string } = {}) {
    super(message, 'ERR_SOURCE_UNAVAILABLE', details);
    if (details.reason !== undefined) this.reason = details.reason;
  }
}

/** A network request failed (connection error, or HTTP error after retries). */
export class NetworkError extends ApkDownloaderError {
  readonly url: string;
  readonly status?: number;

  constructor(message: string, details: ErrorDetails & { url: string; status?: number }) {
    super(message, 'ERR_NETWORK', details);
    this.url = details.url;
    if (details.status !== undefined) this.status = details.status;
  }
}

/** A request or download stalled longer than the configured timeout. */
export class TimeoutError extends ApkDownloaderError {
  readonly url?: string;

  constructor(message: string, details: ErrorDetails & { url?: string } = {}) {
    super(message, 'ERR_TIMEOUT', details);
    if (details.url !== undefined) this.url = details.url;
  }
}

/** The downloaded file does not match the checksum published by the source. */
export class ChecksumMismatchError extends ApkDownloaderError {
  readonly algorithm: string;
  readonly expected: string;
  readonly actual: string;

  constructor(details: ErrorDetails & { algorithm: string; expected: string; actual: string }) {
    super(
      `Checksum mismatch (${details.algorithm}): expected ${details.expected}, got ${details.actual}`,
      'ERR_CHECKSUM',
      details,
    );
    this.algorithm = details.algorithm;
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

/** The target file already exists and `ifExists` is `'error'`. */
export class FileExistsError extends ApkDownloaderError {
  readonly path: string;

  constructor(path: string) {
    super(`File already exists: ${path}`, 'ERR_FILE_EXISTS');
    this.path = path;
  }
}

/** The operation was cancelled through an `AbortSignal`. */
export class AbortError extends ApkDownloaderError {
  constructor(message = 'The operation was aborted', details: ErrorDetails = {}) {
    super(message, 'ERR_ABORTED', details);
  }
}

/**
 * A local filesystem operation failed (unwritable directory, disk full, ...).
 * Never triggers fallback: another source would hit the same local problem.
 */
export class FileSystemError extends ApkDownloaderError {
  readonly path?: string;
  /** The underlying Node.js error code, e.g. `ENOSPC`, `EACCES`. */
  readonly systemCode?: string;

  constructor(
    message: string,
    details: ErrorDetails & { path?: string; systemCode?: string } = {},
  ) {
    super(message, 'ERR_FS', details);
    if (details.path !== undefined) this.path = details.path;
    if (details.systemCode !== undefined) this.systemCode = details.systemCode;
  }
}

/** An XAPK archive is corrupt or does not contain any APK. */
export class InvalidArchiveError extends ApkDownloaderError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 'ERR_INVALID_ARCHIVE', details);
  }
}

/** An XAPK archive contains an entry that would be written outside the destination ("zip slip"). */
export class UnsafeArchiveError extends ApkDownloaderError {
  readonly entry: string;

  constructor(entry: string, details: ErrorDetails = {}) {
    super(
      `Refusing to extract unsafe archive entry: ${JSON.stringify(entry)}`,
      'ERR_UNSAFE_ARCHIVE',
      details,
    );
    this.entry = entry;
  }
}

/** Every source was tried and none could serve the request. */
export class AllSourcesFailedError extends ApkDownloaderError {
  readonly packageName: string;
  readonly errors: ApkDownloaderError[];

  constructor(packageName: string, errors: ApkDownloaderError[]) {
    const summary = errors.map((e) => `${e.source ?? 'unknown'}: ${e.message}`).join('; ');
    super(
      `All sources failed for ${packageName}${summary ? ` (${summary})` : ''}`,
      'ERR_ALL_SOURCES_FAILED',
    );
    this.packageName = packageName;
    this.errors = errors;
  }
}
