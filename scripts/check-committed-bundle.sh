#!/usr/bin/env bash
# Bundle-check the COMMITTED tree (HEAD), not the worktree.
#
# Why this exists: the per-file staged-parse pre-commit gate catches syntax
# damage inside one file, but a commit can also break HEAD across files —
# e.g. removing an export while another (untouched, unstaged) file still
# imports it. That compiles fine in every dirty worktree and only explodes
# on a clean checkout (CI, EC2 deploy, fresh clone). 2026-08-17: exactly
# this killed an EC2 deploy and 502'd the cloud companion (b7e23c32 removed
# getNotesContext; context-inspector.ts still imported it; fixed by 44b982bd).
#
# Approach: git-archive HEAD's src/ into a temp dir and esbuild-bundle the
# same entry points tsup builds. Bundling resolves the import graph, so a
# dangling cross-file import fails here in ~100ms per entry. No type-check
# (pre-push already runs tsc on the worktree); this is purely "does the
# committed import graph resolve".
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TMP=$(mktemp -d /tmp/committed-bundle.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

git archive HEAD src package.json tsconfig.json | tar -x -C "$TMP"

ESBUILD="node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || { echo "check-committed-bundle: esbuild not found — skipping (run npm install)"; exit 0; }

# Keep in sync with tsup.config.ts entry[] (plugin entries are covered
# transitively where imported; standalone ones listed explicitly).
ENTRIES=(
  src/cli.ts
  src/hooks/on-stop.ts
  src/hooks/on-compact.ts
  src/web/server.ts
  src/session-server/index.ts
  src/workers/qmd-index-worker.ts
  src/workers/git-compaction-worker.ts
)

FAIL=0
for entry in "${ENTRIES[@]}"; do
  [ -f "$TMP/$entry" ] || continue
  # --format=esm matches tsup.config.ts (format: ['esm']) — esbuild's cjs
  # default rejects legal top-level await (false positive, 2026-08-21).
  #
  # --log-override:ignored-dynamic-import=error closes the hole that let a broken
  # HEAD through on 2026-08-22: esbuild SILENTLY tolerates an unresolvable
  # dynamic import when any enclosing scope has a catch ("dynamic import failures
  # appear to be handled here"), which is the shape of every lazily-loaded module
  # in this codebase. A commit whose `await import('../human-inbox/relay.js')`
  # target was never committed therefore bundled "clean" here while CI's tsc
  # failed, and main's build gate went red. tsc treats it as an error, so this
  # gate must too — an optional dependency is a BARE specifier, which
  # --packages=external already excludes, so only genuinely dangling relative
  # imports can trip this.
  if ! (cd "$TMP" && "$OLDPWD/$ESBUILD" "$entry" --bundle --platform=node --format=esm \
        --packages=external --loader:.node=file \
        --log-override:ignored-dynamic-import=error --outfile=/dev/null 2>"$TMP/err.log"); then
    echo ""
    echo "✗ Committed tree (HEAD) fails to bundle at $entry:"
    grep -m 6 -E "ERROR|error" "$TMP/err.log" || tail -6 "$TMP/err.log"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "HEAD is unbuildable on a clean checkout (cross-file breakage — a"
  echo "dangling import usually means the fix exists uncommitted in someone's"
  echo "worktree). Commit the missing half before pushing/deploying."
  exit 1
fi
echo "✓ Committed tree bundles clean ($(git rev-parse --short HEAD))."
