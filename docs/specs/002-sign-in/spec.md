# 002 — Sign-in with GitHub and ORCID

Status: draft · Depends on: [001](../001-workers-runtime/spec.md)

## Why
Contributions must carry a real, verifiable author, and researchers without GitHub accounts must be able to
take part with their ORCID iD.

## What
1. OAuth 2.0 authorization-code flow with PKCE for two providers:
   - GitHub OAuth App (scope: `read:user` only — the IPL GitHub App opens PRs, never the user's token);
   - ORCID (`/authenticate` scope, public API; production and sandbox endpoints configurable).
2. After callback, a session (opaque id in an `HttpOnly; Secure; SameSite=Lax` cookie on the `contribute`
   domain, data in Workers KV, 7-day expiry) holding: provider, stable id (GitHub id / ORCID iD), display name,
   profile URL. No e-mail, no tokens stored beyond the exchange.
3. `GET /v1/auth/:provider/start?return_to=<allowed IPL URL>`, `GET /v1/auth/:provider/callback`,
   `GET /v1/session` (JSON identity or 401), `POST /v1/auth/logout`. `return_to` must match an allow-list of
   IPL origins.
4. CORS limited to IPL origins; CSRF protection on state-changing routes (double-submit token).

## Acceptance criteria
- [ ] Sign-in round trip works for GitHub and ORCID sandbox; `/v1/session` returns the identity.
- [ ] Session cookie flags and KV expiry verified by tests; logout deletes the KV entry.
- [ ] Open-redirect, CSRF and state-mismatch cases are rejected (tests).
- [ ] Privacy note: what is stored and for how long, published with the service.

## Out of scope
Account pages, profiles, roles (code owners decide on PRs).
