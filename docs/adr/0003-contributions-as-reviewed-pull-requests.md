# 0003 — Every contribution is a reviewed pull request, routed by CODEOWNERS

Date: 2026-10-10 · Status: Accepted

## Context

Signed-in readers (GitHub or ORCID) will edit pages and suggest resources. A library that anyone can change
must protect content quality and resist spam and vandalism.

## Decision

`contribute` never commits to a default branch. Each edit or suggestion becomes a pull request on the content
repository (`InternetPublicLibrary/en-US`, `pt-BR` or `IPLibrary-website` for `_data`), opened by the IPL GitHub
App, crediting the author:
- GitHub users: `Co-authored-by: <name> <id+login@users.noreply.github.com>` and a mention in the PR body;
- ORCID users: name and ORCID iD (`https://orcid.org/…`) in the PR body and a `Co-authored-by` trailer with
  their ORCID iD as identifier (no e-mail is collected).
Reviewers are assigned by `.github/CODEOWNERS` in each content repository; merging requires an approving
review from a code owner (branch protection).

## Consequences

- Nothing reaches readers without human review.
- Maintainers need a CODEOWNERS map per area (categories/languages) and enough reviewers.
- Auto-approval for trusted contributors is out of scope (maintainer decision 2026-10-10).
