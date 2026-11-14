import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractXapk } from '../../src/download/xapk.js';
import { InvalidArchiveError, UnsafeArchiveError } from '../../src/errors.js';
import { makeZip } from '../helpers/zip.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'apkdl-xapk-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function archive(entries: Array<{ name: string; data: string }>): Promise<string> {
  const file = path.join(dir, 'app.xapk');
  await writeFile(file, makeZip(entries));
  return file;
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .sort();
}

describe('extractXapk', () => {
  it('extracts APKs, OBB files and the manifest, preserving the OBB path', async () => {
    const file = await archive([
      { name: 'manifest.json', data: '{"package_name":"a.b"}' },
      { name: 'icon.png', data: 'png' },
      { name: 'a.b.apk', data: 'base' },
      { name: 'config.arm64_v8a.apk', data: 'abi' },
      { name: 'Android/obb/a.b/main.1.a.b.obb', data: 'obb' },
      { name: 'Android/obb/a.b/', data: '' },
      { name: 'other/readme.txt', data: 'ignored' },
    ]);
    const dest = path.join(dir, 'out');
    const files = await extractXapk(file, dest);

    expect(files.map((f) => path.relative(dest, f)).sort()).toEqual([
      'Android/obb/a.b/main.1.a.b.obb',
      'a.b.apk',
      'config.arm64_v8a.apk',
      'manifest.json',
    ]);
    for (const f of files) expect(path.isAbsolute(f)).toBe(true);
    expect(await readFile(path.join(dest, 'config.arm64_v8a.apk'), 'utf8')).toBe('abi');
    expect(await walk(dest)).toEqual(files.map((f) => path.relative(dest, f)).sort());
  });

  it.each(['../evil.apk', 'Android/obb/../../evil.obb', '/abs/evil.apk', 'C:\\evil.apk', 'a\\..\\..\\evil.apk'])(
    'rejects unsafe entry %j and writes nothing',
    async (name) => {
      const file = await archive([
        { name: 'ok.apk', data: 'ok' },
        { name, data: 'evil' },
      ]);
      const dest = path.join(dir, 'out');
      const err = await extractXapk(file, dest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsafeArchiveError);
      expect((err as UnsafeArchiveError).code).toBe('ERR_UNSAFE_ARCHIVE');
      expect(await readdir(dir)).toEqual(expect.not.arrayContaining(['evil.apk', 'evil.obb']));
      const leftovers = await readdir(dest).catch(() => []);
      expect(leftovers).toEqual([]);
    },
  );

  it('rejects a corrupt archive', async () => {
    const file = path.join(dir, 'bad.xapk');
    await writeFile(file, 'PK\x03\x04 definitely not a zip');
    const err = await extractXapk(file, path.join(dir, 'out')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidArchiveError);
    expect((err as InvalidArchiveError).code).toBe('ERR_INVALID_ARCHIVE');
  });

  it('rejects an archive without any APK', async () => {
    const file = await archive([{ name: 'manifest.json', data: '{}' }]);
    await expect(extractXapk(file, path.join(dir, 'out'))).rejects.toBeInstanceOf(InvalidArchiveError);
  });
});
