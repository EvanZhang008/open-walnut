#!/bin/bash
set -euo pipefail
# The Mac app's pop-out windows against a live Walnut page (macOS only: AppKit, WebKit).
# Point it at a test server and a session in it (WALNUT_TEST_PORT, WALNUT_TEST_SESSION),
# or name neither: it then starts the browser suite's fixture server (temp data, mock CLI)
# and one session there, as the nightly run does (.github/workflows/nightly-extra-tests.yml).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/walnut-popout-tests.XXXXXX")"
FIXTURE=""
cleanup() {
    if [ -n "$FIXTURE" ]; then kill -TERM "$FIXTURE" 2>/dev/null || true; wait "$FIXTURE" 2>/dev/null || true; fi
    rm -rf "$OUT"
}
trap cleanup EXIT
if [ -z "${WALNUT_TEST_PORT:-}" ]; then
    export WALNUT_TEST_PORT=3545
    PW_TEST_PORT="$WALNUT_TEST_PORT" bun "$ROOT/tests/e2e/browser/test-server.ts" > "$OUT/fixture.log" 2>&1 &
    FIXTURE=$!
    for _ in $(seq 1 180); do
        curl -sf "http://localhost:$WALNUT_TEST_PORT/api/dashboard" > /dev/null && break
        sleep 1
    done
    WALNUT_TEST_SESSION="$(bun "$ROOT/scripts/lib/desktop-popout-session.mjs" "$WALNUT_TEST_PORT")" || { tail -n 40 "$OUT/fixture.log"; exit 1; }
    export WALNUT_TEST_SESSION
fi
: "${WALNUT_TEST_SESSION:?Choose a session in that server}"
if [ "$WALNUT_TEST_PORT" = 3456 ]; then
    exit 1
fi
python3 - "$ROOT/desktop/main.swift" "$OUT/AppDelegate.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
pathlib.Path(sys.argv[2]).write_text(source.split('// MARK: - Entry Point')[0])
PY
# The whole app (scripts/lib/desktop-app-sources.sh), with main.swift cut before its entry point.
SOURCES=()
while IFS= read -r f; do
    case "$(basename "$f")" in
        main.swift) SOURCES+=("$OUT/AppDelegate.swift") ;;
        *) SOURCES+=("$f") ;;
    esac
done < <(bash "$ROOT/scripts/lib/desktop-app-sources.sh" "$ROOT")
swiftc -parse-as-library -D WALNUT_APP -D WALNUT_DESKTOP_TEST \
    "${SOURCES[@]}" "$ROOT/tests/desktop/popout-window-tests.swift" \
    -Xlinker -weak_framework -Xlinker AppIntents \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -framework Security -framework UserNotifications \
    -o "$OUT/popout-tests"
"$OUT/popout-tests" | tee "$OUT/result.log"
grep -q 'PopoutWindowTests: .* passed' "$OUT/result.log"
