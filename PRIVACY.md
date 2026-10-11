# Privacy — IPL contribute

What the contribution service stores, where, and for how long. It applies to the production and staging Workers.

## What we store

| Data | Where | How long | Why |
| --- | --- | --- | --- |
| Sign-in session (spec 002): provider (`github`/`orcid`), stable id (GitHub numeric id or ORCID iD), display name, profile URL | Cloudflare Workers KV | 7 days, or until you sign out | to know who is contributing |
| Sign-in state (OAuth `state`, PKCE verifier, return page) | Workers KV | 10 minutes, single use | to complete sign-in safely |
| Rate-limit counters per identity (spec 003) | Workers KV | up to 1 day | to stop abuse |
| GitHub App tokens, installation ids, default branches, webhook delivery ids | Workers KV | at most 24 hours | to talk to GitHub efficiently |
| Request logs: request id, route, status, error code | Cloudflare Workers Logs | Cloudflare's default retention | to find and fix failures |

## What we never collect

- **No e-mail address.** Sign-in asks GitHub only for `read:user` and ORCID only for `/authenticate`; entries with an
  e-mail field are rejected. There is no md5 "hash" of e-mails and no encrypted fields.
- No passwords and no provider access tokens: the token from GitHub or ORCID is used once to read your public profile
  and discarded.
- No analytics, advertising or tracking cookies. The only cookie is the session cookie (`HttpOnly`, `Secure`).
- Logs contain no request bodies, tokens, names or e-mail addresses. Cloudflare records client IP addresses for its
  own security and operations under its privacy policy; this service does not store or use them.

## What becomes public

A contribution is a **public pull request** on a GitHub repository of the Internet Public Library. It shows what you
submitted, your display name and a link to your GitHub profile or ORCID record — nothing else. Merged contributions
stay in the public history of the repository.

## Your choices

Sign out at any time (the session is deleted). To have a contribution's attribution changed or removed, open an issue
or use [private vulnerability reporting](https://github.com/InternetPublicLibrary/contribute/security/advisories/new)
for sensitive requests.
