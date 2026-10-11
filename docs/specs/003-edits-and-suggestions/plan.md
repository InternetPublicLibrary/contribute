# 003 — Plan

Spec: [spec.md](spec.md) · Depends on 001 (runtime, GitHub App) and 002 (sessions).

## Architecture

```
src/contrib/
  topics.ts        menu.yaml (IPLibrary-website, default branch, cached) → topic node → data file path (#11)
  pages.ts         IPL page URL → content repository + candidate source files (#11)
  branches.ts      server-generated contribute/<id> branch names (#11)
  suggestion.ts    strict request schema; YAML entry appended with a serializer (#7)
  safety.ts        plain-text and URL rules for suggestions; HTML scan of page edits with line numbers (#3)
  attribution.ts   commit trailers and credit only from the session identity (#16)
  pr-body.ts       safe pull request body: escaped, no mentions, no closing keywords, size caps (#8)
  labels.ts        titles and labels by type, language and topic (#9)
  routes.ts        GET /v1/source · POST /v1/edits · POST /v1/suggestions · GET /v1/contributions (#12)
  limits.ts        per-identity daily/open PR limits, body size, deny-list (#6)
```

## Data locations (what the IPL site renders)

- Topic resources: `_data/<lang>/<segment 1>/<segment 2>/<type>.yaml` in **IPLibrary-website**, where the segments come
  from the topic's `path` in `_data/<lang>/menu.yaml` (the site reads `site.data[lang][url[2]][url[3]]`). Only category
  and subcategory nodes accept suggestions. Types: `tools`, `databases`, `learn`, `publications`, `blogs-and-sites`,
  `events-and-conferences` (IPLibrary-website spec 002).
- Pages: `https://<IPL origin>/<lang>/<path>/` → the `<lang>` content repository, first existing of
  `<path>/index.html`, `<path>/index.md`, `<path>.html`, `<path>.md` (root: `index.html`, `index.md`). Topic pages generated
  from the menu are not files there and answer 409 (`GENERATED_PAGE`).

## Decisions

- Paths are **derived** from known values (menu nodes, language and type enums); client strings are only looked up,
  never interpolated. Branch names never contain client input.
- One PR body template, user text only inside quoted blocks; identity marker in a hidden comment for
  `GET /v1/contributions`.
