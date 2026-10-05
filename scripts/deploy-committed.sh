#!/usr/bin/env bash
# Deploy a COMMIT of this checkout to production, never its working tree.
#
#   bash scripts/deploy-committed.sh             # deploy HEAD
#   bash scripts/deploy-committed.sh <commit>    # deploy another commit
#   WALNUT_DEVPROD_DRY_RUN=1 bash scripts/deploy-committed.sh
#
# Several agents share one checkout, and `npm run dev:prod` builds whatever is on
# disk, so a peer's half-written files ship with your commit (2026-09-26: a peer's
# JS went out without its CSS and no long session could scroll). This script
# clones the commit into a temp directory (a separate clone that borrows this
# repo's objects: no worktree, no stash, nothing in this checkout changes), links
# this checkout's dependencies into it, and runs the CLONE's dev-prod.sh with
# WALNUT_DEVPROD_SERVE_ROOT pointing back here, so the server still runs as this
# checkout. Every guard of dev-prod.sh applies unchanged (type-check, smoke boot
# before the kill, rollback, cooldown), and WALNUT_DEVPROD_* knobs pass through.
# The clone is removed afterwards (WALNUT_DEPLOY_KEEP_BUILD=1 keeps it).
set -euo pipefail

SERVE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# An inherited GIT_DIR outranks -C (git exports one while it runs hooks).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX

REF="${1:-HEAD}"
if ! SHA="$(git -C "$SERVE_ROOT" rev-parse --verify --quiet "$REF^{commit}")"; then
  echo "Not a commit in $SERVE_ROOT: $REF" >&2
  exit 1
fi
BRANCH="$(git -C "$SERVE_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then BRANCH=deploy; fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

BUILD="${TMPDIR:-/tmp}"
BUILD="${BUILD%/}/open-walnut-build.${SHA:0:12}.$$"
cleanup() {
  if [[ "${WALNUT_DEPLOY_KEEP_BUILD:-0}" == "1" ]]; then
    echo "Build clone kept: $BUILD"
  elif [[ "$BUILD" == */open-walnut-build.* && -d "$BUILD" ]]; then
    rm -rf "$BUILD"
  fi
}
trap cleanup EXIT

echo "Deploying commit ${SHA:0:12} ($BRANCH) from a clean clone: $BUILD"
git clone --quiet --shared --no-checkout "$SERVE_ROOT" "$BUILD"
git -C "$BUILD" checkout --quiet -B "$BRANCH" "$SHA"

# A commit from before the serve-root knob would run the server inside the clone,
# which is deleted on exit.
if ! grep -q 'WALNUT_DEVPROD_SERVE_ROOT' "$BUILD/scripts/dev-prod.sh"; then
  echo "Commit ${SHA:0:12} predates WALNUT_DEVPROD_SERVE_ROOT; deploy it with npm run dev:prod from a clean tree." >&2
  exit 1
fi

# Dependencies: every top-level entry of this checkout's node_modules is linked,
# except the npm workspace packages, which must be the COMMITTED ones in the
# clone (this checkout's links point at its own, possibly edited, packages/).
"$NODE_BIN" - "$SERVE_ROOT/node_modules" "$BUILD/node_modules" "$BUILD" <<'JS'
const fs = require('fs')
const path = require('path')
const [src, dst, build] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(path.join(build, 'package.json'), 'utf8'))
const workspaces = new Map()
for (const dir of pkg.workspaces ?? []) {
  const name = JSON.parse(fs.readFileSync(path.join(build, dir, 'package.json'), 'utf8')).name
  workspaces.set(name, path.join(build, dir))
}
const scopes = new Set([...workspaces.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]))
fs.mkdirSync(dst, { recursive: true })
for (const entry of fs.readdirSync(src)) {
  if (scopes.has(entry)) {
    fs.mkdirSync(path.join(dst, entry), { recursive: true })
    for (const child of fs.readdirSync(path.join(src, entry))) {
      const name = `${entry}/${child}`
      if (!workspaces.has(name)) fs.symlinkSync(path.join(src, entry, child), path.join(dst, entry, child))
    }
  } else if (!workspaces.has(entry)) {
    fs.symlinkSync(path.join(src, entry), path.join(dst, entry))
  }
}
for (const [name, dir] of workspaces) {
  fs.mkdirSync(path.dirname(path.join(dst, name)), { recursive: true })
  fs.symlinkSync(dir, path.join(dst, name))
}
JS
if [[ -d "$SERVE_ROOT/web/node_modules" ]]; then
  ln -s "$SERVE_ROOT/web/node_modules" "$BUILD/web/node_modules"
fi

cd "$BUILD"
WALNUT_DEVPROD_SERVE_ROOT="$SERVE_ROOT" bash "$BUILD/scripts/dev-prod.sh"
