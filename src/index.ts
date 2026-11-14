import path from 'node:path';
import { ApkDownloader, type DownloadManyOptions, type LookupCallOptions } from './client.js';
import type { AppInfo, AppVersion, BatchResult, DownloadOptions, DownloadResult } from './types.js';

/** The version of this package. */
export const VERSION = '2.0.0';

export { ApkDownloader, type DownloadManyOptions, type LookupCallOptions } from './client.js';
export * from './errors.js';
export type * from './types.js';
export {
  apkpure,
  aptoide,
  builtinSources,
  createApkpureSource,
  createAptoideSource,
  createFdroidSource,
  DEFAULT_INFO_SOURCES,
  DEFAULT_SOURCES,
  fdroid,
  type ApkpureSourceOptions,
  type AptoideSourceOptions,
  type FdroidSourceOptions,
} from './sources/index.js';
export { DEFAULT_USER_AGENT } from './http/client.js';

let defaultClient: ApkDownloader | undefined;
const client = () => (defaultClient ??= new ApkDownloader());

/** Download one app with the default client. See {@link ApkDownloader.download}. */
export function download(packageName: string, options?: DownloadOptions): Promise<DownloadResult> {
  return client().download(packageName, options);
}

/** Download several apps with the default client. See {@link ApkDownloader.downloadMany}. */
export function downloadMany(packageNames: string[], options?: DownloadManyOptions): Promise<BatchResult[]> {
  return client().downloadMany(packageNames, options);
}

/** Look up app metadata with the default client. See {@link ApkDownloader.getInfo}. */
export function getInfo(packageName: string, options?: LookupCallOptions): Promise<AppInfo> {
  return client().getInfo(packageName, options);
}

/** List versions with the default client. See {@link ApkDownloader.listVersions}. */
export function listVersions(packageName: string, options?: LookupCallOptions): Promise<AppVersion[]> {
  return client().listVersions(packageName, options);
}

let warnedDownloadAPK = false;

/**
 * v1 compatibility: download into `./Downloads`.
 * @deprecated Use {@link download} (`download(pkg, { outDir: 'Downloads' })`).
 */
export function downloadAPK(packageName: string): Promise<DownloadResult> {
  if (!warnedDownloadAPK) {
    warnedDownloadAPK = true;
    process.emitWarning('downloadAPK() is deprecated; use download(packageName, options) instead.', {
      type: 'DeprecationWarning',
      code: 'APKDL_DEP_DOWNLOADAPK',
    });
  }
  return client().download(packageName, { outDir: path.join(process.cwd(), 'Downloads') });
}
