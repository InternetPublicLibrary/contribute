import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { GitHubApp, type RepositoryRef } from './client';
import { utf8ToBase64 } from './encoding';
import { defaultBranch, readRepositoryConfig } from './repository';

let pem: string;
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

let counter = 0;
const freshRepo = (): RepositoryRef => ({ owner: 'InternetPublicLibrary', repo: `repo-${Date.now()}-${counter++}` });
const app = (fake: FakeGitHub) => new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });
const file = (text: string) => ({ type: 'file', sha: 'blob-sha', encoding: 'base64', content: utf8ToBase64(text) });

describe('defaultBranch', () => {
  it('uses whatever the repository calls its default branch, without configuration', async () => {
    const fake = new FakeGitHub().withInstallation().on('GET', /^\/repos\/[^/]+\/[^/]+$/, { default_branch: 'trunk' });

    await expect(defaultBranch(app(fake), env.CONTRIBUTE_KV, freshRepo())).resolves.toBe('trunk');
  });

  it('caches the answer', async () => {
    const fake = new FakeGitHub().withInstallation().on('GET', /^\/repos\/[^/]+\/[^/]+$/, { default_branch: 'main' });
    const repository = freshRepo();

    await defaultBranch(app(fake), env.CONTRIBUTE_KV, repository);
    await defaultBranch(app(fake), env.CONTRIBUTE_KV, repository);

    expect(fake.count('GET', /^\/repos\/[^/]+\/[^/]+$/)).toBe(1);
  });
});

describe('readRepositoryConfig', () => {
  it('reads contribute.yml from the given branch', async () => {
    const fake = new FakeGitHub().withInstallation().on('GET', /\/contents\/contribute\.yml$/, file('comments: {}\n'));

    await expect(readRepositoryConfig(app(fake), freshRepo(), 'main')).resolves.toEqual({ path: 'contribute.yml', sha: 'blob-sha', content: 'comments: {}\n' });
    expect(fake.calls.at(-1)?.path).toMatch(/contents\/contribute\.yml$/);
  });

  it('falls back to staticman.yml', async () => {
    const fake = new FakeGitHub()
      .withInstallation()
      .on('GET', /\/contents\/contribute\.yml$/, new Response('{"message":"Not Found"}', { status: 404 }))
      .on('GET', /\/contents\/staticman\.yml$/, file('legacy: {}\n'));

    await expect(readRepositoryConfig(app(fake), freshRepo(), 'main')).resolves.toMatchObject({ path: 'staticman.yml' });
  });

  it('reports a repository without config as CONFIG_MISSING, not as an auth error', async () => {
    const notFound = new Response('{"message":"Not Found"}', { status: 404 });
    const fake = new FakeGitHub().withInstallation().on('GET', /\/contents\//, notFound);

    await expect(readRepositoryConfig(app(fake), freshRepo(), 'main')).rejects.toMatchObject({ code: 'CONFIG_MISSING', status: 404 });
  });
});
