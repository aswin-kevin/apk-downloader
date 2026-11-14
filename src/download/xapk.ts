import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Entry, ZipFile } from 'yauzl';
import { InvalidArchiveError, UnsafeArchiveError } from '../errors.js';

/** Messages yauzl uses when it rejects a file name for path-safety reasons. */
const YAUZL_UNSAFE_NAME = /invalid relative path|absolute path|invalid characters in fileName/i;

/**
 * Extract an XAPK: every `.apk`, OBB files under `Android/obb/`, and the root `manifest.json`.
 * Paths inside the archive are preserved relative to `destDir`.
 *
 * All entry names are validated before anything is written, so an archive containing a single
 * unsafe entry ("zip slip") is rejected without touching the disk. Returns absolute file paths.
 */
export async function extractXapk(file: string, destDir: string): Promise<string[]> {
  const root = path.resolve(destDir);
  const zip = await open(file);
  const written: string[] = [];
  try {
    const entries = await listEntries(zip);
    const selected = entries.filter((entry) => isWanted(entry.fileName));
    if (!selected.some((entry) => entry.fileName.toLowerCase().endsWith('.apk'))) {
      throw new InvalidArchiveError(`No APK found in ${path.basename(file)}`);
    }
    const targets = selected.map((entry) => ({ entry, target: safeTarget(root, entry.fileName) }));

    for (const { entry, target } of targets) {
      await mkdir(path.dirname(target), { recursive: true });
      const stream = await openEntry(zip, entry);
      written.push(target);
      await pipeline(stream, createWriteStream(target));
    }
    return written;
  } catch (error) {
    await Promise.all(written.map((f) => rm(f, { force: true }).catch(() => {})));
    if (error instanceof InvalidArchiveError || error instanceof UnsafeArchiveError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArchiveError(`Cannot extract ${path.basename(file)}: ${message}`, {
      cause: error,
    });
  } finally {
    zip.close();
  }
}

function isWanted(name: string): boolean {
  if (name.endsWith('/')) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.apk') || lower.startsWith('android/obb/') || name === 'manifest.json';
}

/** Resolve an entry name inside `root`, rejecting anything that could escape it. */
function safeTarget(root: string, name: string): string {
  const unsafe =
    name.length === 0 ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((segment) => segment === '..');
  const target = path.resolve(root, name);
  if (unsafe || !target.startsWith(root + path.sep)) throw new UnsafeArchiveError(name);
  return target;
}

async function open(file: string): Promise<ZipFile> {
  const yauzl = await import('yauzl');
  try {
    return await new Promise<ZipFile>((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) =>
        err || !zip ? reject(err ?? new Error('unknown error')) : resolve(zip),
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArchiveError(`Not a valid XAPK archive: ${message}`, { cause: error });
  }
}

function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', (error: Error) => {
      const unsafe = YAUZL_UNSAFE_NAME.exec(error.message);
      reject(
        unsafe
          ? new UnsafeArchiveError(error.message.split(': ').slice(1).join(': ') || error.message)
          : error,
      );
    });
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) =>
      err || !stream ? reject(err ?? new Error('no stream')) : resolve(stream),
    );
  });
}
