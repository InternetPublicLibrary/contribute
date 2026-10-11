# 0002 — Run on Cloudflare Workers

Date: 2026-10-10 · Status: Accepted

## Context

The IPL site is served by Cloudflare Pages. Staticman is an Express server meant for a long-running Node
process (Heroku/Docker). Running a container would add a server to maintain.

## Decision

Port `contribute` to Cloudflare Workers: a fetch-handler router (Hono), Web Crypto instead of Node `crypto`,
`fetch`-based GitHub REST calls instead of `request`/Octokit Node adapters, Workers KV for sign-in state and
short-lived sessions, secrets in Wrangler. Deployed on the same Cloudflare account as the site.

## Consequences

- No server to patch; free/cheap tier; same platform as the site.
- The port touches most of the codebase (Express middleware, Node-only dependencies).
- CPU-time limits per request apply: GitHub calls must stay few per request.
