import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  hits: number;
  requests: http.IncomingMessage[];
  close(): Promise<void>;
}

/** Start a throwaway HTTP server on a random local port. */
export async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void,
): Promise<TestServer> {
  const state: TestServer = {
    url: '',
    hits: 0,
    requests: [],
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    state.requests.push(req);
    handler(req, res, state.hits);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
