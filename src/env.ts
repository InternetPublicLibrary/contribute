/** Bindings and variables available to the Worker (wrangler.jsonc + secrets). */
export interface Env {
  ENVIRONMENT: 'development' | 'staging' | 'production';
}
