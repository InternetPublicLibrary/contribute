import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { handleError } from '../errors';
import { FakeGitHub } from '../test/fake-github';
import { codeChallenge } from './pkce';
import { authRoutes } from './routes';
import { SESSION_COOKIE } from './session';

const IPL = 'http://localhost:4000';
const PAGE = `${IPL}/pt-BR/computacao/`;
const SERVICE = 'https://contribute.example';

const vars: Partial<Env> = {
  GITHUB_OAUTH_CLIENT_ID: 'gh-client',
  GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
  ORCID_CLIENT_ID: 'APP-ORCID',
  ORCID_CLIENT_SECRET: 'orcid-secret',
};

/** Challenge sent by the latest /start; the fake providers accept only the matching verifier, like real PKCE. */
let expectedChallenge = '';
async function pkceOk(body: unknown): Promise<boolean> {
  const params = new URLSearchParams(String(body));
  return params.get('code') === 'good' && (await codeChallenge(params.get('code_verifier') ?? '')) === expectedChallenge;
}

function fakeProviders() {
  return new FakeGitHub()
    .on('POST', /^\/login\/oauth\/access_token$/, async (call) =>
      Response.json((await pkceOk(call.body)) ? { access_token: 'gho_user_token', token_type: 'bearer' } : { error: 'bad_verification_code' }),
    )
    .on('GET', /^\/user$/, { id: 583231, login: 'octocat', name: null, html_url: 'https://github.com/octocat' })
    .on('POST', /^\/oauth\/token$/, async (call) => {
      const ok = await pkceOk(call.body);
      return Response.json(ok ? { access_token: 'orcid-token', orcid: '0000-0002-1825-0097', name: '' } : { error: 'invalid_grant' }, { status: ok ? 200 : 400 });
    })
    .on('GET', /^\/v3\.0\/0000-0002-1825-0097\/person$/, { name: { 'credit-name': null, 'given-names': { value: 'Josiah' }, 'family-name': { value: 'Carberry' } } });
}

/** The FakeGitHub fetch records bodies as JSON; OAuth token requests are form-encoded, so keep them as text. */
function textBodies(fake: FakeGitHub): typeof fetch {
  return async (input, init) => {
    const body = init?.body instanceof URLSearchParams ? JSON.stringify(init.body.toString()) : init?.body;
    return fake.fetch(input, { ...init, ...(body === undefined ? {} : { body }) });
  };
}

function setup(fake = fakeProviders()) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.route('/v1', authRoutes(textBodies(fake)));
  const request = (path: string, init: RequestInit = {}) => app.request(`${SERVICE}${path}`, init, { ...env, ...vars });
  return { fake, request };
}

/** The `name=value` of one cookie set by a response ('' when it is not set or is being deleted). */
const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`)) ?? '';
const cookieOf = (response: Response) => setCookie(response, SESSION_COOKIE).split(';')[0] ?? '';

async function start(request: ReturnType<typeof setup>['request'], provider: string, returnTo = PAGE) {
  const response = await request(`/v1/auth/${provider}/start?return_to=${encodeURIComponent(returnTo)}`);
  const location = new URL(response.headers.get('location') ?? '');
  expectedChallenge = location.searchParams.get('code_challenge') ?? '';
  return { response, location, state: location.searchParams.get('state') ?? '', stateCookie: setCookie(response, '__Host-ipl_contribute_state').split(';')[0] ?? '' };
}


describe('GET /v1/auth/:provider/start', () => {
  it('redirects to GitHub with read:user only, a state and an S256 PKCE challenge', async () => {
    const { request } = setup();
    const { response, location, state } = await start(request, 'github');

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'gh-client',
      scope: 'read:user',
      redirect_uri: `${SERVICE}/v1/auth/github/callback`,
      code_challenge_method: 'S256',
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('redirects to the ORCID sandbox with the /authenticate scope', async () => {
    const { request } = setup();
    const { location } = await start(request, 'orcid');

    expect(location.origin + location.pathname).toBe('https://sandbox.orcid.org/oauth/authorize');
    expect(location.searchParams.get('scope')).toBe('/authenticate');
  });

  it('answers an unknown provider with 404', async () => {
    const { request } = setup();

    expect((await request('/v1/auth/gitlab/start')).status).toBe(404);
  });
});

describe('sign-in round trip', () => {
  it('signs in a GitHub account without public e-mail or name and shows its login', async () => {
    const { request, fake } = setup();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(PAGE);
    expect(setCookie(callback, SESSION_COOKIE)).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax$`));
    expect(callback.headers.getSetCookie()).toContainEqual(expect.stringMatching(/^__Host-ipl_contribute_state=; Max-Age=0/));

    const session = await request('/v1/session', { headers: { cookie: cookieOf(callback), origin: IPL } });
    expect(await session.json()).toEqual({
      identity: { provider: 'github', id: '583231', login: 'octocat', name: 'octocat', profileUrl: 'https://github.com/octocat' },
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(session.headers.get('access-control-allow-origin')).toBe(IPL);
    expect(session.headers.get('access-control-allow-credentials')).toBe('true');

    const tokenRequest = fake.calls.find((call) => call.path === '/login/oauth/access_token');
    expect(String(tokenRequest?.body)).toMatch(/code_verifier=[A-Za-z0-9_-]{43}/);
  });

  it('keeps no provider token in KV after the callback', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });
    const id = cookieOf(callback).split('=')[1] ?? '';

    const stored = await env.CONTRIBUTE_KV.get(`session:${id}`);
    expect(stored).toContain('octocat');
    expect(stored).not.toContain('gho_user_token');
  });

  it('signs in with ORCID and falls back to given and family names from the public record', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'orcid');
    const callback = await request(`/v1/auth/orcid/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });
    const session = await request('/v1/session', { headers: { cookie: cookieOf(callback) } });

    expect(await session.json()).toMatchObject({
      identity: { provider: 'orcid', id: '0000-0002-1825-0097', name: 'Josiah Carberry', profileUrl: 'https://sandbox.orcid.org/0000-0002-1825-0097' },
    });
  });

  it('uses the ORCID iD when no name is public', async () => {
    const bare = new FakeGitHub()
      .on('POST', /^\/oauth\/token$/, { access_token: 't', orcid: '0000-0002-1825-0097', name: null })
      .on('GET', /^\/v3\.0\/.*\/person$/, new Response('{}', { status: 404 }));
    const { request } = setup(bare);
    const { state, stateCookie } = await start(request, 'orcid');
    const callback = await request(`/v1/auth/orcid/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });

    expect(await (await request('/v1/session', { headers: { cookie: cookieOf(callback) } })).json()).toMatchObject({ identity: { name: '0000-0002-1825-0097' } });
  });

  it('redirects only to the return URL stored with the state, never to one in the callback', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?code=good&state=${state}&return_to=https://evil.example`, { headers: { cookie: stateCookie } });

    expect(callback.headers.get('location')).toBe(PAGE);
  });

  it('stores the site home when return_to is not an IPL page', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github', 'https://evil.example/phish');
    const callback = await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });

    expect(callback.headers.get('location')).toBe(`${IPL}/`);
  });
});

describe('rejected callbacks', () => {
  it('rejects a reused state', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github');
    await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });
    const replay = await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });

    expect(replay.status).toBe(400);
    expect(cookieOf(replay)).toBe('');
  });

  it.each(['', 'short', 'A'.repeat(43)])('rejects a missing or unknown state %j', async (state) => {
    const { request } = setup();

    expect((await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: `__Host-ipl_contribute_state=${state}` } })).status).toBe(400);
  });

  it('rejects a callback started in another browser (login CSRF)', async () => {
    const { request, fake } = setup();
    // The attacker starts a sign-in and sends the victim the callback URL with the attacker's state and code.
    const attacker = await start(request, 'github');
    const victim = await request(`/v1/auth/github/callback?code=good&state=${attacker.state}`);

    expect(victim.status).toBe(400);
    expect(cookieOf(victim)).toBe('');
    expect(fake.count('POST', /access_token$/)).toBe(0);
  });

  it('rejects a callback whose state cookie belongs to another sign-in', async () => {
    const { request } = setup();
    const first = await start(request, 'github');
    const second = await start(request, 'github');

    expect((await request(`/v1/auth/github/callback?code=good&state=${first.state}`, { headers: { cookie: second.stateCookie } })).status).toBe(400);
  });

  it('sets the state cookie with host-only, HttpOnly, Secure and SameSite=Lax flags', async () => {
    const { request } = setup();
    const { response } = await start(request, 'github');

    expect(setCookie(response, '__Host-ipl_contribute_state')).toMatch(/^__Host-ipl_contribute_state=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('rejects a state issued for another provider', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'orcid');

    expect((await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } })).status).toBe(400);
  });

  it('fails when the verifier does not match the challenge the provider received (PKCE)', async () => {
    const { request } = setup();
    const first = await start(request, 'github');
    await start(request, 'github'); // the provider now expects the second sign-in's challenge
    const callback = await request(`/v1/auth/github/callback?code=good&state=${first.state}`, { headers: { cookie: first.stateCookie } });

    expect(callback.status).toBe(401);
    expect(cookieOf(callback)).toBe('');
  });

  it('rejects a code the provider refuses (e.g. wrong PKCE verifier) with 401 and no session', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?code=bad&state=${state}`, { headers: { cookie: stateCookie } });

    expect(callback.status).toBe(401);
    expect(await callback.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(cookieOf(callback)).toBe('');
  });

  it('returns to the page, signed out, when the person declines at the provider', async () => {
    const { request } = setup();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?error=access_denied&state=${state}`, { headers: { cookie: stateCookie } });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(PAGE);
    expect(cookieOf(callback)).toBe('');
  });
});

describe('session and logout', () => {
  async function signedIn() {
    const context = setup();
    const { state, stateCookie } = await start(context.request, 'github');
    const callback = await context.request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie } });
    const cookie = cookieOf(callback);
    const { csrfToken } = (await (await context.request('/v1/session', { headers: { cookie } })).json()) as { csrfToken: string };
    return { ...context, cookie, csrfToken, id: cookie.split('=')[1] ?? '' };
  }

  it('replaces an existing session on a new sign-in (no fixation)', async () => {
    const { request, cookie: oldCookie, id: oldId } = await signedIn();
    const { state, stateCookie } = await start(request, 'github');
    const callback = await request(`/v1/auth/github/callback?code=good&state=${state}`, { headers: { cookie: `${oldCookie}; ${stateCookie}` } });
    const newCookie = cookieOf(callback);

    expect(newCookie).not.toBe(oldCookie);
    expect(await env.CONTRIBUTE_KV.get(`session:${oldId}`)).toBeNull();
  });

  it('answers 401 without a session', async () => {
    const { request } = setup();

    expect((await request('/v1/session')).status).toBe(401);
  });

  it('gives other origins no CORS access', async () => {
    const { request, cookie } = await signedIn();
    const response = await request('/v1/session', { headers: { cookie, origin: 'https://evil.example' } });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('logs out with the CSRF token from an IPL origin and deletes the KV record', async () => {
    const { request, cookie, csrfToken, id } = await signedIn();
    const response = await request('/v1/auth/logout', { method: 'POST', headers: { cookie, origin: IPL, 'x-csrf-token': csrfToken } });

    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toContainEqual(expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`)));
    expect(await env.CONTRIBUTE_KV.get(`session:${id}`)).toBeNull();
    expect((await request('/v1/session', { headers: { cookie } })).status).toBe(401);
  });

  it('rejects logout without the CSRF token', async () => {
    const { request, cookie, id } = await signedIn();
    const response = await request('/v1/auth/logout', { method: 'POST', headers: { cookie, origin: IPL } });

    expect(response.status).toBe(403);
    expect(await env.CONTRIBUTE_KV.get(`session:${id}`)).not.toBeNull();
  });

  it('rejects logout from another origin', async () => {
    const { request, cookie, csrfToken } = await signedIn();
    const response = await request('/v1/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrfToken } });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });
});
