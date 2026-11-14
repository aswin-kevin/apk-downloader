import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderFileName } from '../../src/util/filename.js';

const base = { package: 'a.b', version: '1.0', versionCode: 10, source: 'aptoide', ext: 'apk' };

describe('renderFileName', () => {
  it('renders the default template', () => {
    expect(renderFileName('{package}-{version}.{ext}', base)).toBe('a.b-1.0.apk');
  });

  it('supports every placeholder', () => {
    expect(renderFileName('{source}_{package}_{versionCode}_{version}.{ext}', base)).toBe(
      'aptoide_a.b_10_1.0.apk',
    );
  });

  it('falls back to "latest" when version is unknown', () => {
    expect(renderFileName('{package}-{version}.{ext}', { ...base, version: undefined })).toBe(
      'a.b-latest.apk',
    );
  });

  it('renders unknown versionCode as empty and leaves unknown placeholders untouched', () => {
    expect(renderFileName('{package}{versionCode}-{nope}.{ext}', { ...base, versionCode: undefined })).toBe(
      'a.b-{nope}.apk',
    );
  });

  it('sanitizes template values', () => {
    const result = renderFileName('{package}/../{version}.{ext}', { ...base, version: '../../x' });
    expect(result).not.toMatch(/[/\\]/);
    expect(result.startsWith('.')).toBe(false);
    expect(path.basename(result)).toBe(result);
  });

  it('strips control and reserved characters', () => {
    const result = renderFileName('{version}.{ext}', { ...base, version: 'a:b*c?"<>|\u0001' });
    expect(result).toBe('a_b_c______.apk');
  });

  it('limits length to 200 characters while keeping the extension', () => {
    const result = renderFileName('{version}.{ext}', { ...base, version: 'v'.repeat(500) });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.apk')).toBe(true);
  });

  it('never returns an empty name', () => {
    expect(renderFileName('{nothing}', { ...base })).toBe('{nothing}');
    expect(renderFileName('...', { ...base }).length).toBeGreaterThan(0);
  });
});
