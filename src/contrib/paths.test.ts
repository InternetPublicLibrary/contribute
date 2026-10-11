import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '../config/environment';
import type { Env } from '../env';
import { contributionBranch, newContributionId } from './branches';
import { pageSource } from './pages';
import { type MenuNode, RESOURCE_TYPES, resolveTopic, resourceFilePath } from './topics';

const MENU: MenuNode[] = [
  {
    title: 'Computação',
    path: '/pt-BR/computacao/',
    children: [
      { title: 'Ciência de Dados', path: '/pt-BR/computacao/ciencia-de-dados/', children: [{ title: 'Aprendizado de Máquina', path: '/pt-BR/computacao/ciencia-de-dados/aprendizado-de-maquina/' }] },
      { title: 'Programação em Ação', path: '/pt-BR/computacao/programação-em-ação/' },
    ],
  },
  { title: 'Bad', path: '/pt-BR/../.github/' },
];

const settings = loadSettings({ ...env, IPL_ALLOWED_ORIGINS: 'https://ipl.better-web.org', ENVIRONMENT: 'staging' } as Env);

describe('resolveTopic', () => {
  it('maps a subcategory to the data file the site renders', () => {
    const topic = resolveTopic(MENU, 'pt-BR', '/pt-BR/computacao/ciencia-de-dados/');

    expect(topic).toMatchObject({ title: 'Ciência de Dados', category: 'Computação', segments: ['computacao', 'ciencia-de-dados'] });
    expect(resourceFilePath(topic, 'tools')).toBe('_data/pt-BR/computacao/ciencia-de-dados/tools.yaml');
  });

  it('maps a category to its own folder', () => {
    expect(resourceFilePath(resolveTopic(MENU, 'pt-BR', '/pt-BR/computacao/'), 'learn')).toBe('_data/pt-BR/computacao/learn.yaml');
  });

  it('resolves accented topics (NFC and NFD input) to the right file', () => {
    const nfd = '/pt-BR/computacao/programação-em-ação/'.normalize('NFD');

    expect(resourceFilePath(resolveTopic(MENU, 'pt-BR', nfd), 'databases')).toBe('_data/pt-BR/computacao/programação-em-ação/databases.yaml');
  });

  it.each([
    ['../../.github', 'NOT_FOUND'],
    ['%2e%2e/', 'NOT_FOUND'],
    ['/pt-BR/computacao//', 'NOT_FOUND'],
    ['computacao/', 'NOT_FOUND'],
    ['/computacao', 'NOT_FOUND'],
    ['/pt-BR/computacao', 'NOT_FOUND'],
    ['/pt-BR/unknown/', 'NOT_FOUND'],
    ['/en-US/computacao/', 'NOT_FOUND'],
    ['/pt-BR/../.github/', 'NOT_FOUND'],
    ['/pt-BR/computacao/ciencia-de-dados/aprendizado-de-maquina/', 'NOT_FOUND'],
  ])('rejects the topic path %j', (path, code) => {
    expect(() => resolveTopic(MENU, 'pt-BR', path)).toThrow(expect.objectContaining({ code }));
  });

  it.each([42, null, 'x'.repeat(301)])('rejects a malformed topic path %j with 422', (path) => {
    expect(() => resolveTopic(MENU, 'pt-BR', path)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('pageSource', () => {
  it('maps a page URL to the content repository and candidate files', () => {
    expect(pageSource('https://ipl.better-web.org/pt-BR/sobre/', settings)).toEqual({
      lang: 'pt-BR',
      repository: settings.repositories['pt-BR'],
      candidates: ['sobre/index.html', 'sobre/index.md', 'sobre.html', 'sobre.md'],
      pagePath: '/pt-BR/sobre/',
    });
  });

  it('maps the language home', () => {
    expect(pageSource('https://ipl.better-web.org/en-US/', settings).candidates).toEqual(['index.html', 'index.md']);
  });

  it('decodes Unicode paths', () => {
    expect(pageSource('https://ipl.better-web.org/pt-BR/ci%C3%AAncia/', settings).candidates[0]).toBe('ciência/index.html');
  });

  it.each([
    'https://evil.example/pt-BR/sobre/',
    'https://ipl.better-web.org/fr-FR/a-propos/',
    'https://ipl.better-web.org/pt-BR/%2e%2e/.github/workflows/',
    'https://ipl.better-web.org/pt-BR/.github/CODEOWNERS',
    'https://ipl.better-web.org/pt-BR/a%2F..%2F..%2Fx/',
    'https://ipl.better-web.org/pt-BR/a%5Cb/',
    'https://user@ipl.better-web.org/pt-BR/sobre/',
    '/pt-BR/sobre/',
    'javascript:alert(1)',
  ])('rejects %s', (url) => {
    expect(() => pageSource(url, settings)).toThrow();
  });
});

describe('no route input can produce a write outside the allowed roots (generated inputs)', () => {
  // Deterministic pseudo-random strings over an alphabet full of path tricks.
  const ALPHABET = ['a', 'b', 'ç', 'ã', '-', '.', '..', '/', '//', '%2e', '%2f', '%5c', '\\', ' ', '\u0000', '‮', 'pt-BR', 'computacao', '.github', 'ciencia-de-dados', '?', '#'];
  let seed = 20261011;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  const randomPath = () => Array.from({ length: 1 + (next() % 8) }, () => ALPHABET[next() % ALPHABET.length]).join('');

  it('topic paths either fail or resolve under _data/<lang>/ with plain segments', () => {
    for (let index = 0; index < 2000; index += 1) {
      const input = randomPath();
      let path: string | undefined;
      try {
        path = resourceFilePath(resolveTopic(MENU, 'pt-BR', input), RESOURCE_TYPES[index % RESOURCE_TYPES.length] ?? 'tools');
      } catch {
        path = undefined;
      }
      expect(path === undefined || /^_data\/pt-BR\/(?:[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]*\/){1,2}[a-z-]+\.yaml$/u.test(path)).toBe(true);
    }
  });

  it('page URLs either fail or give candidates without dot segments or .github', () => {
    for (let index = 0; index < 2000; index += 1) {
      let candidates: string[] = [];
      try {
        candidates = pageSource(`https://ipl.better-web.org/pt-BR/${randomPath()}`, settings).candidates;
      } catch {
        candidates = [];
      }
      expect(candidates.every((file) => file.split('/').every((segment) => segment !== '' && !segment.startsWith('.')))).toBe(true);
    }
  });
});

describe('contribution branches', () => {
  it('are generated by the server and never contain request text', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newContributionId()));

    expect(ids.size).toBe(100);
    for (const id of ids) expect(contributionBranch(id)).toMatch(/^contribute\/[a-z0-9]+-[0-9a-f]{10}$/);
  });
});

describe('loadMenu', () => {
  it('reads the menu from the website default branch once and caches it', async () => {
    const { FakeGitHub, generateAppKey } = await import('../test/fake-github');
    const { GitHubApp } = await import('../github/client');
    const { utf8ToBase64 } = await import('../github/encoding');
    const { loadMenu } = await import('./topics');
    const { pem } = await generateAppKey();
    const website = { owner: 'InternetPublicLibrary', repo: `website-${Date.now()}` };
    const fake = new FakeGitHub()
      .withInstallation()
      .on('GET', /^\/repos\/[^/]+\/[^/]+$/, { default_branch: 'master' })
      .on('GET', /\/contents\/_data\/pt-BR\/menu\.yaml$/, { type: 'file', sha: 's', encoding: 'base64', content: utf8ToBase64('- title: Computação\n  path: /pt-BR/computacao/\n') });
    const github = () => new GitHubApp({ appId: '1', privateKey: pem, kv: env.CONTRIBUTE_KV, fetch: fake.fetch });

    await expect(loadMenu(github(), env.CONTRIBUTE_KV, website, 'pt-BR')).resolves.toEqual([{ title: 'Computação', path: '/pt-BR/computacao/' }]);
    await loadMenu(github(), env.CONTRIBUTE_KV, website, 'pt-BR');
    expect(fake.count('GET', /menu\.yaml$/)).toBe(1);
    expect(fake.calls.find((call) => call.path.endsWith('menu.yaml'))).toBeDefined();
  });
});
