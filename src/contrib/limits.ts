import type { Context } from 'hono';
import type { Identity } from '../auth/identity';
import type { Env } from '../env';
import { AppError } from '../errors';

/**
 * Abuse limits (issue #6). Every write is tied to a signed-in identity and checked here **before** any GitHub call:
 * a maintainer deny-list, a daily cap (reserved up front and given back if the contribution fails) and a cap on
 * pull requests open at once. Workers KV has no atomic increment, so parallel requests from one identity can still
 * slip past a cap by a few; the per-IP Rate Limiting binding bounds that, and a Durable Object is the upgrade path if
 * exact counts are ever needed.
 */
export const DEFAULT_MAX_PRS_PER_DAY = 20;
export const DEFAULT_MAX_OPEN_PRS = 5;
export const MAX_LINK_CHECKS_PER_DAY = 50;
const DAY_TTL_S = 2 * 24 * 60 * 60;
const OPEN_TTL_S = 30 * 24 * 60 * 60;
const OPEN_RETRY_S = 60 * 60;

type AppContext = Context<{ Bindings: Env }>;
type Who = Pick<Identity, 'provider' | 'id'>;
const who = (identity: Who) => `${identity.provider}:${identity.id}`;
const today = (now: Date) => now.toISOString().slice(0, 10);
const dayKey = (identity: Who, now: Date) => `quota:day:${who(identity)}:${today(now)}`;
const probeKey = (identity: Who, now: Date) => `quota:probe:${who(identity)}:${today(now)}`;
const openKey = (identity: Who) => `quota:open:${who(identity)}`;
/** Repository names are case-insensitive on GitHub; keys must be too. */
const pullKey = (pullRequest: string) => pullRequest.toLowerCase();

function limit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const secondsToMidnight = (now: Date) =>
  Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);

/** Coarse per-IP limit (Workers Rate Limiting binding, configured for staging and production). */
export async function assertIpAllowed(c: AppContext): Promise<void> {
  const limiter = c.env.IP_RATE_LIMITER;
  if (!limiter) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: ip });
  if (!success) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a minute.', undefined, 60);
}

export interface Reservation {
  /** Give the daily slot back (the contribution failed before a pull request existed). */
  rollback(): Promise<void>;
}

/** Deny-list and caps; reserves today's slot. 403 or 429 with Retry-After, before any GitHub call. */
export async function reserveContribution(c: AppContext, identity: Identity, now = new Date()): Promise<Reservation> {
  const kv = c.env.CONTRIBUTE_KV;
  if (await kv.get(`deny:${who(identity)}`)) {
    throw new AppError('FORBIDDEN', 'This account cannot send contributions. Contact the maintainers if you think this is a mistake.');
  }
  const maxOpen = limit(c.env.MAX_OPEN_PRS, DEFAULT_MAX_OPEN_PRS);
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  if (open.length >= maxOpen) {
    throw new AppError('RATE_LIMITED', `You already have ${open.length} contributions waiting for review.`, { limit: 'open', max: maxOpen }, OPEN_RETRY_S);
  }
  const perDay = limit(c.env.MAX_PRS_PER_DAY, DEFAULT_MAX_PRS_PER_DAY);
  const key = dayKey(identity, now);
  const sentToday = Number((await kv.get(key)) ?? 0);
  if (sentToday >= perDay) {
    throw new AppError('RATE_LIMITED', `You can send up to ${perDay} contributions a day.`, { limit: 'daily', max: perDay }, secondsToMidnight(now));
  }
  await kv.put(key, String(sentToday + 1), { expirationTtl: DAY_TTL_S });
  return {
    async rollback() {
      const current = Number((await kv.get(key)) ?? 0);
      await kv.put(key, String(Math.max(0, current - 1)), { expirationTtl: DAY_TTL_S });
    },
  };
}

/** Link checks reach other servers on the reader's behalf, so they are capped per identity too. */
export async function countLinkCheck(kv: KVNamespace, identity: Identity, now = new Date()): Promise<void> {
  const key = probeKey(identity, now);
  const used = Number((await kv.get(key)) ?? 0);
  if (used >= MAX_LINK_CHECKS_PER_DAY) {
    throw new AppError('RATE_LIMITED', 'Too many link checks today.', { limit: 'link-checks', max: MAX_LINK_CHECKS_PER_DAY }, secondsToMidnight(now));
  }
  await kv.put(key, String(used + 1), { expirationTtl: DAY_TTL_S });
}

/** Count a pull request that was opened and is waiting for review. */
export async function recordContribution(kv: KVNamespace, identity: Who, pullRequest: string): Promise<void> {
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  await kv.put(openKey(identity), JSON.stringify([...new Set([...open, pullKey(pullRequest)])]), { expirationTtl: OPEN_TTL_S });
}

/** Free an open slot when a contribution pull request closes (merged or not), using the body's identity marker. */
export async function releaseContribution(kv: KVNamespace, body: unknown, pullRequest: string): Promise<boolean> {
  const match = typeof body === 'string' ? /<!-- contribute-identity:(github|orcid):([\w-]{1,64}) -->\s*$/.exec(body) : null;
  if (!match?.[1] || !match[2]) return false;
  const identity = { provider: match[1] as Identity['provider'], id: match[2] };
  const open = (await kv.get<string[]>(openKey(identity), 'json')) ?? [];
  if (!open.includes(pullKey(pullRequest))) return false;
  await kv.put(openKey(identity), JSON.stringify(open.filter((item) => item !== pullKey(pullRequest))), { expirationTtl: OPEN_TTL_S });
  return true;
}
