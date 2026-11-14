import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AbortError, NetworkError, TimeoutError } from '../../src/errors.js';
import { HttpClient, DEFAULT_USER_AGENT, resolveProxy } from '../../src/http/client.js';
import { computeBackoff } from '../../src/http/retry.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const noSleep = async () => {};

function client(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({ timeout: 2000, retries: 2, userAgent: 'test-agent', sleep: noSleep, ...overrides });
}

describe('computeBackoff', () => {
  it('grows exponentially with jitter and a cap', () => {
    for (let i = 0; i < 20; i++) {
      const first = computeBackoff(0);
      expect(first).toBeGreaterThanOrEqual(400);
      expect(first).toBeLessThanOrEqual(600);
      const third = computeBackoff(2);
      expect(third).toBeGreaterThanOrEqual(1600);
      expect(third).toBeLessThanOrEqual(2400);
      expect(computeBackoff(20)).toBeLessThanOrEqual(30_000);
    }
  });

  it('honours Retry-After seconds and dates, capped at 60s', () => {
    expect(computeBackoff(0, '2')).toBe(2000);
    expect(computeBackoff(0, '3600')).toBe(60_000);
    const inFive = new Date(Date.now() + 5000).toUTCString();
    const fromDate = computeBackoff(0, inFive);
    expect(fromDate).toBeGreaterThan(3000);
    expect(fromDate).toBeLessThanOrEqual(5000);
  });

  it('ignores an unparseable Retry-After', () => {
    const ms = computeBackoff(0, 'soon');
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(ms).toBeLessThanOrEqual(600);
  });
});

describe('HttpClient', () => {
  it('retries 503 then succeeds', async () => {
    server = await startServer((_req, res, hit) => {
      res.statusCode = hit < 3 ? 503 : 200;
      res.end(hit < 3 ? 'busy' : 'ok');
    });
    const res = await client().request(server.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(server.hits).toBe(3);
  });

  it('waits for the Retry-After delay between attempts', async () => {
    const waits: number[] = [];
    server = await startServer((_req, res, hit) => {
      if (hit === 1) {
        res.writeHead(429, { 'retry-after': '2' });
        res.end();
      } else res.end('ok');
    });
    const res = await client({ sleep: async (ms) => void waits.push(ms) }).request(server.url);
    expect(res.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  it('does not retry 404 and returns the response', async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const res = await client().request(server.url);
    expect(res.status).toBe(404);
    expect(server.hits).toBe(1);
  });

  it('throws NetworkError with status after retries are exhausted', async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const err = await client().request(server.url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).status).toBe(503);
    expect(server.hits).toBe(3);
  });

  it('throws NetworkError when the connection fails', async () => {
    const err = await client({ retries: 1 }).request('http://127.0.0.1:1/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });

  it('raises TimeoutError when the server does not answer in time', async () => {
    server = await startServer(() => {
      /* never respond */
    });
    const err = await client({ timeout: 100, retries: 1 }).request(server.url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(server.hits).toBe(2);
  });

  it('caller abort raises AbortError and does not retry', async () => {
    server = await startServer(() => {
      /* never respond */
    });
    const controller = new AbortController();
    const pending = client().request(server.url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(server.hits).toBe(1);
  });

  it('rejects immediately with AbortError for an already-aborted signal', async () => {
    const err = await client()
      .request('http://127.0.0.1:1/', { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
  });

  it('sends the configured user-agent unless the caller overrides it', async () => {
    server = await startServer((_req, res) => res.end());
    await client().request(server.url);
    await client().request(server.url, { headers: { 'User-Agent': 'custom' } });
    expect(server.requests[0]?.headers['user-agent']).toBe('test-agent');
    expect(server.requests[1]?.headers['user-agent']).toBe('custom');
  });

  it('has a browser-like default user-agent', () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
  });

  it('json() parses 2xx bodies and throws NetworkError otherwise', async () => {
    server = await startServer((req, res) => {
      res.statusCode = req.url === '/ok' ? 200 : 400;
      res.end(JSON.stringify({ hello: 'world' }));
    });
    await expect(client().json(`${server.url}/ok`)).resolves.toEqual({ hello: 'world' });
    const err = await client().json(`${server.url}/bad`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).status).toBe(400);
  });

  it('json() throws NetworkError on an invalid body', async () => {
    server = await startServer((_req, res) => res.end('<html>'));
    await expect(client().json(server.url)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('HttpClient proxy support', () => {
  it('routes requests through the configured proxy', async () => {
    server = await startServer((_req, res) => res.end('via-proxy'));
    const tunnels: string[] = [];
    const sockets: Array<{ destroy(): void }> = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      tunnels.push(req.url ?? '');
      sockets.push(clientSocket);
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      sockets.push(upstream);
      upstream.on('error', () => clientSocket.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.address() as AddressInfo;
    try {
      const res = await client({ proxy: `http://127.0.0.1:${port}` }).request(server.url);
      expect(await res.text()).toBe('via-proxy');
      expect(tunnels).toEqual([new URL(server.url).host]);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

describe('resolveProxy', () => {
  it('prefers the explicit proxy', () => {
    expect(resolveProxy('https://a.com/x', 'http://p:1', { HTTPS_PROXY: 'http://env:2' })).toBe('http://p:1');
  });

  it('uses HTTPS_PROXY / HTTP_PROXY by scheme, either case', () => {
    expect(resolveProxy('https://a.com', undefined, { https_proxy: 'http://s:1' })).toBe('http://s:1');
    expect(resolveProxy('http://a.com', undefined, { HTTP_PROXY: 'http://h:1' })).toBe('http://h:1');
    expect(resolveProxy('http://a.com', undefined, { HTTPS_PROXY: 'http://s:1' })).toBeUndefined();
  });

  it('respects NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://s:1', NO_PROXY: 'localhost, .example.com,other.org' };
    expect(resolveProxy('https://api.example.com', undefined, env)).toBeUndefined();
    expect(resolveProxy('https://other.org', undefined, env)).toBeUndefined();
    expect(resolveProxy('https://localhost:8080', undefined, env)).toBeUndefined();
    expect(resolveProxy('https://example.org', undefined, env)).toBe('http://s:1');
    expect(resolveProxy('https://x.com', undefined, { HTTPS_PROXY: 'http://s:1', NO_PROXY: '*' })).toBeUndefined();
  });
});
