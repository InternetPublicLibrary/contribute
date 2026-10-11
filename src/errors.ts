import type { Context } from 'hono';

/**
 * One error shape for every route (issue #10):
 *   { "error": { "code", "message", "details"? }, "requestId" }
 * The IPL site maps `code` to reader-facing messages, so codes are a stable contract (spec 003).
 */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  INVALID_JSON: 400,
  UNKNOWN_FIELDS: 400,
  UNAUTHENTICATED: 401,
  INVALID_SIGNATURE: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_SHA: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  CONFIG_INVALID: 422,
  CONFIG_MISSING: 404,
  INTERNAL: 500,
  GITHUB_ERROR: 502,
  GITHUB_AUTH: 502,
  GITHUB_UNAVAILABLE: 503,
  NOT_CONFIGURED: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

export class AppError extends Error {
  readonly status: ErrorStatus;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
  requestId: string;
}

export function requestIdOf(request: Request): string {
  return request.headers.get('cf-ray') ?? crypto.randomUUID();
}

export function errorResponse(c: Context, error: AppError): Response {
  const body: ErrorBody = {
    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    requestId: requestIdOf(c.req.raw),
  };
  if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter));
  return c.json(body, error.status);
}

/** Hono onError: AppErrors keep their status; anything else is a logged 500 that leaks no internals. */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof AppError) {
    if (error.status >= 500) log('error', c, { code: error.code, details: error.details });
    return errorResponse(c, error);
  }
  log('error', c, { code: 'INTERNAL', name: error.name, message: error.message });
  return errorResponse(c, new AppError('INTERNAL', 'Something went wrong on our side. Please try again later.'));
}

export function handleNotFound(c: Context): Response {
  return errorResponse(c, new AppError('NOT_FOUND', `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`));
}

/** Default request body limit (issue #6); routes may pass a smaller or larger one. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Parse a JSON body; too large is a 413, malformed or non-object JSON a 400, never a 500. */
export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
  }
  const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', `The request body is larger than ${Math.round(maxBytes / 1024)} KB.`);
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLarge();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError('INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_JSON', 'The request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/**
 * Map a failed GitHub API response to an AppError without assuming its body is JSON.
 * 401 / bad credentials → GITHUB_AUTH; rate limits → GITHUB_UNAVAILABLE with Retry-After; others → GITHUB_ERROR.
 */
export async function gitHubError(response: Response, operation: string): Promise<AppError> {
  const text = await response.text().catch(() => '');
  let githubMessage = text.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
      githubMessage = parsed.message;
    }
  } catch {
    // Non-JSON error bodies (HTML error pages, plain text) are reported as text.
  }
  const details = { operation, githubStatus: response.status, githubMessage };
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryAfterHeader = response.headers.get('retry-after');
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (remaining === '0' || retryAfterHeader !== null || /rate limit/i.test(githubMessage)));

  if (rateLimited) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const retryAfter = retryAfterHeader !== null
      ? Number(retryAfterHeader)
      : Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
    return new AppError('GITHUB_UNAVAILABLE', 'GitHub is rate-limiting us. Please try again later.', details, retryAfter);
  }
  if (response.status === 401) {
    return new AppError('GITHUB_AUTH', 'The service could not authenticate with GitHub.', details);
  }
  if (response.status >= 500) {
    return new AppError('GITHUB_UNAVAILABLE', 'GitHub is unavailable right now. Please try again later.', details, 30);
  }
  return new AppError('GITHUB_ERROR', `GitHub rejected the request (${operation}).`, details);
}

type LogLevel = 'info' | 'warn' | 'error';

/** Structured log line for Workers Logs. Never pass tokens, e-mails or request bodies. */
export function log(level: LogLevel, c: Context, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    requestId: requestIdOf(c.req.raw),
    route: `${c.req.method} ${new URL(c.req.url).pathname}`,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
