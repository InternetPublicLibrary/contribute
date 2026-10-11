# AGENTS.md — contribute

Service of the Internet Public Library that turns signed-in readers' edits and resource suggestions into
pull requests reviewed by code owners. Hard fork of Staticman (see NOTICE.md).

- Read `docs/specs/ROADMAP.md` first; work spec by spec (`docs/specs/<NNN>-<feature>/spec.md → plan.md → tasks.md`).
- Decisions live in `docs/adr/`.
- Runtime target: Cloudflare Workers (ADR 0002). Until spec 001 lands, the upstream Express code is still in place.
- Never commit to `main` directly; signed commits; Conventional Commits.
