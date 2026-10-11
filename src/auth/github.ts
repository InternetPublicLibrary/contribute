import { AppError } from '../errors';
import { displayName, type IdentityProvider, type ProviderDeps, readJson, signInFailed } from './identity';

/** GitHub OAuth App used only to identify people (scope read:user); the GitHub App writes (spec 002). */
export function githubProvider({ env, fetch: fetcher }: ProviderDeps): IdentityProvider {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new AppError('NOT_CONFIGURED', 'GitHub sign-in is not configured.');

  return {
    id: 'github',
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async signIn({ code, codeVerifier, redirectUri }) {
      const tokenResponse = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      const token = await readJson<{ access_token?: string; error?: string }>(tokenResponse, 'github', 'token');
      if (!token.access_token) throw signInFailed('github', token.error ?? 'no access token');

      const user = await readJson<{ id?: number; login?: string; name?: string | null; html_url?: string }>(
        await fetcher('https://api.github.com/user', {
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'ipl-contribute' },
        }),
        'github',
        'profile',
      );
      if (typeof user.id !== 'number' || !user.login || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) throw signInFailed('github', 'unexpected profile');
      // The access token goes out of scope here: it is never stored.
      return {
        provider: 'github',
        id: String(user.id),
        login: user.login,
        name: displayName(user.name, user.login),
        profileUrl: `https://github.com/${user.login}`,
      };
    },
  };
}
