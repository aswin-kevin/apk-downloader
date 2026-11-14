import { describe, expect, it } from 'vitest';
import { InvalidPackageError } from '../../src/errors.js';
import { assertPackageName, isValidPackageName } from '../../src/util/package-name.js';

describe('package name validation', () => {
  it.each(['com.whatsapp', 'a.b_c.d1', 'org.fdroid.fdroid', 'com.Example.App'])(
    'accepts %s',
    (pkg) => {
      expect(isValidPackageName(pkg)).toBe(true);
      expect(() => assertPackageName(pkg)).not.toThrow();
    },
  );

  it.each(['whatsapp', 'com..x', '1com.x', 'com/x', '', 'com.x.', '.com.x', 'com.1x', 'com.x;rm'])(
    'rejects %j',
    (pkg) => {
      expect(isValidPackageName(pkg)).toBe(false);
      expect(() => assertPackageName(pkg)).toThrow(InvalidPackageError);
    },
  );
});
