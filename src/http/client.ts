import { AbortError, NetworkError, TimeoutError } from '../errors.js';
import type { Http, HttpRequestInit } from '../types.js';
import { computeBackoff, RETRYABLE_STATUSES, sleep as defaultSleep } from './retry.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export interface HttpClientOptions {
  /** Per-request timeout in ms. */
  timeout: number;
  /** Retries for transient failures (network errors, timeouts, retryable statuses). */
  retries: number;
  userAgent: string;
  /** Explicit proxy URL. When omitted, standard proxy environment variables are used. */
  proxy?: string | undefined;
  /** Custom fetch implementation. Proxy settings are ignored when this is set. */
  fetch?: typeof fetch | undefined;
  /** Injected for tests. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Environment used for proxy detection. Default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
}

type ProxyFetch = { fetch: typeof fetch; dispatcher: unknown };

/** HTTP client shared by all sources: user agent, timeouts, retries with backoff, proxy, cancellation. */
export class HttpClient implements Http {
  private readonly options: HttpClientOptions;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly proxies = new Map<string, Promise<ProxyFetch>>();

  constructor(options: HttpClientOptions) {
    this.options = options;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<Response> {
    const { timeout = this.options.timeout, signal, ...rest } = init;
    const callerSignal = signal ?? undefined;
    const headers = new Headers(rest.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', this.options.userAgent);

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(callerSignal);
      const isLast = attempt >= this.options.retries;
      const timeoutSignal = timeout === false ? undefined : AbortSignal.timeout(timeout);
      const signal = combineSignals(callerSignal, timeoutSignal);

      let response: Response;
      try {
        response = await this.fetch(url, { ...rest, headers, signal });
      } catch (error) {
        if (callerSignal?.aborted) throw new AbortError(undefined, { cause: error });
        const failure = timeoutSignal?.aborted
          ? new TimeoutError(`Request timed out after ${String(timeout)} ms: ${url}`, { url, cause: error })
          : new NetworkError(`Request failed: ${url} (${describe(error)})`, { url, cause: error });
        if (isLast) throw failure;
        await this.backoff(attempt, null, callerSignal);
        continue;
      }

      if (!RETRYABLE_STATUSES.has(response.status)) return response;

      await response.body?.cancel().catch(() => {});
      if (isLast) {
        throw new NetworkError(`HTTP ${response.status} from ${url}`, { url, status: response.status });
      }
      await this.backoff(attempt, response.headers.get('retry-after'), callerSignal);
    }
  }

  async json<T = unknown>(url: string, init: HttpRequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    const response = await this.request(url, { ...init, headers });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new NetworkError(`HTTP ${response.status} from ${url}`, { url, status: response.status });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new NetworkError(`Invalid JSON from ${url}`, { url, status: response.status, cause: error });
    }
  }

  private async backoff(attempt: number, retryAfter: string | null, signal?: AbortSignal): Promise<void> {
    try {
      await this.sleep(computeBackoff(attempt, retryAfter), signal);
    } catch (error) {
      throw new AbortError(undefined, { cause: error });
    }
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (this.options.fetch) return this.options.fetch(url, init);
    const proxy = resolveProxy(url, this.options.proxy, this.options.env ?? process.env);
    if (!proxy) return fetch(url, init);
    const { fetch: proxiedFetch, dispatcher } = await this.proxyFetch(proxy);
    return proxiedFetch(url, { ...init, dispatcher } as RequestInit);
  }

  /** Lazily load undici only when a proxy is actually used. */
  private proxyFetch(proxy: string): Promise<ProxyFetch> {
    let entry = this.proxies.get(proxy);
    if (!entry) {
      entry = import('undici').then((undici) => ({
        fetch: undici.fetch as unknown as typeof fetch,
        dispatcher: new undici.ProxyAgent(proxy),
      }));
      this.proxies.set(proxy, entry);
    }
    return entry;
  }
}

/**
 * Pick the proxy for a URL: the explicit proxy if given, otherwise `HTTPS_PROXY` / `HTTP_PROXY`
 * (either case) by scheme, honouring `NO_PROXY`.
 */
export function resolveProxy(
  url: string,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (explicit) return explicit;
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const proxy = isHttps
    ? (env.HTTPS_PROXY ?? env.https_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy);
  if (!proxy) return undefined;
  return bypassesProxy(target.hostname, env.NO_PROXY ?? env.no_proxy) ? undefined : proxy;
}

function bypassesProxy(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const suffix = entry.startsWith('.') ? entry : `.${entry}`;
      return host === entry.replace(/^\./, '') || host.endsWith(suffix);
    });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
