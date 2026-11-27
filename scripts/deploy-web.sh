#!/usr/bin/env bash
# Deploy a commit that changes only the web app (web/) WITHOUT restarting production.
#
# deploy-committed.sh runs this in its clean clone of the commit, from the deploy queue's runner,
# when nothing else production runs changed since the code it runs (dq_change_kind "web"). It
# type-checks and builds web/ as dev-prod.sh does, then swaps the build under the running server
# (scripts/web-swap.mjs), which keeps serving with its sockets, host links and sessions untouched
# (2026-11-27: 22% of the deploys that restarted production changed only web/; each restart drops
# every window's socket and every host's link for seconds). Open windows learn of the new bundle
# and reload when they can (web/src/utils/stale-assets.ts).
#
# Exit 0 swapped, 75 refused (the swap cannot be made here: deploy-committed.sh deploys with a
# restart instead), anything else failed. Writes the new web id to <clone>/.walnut-web-swap-bundle.
# The host servers' Linux files keep the web app they were built with until the next full deploy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_URL="${WALNUT_DEPLOY_CONFIG_URL:-http://127.0.0.1:3456/api/config}"
BUILD_NICE="${WALNUT_BUILD_NICE:-10}"
# dev-prod.sh's lock: never beside a full deploy (bun run dev:prod outside the queue included).
LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"

. "$REPO_ROOT/scripts/lib/find-bun.sh"
walnut_find_bun "$REPO_ROOT" || { echo "$(walnut_bun_missing)" >&2; exit 1; }

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
    echo "Web swap refused: a dev:prod deployment runs now (PID $holder)."
    exit 75
  fi
  rm -f "$LOCK_DIR/pid"
  { rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; } || { echo "Web swap refused: could not take $LOCK_DIR."; exit 75; }
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
release_lock() {
  [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]] || return 0
  rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap release_lock EXIT

# The server it swaps under: the build deploy-committed.sh judged the change against.
SERVED="${WALNUT_DEPLOY_SERVED_COMMIT:-}"
[[ "$SERVED" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Web swap refused: no WALNUT_DEPLOY_SERVED_COMMIT names the build production serves."; exit 75; }
WEB_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
swap() { "$BUN_BIN" "$REPO_ROOT/scripts/web-swap.mjs" --config-url "$CONFIG_URL" --expect-commit "$SERVED" "$@"; }
# Refused before the build when it cannot be made, so a refusal costs seconds, not a build.
swap --check

# The same type check dev-prod.sh runs before a build (a half-edited component ships as a
# first-paint crash), skipped when this commit passed it already.
TSC_DONE=0
if [[ "${WALNUT_DEVPROD_SKIP_TSC:-0}" != "1" ]] && [[ -f "$REPO_ROOT/scripts/lib/tsc-done.sh" ]]; then
  . "$REPO_ROOT/scripts/lib/tsc-done.sh"
  if walnut_tsc_done "$REPO_ROOT" || walnut_tsc_wait "$REPO_ROOT"; then
    TSC_DONE=1
    echo "web/ type-check skipped: commit $(git -C "$REPO_ROOT" rev-parse --short HEAD) passed it already."
  fi
fi
if [[ "${WALNUT_DEVPROD_SKIP_TSC:-0}" != "1" && "$TSC_DONE" != "1" ]]; then
  WEB_TSC="$REPO_ROOT/web/node_modules/.bin/tsc"
  [[ -x "$WEB_TSC" ]] || WEB_TSC="$REPO_ROOT/node_modules/.bin/tsc"
  . "$REPO_ROOT/scripts/lib/tsc-runtime.sh"
  walnut_tsc_runtime "$BUN_BIN"
  if [[ -x "$WEB_TSC" ]]; then
    echo "Type-checking web/ before the build (WALNUT_DEVPROD_SKIP_TSC=1 skips)."
    if ! (cd "$REPO_ROOT/web" && nice -n "$BUILD_NICE" "$TSC_RUNTIME" "$WEB_TSC" --noEmit -p tsconfig.json); then
      echo "web/ type-check FAILED: nothing was swapped, production untouched." >&2
      exit 1
    fi
  else
    echo "web/ type-check skipped: no tsc binary found under web/ or the repo root." >&2
  fi
fi

# Only the web app's own build (web:build's vite step): the server, the daemon, the plugins and the
# extension are the build production already runs.
VITE="$REPO_ROOT/web/node_modules/.bin/vite"
[[ -x "$VITE" ]] || VITE="$REPO_ROOT/node_modules/.bin/vite"
(cd "$REPO_ROOT/web" && PATH="$(dirname "$BUN_BIN"):$PATH" nice -n "$BUILD_NICE" "$VITE" build)

swap --from "$REPO_ROOT/dist/web/static" --web-commit "$WEB_COMMIT" \
  --out "$REPO_ROOT/.walnut-web-swap-bundle" --wait "${WALNUT_WEB_SWAP_WAIT_SECS:-150}"
