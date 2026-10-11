import { AppError, gitHubError } from '../errors';
import { createAppJwt, importAppPrivateKey } from './app-jwt';

export interface GitHubAppOptions {
  appId: string | undefined;
  privateKey: string | undefined;
  kv: KVNamespace;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

const API = 'https://api.github.com';
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const INSTALLATION_TTL_S = 24 * 60 * 60;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * The only way the service talks to GitHub: as the IPL GitHub App (issue #18). There is no code path for personal
 * access tokens or user tokens. Installation ids and installation tokens are cached in KV, so a warm request spends
 * GitHub calls only on the operation itself; `calls` counts every request for budget tests.
 */
export class GitHubApp {
  calls = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private key: Promise<CryptoKey> | undefined;
  /** Per-request memo, so one contribution never mints more than one token even when KV cannot hold it. */
  private readonly tokens = new Map<number, CachedToken>();

  constructor(private readonly options: GitHubAppOptions) {
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  private async appJwt(): Promise<string> {
    if (!this.options.appId) throw new AppError('NOT_CONFIGURED', 'GITHUB_APP_ID is not set.');
    this.key ??= importAppPrivateKey(this.options.privateKey);
    return createAppJwt(this.options.appId, await this.key, Math.floor(this.now() / 1000));
  }

  private async send(method: string, path: string, authorization: string, body?: unknown): Promise<Response> {
    this.calls += 1;
    return this.fetcher(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization,
        'user-agent': 'ipl-contribute',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async installationId({ owner, repo }: RepositoryRef): Promise<number> {
    const cacheKey = `gh:installation:${owner}/${repo}`.toLowerCase();
    const cached = await this.options.kv.get(cacheKey);
    if (cached) return Number(cached);

    const response = await this.send('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, `Bearer ${await this.appJwt()}`);
    if (response.status === 404) {
      throw new AppError('NOT_CONFIGURED', `The IPL GitHub App is not installed on ${owner}/${repo}.`, { repository: `${owner}/${repo}` });
    }
    if (!response.ok) throw await gitHubError(response, 'get installation');
    const { id } = (await response.json()) as { id: number };
    await this.options.kv.put(cacheKey, String(id), { expirationTtl: INSTALLATION_TTL_S });
    return id;
  }

  private async installationToken(repository: RepositoryRef): Promise<string> {
    const id = await this.installationId(repository);
    const memo = this.tokens.get(id);
    if (memo && memo.expiresAt > this.now()) return memo.token;
    const cacheKey = `gh:token:${id}`;
    const cached = await this.options.kv.get<CachedToken>(cacheKey, 'json');
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) {
      this.tokens.set(id, cached);
      return cached.token;
    }

    const response = await this.send('POST', `/app/installations/${id}/access_tokens`, `Bearer ${await this.appJwt()}`);
    if (!response.ok) throw await gitHubError(response, 'create installation token');
    const { token, expires_at: expiresAtText } = (await response.json()) as { token: string; expires_at: string };
    const expiresAt = Date.parse(expiresAtText);
    this.tokens.set(id, { token, expiresAt });
    const ttlSeconds = Math.floor((expiresAt - TOKEN_MARGIN_MS - this.now()) / 1000);
    if (ttlSeconds >= 60) {
      await this.options.kv.put(cacheKey, JSON.stringify({ token, expiresAt } satisfies CachedToken), { expirationTtl: ttlSeconds });
    }
    return token;
  }

  /** Call the REST API for one repository as the installation; non-2xx responses become AppErrors. */
  async request<T>(repository: RepositoryRef, method: string, path: string, operation: string, body?: unknown): Promise<T> {
    const token = await this.installationToken(repository);
    const response = await this.send(method, path, `Bearer ${token}`, body);
    if (response.status === 401) {
      // A revoked token: forget it so the next request mints a new one.
      const id = await this.installationId(repository);
      this.tokens.delete(id);
      await this.options.kv.delete(`gh:token:${id}`);
    }
    if (!response.ok) throw await gitHubError(response, operation);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  /** Like request, but returns null on 404 (e.g. a file that does not exist yet). */
  async requestOrNull<T>(repository: RepositoryRef, method: string, path: string, operation: string): Promise<T | null> {
    const token = await this.installationToken(repository);
    const response = await this.send(method, path, `Bearer ${token}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await gitHubError(response, operation);
    return (await response.json()) as T;
  }
}

export const repoPath = ({ owner, repo }: RepositoryRef) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/** Encode a repository file path per segment for the contents API (keeps `/`, encodes Unicode and spaces). */
export const contentsPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
