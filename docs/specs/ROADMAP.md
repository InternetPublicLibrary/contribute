# contribute — Roadmap

Goal: signed-in readers of the Internet Public Library edit pages and suggest resources; every change becomes a
pull request reviewed by code owners. Decisions: [ADR 0001](../adr/0001-hard-fork-of-staticman.md),
[0002](../adr/0002-run-on-cloudflare-workers.md), [0003](../adr/0003-contributions-as-reviewed-pull-requests.md).

| Order | Spec | Depends on |
| --- | --- | --- |
| 1 | [001 Workers runtime](001-workers-runtime/spec.md) — the fork runs on Cloudflare Workers with today's entry flow | — |
| 2 | [002 Sign-in with GitHub and ORCID](002-sign-in/spec.md) | 001 |
| 3 | [003 Page edits and resource suggestions](003-edits-and-suggestions/spec.md) — owns the API contract used by the IPL site | 001, 002 |

Consumer: `InternetPublicLibrary/IPLibrary-website` (its own spec references the contract defined in 003).
Related service: `InternetPublicLibrary/discuss` (comments), which shares the sign-in approach but not the code.
