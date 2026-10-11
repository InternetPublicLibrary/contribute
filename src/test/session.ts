import { env } from 'cloudflare:workers';
import type { Identity } from '../auth/identity';
import { randomToken } from '../auth/pkce';
import { SESSION_COOKIE } from '../auth/session';

export const GITHUB_READER: Identity = { provider: 'github', id: '583231', login: 'octocat', name: 'The Octocat', profileUrl: 'https://github.com/octocat' };
export const ORCID_READER: Identity = { provider: 'orcid', id: '0000-0002-1825-0097', name: 'Josiah Carberry', profileUrl: 'https://orcid.org/0000-0002-1825-0097' };

/** A signed-in browser: the session record in KV and the headers a credentialed IPL request sends. */
export async function signedIn(identity: Identity = GITHUB_READER, origin = 'http://localhost:4000') {
  const id = randomToken();
  const csrfToken = randomToken();
  await env.CONTRIBUTE_KV.put(`session:${id}`, JSON.stringify({ identity, csrfToken, createdAt: new Date().toISOString() }));
  return { id, csrfToken, headers: { cookie: `${SESSION_COOKIE}=${id}`, origin, 'x-csrf-token': csrfToken } };
}
