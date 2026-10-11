/** Bindings, variables and secrets available to the Worker (wrangler.jsonc + `wrangler secret put`). */
export interface Env {
  ENVIRONMENT: 'development' | 'staging' | 'production';
  /** KV: GitHub installation ids and tokens, caches (and sessions from spec 002). */
  CONTRIBUTE_KV: KVNamespace;
  /** Comma-separated exact origins of the IPL sites (var). */
  IPL_ALLOWED_ORIGINS?: string;
  /** JSON map of role → "owner/repo" for content repositories (var). */
  CONTENT_REPOSITORIES?: string;
  /** ORCID registry: "sandbox" (default outside production) or "production" (var). */
  ORCID_ENVIRONMENT?: string;
  /** "on" enables the anonymous upstream entry route outside production (var; never on in production). */
  LEGACY_ENTRY_ROUTE?: string;
  /** Per-identity caps (vars; defaults 20 a day and 5 open). */
  MAX_PRS_PER_DAY?: string;
  MAX_OPEN_PRS?: string;
  /** Workers Rate Limiting binding: coarse per-IP limit on sign-in starts and writes (staging, production). */
  IP_RATE_LIMITER?: RateLimit;
  /** GitHub App id (var). */
  GITHUB_APP_ID?: string;
  /** Secret configured on the GitHub App webhook (secret). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** GitHub OAuth App used for sign-in only (secrets). */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** ORCID member/public API client for the configured registry (secrets). */
  ORCID_CLIENT_ID?: string;
  ORCID_CLIENT_SECRET?: string;
  /** GitHub App private key, PKCS#8 PEM (secret). */
  GITHUB_APP_PRIVATE_KEY?: string;
}

declare global {
  // `env` from `cloudflare:workers` (used by tests) has the same bindings as the Worker.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augments the Workers runtime's global namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

type AppEnv = Env;
