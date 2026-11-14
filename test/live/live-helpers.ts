import { DEFAULT_USER_AGENT, HttpClient } from '../../src/http/client.js';

export * from '../../src/index.js';

/** The same HTTP stack the client uses, for calling sources directly. */
export function HttpClientForTests(): HttpClient {
  return new HttpClient({ timeout: 30_000, retries: 2, userAgent: DEFAULT_USER_AGENT });
}
