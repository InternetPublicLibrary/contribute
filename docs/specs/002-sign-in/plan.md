# 002 — Plan

Spec: [spec.md](spec.md) · Depends on spec 001.

## Architecture

```
src/auth/
  return-url.ts     resolveReturnUrl: the only way to build a redirect target (#4)
  pkce.ts           state, verifier, S256 challenge (Web Crypto)
  providers.ts      IdentityProvider interface + registry
  github.ts         GitHub OAuth App: scope read:user, PKCE; profile from GET /user
  orcid.ts          ORCID /authenticate (production or sandbox from spec 001 settings), PKCE; name from the token
                    response, falling back to the public record
  session.ts        KV sessions, cookie, CSRF token, CORS for IPL origins
  routes.ts         /v1/auth/:provider/start · /callback · /v1/session · /v1/auth/logout
```

## Contracts

- `GET /v1/auth/:provider/start?return_to=<IPL URL>` → 302 to the provider. `return_to` passes through
  `resolveReturnUrl`; the result is stored with `state` and the PKCE verifier in KV (`oauth:<state>`, 10 min, single use),
  and `state` is also set in a `__Host-ipl_contribute_state` cookie: the callback must come from the same browser
  (login-CSRF protection).
- `GET /v1/auth/:provider/callback?code&state` → checks the state against KV **and** the state cookie, exchanges the code
  with the verifier, reads the profile, discards the provider token, deletes any previous session of this browser,
  creates `session:<id>` (7 days) and redirects **only** to the stored `return_to`.
- `GET /v1/session` → `{ identity: { provider, id, name, profileUrl }, csrfToken }` or 401.
- `POST /v1/auth/logout` (header `X-CSRF-Token`) → deletes the KV record and the cookie.
- Cookie `__Host-ipl_contribute` (`HttpOnly; Secure; SameSite=Lax; Path=/`), random 256-bit id.

## Decisions

- **CSRF:** a session-bound synchronizer token instead of a double-submit cookie. The IPL site and the service are
  different hosts, so the site's JavaScript cannot read a cookie set by the service; it reads `csrfToken` from
  `GET /v1/session` (a credentialed CORS request only IPL origins may make) and sends it as `X-CSRF-Token`. State-changing
  requests also need an allowed `Origin`.
- **No e-mail, no stored tokens:** GitHub scope `read:user`; ORCID `/authenticate`; the access token lives only for the
  callback request.
- **Display names:** GitHub `name` → `login`; ORCID credit name → given + family names → the iD.

## Risks

- Workers KV is eventually consistent: a deleted session or consumed `oauth:<state>` can still be read at other
  locations for up to about a minute. The OAuth case is covered by the state cookie and the provider's single-use code;
  a logged-out session may survive that long elsewhere. Acceptable for this service; revisit with a Durable Object if
  sessions ever authorise more than opening reviewed pull requests.
- `/v1/auth/:provider/start` writes to KV for every call; a coarse per-IP rate limit (Workers Rate Limiting or a WAF
  rule) is part of spec 003 T8 (#6).

- ORCID's PKCE support must be confirmed on the sandbox; the flow keeps the client secret as well.
