import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { branchCleanup } from './branch-cleanup';
import type { Env } from './env';
import { handleError } from './errors';
import { FakeGitHub, generateAppKey } from './test/fake-github';
import { webhookRoute } from './webhook';

const SECRET = 'webhook-secret';
const SANDBOX = 'InternetPublicLibrary/contribute-sandbox';
let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

let counter = 0;
async function deliverClosed(fake: FakeGitHub, ref: string, options: { head?: string; base?: string; action?: string } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.post('/v1/webhook', webhookRoute({ pull_request: branchCleanup(fake.fetch) }));
  // Every delivery body is unique, like GitHub's (the webhook remembers signatures against replays).
  const body = JSON.stringify({
    delivered_at: `${Date.now()}-${counter}`,
    action: options.action ?? 'closed',
    pull_request: { number: 12, merged: true, head: { ref, repo: { full_name: options.head ?? SANDBOX } }, base: { repo: { full_name: options.base ?? SANDBOX } } },
  });
  const response = await app.request(
    '/v1/webhook',
    {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': `cleanup-${Date.now()}-${counter++}`, 'x-hub-signature-256': await sign(body) },
    },
    { ...env, GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const deletes = (fake: FakeGitHub) => fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);

describe('branch cleanup on pull_request.closed', () => {
  it('deletes the contribution branch of a merged pull request', async () => {
    const fake = new FakeGitHub().withInstallation().on('DELETE', /\/git\/refs\/heads\//, new Response(null, { status: 204 }));
    const result = await deliverClosed(fake, 'contribute/01J9AB');

    expect(result).toMatchObject({ status: 200, body: { status: 'deleted', branch: 'contribute/01J9AB', pullRequest: 12 } });
    expect(deletes(fake)).toEqual([`/repos/${SANDBOX}/git/refs/heads/contribute/01J9AB`]);
  });

  it('treats a second closed delivery (branch already gone, 422) as success', async () => {
    const fake = new FakeGitHub()
      .withInstallation()
      .on('DELETE', /\/git\/refs\/heads\//, new Response('{"message":"Reference does not exist"}', { status: 422 }));
    const result = await deliverClosed(fake, 'contribute/01J9AB');

    expect(result).toMatchObject({ status: 200, body: { status: 'already-deleted' } });
  });

  it('treats 404 as already deleted', async () => {
    const fake = new FakeGitHub().withInstallation().on('DELETE', /\/git\/refs\/heads\//, new Response('{"message":"Not Found"}', { status: 404 }));

    expect((await deliverClosed(fake, 'contribute/x')).body).toMatchObject({ status: 'already-deleted' });
  });

  it.each(['main', 'feature/contribute', 'contributeX/1'])('ignores the non-contribution branch %s', async (ref) => {
    const fake = new FakeGitHub().withInstallation();
    const result = await deliverClosed(fake, ref);

    expect(result.body).toMatchObject({ status: 'ignored', reason: 'not a contribution branch' });
    expect(fake.calls).toEqual([]);
  });

  it('ignores pull requests from forks', async () => {
    const fake = new FakeGitHub().withInstallation();
    const result = await deliverClosed(fake, 'contribute/x', { head: 'someone/contribute-sandbox' });

    expect(result.body).toMatchObject({ status: 'ignored', reason: 'branch from another repository' });
    expect(fake.calls).toEqual([]);
  });

  it('ignores repositories that are not configured for this environment', async () => {
    const fake = new FakeGitHub().withInstallation();
    const result = await deliverClosed(fake, 'contribute/x', { head: 'InternetPublicLibrary/en-US', base: 'InternetPublicLibrary/en-US' });

    expect(result.body).toMatchObject({ status: 'ignored', reason: 'not a configured content repository' });
    expect(fake.calls).toEqual([]);
  });

  it('ignores other pull request actions', async () => {
    const fake = new FakeGitHub().withInstallation();

    expect((await deliverClosed(fake, 'contribute/x', { action: 'opened' })).body).toMatchObject({ status: 'ignored' });
  });

  it('acknowledges a failed cleanup with 2xx so GitHub does not retry forever', async () => {
    const fake = new FakeGitHub().withInstallation().on('DELETE', /\/git\/refs\/heads\//, new Response('boom', { status: 500 }));
    const result = await deliverClosed(fake, 'contribute/x');

    expect(result).toMatchObject({ status: 200, body: { status: 'cleanup-failed' } });
  });
});
