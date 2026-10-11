import type { Settings } from '../config/environment';
import type { Env } from '../env';
import { AppError } from '../errors';
import { singleLine } from '../text';

export const PROVIDERS = ['github', 'orcid'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Who signed in: public profile data only — no e-mail, no tokens (spec 002). */
export interface Identity {
  provider: ProviderId;
  /** GitHub numeric user id or ORCID iD. */
  id: string;
  /** GitHub login (GitHub only), used for credit and noreply addresses. */
  login?: string;
  name: string;
  profileUrl: string;
}

export interface AuthorizeRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface SignInRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * An identity provider: builds the authorization URL and turns a code into an Identity. The provider access token
 * never leaves `signIn`. Adding a provider means adding one module and one registry entry.
 */
export interface IdentityProvider {
  id: ProviderId;
  authorizeUrl(request: AuthorizeRequest): string;
  signIn(request: SignInRequest): Promise<Identity>;
}

export interface ProviderDeps {
  env: Env;
  settings: Settings;
  fetch: typeof fetch;
}



/** Display names are flattened and capped; empty names fall back to the given value. */
export function displayName(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const cleaned = singleLine(candidate ?? '', 100).replace(/[<>]/g, '');
    if (cleaned) return cleaned;
  }
  return '';
}

export function signInFailed(provider: ProviderId, reason: string): AppError {
  return new AppError('UNAUTHENTICATED', 'Sign-in failed. Please try again.', { provider, reason });
}

export async function readJson<T>(response: Response, provider: ProviderId, step: string): Promise<T> {
  if (!response.ok) throw signInFailed(provider, `${step}: HTTP ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw signInFailed(provider, `${step}: invalid JSON`);
  }
}
