import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import packageText from '../../package.json?raw';
import { authRoutes } from '../auth/routes';
import type { Env } from '../env';
import { handleError } from '../errors';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { GITHUB_READER, signedIn } from '../test/session';
import { recordContribution, releaseContribution } from './limits';
import { contributionRoutes } from './routes';

const IPL = 'http://localhost:4000';
let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

function app(fake: FakeGitHub, vars: Partial<Env> = {}) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleError);
  hono.route('/v1', authRoutes(fake.fetch));
  hono.route('/v1', contributionRoutes({ fetch: fake.fetch, probe: async () => new Response(null) }));
  return (path: string, init: RequestInit = {}) => hono.request(path, init, { ...env, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem, GITHUB_OAUTH_CLIENT_ID: 'c', GITHUB_OAUTH_CLIENT_SECRET: 's', ...vars });
}

let counter = 0;
/** A fresh identity per test, so KV counters do not leak between tests. */
const reader = () => ({ ...GITHUB_READER, id: String(900000 + counter++) });
const edit = { url: `${IPL}/pt-BR/sobre/`, content: 'x', sha: 'a'.repeat(40), summary: 's' };
const postEdit = (request: ReturnType<typeof app>, headers: Record<string, string>, body: string = JSON.stringify(edit)) =>
  request('/v1/edits', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('per-identity limits (before any GitHub call)', () => {
  it('answers the 21st contribution of the day with 429 and Retry-After until midnight UTC', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    await env.CONTRIBUTE_KV.put(`quota:day:github:${identity.id}:${new Date().toISOString().slice(0, 10)}`, '20');
    const fake = new FakeGitHub();
    const response = await postEdit(app(fake), session.headers);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED', details: { limit: 'daily', max: 20 } } });
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(86400);
    expect(fake.calls).toEqual([]);
  });

  it('answers a 6th concurrently open contribution with 429', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    for (let n = 1; n <= 5; n += 1) await recordContribution(env.CONTRIBUTE_KV, identity, `o/r#${n}`);
    const fake = new FakeGitHub();
    const response = await postEdit(app(fake), session.headers);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { details: { limit: 'open', max: 5 } } });
    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(fake.calls).toEqual([]);
  });

  it('honours configured caps', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    await recordContribution(env.CONTRIBUTE_KV, identity, 'o/r#1');

    expect((await postEdit(app(new FakeGitHub(), { MAX_OPEN_PRS: '1' }), session.headers)).status).toBe(429);
  });

  it('frees an open slot when the pull request closes', async () => {
    const identity = reader();
    await recordContribution(env.CONTRIBUTE_KV, identity, 'o/r#7');
    const released = await releaseContribution(env.CONTRIBUTE_KV, `text\n<!-- contribute-identity:github:${identity.id} -->`, 'o/r#7');

    expect(released).toBe(true);
    expect(await env.CONTRIBUTE_KV.get(`quota:open:github:${identity.id}`, 'json')).toEqual([]);
  });

  it('gives a deny-listed identity 403 with a generic message', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    await env.CONTRIBUTE_KV.put(`deny:github:${identity.id}`, 'spam');
    const fake = new FakeGitHub();
    const response = await postEdit(app(fake), session.headers);

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('spam');
    expect(fake.calls).toEqual([]);
  });
});

describe('size limits', () => {
  it('rejects an oversized body with 413 by Content-Length', async () => {
    const session = await signedIn(reader());
    const response = await postEdit(app(new FakeGitHub()), { ...session.headers, 'content-length': String(10 * 1024 * 1024) });

    expect(response.status).toBe(413);
  });

  it('rejects an oversized body with 413 when Content-Length is missing or wrong', async () => {
    const session = await signedIn(reader());
    const huge = JSON.stringify({ ...edit, content: 'x'.repeat(300 * 1024) });

    expect((await postEdit(app(new FakeGitHub()), session.headers, huge)).status).toBe(413);
  });

  it('keeps suggestions small', async () => {
    const session = await signedIn(reader());
    const response = await app(new FakeGitHub())('/v1/suggestions', {
      method: 'POST',
      body: JSON.stringify({ description: 'x'.repeat(20 * 1024) }),
      headers: { 'content-type': 'application/json', ...session.headers },
    });

    expect(response.status).toBe(413);
  });
});

describe('per-IP limit', () => {
  const limiter = (success: boolean) => ({ limit: async () => ({ success }) }) as unknown as RateLimit;

  it('throttles sign-in starts', async () => {
    const response = await app(new FakeGitHub(), { IP_RATE_LIMITER: limiter(false) })('/v1/auth/github/start');

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('throttles writes', async () => {
    const session = await signedIn(reader());

    expect((await postEdit(app(new FakeGitHub(), { IP_RATE_LIMITER: limiter(false) }), session.headers)).status).toBe(429);
  });
});

describe('dependencies', () => {
  it('no longer include express-brute', () => {
    const pkg = JSON.parse(packageText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('express-brute');
  });
});
