/**
 * The only way to build a redirect target (issue #4). The input must be an absolute URL whose origin is **exactly**
 * one of the configured IPL origins (`IPL_ALLOWED_ORIGINS`, already restricted to https — http://localhost only in
 * development). Anything else falls back to a fixed safe page; the input is never echoed.
 */
export function resolveReturnUrl(input: string | null | undefined, allowedOrigins: readonly string[]): string {
  const fallback = `${allowedOrigins[0] ?? ''}/`;
  if (!input || input.length > 2048) return fallback;
  // Backslashes, control characters and whitespace are normalised differently by browsers: refuse them outright.
  if (/[\\\p{Cc}\s]/u.test(input)) return fallback;
  if (!/^https?:\/\//i.test(input)) return fallback;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fallback;
  }
  if (url.username || url.password) return fallback;
  if (!allowedOrigins.includes(url.origin)) return fallback;
  return url.href;
}
