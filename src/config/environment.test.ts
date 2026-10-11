import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import wranglerText from '../../wrangler.jsonc?raw';
import type { Env } from '../env';
import { loadSettings } from './environment';

interface WranglerEnvironment {
  vars: Partial<Env>;
}
const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, '')) as WranglerEnvironment & {
  env: Record<'staging' | 'production', WranglerEnvironment>;
};
const settingsFor = (vars: Partial<Env>) => loadSettings({ ...env, ...vars } as Env);

describe('environment settings in wrangler.jsonc', () => {
  it.each(['development', 'staging'] as const)('%s points only at test repositories and the ORCID sandbox', (name) => {
    const vars = name === 'development' ? wrangler.vars : wrangler.env.staging.vars;
    const settings = settingsFor(vars);

    expect(settings.orcidBaseUrl).toBe('https://sandbox.orcid.org');
    expect(Object.values(settings.repositories).map((r) => `${r.owner}/${r.repo}`)).not.toContain('InternetPublicLibrary/en-US');
  });

  it('production points at the IPL content repositories, the IPL origin and ORCID production', () => {
    const settings = settingsFor(wrangler.env.production.vars);

    expect(settings).toMatchObject({
      environment: 'production',
      allowedOrigins: ['https://ipl.better-web.org'],
      orcidBaseUrl: 'https://orcid.org',
      repositories: {
        'en-US': { owner: 'InternetPublicLibrary', repo: 'en-US' },
        'pt-BR': { owner: 'InternetPublicLibrary', repo: 'pt-BR' },
        website: { owner: 'InternetPublicLibrary', repo: 'IPLibrary-website' },
      },
    });
  });
});

describe('loadSettings guards', () => {
  const staging = wrangler.env.staging.vars;

  it('refuses a staging Worker configured with a production repository', () => {
    expect(() => settingsFor({ ...staging, CONTENT_REPOSITORIES: '{"pt-BR":"InternetPublicLibrary/pt-BR"}' })).toThrow(
      expect.objectContaining({ code: 'NOT_CONFIGURED', message: expect.stringContaining('InternetPublicLibrary/pt-BR') }),
    );
  });

  it('compares repository names case-insensitively', () => {
    expect(() => settingsFor({ ...staging, CONTENT_REPOSITORIES: '{"x":"internetpubliclibrary/EN-us"}' })).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
  });

  it('refuses ORCID production outside production', () => {
    expect(() => settingsFor({ ...staging, ORCID_ENVIRONMENT: 'production' })).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
  });

  it.each(['', 'not json', '[]', '{"x":"no-slash"}'])('rejects CONTENT_REPOSITORIES %j', (value) => {
    expect(() => settingsFor({ ...staging, CONTENT_REPOSITORIES: value })).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
  });

  it.each(['', 'ipl.better-web.org', 'https://ipl.better-web.org/', 'http://ipl.better-web.org', 'http://localhost:4000'])(
    'rejects the staging origin list %j',
    (origins) => {
      expect(() => settingsFor({ ...staging, IPL_ALLOWED_ORIGINS: origins })).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    },
  );

  it('allows http://localhost only in development', () => {
    expect(settingsFor(wrangler.vars).allowedOrigins).toEqual(['http://localhost:4000']);
  });
});
