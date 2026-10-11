/** Small text helpers shared by config, entries and pull requests. */

/** Lower-case slug that keeps letters of any script (pt-BR accents are folded to ASCII, CJK is kept). */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/**
 * Format a UTC date with the tokens upstream configurations use in `{@date:…}` placeholders
 * (a subset of moment.js): YYYY YY MM M DD D HH H mm ss X (seconds) x (milliseconds).
 */
export function formatDate(date: Date, pattern: string): string {
  const tokens: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    YY: pad(date.getUTCFullYear() % 100),
    MM: pad(date.getUTCMonth() + 1),
    M: String(date.getUTCMonth() + 1),
    DD: pad(date.getUTCDate()),
    D: String(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
    H: String(date.getUTCHours()),
    mm: pad(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    X: String(Math.floor(date.getTime() / 1000)),
    x: String(date.getTime()),
  };
  return pattern.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss|X|x/g, (token) => tokens[token] ?? token);
}
