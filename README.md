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

> **Status:** fork created on 2026-10-10. The code is still the upstream Staticman (Express); the IPL service is being
> built spec by spec — see the [roadmap](docs/specs/ROADMAP.md).

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
- **No passwords, no e-mail**: sessions hold only the provider, a stable id, the display name and profile URL.

## API (planned)

Defined in [spec 003](docs/specs/003-edits-and-suggestions/spec.md) — the contract consumed by the IPL site:

| Route | Purpose |
| --- | --- |
| `GET /v1/auth/:provider/start` · `/callback` · `GET /v1/session` · `POST /v1/auth/logout` | Sign-in with GitHub or ORCID ([spec 002](docs/specs/002-sign-in/spec.md)) |
| `GET /v1/source?url=` | Source file of an IPL page |
| `POST /v1/edits` | Propose a page edit (opens a PR) |
| `POST /v1/suggestions` | Suggest a resource for a topic (opens a PR on `_data`) |
| `GET /v1/contributions` | The signed-in author's pull requests |

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
