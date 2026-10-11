# 003 — Page edits and resource suggestions

Status: draft · Depends on: [001](../001-workers-runtime/spec.md), [002](../002-sign-in/spec.md) ·
ADR: [0003](../../adr/0003-contributions-as-reviewed-pull-requests.md)

## Why
Readers should improve IPL pages and suggest resources from the site itself, and maintainers should review each
change as a pull request.

## What — API contract (owned here; consumed by IPLibrary-website)
All routes require a session (002) and an IPL origin; responses are JSON.

| Route | Body | Result |
| --- | --- | --- |
| `GET /v1/source?url=<IPL page URL>` | — | `{ repository, path, branch, content, sha }` of the page's source file |
| `POST /v1/edits` | `{ url, content, sha, summary }` | opens a PR replacing the file; `{ pullRequest: { number, url } }` |
| `POST /v1/suggestions` | `{ lang, topicPath, type, name, url, description, access? }` | opens a PR appending to `_data/<lang>/<category>/<subcategory>/<type>.yaml`; `{ pullRequest }` |
| `GET /v1/contributions` | — | the signed-in author's open/merged PRs |

Rules:
1. Page → source mapping: `en-US`/`pt-BR` content repositories by URL prefix; generated pages map to
   `IPLibrary-website` templates/data and are not editable through `/v1/edits` (409 with a reason).
2. Optimistic concurrency: `sha` must match the default branch; otherwise 409 with the current content.
3. Suggestions are validated like spec 002 of IPLibrary-website (`name`, https `url`, `description`; no
   duplicates in the file; URL reachable) before a PR is opened.
4. PRs: branch `contribute/<id>`, title `Edit: <page title>` / `Resource suggestion: <name>`, body with the author
   (GitHub login or ORCID iD link), summary and the page URL, label `contribution`, `Co-authored-by` trailer.
5. Rate limits per identity (e.g. 20 PRs/day) in KV; size limits on content.

## Acceptance criteria
- [ ] Each route covered by tests against a test repository (happy path, 401, 409 conflict, validation errors).
- [ ] A PR opened by an ORCID user shows the ORCID iD and name; one by a GitHub user co-authors the commit.
- [ ] Code owners are requested automatically (CODEOWNERS present in content repositories).
- [ ] No direct commits to default branches are possible with the App's permissions (branch protection).

## Out of scope
The editor UI on the IPL site (IPLibrary-website spec), auto-merge, moderation dashboards.
