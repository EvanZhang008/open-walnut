#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${WALNUT_RECENT_BUILD:?Build directory required}"
mkdir -p "$OUT"
python3 - "$ROOT/desktop/main.swift" "$OUT/AppDelegate.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
source = source.split('// MARK: - Entry Point')[0]
# Same app shell, with a test-owned WebKit store: no real window or browser cache.
source = source.replace('let config = WKWebViewConfiguration()\n        config.preferences.setValue', 'let config = WKWebViewConfiguration()\n        config.websiteDataStore = .nonPersistent()\n        config.preferences.setValue')
pathlib.Path(sys.argv[2]).write_text(source)
PY
cp "$ROOT/tests/desktop/recent-human-touch-tests.swift" "$OUT/RecentTests.swift"
# The whole app (scripts/lib/desktop-app-sources.sh), with main.swift cut before its entry point.
SOURCES=()
while IFS= read -r f; do
    case "$(basename "$f")" in
        main.swift) SOURCES+=("$OUT/AppDelegate.swift") ;;
        *) SOURCES+=("$f") ;;
    esac
done < <(bash "$ROOT/scripts/lib/desktop-app-sources.sh" "$ROOT")
swiftc -j 1 -parse-as-library -D WALNUT_APP -D WALNUT_DESKTOP_TEST \
    "${SOURCES[@]}" "$OUT/RecentTests.swift" \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -framework Security -framework UserNotifications -Xlinker -weak_framework -Xlinker AppIntents \
    -o "$OUT/recent-tests"

# Native framework calls require a bundle identity, even for an activation-prohibited test app.
APP="$OUT/RecentTests.app/Contents"
mkdir -p "$APP/MacOS"
cp "$OUT/recent-tests" "$APP/MacOS/RecentTests"
cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.open-walnut.recent-tests</string>
<key>CFBundleName</key><string>Recent Tests</string>
<key>CFBundleExecutable</key><string>RecentTests</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
