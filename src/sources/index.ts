import type { Source } from '../types.js';
import { apkpure } from './apkpure.js';
import { aptoide } from './aptoide.js';
import { fdroid } from './fdroid.js';

export { apkpure, createApkpureSource, type ApkpureSourceOptions } from './apkpure.js';
export { aptoide, createAptoideSource, type AptoideSourceOptions } from './aptoide.js';
export { createFdroidSource, fdroid, type FdroidSourceOptions } from './fdroid.js';

/** Sources that ship with the library, by id. */
export const builtinSources: Readonly<Record<string, Source>> = Object.freeze({
  aptoide,
  apkpure,
  fdroid,
});

/** Default fallback order for downloads. */
export const DEFAULT_SOURCES: readonly string[] = Object.freeze(['aptoide', 'apkpure', 'fdroid']);

/** Default order for `getInfo` / `listVersions` (richest metadata first). */
export const DEFAULT_INFO_SOURCES: readonly string[] = Object.freeze(['aptoide', 'fdroid', 'apkpure']);
