import { describe, expect, it } from 'vitest';
import {
  AbortError,
  AllSourcesFailedError,
  ApkDownloaderError,
  AppNotFoundError,
  ChecksumMismatchError,
  FileExistsError,
  InvalidArchiveError,
  InvalidOptionError,
  InvalidPackageError,
  NetworkError,
  SourceUnavailableError,
  TimeoutError,
  UnsafeArchiveError,
  VersionNotFoundError,
} from '../../src/errors.js';

describe('errors', () => {
  const cases: Array<[ApkDownloaderError, string, string]> = [
    [new InvalidPackageError('x'), 'ERR_INVALID_PACKAGE', 'InvalidPackageError'],
    [new AppNotFoundError('a.b', { source: 'aptoide' }), 'ERR_APP_NOT_FOUND', 'AppNotFoundError'],
    [new VersionNotFoundError('a.b', '1.0'), 'ERR_VERSION_NOT_FOUND', 'VersionNotFoundError'],
    [
      new SourceUnavailableError('down', { source: 'apkpure', reason: 'http-403' }),
      'ERR_SOURCE_UNAVAILABLE',
      'SourceUnavailableError',
    ],
    [new NetworkError('boom', { url: 'https://x', status: 503 }), 'ERR_NETWORK', 'NetworkError'],
    [new TimeoutError('slow', { url: 'https://x' }), 'ERR_TIMEOUT', 'TimeoutError'],
    [
      new ChecksumMismatchError({ algorithm: 'md5', expected: 'a', actual: 'b' }),
      'ERR_CHECKSUM',
      'ChecksumMismatchError',
    ],
    [new FileExistsError('/tmp/x.apk'), 'ERR_FILE_EXISTS', 'FileExistsError'],
    [new AbortError(), 'ERR_ABORTED', 'AbortError'],
    [new AllSourcesFailedError('a.b', []), 'ERR_ALL_SOURCES_FAILED', 'AllSourcesFailedError'],
    [new InvalidOptionError('bad'), 'ERR_INVALID_OPTION', 'InvalidOptionError'],
    [new InvalidArchiveError('bad zip'), 'ERR_INVALID_ARCHIVE', 'InvalidArchiveError'],
    [new UnsafeArchiveError('../x'), 'ERR_UNSAFE_ARCHIVE', 'UnsafeArchiveError'],
  ];

  it.each(cases)('%s has code %s and name %s', (err, code, name) => {
    expect(err).toBeInstanceOf(ApkDownloaderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.name).toBe(name);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('preserves cause', () => {
    const cause = new Error('root');
    const err = new NetworkError('wrapped', { url: 'https://x', cause });
    expect(err.cause).toBe(cause);
  });

  it('carries structured details', () => {
    const net = new NetworkError('x', { url: 'https://u', status: 502 });
    expect(net.status).toBe(502);
    expect(net.url).toBe('https://u');

    const sum = new ChecksumMismatchError({ algorithm: 'sha256', expected: 'aa', actual: 'bb' });
    expect(sum.expected).toBe('aa');
    expect(sum.actual).toBe('bb');

    const unavailable = new SourceUnavailableError('x', {
      source: 'aptoide',
      reason: 'split-unsupported',
    });
    expect(unavailable.source).toBe('aptoide');
    expect(unavailable.reason).toBe('split-unsupported');

    const inner = [new AppNotFoundError('a.b', { source: 'aptoide' })];
    const all = new AllSourcesFailedError('a.b', inner);
    expect(all.errors).toEqual(inner);
    expect(all.message).toContain('aptoide');
  });
});
