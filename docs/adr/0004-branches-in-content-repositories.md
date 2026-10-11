# 0004 — Contribution branches in the content repository, not forks

Date: 2026-10-11 · Status: Accepted · Issue: #13

## Context

Contributions become pull requests (ADR 0003). Upstream Staticman needed write access to every repository and a
fork-based flow was proposed so the bot would need less access. A GitHub App cannot own forks; a fork flow would
need a bot user account with its own token, which is exactly the kind of long-lived credential we are removing.

## Decision

The App creates `contribute/<id>` branches **in the content repository** and opens pull requests from them. Write
access is limited by GitHub, not only by our code: least-privilege App permissions (no Workflows, no Administration)
and a default-branch ruleset that requires a code-owner-approved pull request with **no bypass actors** — so even a
stolen App key cannot change the published site without a human review.

## Consequences

- No bot user, no personal token; one App key to protect and rotate (`docs/github/app.md`).
- The App can push to any non-default branch of the installed repositories; branches are only created under
  `contribute/` by our code and deleted after the PR closes (#14).
- Rulesets must be present on every installed repository; installing the App elsewhere requires the same ruleset.
