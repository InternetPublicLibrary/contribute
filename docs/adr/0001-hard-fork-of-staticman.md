# 0001 — Hard fork of Staticman

Date: 2026-10-10 · Status: Accepted

## Context

The Internet Public Library (IPL) needs readers to suggest resources and edit pages without a backend of its
own, with every change reviewed. Staticman (MIT) already turns form submissions into commits or pull requests
on a Git repository. Its last upstream push was in April 2024; IPL needs changes upstream is unlikely to accept:
sign-in with GitHub and ORCID, attribution of the signed-in author, a Cloudflare Workers runtime and an API
shaped around page edits.

## Decision

Create `InternetPublicLibrary/contribute` as a hard fork: copy the full upstream history (not a GitHub fork
link), keep the MIT license and the original copyright notice (NOTICE.md), and evolve it independently.

## Consequences

- IPL owns the roadmap and security fixes; upstream fixes are ported manually when relevant.
- The upstream history and authorship stay visible.
- Staticman features IPL does not use (GitLab, reCAPTCHA, Akismet, email notifications) may be removed.
