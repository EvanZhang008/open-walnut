#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WALNUT_RECENT_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/walnut-recent-native.XXXXXX")"
export WALNUT_RECENT_BUILD
trap 'rm -rf "$WALNUT_RECENT_BUILD"' EXIT
cd "$ROOT"
bun run web:build
bash scripts/build-desktop-recent-test.sh
PW_BUILT_SPA=1 WALNUT_WEB_STATIC_DIR="$ROOT/dist/web/static" PW_WEBKIT=1 \
  WALNUT_RECENT_NATIVE_BINARY="$WALNUT_RECENT_BUILD/RecentTests.app/Contents/MacOS/RecentTests" \
  WALNUT_RECENT_EVIDENCE_DIR="$WALNUT_RECENT_BUILD/evidence" \
  bun x playwright test tests/e2e/browser/recent-human-native.spec.ts --project webkit
