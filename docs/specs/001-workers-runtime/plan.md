# 001 — Plan

Spec: [spec.md](spec.md) · ADR: [0002](../../adr/0002-run-on-cloudflare-workers.md)

## Architecture

```
src/
  worker.ts            Hono app: routes, error middleware, export default
  env.ts               Env: bindings, vars and secrets (one place)
  errors.ts            AppError + the single JSON error shape (#10)
  config/              environment config (origins, repositories, guards) (#19); contribute.yml parsing (#20)
  entry/               field validation and transforms for the legacy entry route (#20, #17)
  github/              GitHub App: Web Crypto JWT, installation tokens in KV, fetch client with call budget (#18)
  webhook.ts           signed webhook, branch cleanup (#5, #14)
```

- **Runtime:** Workers, TypeScript (strict), ESM, Hono. No Node built-ins: `fetch`, Web Crypto, `TextEncoder`.
- **GitHub:** GitHub App only. Every outbound call goes through one `GitHubClient` taking an injected `fetch`, so
  tests count and mock calls without network.
- **State:** Workers KV (`CONTRIBUTE_KV`): installation tokens, installation ids, default branches, webhook delivery ids.
- **Config:** Wrangler `vars` per environment (`development`, `staging`, `production`) + secrets; repository rules
  from `contribute.yml` (fallback `staticman.yml`) on the repository's default branch.
- **Legacy entry route:** `POST /v3/entry/github/:owner/:repo/:branch/:property` keeps upstream's flow (form fields →
  file → pull request) for parity; the `:branch` segment is ignored (default branch is used), it is off unless
  `LEGACY_ENTRY_ROUTE=on`, and it is never on in production (issue #6).
- **Tests:** Vitest 4 + `@cloudflare/vitest-plugin` (runs in workerd); `vitest/no-conditional-expect` (#20).
- **CI:** GitHub Actions on every PR: lint, typecheck, tests; Dependabot; CodeQL.

## Contracts

Error body (every route): `{ "error": { "code", "message", "details"? }, "requestId" }` — codes listed in
[`src/errors.ts`](../../../src/errors.ts) and spec 003.

## Decisions

- Branch cleanup (#14): both. Content repositories enable "Automatically delete head branches", and the
  `pull_request.closed` handler deletes `contribute/*` branches of same-repository PRs in configured repositories.
  A branch already gone (404 / 422) is success; any other failure is logged and acknowledged with **2xx**, because a
  GitHub redelivery would repeat the same failure and a leftover branch is harmless.
- Branches in the content repository, not forks (ADR 0004, #13).

## Risks

- PKCS#1 private keys from GitHub must be converted to PKCS#8 for Web Crypto (#18).
- KV is eventually consistent: counters are approximate (rate limits are spec 003).
