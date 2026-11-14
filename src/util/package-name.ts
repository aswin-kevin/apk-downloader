import { InvalidPackageError } from '../errors.js';

/**
 * Android application ids: at least two dot-separated segments, each starting with a
 * letter and containing only letters, digits and underscores.
 */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_LENGTH = 255;

export function isValidPackageName(packageName: string): boolean {
  return packageName.length <= MAX_LENGTH && PACKAGE_NAME.test(packageName);
}

export function assertPackageName(packageName: string): void {
  if (!isValidPackageName(packageName)) throw new InvalidPackageError(packageName);
}
