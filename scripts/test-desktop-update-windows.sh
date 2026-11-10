#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/walnut-update-window-tests.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
python3 - "$ROOT" "$OUT" <<'PY'
import pathlib, sys
root, out = map(pathlib.Path, sys.argv[1:])
source = (root / 'desktop/main.swift').read_text()
(out / 'AppDelegate.swift').write_text(source.split('// MARK: - Entry Point')[0])
source = (root / 'desktop/AppUpdater.swift').read_text()
assert source.count('private(set) var state: AppUpdateState') == 1
source = source.replace('private(set) var state: AppUpdateState', 'var state: AppUpdateState')
start = source.index('    func install(done:')
end = source.index('    private func launchApplyScript', start)
source = source[:start] + '    var testInstallCalls = 0\n    func install(done: @escaping (Bool, Bool) -> Void) { testInstallCalls += 1; done(true, false) }\n\n' + source[end:]
(out / 'AppUpdater.swift').write_text(source)
PY
# The whole app (scripts/lib/desktop-app-sources.sh), with main.swift cut before its entry point and the updater's install stubbed.
SOURCES=()
while IFS= read -r f; do
    case "$(basename "$f")" in
        main.swift) SOURCES+=("$OUT/AppDelegate.swift") ;;
        AppUpdater.swift) SOURCES+=("$OUT/AppUpdater.swift") ;;
        *) SOURCES+=("$f") ;;
    esac
done < <(bash "$ROOT/scripts/lib/desktop-app-sources.sh" "$ROOT")
swiftc -parse-as-library -D WALNUT_APP -D WALNUT_DESKTOP_TEST \
    "${SOURCES[@]}" "$ROOT/tests/desktop/update-window-tests.swift" \
    -Xlinker -weak_framework -Xlinker AppIntents \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -framework Security -framework UserNotifications \
    -o "$OUT/update-tests"
"$OUT/update-tests" | tee "$OUT/result.log"
grep -q 'UpdateWindowTests: passed' "$OUT/result.log"
