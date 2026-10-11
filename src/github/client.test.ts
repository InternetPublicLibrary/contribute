import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { createAppJwt, importAppPrivateKey } from './app-jwt';
import { contentsPath, GitHubApp, type RepositoryRef } from './client';
import { base64ToBytes, base64ToUtf8, utf8ToBase64 } from './encoding';
import { proposeChange } from './pull-requests';

let pem: string;
let publicKey: CryptoKey;
beforeAll(async () => {
  ({ pem, publicKey } = await generateAppKey());
});

let repoCounter = 0;
const freshRepo = (): RepositoryRef => ({ owner: 'InternetPublicLibrary', repo: `test-${Date.now()}-${repoCounter++}` });

function prRoutes(fake: FakeGitHub) {
  return fake
    .on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'base-sha' } })
    .on('POST', /\/git\/refs$/, { ref: 'refs/heads/contribute/x' })
    .on('PUT', /\/contents\//, { content: { sha: 'new-blob' } })
    .on('POST', /\/pulls$/, { number: 7, html_url: 'https://github.com/InternetPublicLibrary/test/pull/7' });
}

const change = (repository: RepositoryRef) => ({
  repository,
  base: 'main',
  branch: 'contribute/01J9',
  path: '_data/pt-BR/computação/sites.yaml',
  content: 'name: Ação ✓ 📚\n',
  message: 'Add resource suggestion',
  title: 'Resource suggestion: Ação',
  body: 'body',
});

describe('importAppPrivateKey', () => {
  it('rejects a PKCS#1 key with instructions to convert it', async () => {
    await expect(importAppPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: expect.stringContaining('openssl pkcs8 -topk8 -nocrypt'),
    });
  });

  it('reports a missing key as NOT_CONFIGURED', async () => {
    await expect(importAppPrivateKey(undefined)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 });
  });

  it('rejects text that is not a PEM key', async () => {
    await expect(importAppPrivateKey('not a key')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('imports a PKCS#8 key, also when newlines arrive escaped', async () => {
    await expect(importAppPrivateKey(pem)).resolves.toBeDefined();
    await expect(importAppPrivateKey(pem.replace(/\n/g, '\\n'))).resolves.toBeDefined();
  });
});

describe('createAppJwt', () => {
  it('signs RS256 claims GitHub accepts (iat 60 s back, exp within 10 min)', async () => {
    const jwt = await createAppJwt('12345', await importAppPrivateKey(pem), 1_800_000_000);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload)).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '12345' });
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      base64ToBytes(signature.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (signature.length % 4)) % 4)),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });
});

describe('GitHubApp', () => {
  const app = (fake: FakeGitHub, now?: () => number) =>
    new GitHubApp({ appId: '12345', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch, ...(now ? { now } : {}) });

  it('opens a pull request in 4 calls with warm caches and 6 when cold', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation());
    const repository = freshRepo();

    const cold = app(fake);
    await expect(proposeChange(cold, change(repository))).resolves.toEqual({ number: 7, url: 'https://github.com/InternetPublicLibrary/test/pull/7' });
    expect(cold.calls).toBe(6);

    const warm = app(fake);
    await proposeChange(warm, change(repository));
    expect(warm.calls).toBe(4);
  });

  it('reuses one installation token for two contributions within an hour', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation(77));
    const repository = freshRepo();

    await proposeChange(app(fake), change(repository));
    await proposeChange(app(fake, () => Date.now() + 30 * 60 * 1000), change(repository));

    expect(fake.count('POST', /access_tokens$/)).toBe(1);
  });

  it('mints a new token when the cached one is within 5 minutes of expiry', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation(78, new Date(Date.now() + 20 * 60 * 1000).toISOString()));
    const repository = freshRepo();

    await proposeChange(app(fake), change(repository));
    await proposeChange(app(fake, () => Date.now() + 16 * 60 * 1000), change(repository));

    expect(fake.count('POST', /access_tokens$/)).toBe(2);
  });

  it('authenticates the operation with the installation token and the token request with the App JWT', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation(79));
    await proposeChange(app(fake), change(freshRepo()));

    const tokenCall = fake.calls.find((call) => call.path.endsWith('/access_tokens'));
    const pullCall = fake.calls.find((call) => call.path.endsWith('/pulls'));
    expect(tokenCall?.authorization).toMatch(/^Bearer eyJ/);
    expect(pullCall?.authorization).toBe('Bearer ghs_installation_79');
  });

  it('writes the file as UTF-8 base64 on the new branch, never on the default branch', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation());
    await proposeChange(app(fake), change(freshRepo()));

    const put = fake.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toMatch(/\/contents\/_data\/pt-BR\/computação\/sites\.yaml$/);
    expect(put?.body).toMatchObject({ branch: 'contribute/01J9' });
    expect(base64ToUtf8((put?.body as { content: string }).content)).toBe('name: Ação ✓ 📚\n');
  });

  it('turns a secondary rate limit into 503 with Retry-After', async () => {
    const fake = new FakeGitHub()
      .withInstallation()
      .on('GET', /\/git\/ref\/heads\/main$/, new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403, headers: { 'retry-after': '60' } }));

    await expect(proposeChange(app(fake), change(freshRepo()))).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 503, retryAfter: 60 });
  });

  it('says clearly when the App is not installed on the repository', async () => {
    const fake = new FakeGitHub().on('GET', /\/installation$/, new Response('{"message":"Not Found"}', { status: 404 }));

    await expect(proposeChange(app(fake), change(freshRepo()))).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('forgets a revoked installation token', async () => {
    const repository = freshRepo();
    const fake = new FakeGitHub().withInstallation(80).on('GET', /\/git\/ref\/heads\/main$/, new Response('{"message":"Bad credentials"}', { status: 401 }));

    await expect(proposeChange(app(fake), change(repository))).rejects.toMatchObject({ code: 'GITHUB_AUTH' });
    expect(await env.CONTRIBUTE_KV.get('gh:token:80')).toBeNull();
  });
});

describe('encoding', () => {
  it('round-trips pt-BR text and emoji byte for byte', () => {
    const text = 'Acentuação: ç ã é — 📚\r\nfim\n';

    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });
});

describe('path safety', () => {
  it.each(['../../app/installations', '_data/../../../user', '%2e%2e/secrets', '_data//x', './x', 'a\\b', 'a\u0000b'])(
    'contentsPath refuses %j',
    (path) => {
      expect(() => contentsPath(path)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    },
  );

  it('contentsPath encodes Unicode and spaces per segment', () => {
    expect(contentsPath('_data/pt-BR/ciência de dados/sites.yaml')).toBe('_data/pt-BR/ci%C3%AAncia%20de%20dados/sites.yaml');
  });

  it('never sends a request whose path changes when parsed', async () => {
    const fake = new FakeGitHub().withInstallation();
    const github = new GitHubApp({ appId: '12345', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });

    await expect(github.request(freshRepo(), 'GET', '/repos/a/b/contents/x/%2e%2e/%2e%2e/%2e%2e/user', 'probe')).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(fake.calls.some((call) => call.path === '/user')).toBe(false);
  });

  it('refuses a change whose file path climbs out of the repository', async () => {
    const fake = prRoutes(new FakeGitHub().withInstallation());

    await expect(proposeChange(new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch }), { ...change(freshRepo()), path: '../../../user' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fake.calls).toEqual([]);
  });
});

describe('stale caches', () => {
  it('looks the installation up again when the App was reinstalled', async () => {
    const repository = freshRepo();
    await env.CONTRIBUTE_KV.put(`gh:installation:${repository.owner}/${repository.repo}`.toLowerCase(), '111');
    const fake = prRoutes(
      new FakeGitHub()
        .on('POST', /^\/app\/installations\/111\/access_tokens$/, new Response('{"message":"Not Found"}', { status: 404 }))
        .withInstallation(222),
    );

    await expect(proposeChange(new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch }), change(repository))).resolves.toMatchObject({ number: 7 });
    expect(fake.calls.find((call) => call.path.endsWith('/pulls'))?.authorization).toBe('Bearer ghs_installation_222');
  });

  it('forgets a revoked token on reads too', async () => {
    const repository = freshRepo();
    const fake = new FakeGitHub().withInstallation(333).on('GET', /\/contents\//, new Response('{"message":"Bad credentials"}', { status: 401 }));
    const github = new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });

    await expect(github.requestOrNull(repository, 'GET', '/repos/a/b/contents/x', 'read')).rejects.toMatchObject({ code: 'GITHUB_AUTH' });
    expect(await env.CONTRIBUTE_KV.get('gh:token:333')).toBeNull();
  });
});
