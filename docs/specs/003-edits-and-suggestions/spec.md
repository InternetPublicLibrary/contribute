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

## Errors

Every error response has the same body (issue #10), defined in [`src/errors.ts`](../../../src/errors.ts):

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": { } }, "requestId": "…" }
```

| Status | Codes | Meaning for the IPL site |
| --- | --- | --- |
| 400 | `BAD_REQUEST`, `INVALID_JSON`, `UNKNOWN_FIELDS` | client bug: malformed body or unexpected keys (`details.fields`) |
| 401 | `UNAUTHENTICATED`, `INVALID_SIGNATURE` | sign in again |
| 403 | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED` | not allowed (origin, CSRF, deny-list) |
| 404 | `NOT_FOUND`, `CONFIG_MISSING` | unknown page, topic or route; repository has no `contribute.yml` |
| 409 | `CONFLICT`, `STALE_SHA` | the page changed; `details` carries the current content and sha |
| 410 | `GONE` | retired route |
| 413 | `PAYLOAD_TOO_LARGE` | content too long |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | send `application/json` |
| 422 | `VALIDATION_FAILED`, `CONFIG_INVALID` | fix the listed fields (`details.fields`) |
| 429 | `RATE_LIMITED` | too many contributions; `Retry-After` header |
| 500 | `INTERNAL` | unexpected; quote the `requestId` |
| 502 | `GITHUB_ERROR`, `GITHUB_AUTH` | GitHub refused the request; `details.githubStatus` |
| 503 | `GITHUB_UNAVAILABLE`, `NOT_CONFIGURED` | try later; `Retry-After` header |

## Content rules (issue #3)

Implemented in [`src/contrib/safety.ts`](../../../src/contrib/safety.ts); violations are `422 VALIDATION_FAILED`.

- **Suggestions:** `name`, `description` and `organization` are plain text — no `<tag`, no control characters other
  than line breaks, no bidi controls; NFC-normalised and trimmed. `url` is a public `https:` address (no
  `javascript:`, `data:`, `vbscript:`, credentials, `localhost` or IP hosts).
- **Page edits:** only lines the edit adds or changes are judged, and `details.problems` lists `{ line, reason }`.
  Always rejected: `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<form>` and other active tags; `on*=`
  attributes; `javascript:` / `data:` / `vbscript:` links (also entity-encoded or split by whitespace); new Liquid
  tags. Markdown pages may add only `<kbd>`, `<sup>`, `<sub>`, `<br>` outside code fences, and such PRs get the
  `contains-html` label. Front matter that decides publication (`permalink`, `layout`, `redirect_from`, `redirect_to`,
  `lang`, `published`) cannot change.
- Template-side escaping in IPLibrary-website remains required and is tracked there.
