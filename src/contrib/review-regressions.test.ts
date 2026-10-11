import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { handleError, readJsonObject } from '../errors';
import { GitHubApp } from '../github/client';
import { utf8ToBase64 } from '../github/encoding';
import { proposeChange } from '../github/pull-requests';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { GITHUB_READER, signedIn } from '../test/session';
import { commitMessage } from './attribution';
import { pullRequestTitle } from './labels';
import { recordContribution, releaseContribution } from './limits';
import { assertReachable } from './reachability';
import { contributionRoutes } from './routes';

const MENTION = /(^|[^\w])@[A-Za-z0-9]/;
const REFERENCE = /(^|[^\w])#\d|[\w.-]+\/[\w.-]+#\d|\bGH-\d/i;
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i;
const SHA = 'a'.repeat(40);
const PAGE = '---\ntitle: Sobre\n---\n<p>texto</p>\n';
let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

let counter = 0;
const reader = () => ({ ...GITHUB_READER, id: String(800000 + counter++) });
const file = (text: string, sha = SHA) => ({ type: 'file', sha, encoding: 'base64', content: utf8ToBase64(text) });
const change = (repo: string) => ({ repository: { owner: 'InternetPublicLibrary', repo }, base: 'main', branch: 'contribute/x', path: 'a.md', content: 'x', message: 'm', title: 't', body: 'b', labels: ['contribution'] });

describe('titles and commit subjects cannot close, reference or mention', () => {
  const nasty = 'fixes #12 closes InternetPublicLibrary/pt-BR#3 resolves GH-4 @octocat https://evil.example';

  it('neutralises the PR title', () => {
    const title = pullRequestTitle('suggestion', nasty);

    expect(title).not.toMatch(MENTION);
    expect(title).not.toMatch(REFERENCE);
    expect(title).not.toMatch(CLOSING);
    expect(title).not.toMatch(/https:\/\//);
  });

  it('neutralises the commit subject', () => {
    const subject = commitMessage(`Suggest ${nasty}`, GITHUB_READER).split('\n')[0] ?? '';

    expect(subject).not.toMatch(MENTION);
    expect(subject).not.toMatch(REFERENCE);
    expect(subject).not.toMatch(CLOSING);
  });
});

describe('proposeChange failure handling', () => {
  const base = (fake: FakeGitHub) =>
    fake.withInstallation().on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'b' } }).on('POST', /\/git\/refs$/, {}).on('DELETE', /\/git\/refs\/heads\//, new Response(null, { status: 204 }));

  it('deletes the new branch when the commit fails, leaving no orphan', async () => {
    const fake = base(new FakeGitHub()).on('PUT', /\/contents\//, new Response('{"message":"conflict"}', { status: 409 }));
    const github = new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });

    await expect(proposeChange(github, change(`orphan-${Date.now()}`))).rejects.toMatchObject({ code: 'GITHUB_ERROR' });
    expect(fake.calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/git/refs/heads/contribute/x'))).toBe(true);
  });

  it('keeps an opened pull request when labelling fails', async () => {
    const fake = base(new FakeGitHub())
      .on('PUT', /\/contents\//, {})
      .on('POST', /\/pulls$/, { number: 3, html_url: 'https://github.com/o/r/pull/3' })
      .on('POST', /\/labels$/, new Response('boom', { status: 500 }));
    const github = new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });

    await expect(proposeChange(github, change(`labels-${Date.now()}`))).resolves.toEqual({ number: 3, url: 'https://github.com/o/r/pull/3', labelled: false });
    expect(fake.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});

describe('reachability probe', () => {
  const hops = (responses: Record<string, Response>) => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      return responses[url]?.clone() ?? new Response(null, { status: 404 });
    };
    return { seen, fetcher };
  };
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  it.each(['http://10.0.0.1/', 'http://localhost/', 'https://127.0.0.1/admin'])('refuses a redirect to %s without requesting it', async (target) => {
    const { seen, fetcher } = hops({ 'https://attacker.example/': redirect(target) });

    await expect(assertReachable('https://attacker.example/', fetcher)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(seen).toEqual(['https://attacker.example/']);
  });

  it('follows up to three public https redirects', async () => {
    const { fetcher } = hops({ 'https://a.example/': redirect('https://b.example/x'), 'https://b.example/x': redirect('/y'), 'https://b.example/y': new Response(null, { status: 200 }) });

    await expect(assertReachable('https://a.example/', fetcher)).resolves.toBeUndefined();
  });

  it('gives up after too many redirects', async () => {
    const { fetcher } = hops({ 'https://a.example/': redirect('https://a.example/1'), 'https://a.example/1': redirect('https://a.example/2'), 'https://a.example/2': redirect('https://a.example/3'), 'https://a.example/3': redirect('https://a.example/4') });

    await expect(assertReachable('https://a.example/', fetcher)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('quota bookkeeping', () => {
  it('frees open slots whatever the case of the repository name', async () => {
    const identity = reader();
    await recordContribution(env.CONTRIBUTE_KV, identity, 'internetpubliclibrary/pt-br#5');

    await expect(releaseContribution(env.CONTRIBUTE_KV, `x\n<!-- contribute-identity:github:${identity.id} -->`, 'InternetPublicLibrary/pt-BR#5')).resolves.toBe(true);
  });

  it('ignores a marker that is not the last line of the body', async () => {
    const identity = reader();
    await recordContribution(env.CONTRIBUTE_KV, identity, 'o/r#1');

    await expect(releaseContribution(env.CONTRIBUTE_KV, `<!-- contribute-identity:github:${identity.id} -->\nmore`, 'o/r#1')).resolves.toBe(false);
  });
});

describe('routes after review', () => {
  const IPL = 'http://localhost:4000';
  const fakeSite = () =>
    new FakeGitHub()
      .withInstallation()
      .on('GET', /^\/repos\/[^/]+\/[^/]+$/, { default_branch: 'main' })
      .on('GET', /\/contents\/_data\/pt-BR\/menu\.yaml$/, file('- title: Computação\n  path: /pt-BR/computacao/\n'))
      .on('GET', /\/contents\/sobre\/index\.(html|md)$/, new Response('{}', { status: 404 }))
      .on('GET', /\/contents\/_data\/pt-BR\/computacao\/learn\.yaml$/, new Response('{}', { status: 404 }));
  const call = (fake: FakeGitHub, path: string, body: unknown, headers: Record<string, string>, probe: typeof fetch = async () => new Response(null)) => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.route('/v1', contributionRoutes({ fetch: fake.fetch, probe }));
    return app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }, { ...env, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem });
  };
  const today = () => new Date().toISOString().slice(0, 10);

  it('returns the current content when the page changes between read and commit', async () => {
    let reads = 0;
    const fake = fakeSite()
      .on('GET', /\/contents\/sobre\.html$/, () => Response.json(reads++ === 0 ? file(PAGE) : file(`${PAGE}<p>novo</p>\n`, 'c'.repeat(40))))
      .on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'b' } })
      .on('POST', /\/git\/refs$/, {})
      .on('PUT', /\/contents\//, new Response('{"message":"sha mismatch"}', { status: 409 }))
      .on('DELETE', /\/git\/refs\//, new Response(null, { status: 204 }));
    const session = await signedIn(reader());
    const response = await call(fake, '/v1/edits', { url: `${IPL}/pt-BR/sobre/`, content: PAGE.replace('texto', 'texto novo'), sha: SHA, summary: 's' }, session.headers);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'STALE_SHA', details: { content: `${PAGE}<p>novo</p>\n`, sha: 'c'.repeat(40) } } });
  });

  it('gives the daily slot back when a contribution fails', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    const suggestion = { lang: 'pt-BR', topicPath: '/pt-BR/computacao/', type: 'learn', name: 'X', url: 'https://x.example/', description: 'y' };
    const response = await call(fakeSite(), '/v1/suggestions', suggestion, session.headers, async () => new Response(null, { status: 404 }));

    expect(response.status).toBe(422);
    expect(await env.CONTRIBUTE_KV.get(`quota:day:github:${identity.id}:${today()}`)).toBe('0');
  });

  it('limits link checks per identity', async () => {
    const identity = reader();
    const session = await signedIn(identity);
    await env.CONTRIBUTE_KV.put(`quota:probe:github:${identity.id}:${today()}`, '50');
    const suggestion = { lang: 'pt-BR', topicPath: '/pt-BR/computacao/', type: 'learn', name: 'X', url: 'https://x.example/', description: 'y' };
    const response = await call(fakeSite(), '/v1/suggestions', suggestion, session.headers);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { details: { limit: 'link-checks' } } });
  });
});

describe('streamed bodies', () => {
  it('stops reading a body without Content-Length once it passes the limit', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 1000) controller.close();
      },
    });
    const request = new Request('https://x/', { method: 'POST', body: stream, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit);

    await expect(readJsonObject(request, 256 * 1024)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(pulled).toBeLessThan(20);
  });
});
