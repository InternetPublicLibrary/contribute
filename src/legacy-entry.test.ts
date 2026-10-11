import { env } from 'cloudflare:workers';
import { load } from 'js-yaml';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './env';
import { handleError } from './errors';
import { base64ToUtf8, utf8ToBase64 } from './github/encoding';
import { legacyEntryRoute } from './legacy-entry';
import { FakeGitHub, generateAppKey } from './test/fake-github';
import { app as worker } from './worker';

const SANDBOX = '/repos/InternetPublicLibrary/contribute-sandbox';
const CONFIG = `comments:
  allowedFields: [name, message, email]
  requiredFields: [name, message]
  format: yaml
  path: "_data/comments/{options.slug}"
  filename: "entry{@timestamp}"
  commitMessage: "Add comment by {fields.name}"
  pullRequestBody: "Comment for review."
  generatedFields:
    date:
      type: date
`;
let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

function sandboxGitHub() {
  return new FakeGitHub()
    .withInstallation()
    .on('GET', new RegExp(`^${SANDBOX}$`), { default_branch: 'main' })
    .on('GET', /\/contents\/contribute\.yml$/, { type: 'file', sha: 'cfg', encoding: 'base64', content: utf8ToBase64(CONFIG) })
    .on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'base' } })
    .on('POST', /\/git\/refs$/, {})
    .on('PUT', /\/contents\//, {})
    .on('POST', /\/pulls$/, { number: 5, html_url: 'https://github.com/InternetPublicLibrary/contribute-sandbox/pull/5' });
}

function post(fake: FakeGitHub, body: BodyInit, vars: Partial<Env> = { LEGACY_ENTRY_ROUTE: 'on' }, path = '/v3/entry/github/InternetPublicLibrary/contribute-sandbox/master/comments') {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.post('/v3/entry/github/:owner/:repo/:branch/:property', legacyEntryRoute(fake.fetch));
  const headers = typeof body === 'string' ? { 'content-type': 'application/json' } : undefined;
  return app.request(path, { method: 'POST', body, ...(headers ? { headers } : {}) }, { ...env, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem, ...vars });
}

const form = (entries: Record<string, string>) => {
  const data = new URLSearchParams(entries);
  return data;
};

describe('legacy entry route', () => {
  it('opens a pull request for a valid form entry on the default branch, ignoring the :branch segment', async () => {
    const fake = sandboxGitHub();
    const response = await post(fake, form({ 'fields[name]': ' Ana ', 'fields[message]': 'Olá, IPL!', 'options[slug]': 'Minha Página' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, pullRequest: { number: 5 } });
    const put = fake.calls.find((call) => call.method === 'PUT');
    const body = put?.body as { branch: string; content: string; message: string };
    expect(put?.path).toMatch(/\/contents\/_data\/comments\/minha-pagina\/entry\d+\.yml$/);
    expect(body.branch).toMatch(/^contribute\//);
    expect(body.message).toBe('Add comment by Ana');
    expect(load(base64ToUtf8(body.content))).toMatchObject({ name: 'Ana', message: 'Olá, IPL!', date: expect.any(String), _id: expect.any(String) });
    expect(fake.calls.find((call) => call.path.endsWith('/pulls'))?.body).toMatchObject({ base: 'main', head: body.branch });
  });

  it('accepts JSON bodies', async () => {
    const response = await post(sandboxGitHub(), JSON.stringify({ fields: { name: 'Ana', message: 'Oi' }, options: { slug: 'x' } }));

    expect(response.status).toBe(200);
  });

  it('rejects any e-mail field, even when the repository allows it, before calling GitHub', async () => {
    const fake = sandboxGitHub();
    const response = await post(fake, form({ 'fields[name]': 'Ana', 'fields[message]': 'Oi', 'fields[email]': 'ana@example.com' }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: { fields: ['email'] } } });
    expect(fake.calls).toEqual([]);
  });

  it('rejects unsupported options such as redirect or reCaptcha', async () => {
    const fake = sandboxGitHub();
    const response = await post(fake, form({ 'fields[name]': 'Ana', 'fields[message]': 'Oi', 'options[redirect]': 'https://evil.example' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'UNKNOWN_FIELDS', details: { options: ['redirect'] } } });
  });

  it('refuses repositories that are not configured content repositories', async () => {
    const response = await post(sandboxGitHub(), form({ 'fields[name]': 'Ana' }), { LEGACY_ENTRY_ROUTE: 'on' }, '/v3/entry/github/someone/blog/main/comments');

    expect(response.status).toBe(403);
  });

  it('is retired (410) unless explicitly enabled', async () => {
    const fake = sandboxGitHub();

    expect((await post(fake, form({ 'fields[name]': 'Ana' }), {})).status).toBe(410);
    expect(fake.calls).toEqual([]);
  });

  it('is retired in production even when enabled', async () => {
    const response = await post(sandboxGitHub(), form({ 'fields[name]': 'Ana' }), { ENVIRONMENT: 'production', LEGACY_ENTRY_ROUTE: 'on' });

    expect(response.status).toBe(410);
  });
});

describe('retired upstream routes', () => {
  it.each([
    ['POST', '/v2/entry/user/repo/master/comments'],
    ['POST', '/v1/entry/user/repo/master'],
    ['POST', '/v3/entry/gitlab/user/repo/master/comments'],
    ['GET', '/v2/encrypt/secret'],
    ['GET', '/v3/encrypt/secret'],
    ['GET', '/v2/connect/user/repo'],
    ['GET', '/v3/auth/github/user/repo/master/comments'],
  ])('%s %s answers 410', async (method, path) => {
    expect((await worker.request(path, { method }, env)).status).toBe(410);
  });

  it('does not shadow the new /v1 API', async () => {
    expect((await worker.request('/v1/auth/github/start', {}, env)).status).toBe(404);
  });
});
