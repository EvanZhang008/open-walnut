#!/bin/bash
# The Swift files the Mac app is built from, one per line (absolute paths): every file in
# desktop/ but make-icon.swift (a separate tool) and DemoApp.swift (the Demo app, its own @main,
# built by desktop/build-demo.sh), and the two helpers in src/data. The window
# tests (scripts/test-desktop-update-windows.sh, test-desktop-popout.sh,
# build-desktop-recent-test.sh) compile the whole app from this list, so a new app file reaches them by itself (2026-11-10: both failed on
# WalnutIntents.swift, which their own lists lacked). tests/scripts/desktop-app-sources.test.ts
# checks it against the SOURCES of desktop/build.sh and desktop/build-release.sh.
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
for f in "$ROOT"/desktop/*.swift; do
    case "$(basename "$f")" in make-icon.swift|DemoApp.swift) continue ;; esac
    printf '%s\n' "$f"
done
printf '%s\n' "$ROOT/src/data/walnut-calendar.swift" "$ROOT/src/data/walnut-reader.swift"
