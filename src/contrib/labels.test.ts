import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { GitHubApp } from '../github/client';
import { proposeChange } from '../github/pull-requests';
import { FakeGitHub, generateAppKey } from '../test/fake-github';
import { contributionLabels, MAX_TITLE, pageTitle, pullRequestTitle } from './labels';

describe('pullRequestTitle', () => {
  it('names suggestions and edits', () => {
    expect(pullRequestTitle('suggestion', 'Kaggle Learn')).toBe('Resource suggestion: Kaggle Learn');
    expect(pullRequestTitle('edit', 'Sobre a IPL')).toBe('Edit: Sobre a IPL');
  });

  it('is one line of at most 120 characters', () => {
    const title = pullRequestTitle('suggestion', `${'Nome muito longo '.repeat(20)}\nsegunda linha`);

    expect(title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(title).not.toContain('\n');
    expect(title.startsWith('Resource suggestion: ')).toBe(true);
  });
});

describe('contributionLabels', () => {
  it('labels a pt-BR edit with contribution, edit and lang:pt-BR', () => {
    expect(contributionLabels({ kind: 'edit', lang: 'pt-BR' })).toEqual(['contribution', 'edit', 'lang:pt-BR']);
  });

  it('adds topic and contains-html when they apply', () => {
    expect(contributionLabels({ kind: 'suggestion', lang: 'en-US', topic: 'computing', containsHtml: true })).toEqual([
      'contribution',
      'suggestion',
      'lang:en-US',
      'topic:computing',
      'contains-html',
    ]);
  });
});

describe('pageTitle', () => {
  it('reads the front matter title and falls back to the path', () => {
    expect(pageTitle('---\nlayout: info\ntitle: "Sobre a IPL"\n---\n<p>x</p>', 'sobre.html')).toBe('Sobre a IPL');
    expect(pageTitle('<p>sem front matter</p>', 'sobre.html')).toBe('sobre.html');
  });
});

describe('labels on the pull request', () => {
  it('adds the labels with one extra call', async () => {
    const { pem } = await generateAppKey();
    const fake = new FakeGitHub()
      .withInstallation()
      .on('GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'b' } })
      .on('POST', /\/git\/refs$/, {})
      .on('PUT', /\/contents\//, {})
      .on('POST', /\/pulls$/, { number: 9, html_url: 'https://github.com/o/r/pull/9' })
      .on('POST', /\/issues\/9\/labels$/, []);
    const github = new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });
    await proposeChange(github, {
      repository: { owner: 'InternetPublicLibrary', repo: `labels-${Date.now()}` },
      base: 'main',
      branch: 'contribute/x',
      path: 'sobre.html',
      content: 'x',
      message: 'm',
      title: 't',
      body: 'b',
      labels: contributionLabels({ kind: 'edit', lang: 'pt-BR' }),
    });

    expect(fake.calls.find((call) => call.path.endsWith('/labels'))?.body).toEqual({ labels: ['contribution', 'edit', 'lang:pt-BR'] });
    expect(github.calls).toBe(7);
  });
});
