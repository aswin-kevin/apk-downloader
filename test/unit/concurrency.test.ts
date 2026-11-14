import { describe, expect, it } from 'vitest';
import { pLimit } from '../../src/util/concurrency.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pLimit', () => {
  it('never runs more than n tasks at once and returns every result', async () => {
    const limit = pLimit(2);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick(10);
          running--;
          return n * 10;
        }),
      ),
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('propagates rejections and keeps going', async () => {
    const limit = pLimit(1);
    const failing = limit(async () => {
      throw new Error('boom');
    });
    const next = limit(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('rejects invalid limits', () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(1.5)).toThrow(RangeError);
  });
});
