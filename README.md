<p align="center">
  <img src=".github/assets/logo.png" alt="IPL contribute logo" width="128" height="128">
</p>

<h1 align="center">contribute</h1>

<p align="center">
  Signed-in readers of the <a href="https://ipl.better-web.org">Internet Public Library</a> edit pages and suggest
  resources — every change becomes a pull request reviewed by code owners.<br>
  Sign in with <b>GitHub</b> or <b>ORCID</b> · runs on <b>Cloudflare Workers</b> · hard fork of
  <a href="https://github.com/eduardoboucas/staticman">Staticman</a> (MIT)
</p>

---

> **Status:** the Workers service is being built spec by spec in `src/` — see the [roadmap](docs/specs/ROADMAP.md).
> The upstream Staticman code (`lib/`, `controllers/`, …) stays in the tree for reference until the port reaches parity;
> it is not part of the Worker.

## How it works

```
Reader on an IPL page ──► sign in (GitHub or ORCID) ──► edit page / suggest resource
                                                              │
                         contribute (Cloudflare Worker) ◄─────┘
                                │  validates, rate-limits, credits the author
                                ▼
                 IPL GitHub App opens a pull request on the content repository
                 (en-US, pt-BR or IPLibrary-website _data) ──► CODEOWNERS review ──► merge ──► site rebuild
```

- **Nothing is published without review** — the service never commits to a default branch
  ([ADR 0003](docs/adr/0003-contributions-as-reviewed-pull-requests.md)).
- **Authors are credited**: GitHub users as commit co-authors; ORCID users by name and ORCID iD in the PR.
- **No passwords, no e-mail**: sessions hold only the provider, a stable id, the display name and profile URL —
  see the [privacy note](PRIVACY.md).

## API

Defined in [spec 003](docs/specs/003-edits-and-suggestions/spec.md) — the contract consumed by the IPL site:

| Route | Purpose |
| --- | --- |
| `GET /v1/auth/:provider/start?return_to=` · `/callback` · `GET /v1/session` · `POST /v1/auth/logout` | Sign-in with GitHub or ORCID ([spec 002](docs/specs/002-sign-in/spec.md)) — available |
| `GET /v1/source?url=` | Source file of an IPL page (`409 GENERATED_PAGE` for topic pages built from the menu) — available |
| `POST /v1/edits` | Propose a page edit with the `sha` you read (opens a PR; `409 STALE_SHA` with the current content if the page changed) — available |
| `POST /v1/suggestions` | Suggest a resource for a topic (link must answer; opens a PR on `_data`) — available |
| `GET /v1/contributions` | The signed-in author's pull requests — available |

## Pull requests opened by the service

- **Title:** `Edit: <page title>` or `Resource suggestion: <name>`, one line, at most 120 characters.
- **Labels:** `contribution`, `edit` or `suggestion`, `lang:en-US` / `lang:pt-BR`, `topic:<category>` for suggestions and
  `contains-html` when an edit adds inline HTML. GitHub creates a label the first time it is used, so content
  repositories need no setup; maintainers can recolour or describe them afterwards. Labelling needs the App's
  *Pull requests: write* permission, already in the [manifest](docs/github/app-manifest.json).
- **Body:** see spec 003, "Pull request body".

## Abuse limits

Writes need a signed-in session, an IPL origin and the CSRF token. Before any GitHub call, each identity is checked
against a deny-list and two caps (20 contributions a day, 5 open at once → `429` with `Retry-After`); bodies are capped
(edits 272 KB, suggestions 16 KB → `413`); a per-IP limit protects sign-in and writes, and link checks for suggestions are capped at 50 a day per identity. The
daily slot is reserved before GitHub is called and given back if the contribution fails; the open-PR slot is freed by
the webhook when the pull request closes. KV has no atomic counters, so parallel requests can exceed a cap by a few
(bounded by the per-IP limit). To block an account (maintainers):

```bash
npx wrangler kv key put --binding CONTRIBUTE_KV --env production "deny:github:<numeric id>" "reason"   # or deny:orcid:<iD>
```

## Development

Node.js 22+ and npm.

```bash
npm ci
npm run dev          # wrangler dev on http://localhost:8787
npm run check        # lint + typecheck + tests (Vitest inside workerd)
```

Tests live next to the code (`src/**/*.test.ts`) and run in the Workers runtime through `@cloudflare/vitest-plugin`.
CI runs the same `lint`, `typecheck` and `test` scripts on every pull request.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `CONTRIBUTE_KV` | KV binding | GitHub installation ids and tokens (and sessions, spec 002) — one namespace per environment |
| `IPL_ALLOWED_ORIGINS` | var | Exact `https` origins of the IPL site (comma-separated); `http://localhost` only in development |
| `CONTENT_REPOSITORIES` | var | JSON map role → `owner/repo` (`en-US`, `pt-BR`, `website`) |
| `ORCID_ENVIRONMENT` | var | `sandbox` (default outside production) or `production` |
| `MAX_PRS_PER_DAY`, `MAX_OPEN_PRS` | vars | Per-identity caps (defaults 20 a day, 5 open at once) |
| `IP_RATE_LIMITER` | rate-limit binding | Coarse per-IP limit (30/min) on sign-in starts and writes; staging and production |
| `GITHUB_APP_ID` | var | Id of the IPL GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | secret | The App's private key in **PKCS#8** PEM |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | secrets | GitHub **OAuth App** for sign-in only (scope `read:user`); callback `https://<service>/v1/auth/github/callback` |
| `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET` | secrets | ORCID API client for the environment's registry (sandbox or production); callback `https://<service>/v1/auth/orcid/callback` |
| `GITHUB_WEBHOOK_SECRET` | secret | The App's webhook secret; `POST /v1/webhook` answers 503 without it and 401 to any delivery whose `X-Hub-Signature-256` does not match |

For local development copy `.dev.vars.example` to `.dev.vars` (git-ignored). Configure the App webhook with content
type `application/json` and the events `pull_request` and `installation`.

### Environments

| Environment | Worker | Site origin | Repositories | ORCID |
| --- | --- | --- | --- | --- |
| development (`npm run dev`) | local | `http://localhost:4000` | `contribute-sandbox` | sandbox |
| staging (`--env staging`) | `ipl-contribute-staging` | `https://staging.ipl.better-web.org` | `contribute-sandbox` | sandbox |
| production (`--env production`) | `ipl-contribute` | `https://ipl.better-web.org` | `en-US`, `pt-BR`, `IPLibrary-website` | production |

The service must be **same-site** with the IPL pages: the session cookie is `SameSite=Lax`, so a `*.workers.dev`
address would never receive it from `ipl.better-web.org`. Staging and production therefore run on custom domains of
the IPL zone (`contribute.staging.ipl.better-web.org`, `contribute.ipl.better-web.org`) with `workers_dev` off.

A development or staging Worker refuses to start work if any configured repository is a production one, and only
production may use the ORCID production registry. Pull requests always target the repository's **default branch**,
read from the GitHub API (cached for an hour) — neither requests nor `contribute.yml` choose the branch.
Repository rules are read from `contribute.yml` on that branch (upstream's `staticman.yml` is still accepted).

GitHub downloads App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`), which Web Crypto cannot import. Convert once and
store the result:

```bash
openssl pkcs8 -topk8 -nocrypt -in ipl-contribute.private-key.pem -out ipl-contribute.pkcs8.pem
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env production < ipl-contribute.pkcs8.pem
```

App permissions, installation, the default-branch ruleset and **private key rotation** are documented in
[docs/github/app.md](docs/github/app.md) ([ADR 0004](docs/adr/0004-branches-in-content-repositories.md)).

The service authenticates **only** as the GitHub App; no personal or user token is ever used to write. Opening one
pull request costs 4 GitHub API calls with warm caches (base ref, new branch, file, pull request) and 2 more on a cold
cache (installation id, installation token, both cached in KV).

## Roadmap

| Spec | Scope |
| --- | --- |
| [001 Workers runtime](docs/specs/001-workers-runtime/spec.md) | Port from Express to a Hono Worker, GitHub App via Web Crypto |
| [002 Sign-in](docs/specs/002-sign-in/spec.md) | GitHub and ORCID OAuth (PKCE), KV sessions |
| [003 Edits and suggestions](docs/specs/003-edits-and-suggestions/spec.md) | The API above, PR creation, validation, rate limits |

Decisions: [docs/adr/](docs/adr/). Contributor notes: [AGENTS.md](AGENTS.md).

## Related

[IPLibrary-website](https://github.com/InternetPublicLibrary/IPLibrary-website) (consumer, spec 003) ·
[discuss](https://github.com/InternetPublicLibrary/discuss) (comments) ·
[Better Web Initiative](https://better-web.org)

## License and credits

MIT — see [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md). Based on Staticman by Eduardo Bouças; the upstream
README is kept in [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).
