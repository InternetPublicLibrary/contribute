import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { AppError } from '../errors';
import type { Identity } from './identity';
import { randomToken } from './pkce';

/** `__Host-` pins the cookie to this host, Secure and Path=/ (no Domain attribute can widen it). */
export const SESSION_COOKIE = '__Host-ipl_contribute';
export const SESSION_TTL_S = 7 * 24 * 60 * 60;

export interface Session {
  identity: Identity;
  csrfToken: string;
  createdAt: string;
}

type AppContext = Context<{ Bindings: Env }>;
const sessionKey = (id: string) => `session:${id}`;

export async function createSession(c: AppContext, identity: Identity): Promise<Session> {
  const id = randomToken();
  const session: Session = { identity, csrfToken: randomToken(), createdAt: new Date().toISOString() };
  await c.env.CONTRIBUTE_KV.put(sessionKey(id), JSON.stringify(session), { expirationTtl: SESSION_TTL_S });
  setCookie(c, SESSION_COOKIE, id, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_S });
  return session;
}

export async function readSession(c: AppContext): Promise<Session | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return c.env.CONTRIBUTE_KV.get<Session>(sessionKey(id), 'json');
}

export async function requireSession(c: AppContext): Promise<Session> {
  const session = await readSession(c);
  if (!session) throw new AppError('UNAUTHENTICATED', 'Sign in to contribute.');
  return session;
}

export async function destroySession(c: AppContext): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.CONTRIBUTE_KV.delete(sessionKey(id));
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

/**
 * Guard for state-changing requests: an allowed Origin and the session's CSRF token in `X-CSRF-Token`
 * (synchronizer token; see the spec 002 plan for why not double-submit).
 */
export function assertWriteAllowed(c: AppContext, session: Session, allowedOrigins: readonly string[]): void {
  const origin = c.req.header('origin');
  if (!origin || !allowedOrigins.includes(origin)) throw new AppError('ORIGIN_NOT_ALLOWED', 'Requests must come from an IPL page.');
  const token = c.req.header('x-csrf-token') ?? '';
  if (!timingSafeEqual(token, session.csrfToken)) throw new AppError('FORBIDDEN', 'The CSRF token is missing or invalid.');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
