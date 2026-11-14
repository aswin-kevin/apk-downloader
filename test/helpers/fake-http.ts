import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetworkError } from '../../src/errors.js';
import type { Http, HttpRequestInit } from '../../src/types.js';

export interface FakeResponse {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
}

export interface FakeHttp extends Http {
  calls: Array<{ url: string; init?: HttpRequestInit }>;
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, relativePath), 'utf8'));
}

/**
 * An `Http` that answers from a route table. The first route whose matcher matches the URL wins;
 * unmatched URLs fail the test loudly.
 */
export function fakeHttp(routes: Array<[string | RegExp, FakeResponse]>): FakeHttp {
  const calls: FakeHttp['calls'] = [];

  const request = async (url: string, init?: HttpRequestInit): Promise<Response> => {
    calls.push({ url, ...(init ? { init } : {}) });
    const route = routes.find(([matcher]) =>
      typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url),
    );
    if (!route) throw new Error(`fakeHttp: no route for ${url}`);
    const [, spec] = route;
    const body = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.body ?? null);
    const status = spec.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: spec.headers ?? {},
    });
  };

  return {
    calls,
    request,
    async json<T>(url: string, init?: HttpRequestInit): Promise<T> {
      const response = await request(url, init);
      if (!response.ok) throw new NetworkError(`HTTP ${response.status}`, { url, status: response.status });
      return (await response.json()) as T;
    },
  };
}
