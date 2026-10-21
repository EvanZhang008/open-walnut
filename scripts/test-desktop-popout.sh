#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${WALNUT_TEST_PORT:?Point this test at an ephemeral server}"
: "${WALNUT_TEST_SESSION:?Choose a session in that server}"
if [ "$WALNUT_TEST_PORT" = 3456 ]; then
    exit 1
fi
OUT="$(mktemp -d "${TMPDIR:-/tmp}/walnut-popout-tests.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
python3 - "$ROOT/desktop/main.swift" "$OUT/AppDelegate.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
pathlib.Path(sys.argv[2]).write_text(source.split('// MARK: - Entry Point')[0])
PY
swiftc -parse-as-library -D WALNUT_APP -D WALNUT_DESKTOP_TEST \
    "$OUT/AppDelegate.swift" "$ROOT/tests/desktop/popout-window-tests.swift" \
    "$ROOT/desktop/DesktopDiagnostics.swift" "$ROOT/desktop/GlobalDictation.swift" \
    "$ROOT/desktop/WebContentPolicy.swift" "$ROOT/desktop/WebContentWatchdog.swift" \
    "$ROOT/desktop/LinkPolicy.swift" "$ROOT/desktop/SessionHost.swift" \
    "$ROOT/desktop/CalendarBridge.swift" "$ROOT/desktop/ReaderBridge.swift" \
    "$ROOT/desktop/BundledRuntime.swift" "$ROOT/desktop/AppUpdateMachine.swift" \
    "$ROOT/desktop/AppUpdater.swift" "$ROOT/desktop/AppUpdateBridge.swift" \
    "$ROOT/desktop/AppLink.swift" "$ROOT/desktop/CommandLineTool.swift" \
    "$ROOT/src/data/walnut-calendar.swift" "$ROOT/src/data/walnut-reader.swift" \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -framework Security \
    -o "$OUT/popout-tests"
"$OUT/popout-tests" | tee "$OUT/result.log"
grep -q 'PopoutWindowTests: .* passed' "$OUT/result.log"
