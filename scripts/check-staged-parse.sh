#!/usr/bin/env bash
# Parse-check the STAGED content of every .ts/.tsx file in the index.
#
# Why this exists: four separate commits (68359701 server.ts, 00e7f23e
# daemon-capabilities.ts + daemon-standalone.ts, cadf7563
# SessionChatHistory.tsx) landed with a code block spliced into the middle of
# another statement, so the COMMITTED file failed to parse while every dirty
# worktree happened to compile — only clean checkouts (CI, deploys, fresh
# clones) hit the breakage, sometimes days later. The worktree can't be
# trusted as a proxy for the commit; this checks `git show :file` (the staged
# blob) directly.
#
# Fast: esbuild parses ~500 files in under a second; a typical commit stages
# a handful. Skipped when esbuild isn't resolvable (fresh clone pre-install).

set -u

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)
[ -z "$STAGED" ] && exit 0

ESBUILD="node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || exit 0

FAIL=0
while IFS= read -r f; do
  case "$f" in
    *.tsx) LOADER=tsx ;;
    *)     LOADER=ts ;;
  esac
  if ! git show ":$f" | "$ESBUILD" --loader=$LOADER >/dev/null 2>/tmp/staged-parse-err.$$; then
    echo "✗ staged content of $f does not parse:" >&2
    head -6 "/tmp/staged-parse-err.$$" >&2
    FAIL=1
  fi
done <<EOF_LIST
$STAGED
EOF_LIST
rm -f "/tmp/staged-parse-err.$$"

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "The STAGED blob is broken even if your worktree compiles (partial add," >&2
  echo "mangled hunk). Fix the staged content: re-stage the file or edit and" >&2
  echo "'git add' again. Bypass (not recommended): git commit --no-verify" >&2
  exit 1
fi
exit 0
