#!/bin/bash
set -euo pipefail
# A page the Mac app replaces really ends, with its graphics memory (macOS only: AppKit, WebKit).
# Drives desktop/WebContentProcess.swift's retire in a hidden app: no Dock icon, never
# activated, a window that is 1% opaque, click-through and below every normal window.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/walnut-replaced-page.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
# The test file holds the entry point, which swiftc takes only from a file named main.swift.
cp "$ROOT/tests/desktop/replaced-page-process-tests.swift" "$OUT/main.swift"
APP="$OUT/ReplacedPageTests.app"
mkdir -p "$APP/Contents/MacOS"
swiftc "$ROOT/desktop/WebContentProcess.swift" "$ROOT/desktop/QuietKeyWindow.swift" "$OUT/main.swift" \
    -framework Cocoa -framework WebKit -o "$APP/Contents/MacOS/replaced-page-tests"
python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as out:
    plistlib.dump({'CFBundleIdentifier': 'dev.openwalnut.replaced-page-tests', 'CFBundleExecutable': 'replaced-page-tests',
                   'CFBundlePackageType': 'APPL', 'CFBundleName': 'Replaced Page Tests', 'LSUIElement': True}, out)
PY
codesign --force --sign - "$APP"
# A hung WebKit fails the step in three minutes, not at the job's limit.
perl -e 'alarm 180; exec @ARGV' "$APP/Contents/MacOS/replaced-page-tests" | tee "$OUT/result.log"
grep -q 'ReplacedPageProcessTests: all passed' "$OUT/result.log"
