import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadSettings } from '../config/environment';
import type { Env } from '../env';
import { assertIpAllowed } from '../contrib/limits';
import { AppError, log } from '../errors';
import { PROVIDERS, type ProviderId } from './identity';
import { codeChallenge, randomToken } from './pkce';
import { providerFor } from './providers';
import { resolveReturnUrl } from './return-url';
import { assertWriteAllowed, consumeStateCookie, createSession, destroySession, readSession, requireSession, setStateCookie, STATE_TTL_S } from './session';

interface PendingSignIn {
  provider: ProviderId;
  verifier: string;
  returnTo: string;
}

type AppContext = Context<{ Bindings: Env }>;

const redirectUri = (c: AppContext, provider: string) => `${new URL(c.req.url).origin}/v1/auth/${provider}/callback`;

/** Sign-in routes (spec 002). `fetch` is injectable so tests never reach GitHub or ORCID. */
export function authRoutes(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  const routes = new Hono<{ Bindings: Env }>();

  // Credentialed CORS only for IPL origins; other origins get no CORS headers at all.
  routes.use('/session', async (c, next) =>
    cors({
      origin: (origin) => (loadSettings(c.env).allowedOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ['content-type', 'x-csrf-token'],
      allowMethods: ['GET'],
    })(c, next),
  );
  routes.use('/auth/logout', async (c, next) =>
    cors({
      origin: (origin) => (loadSettings(c.env).allowedOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ['content-type', 'x-csrf-token'],
      allowMethods: ['POST'],
    })(c, next),
  );

  routes.get('/auth/:provider/start', async (c) => {
    await assertIpAllowed(c);
    const settings = loadSettings(c.env);
    const provider = providerFor(c.req.param('provider'), { env: c.env, settings, fetch: fetcher });
    const state = randomToken();
    const verifier = randomToken();
    const pending: PendingSignIn = { provider: provider.id, verifier, returnTo: resolveReturnUrl(c.req.query('return_to'), settings.allowedOrigins) };
    await c.env.CONTRIBUTE_KV.put(`oauth:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_S });
    setStateCookie(c, state);
    return c.redirect(provider.authorizeUrl({ state, codeChallenge: await codeChallenge(verifier), redirectUri: redirectUri(c, provider.id) }), 302);
  });

  routes.get('/auth/:provider/callback', async (c) => {
    const settings = loadSettings(c.env);
    const providerId = c.req.param('provider');
    if (!(PROVIDERS as readonly string[]).includes(providerId)) throw new AppError('NOT_FOUND', `Unknown sign-in provider: ${providerId}.`);

    const state = c.req.query('state') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AppError('BAD_REQUEST', 'The sign-in link is invalid or has expired. Please sign in again.');
    const key = `oauth:${state}`;
    const pending = await c.env.CONTRIBUTE_KV.get<PendingSignIn>(key, 'json');
    // Single use: the state is consumed before anything else can fail.
    await c.env.CONTRIBUTE_KV.delete(key);
    // Login CSRF: a callback URL started in another browser (e.g. an attacker's own sign-in) is refused.
    const startedHere = consumeStateCookie(c, state);
    if (!pending || pending.provider !== providerId || !startedHere) {
      throw new AppError('BAD_REQUEST', 'The sign-in link is invalid or has expired. Please sign in again.');
    }

    const code = c.req.query('code');
    if (!code) {
      // The person declined at the provider: go back to where they were, signed out.
      return c.redirect(pending.returnTo, 302);
    }
    const provider = providerFor(providerId, { env: c.env, settings, fetch: fetcher });
    const identity = await provider.signIn({ code, codeVerifier: pending.verifier, redirectUri: redirectUri(c, providerId) });
    await createSession(c, identity);
    log('info', c, { signIn: identity.provider });
    // Only the return URL stored with the state is used, never one from this request.
    return c.redirect(pending.returnTo, 302);
  });

  routes.get('/session', async (c) => {
    const session = await requireSession(c);
    return c.json({ identity: session.identity, csrfToken: session.csrfToken });
  });

  routes.post('/auth/logout', async (c) => {
    const session = await readSession(c);
    if (!session) throw new AppError('UNAUTHENTICATED', 'You are not signed in.');
    assertWriteAllowed(c, session, loadSettings(c.env).allowedOrigins);
    await destroySession(c);
    return c.body(null, 204);
  });

  return routes;
}
