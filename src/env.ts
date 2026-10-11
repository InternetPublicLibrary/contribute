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
  /** GitHub App id (var). */
  GITHUB_APP_ID?: string;
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
