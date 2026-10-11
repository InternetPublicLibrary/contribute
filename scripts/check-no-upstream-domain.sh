#!/usr/bin/env sh
# Issue #21: the former upstream domain served infringing content; it may appear only, de-linked, in the upstream README.
set -eu
pattern='staticman[.]net'
if git grep -n -i -E "$pattern" -- . ':!docs/UPSTREAM-README.md'; then
  echo "Links to the former upstream domain are not allowed outside docs/UPSTREAM-README.md." >&2
  exit 1
fi
if grep -n -i -E "\]\([^)]*$pattern" docs/UPSTREAM-README.md; then
  echo "docs/UPSTREAM-README.md must not link to the former upstream domain." >&2
  exit 1
fi
echo "No links to the former upstream domain."
