import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/index.js';

describe('package', () => {
  it('exposes the package version', () => {
    expect(VERSION).toBe('2.0.0');
  });
});
