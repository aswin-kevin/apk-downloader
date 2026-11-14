const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
const JITTER = 0.2;

/** HTTP statuses worth retrying: timeouts, rate limiting and transient server errors. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Delay before retry number `attempt + 1` (attempt is 0-based).
 * A valid `Retry-After` header (delta-seconds or HTTP date) wins, capped at 60 s;
 * otherwise exponential backoff from 500 ms with ±20% jitter, capped at 30 s.
 */
export function computeBackoff(attempt: number, retryAfter?: string | null): number {
  const fromHeader = parseRetryAfter(retryAfter);
  if (fromHeader !== undefined) return Math.min(fromHeader, MAX_RETRY_AFTER_MS);

  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = exponential * JITTER * (Math.random() * 2 - 1);
  return Math.min(Math.round(exponential + jitter), MAX_BACKOFF_MS);
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/** Promise-based sleep that rejects with the signal's reason when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
