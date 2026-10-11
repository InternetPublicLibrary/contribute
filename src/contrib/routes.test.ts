import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { handleError } from '../errors';
import { base64ToUtf8, utf8ToBase64 } from '../github/encoding';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { ORCID_READER, signedIn } from '../test/session';
import { contributionRoutes, matchLineEndings } from './routes';

const SANDBOX = 'InternetPublicLibrary/contribute-sandbox';
const IPL = 'http://localhost:4000';
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const PAGE = '---\nlayout: info\ntitle: Sobre a IPL\npermalink: /pt-BR/sobre/\n---\n<p>A IPL é uma biblioteca.</p>\n';
const MENU = `- title: Computação
  path: /pt-BR/computacao/
  children:
    - title: Ciência de Dados
      path: /pt-BR/computacao/ciencia-de-dados/
`;
let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

const file = (text: string, sha = SHA) => ({ type: 'file', sha, encoding: 'base64', content: utf8ToBase64(text) });
const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });

function github(options: { page?: string | null; pageSha?: string; resources?: string | null } = {}) {
  const fake = new FakeGitHub()
    .withInstallation()
    .on('GET', /^\/repos\/[^/]+\/[^/]+$/, { default_branch: 'main' })
    .on('GET', /\/contents\/_data\/pt-BR\/menu\.yaml$/, file(MENU))
    .on('GET', /\/contents\/sobre\/index\.(html|md)$/, notFound())
    .on('GET', /\/contents\/sobre\.html$/, () => (options.page === null ? notFound() : Response.json(file(options.page ?? PAGE, options.pageSha ?? SHA))))
    .on('GET', /\/contents\/computacao\/ciencia-de-dados\//, notFound())
    .on('GET', /\/contents\/computacao\/ciencia-de-dados(\.html|\.md)$/, notFound())
    .on('GET', /\/contents\/_data\/pt-BR\/computacao\/ciencia-de-dados\/learn\.yaml$/, () =>
      options.resources === null || options.resources === undefined ? notFound() : Response.json(file(options.resources)),
    )
    .on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'base' } })
    .on('POST', /\/git\/refs$/, {})
    .on('PUT', /\/contents\//, {})
    .on('POST', /\/pulls$/, { number: 12, html_url: `https://github.com/${SANDBOX}/pull/12` })
    .on('POST', /\/issues\/12\/labels$/, []);
  return fake;
}

let reachable = true;
const probe: typeof fetch = async () => new Response(null, { status: reachable ? 200 : 404 });

function request(fake: FakeGitHub, path: string, init: RequestInit = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.route('/v1', contributionRoutes({ fetch: fake.fetch, probe }));
  return app.request(path, init, { ...env, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem });
}

const post = async (fake: FakeGitHub, path: string, body: unknown, session?: Awaited<ReturnType<typeof signedIn>>) =>
  request(fake, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(session?.headers ?? {}) } });

const created = (fake: FakeGitHub) => fake.calls.filter((call) => call.method !== 'GET' && !call.path.endsWith('/access_tokens'));
const put = (fake: FakeGitHub) => fake.calls.find((call) => call.method === 'PUT')?.body as { content: string; sha?: string; message: string; branch: string } | undefined;
const pull = (fake: FakeGitHub) => fake.calls.find((call) => call.path.endsWith('/pulls'))?.body as { title: string; body: string } | undefined;

describe('sessions are required', () => {
  it.each([
    ['GET', '/v1/source?url=http://localhost:4000/pt-BR/sobre/'],
    ['POST', '/v1/edits'],
    ['POST', '/v1/suggestions'],
    ['GET', '/v1/contributions'],
  ])('%s %s answers 401 without a session and calls nothing', async (method, path) => {
    const fake = github();
    const response = await request(fake, path, method === 'POST' ? { method, body: '{}', headers: { 'content-type': 'application/json', origin: IPL } } : {});

    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it('requires the CSRF token for writes', async () => {
    const session = await signedIn();
    const fake = github();
    const response = await request(fake, '/v1/edits', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', cookie: session.headers.cookie, origin: IPL } });

    expect(response.status).toBe(403);
  });
});

describe('GET /v1/source', () => {
  it('returns the source file of a page', async () => {
    const session = await signedIn();
    const response = await request(github(), `/v1/source?url=${encodeURIComponent(`${IPL}/pt-BR/sobre/`)}`, { headers: session.headers });

    expect(await response.json()).toEqual({ repository: SANDBOX, path: 'sobre.html', branch: 'main', content: PAGE, sha: SHA });
  });

  it('answers 409 GENERATED_PAGE for topic pages generated from the menu', async () => {
    const session = await signedIn();
    const response = await request(github(), `/v1/source?url=${encodeURIComponent(`${IPL}/pt-BR/computacao/ciencia-de-dados/`)}`, { headers: session.headers });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'GENERATED_PAGE' } } });
  });
});

describe('POST /v1/edits', () => {
  const edit = (content: string, sha = SHA) => ({ url: `${IPL}/pt-BR/sobre/`, content, sha, summary: 'Corrige a frase.' });

  it('opens a pull request whose change is only the reader’s edit', async () => {
    const session = await signedIn();
    const fake = github();
    const proposed = PAGE.replace('uma biblioteca', 'uma biblioteca pública');
    const response = await post(fake, '/v1/edits', edit(proposed), session);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ pullRequest: { number: 12, url: `https://github.com/${SANDBOX}/pull/12` } });
    expect(base64ToUtf8(put(fake)?.content ?? '')).toBe(proposed);
    expect(put(fake)).toMatchObject({ sha: SHA, branch: expect.stringMatching(/^contribute\//) });
    expect(put(fake)?.message).toBe('Edit sobre.html\n\nCo-authored-by: The Octocat <583231+octocat@users.noreply.github.com>\n');
    expect(pull(fake)?.title).toBe('Edit: Sobre a IPL');
    expect(pull(fake)?.body).toContain('> Corrige a frase.');
    expect(fake.calls.find((call) => call.path.endsWith('/labels'))?.body).toEqual({ labels: ['contribution', 'edit', 'lang:pt-BR'] });
  });

  it('answers a stale sha with 409 and the current content, creating nothing', async () => {
    const session = await signedIn();
    const fake = github({ pageSha: NEWER });
    const response = await post(fake, '/v1/edits', edit(PAGE.replace('IPL é', 'IPL foi')), session);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'STALE_SHA', details: { content: PAGE, sha: NEWER } } });
    expect(created(fake)).toEqual([]);
  });

  it('round-trips pt-BR text and emoji byte for byte', async () => {
    const session = await signedIn(ORCID_READER);
    const fake = github();
    const proposed = PAGE.replace('A IPL é uma biblioteca.', 'Ação, coração e informação — 📚✨');
    await post(fake, '/v1/edits', edit(proposed), session);

    expect(base64ToUtf8(put(fake)?.content ?? '')).toBe(proposed);
    expect(put(fake)?.message).toContain('Co-authored-by: Josiah Carberry <https://orcid.org/0000-0002-1825-0097>');
  });

  it('rejects an edit identical to the current page with 422', async () => {
    const session = await signedIn();
    const response = await post(github(), '/v1/edits', edit(PAGE.replace(/\n$/, '')), session);

    expect(response.status).toBe(422);
  });

  it('keeps CRLF line endings of the file', () => {
    expect(matchLineEndings('a\r\nb\r\n', 'a\nc')).toBe('a\r\nc\r\n');
    expect(matchLineEndings('a\nb', 'a\nc\n\n')).toBe('a\nc');
  });

  it('rejects unsafe content with line numbers before creating anything', async () => {
    const session = await signedIn();
    const fake = github();
    const response = await post(fake, '/v1/edits', edit(`${PAGE}<script>alert(1)</script>\n`), session);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { details: { problems: [{ line: 7, reason: 'disallowed tag <script>' }] } } });
    expect(created(fake)).toEqual([]);
  });

  it('rejects unknown fields and malformed shas', async () => {
    const session = await signedIn();

    expect((await post(github(), '/v1/edits', { ...edit(PAGE), branch: 'main' }, session)).status).toBe(400);
    expect((await post(github(), '/v1/edits', edit(PAGE, 'HEAD'), session)).status).toBe(422);
  });

  it('refuses generated topic pages', async () => {
    const session = await signedIn();
    const response = await post(github(), '/v1/edits', { ...edit('x'), url: `${IPL}/pt-BR/computacao/ciencia-de-dados/` }, session);

    expect(response.status).toBe(409);
  });
});

describe('POST /v1/suggestions', () => {
  const suggestion = {
    lang: 'pt-BR',
    topicPath: '/pt-BR/computacao/ciencia-de-dados/',
    type: 'learn',
    name: 'Kaggle Learn',
    url: 'https://www.kaggle.com/learn',
    description: 'Cursos curtos e gratuitos de ciência de dados.',
    access: 'free',
  };

  it('appends the entry to the topic file and opens a labelled pull request', async () => {
    reachable = true;
    const session = await signedIn();
    const fake = github({ resources: '# Revisado\n- name: Coursera\n  url: https://www.coursera.org/\n  description: Cursos.\n' });
    const response = await post(fake, '/v1/suggestions', suggestion, session);

    expect(response.status).toBe(201);
    const written = put(fake);
    expect(fake.calls.find((call) => call.method === 'PUT')?.path).toBe(`/repos/${SANDBOX}/contents/_data/pt-BR/computacao/ciencia-de-dados/learn.yaml`);
    expect(load(base64ToUtf8(written?.content ?? ''))).toEqual([
      { name: 'Coursera', url: 'https://www.coursera.org/', description: 'Cursos.' },
      { name: 'Kaggle Learn', url: 'https://www.kaggle.com/learn', description: 'Cursos curtos e gratuitos de ciência de dados.', access: 'free' },
    ]);
    expect(written?.sha).toBe(SHA);
    expect(pull(fake)?.title).toBe('Resource suggestion: Kaggle Learn');
    expect(fake.calls.find((call) => call.path.endsWith('/labels'))?.body).toEqual({ labels: ['contribution', 'suggestion', 'lang:pt-BR', 'topic:computacao'] });
  });

  it('creates the file when the topic has none yet', async () => {
    reachable = true;
    const session = await signedIn();
    const fake = github({ resources: null });
    await post(fake, '/v1/suggestions', suggestion, session);

    expect(put(fake)).not.toHaveProperty('sha');
  });

  it('rejects a link that does not answer, before any write', async () => {
    reachable = false;
    const session = await signedIn();
    const fake = github();
    const response = await post(fake, '/v1/suggestions', suggestion, session);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { details: { fields: ['url'] } } });
    expect(created(fake)).toEqual([]);
    reachable = true;
  });

  it('rejects a resource already listed with 409', async () => {
    const session = await signedIn();
    const response = await post(github({ resources: '- name: K\n  url: https://www.kaggle.com/learn/\n  description: x\n' }), '/v1/suggestions', suggestion, session);

    expect(response.status).toBe(409);
  });

  it('rejects unknown topics with 404', async () => {
    const session = await signedIn();

    expect((await post(github(), '/v1/suggestions', { ...suggestion, topicPath: '/pt-BR/../.github/' }, session)).status).toBe(404);
  });
});

describe('GET /v1/contributions', () => {
  it('lists the signed-in reader’s pull requests found by the identity marker', async () => {
    const session = await signedIn();
    const fake = github().on('GET', /^\/search\/issues$/, {
      items: [
        { number: 12, title: 'Edit: Sobre', html_url: 'https://github.com/x/pull/12', state: 'closed', repository_url: `https://api.github.com/repos/${SANDBOX}`, pull_request: { merged_at: '2026-10-11T00:00:00Z' } },
        { number: 13, title: 'Resource suggestion: K', html_url: 'https://github.com/x/pull/13', state: 'open', repository_url: `https://api.github.com/repos/${SANDBOX}`, pull_request: { merged_at: null } },
      ],
    });
    const response = await request(fake, '/v1/contributions', { headers: session.headers });

    expect(await response.json()).toEqual({
      contributions: [
        { repository: SANDBOX, number: 12, title: 'Edit: Sobre', url: 'https://github.com/x/pull/12', state: 'merged' },
        { repository: SANDBOX, number: 13, title: 'Resource suggestion: K', url: 'https://github.com/x/pull/13', state: 'open' },
      ],
    });
    expect(fake.calls.find((call) => call.path === '/search/issues')).toBeDefined();
  });
});
