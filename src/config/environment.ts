import type { Env } from '../env';
import { AppError } from '../errors';
import type { RepositoryRef } from '../github/client';

/**
 * Per-environment settings from Wrangler vars (issue #19). Staging and development point at test repositories and the
 * ORCID sandbox; only production may write to the IPL content repositories.
 */
export const PRODUCTION_REPOSITORIES = [
  'InternetPublicLibrary/en-US',
  'InternetPublicLibrary/pt-BR',
  'InternetPublicLibrary/IPLibrary-website',
] as const;

export const ORCID_URLS = { production: 'https://orcid.org', sandbox: 'https://sandbox.orcid.org' } as const;

export interface Settings {
  environment: Env['ENVIRONMENT'];
  /** Exact origins of IPL sites allowed to call the service and to be redirected to. */
  allowedOrigins: string[];
  /** Content repositories by role (`en-US`, `pt-BR`, `website`). */
  repositories: Record<string, RepositoryRef>;
  orcidBaseUrl: string;
}

const notConfigured = (message: string) => new AppError('NOT_CONFIGURED', message);

function parseRepository(value: unknown, role: string): RepositoryRef {
  const match = typeof value === 'string' ? /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(value) : null;
  if (!match?.[1] || !match[2]) throw notConfigured(`CONTENT_REPOSITORIES.${role} must be "owner/repo".`);
  return { owner: match[1], repo: match[2] };
}

function parseOrigins(value: string | undefined, environment: Settings['environment']): string[] {
  const origins = (value ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) throw notConfigured('IPL_ALLOWED_ORIGINS is not set.');
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw notConfigured(`IPL_ALLOWED_ORIGINS has an invalid origin: ${origin}`);
    }
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(local && environment === 'development'))) {
      throw notConfigured(`IPL_ALLOWED_ORIGINS must list exact https origins (http://localhost only in development): ${origin}`);
    }
  }
  return origins;
}

/** Read and check the settings; a staging or development Worker refuses production repositories. */
export function loadSettings(env: Env): Settings {
  let repositoriesConfig: unknown;
  try {
    repositoriesConfig = JSON.parse(env.CONTENT_REPOSITORIES ?? '');
  } catch {
    throw notConfigured('CONTENT_REPOSITORIES must be a JSON map of role → "owner/repo".');
  }
  if (!repositoriesConfig || typeof repositoriesConfig !== 'object' || Array.isArray(repositoriesConfig)) {
    throw notConfigured('CONTENT_REPOSITORIES must be a JSON map of role → "owner/repo".');
  }

  const repositories = Object.fromEntries(
    Object.entries(repositoriesConfig).map(([role, value]) => [role, parseRepository(value, role)]),
  );
  assertRepositoriesFitEnvironment(env.ENVIRONMENT, Object.values(repositories));

  const orcid = env.ORCID_ENVIRONMENT ?? (env.ENVIRONMENT === 'production' ? 'production' : 'sandbox');
  if (orcid !== 'production' && orcid !== 'sandbox') throw notConfigured('ORCID_ENVIRONMENT must be production or sandbox.');
  if (orcid === 'production' && env.ENVIRONMENT !== 'production') throw notConfigured('Only production may use the ORCID production registry.');

  return {
    environment: env.ENVIRONMENT,
    allowedOrigins: parseOrigins(env.IPL_ALLOWED_ORIGINS, env.ENVIRONMENT),
    repositories,
    orcidBaseUrl: ORCID_URLS[orcid],
  };
}

export function assertRepositoriesFitEnvironment(environment: Settings['environment'], repositories: RepositoryRef[]): void {
  if (environment === 'production') return;
  const production = repositories
    .map(({ owner, repo }) => `${owner}/${repo}`)
    .filter((name) => PRODUCTION_REPOSITORIES.some((protectedName) => protectedName.toLowerCase() === name.toLowerCase()));
  if (production.length) {
    throw notConfigured(`The ${environment} Worker must not open pull requests on production repositories: ${production.join(', ')}`);
  }
}
