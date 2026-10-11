import type { Context } from 'hono';
import type { Identity } from '../auth/identity';
import type { Env } from '../env';
import { AppError } from '../errors';

/**
 * Abuse limits (issue #6). Every write is tied to a signed-in identity and checked here **before** any GitHub call:
 * a maintainer deny-list, a daily cap and a cap on pull requests open at once. KV counters are eventually
 * consistent, so caps are approximate across locations; the per-IP Rate Limiting binding adds a coarse guard.
 */
export const DEFAULT_MAX_PRS_PER_DAY = 20;
export const DEFAULT_MAX_OPEN_PRS = 5;
const DAY_TTL_S = 2 * 24 * 60 * 60;
const OPEN_TTL_S = 30 * 24 * 60 * 60;
const OPEN_RETRY_S = 60 * 60;

type AppContext = Context<{ Bindings: Env }>;
const who = (identity: Pick<Identity, 'provider' | 'id'>) => `${identity.provider}:${identity.id}`;
const today = (now: Date) => now.toISOString().slice(0, 10);
const dayKey = (identity: Pick<Identity, 'provider' | 'id'>, now: Date) => `quota:day:${who(identity)}:${today(now)}`;
const openKey = (identity: Pick<Identity, 'provider' | 'id'>) => `quota:open:${who(identity)}`;

function limit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Coarse per-IP limit (Workers Rate Limiting binding, configured for staging and production). */
export async function assertIpAllowed(c: AppContext): Promise<void> {
  const limiter = c.env.IP_RATE_LIMITER;
  if (!limiter) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: ip });
  if (!success) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a minute.', undefined, 60);
}

/** Deny-list and per-identity caps; 403 or 429 with Retry-After, before any GitHub call. */
export async function assertContributionAllowed(c: AppContext, identity: Identity, now = new Date()): Promise<void> {
  const kv = c.env.CONTRIBUTE_KV;
  if (await kv.get(`deny:${who(identity)}`)) {
    throw new AppError('FORBIDDEN', 'This account cannot send contributions. Contact the maintainers if you think this is a mistake.');
  }
  const perDay = limit(c.env.MAX_PRS_PER_DAY, DEFAULT_MAX_PRS_PER_DAY);
  const sentToday = Number((await kv.get(dayKey(identity, now))) ?? 0);
  if (sentToday >= perDay) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new AppError('RATE_LIMITED', `You can send up to ${perDay} contributions a day.`, { limit: 'daily', max: perDay }, Math.ceil((midnight - now.getTime()) / 1000));
  }
  const maxOpen = limit(c.env.MAX_OPEN_PRS, DEFAULT_MAX_OPEN_PRS);
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  if (open.length >= maxOpen) {
    throw new AppError('RATE_LIMITED', `You already have ${open.length} contributions waiting for review.`, { limit: 'open', max: maxOpen }, OPEN_RETRY_S);
  }
}

/** Count a pull request that was opened. */
export async function recordContribution(kv: KVNamespace, identity: Identity, pullRequest: string, now = new Date()): Promise<void> {
  const sentToday = Number((await kv.get(dayKey(identity, now))) ?? 0);
  await kv.put(dayKey(identity, now), String(sentToday + 1), { expirationTtl: DAY_TTL_S });
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  await kv.put(openKey(identity), JSON.stringify([...new Set([...open, pullRequest])]), { expirationTtl: OPEN_TTL_S });
}

/** Free an open slot when a contribution pull request closes (merged or not), using the body's identity marker. */
export async function releaseContribution(kv: KVNamespace, body: unknown, pullRequest: string): Promise<boolean> {
  const match = typeof body === 'string' ? /<!-- contribute-identity:(github|orcid):([\w-]{1,64}) -->/.exec(body) : null;
  if (!match?.[1] || !match[2]) return false;
  const identity = { provider: match[1] as Identity['provider'], id: match[2] };
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  if (!open.includes(pullRequest)) return false;
  await kv.put(openKey(identity), JSON.stringify(open.filter((item) => item !== pullRequest)), { expirationTtl: OPEN_TTL_S });
  return true;
}
