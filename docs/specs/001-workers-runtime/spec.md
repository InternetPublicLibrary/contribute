# 001 — Workers runtime

Status: draft · Owner: IPL maintainers · ADR: [0002](../../adr/0002-run-on-cloudflare-workers.md)

## Why
The upstream Express server cannot run on Cloudflare Workers, where the IPL site lives.

## What
1. A Workers entry point (`src/worker.ts`) with a Hono router serving the existing routes:
   `GET /`, `POST /v3/entry/github/:username/:repository/:branch/:property`, `GET /v3/connect/...` (to be
   replaced in 002), `POST /v1/webhook`.
2. GitHub access through a GitHub App (installation token via JWT signed with Web Crypto), `fetch` only.
3. Configuration from Wrangler vars/secrets instead of `convict` files; repository rules still read from
   `staticman.yml` in the target repository (renamed `contribute.yml`, old name still accepted).
4. Remove Node-only and unused features: GitLab, Akismet, reCAPTCHA, email notifications, RSA key endpoint.
5. Tests run in the Workers runtime (Vitest + Miniflare); CI on every PR.

## Acceptance criteria
- [ ] `wrangler dev` serves the routes above; posting a valid entry to a test repository opens a pull request.
- [ ] No Node built-ins (`crypto`, `fs`, `request`) remain in the runtime bundle.
- [ ] Existing unit tests for config parsing, field validation and transforms pass on the new runtime.
- [ ] Deployed to a staging Worker; secrets documented in README.

## Out of scope
Sign-in (002), edit/suggestion API (003), UI.
