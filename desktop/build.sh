#!/bin/bash
set -euo pipefail

# Fast single-architecture build (native arch of the build machine). Good for
# local development / testing. For a distributable universal binary + DMG, use
# build-release.sh instead.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Walnut"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
# Icon ships in the repo's web assets (source-controlled — no build required).
ICON_SRC="$SCRIPT_DIR/../web/public/walnut-icon.png"

echo "Building $APP_NAME.app..."

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS" "$RESOURCES"

# Compile the Swift source
swiftc -O -o "$MACOS/$APP_NAME" \
    "$SCRIPT_DIR/main.swift" "$SCRIPT_DIR/DesktopDiagnostics.swift" \
    -framework Cocoa -framework WebKit

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Walnut</string>
    <key>CFBundleDisplayName</key>
    <string>Walnut</string>
    <key>CFBundleIdentifier</key>
    <string>com.local.walnut-desktop</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>Walnut</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
    <!-- Without this key WKWebView hides navigator.mediaDevices entirely,
         which silently removes the web console's voice-input mic button. -->
    <key>NSMicrophoneUsageDescription</key>
    <string>Walnut uses the microphone for voice input (speech-to-text).</string>
    <!-- The calendar view shells out to the walnut-calendar EventKit helper, but
         TCC attributes that request to the RESPONSIBLE process — this app bundle
         — not to the helper binary. Without these keys tccd refuses the request
         outright ("Refusing authorization request ... without
         NSCalendarsUsageDescription key"): no prompt appears, and a Full Access
         toggle already granted to `node` is never consulted. macOS 14+ wants the
         Full Access variant; the legacy key must ALSO be present or the request
         is refused before the variant is read. -->
    <key>NSCalendarsUsageDescription</key>
    <string>Walnut shows and edits your Mac calendar events alongside your tasks.</string>
    <key>NSCalendarsFullAccessUsageDescription</key>
    <string>Walnut shows and edits your Mac calendar events alongside your tasks.</string>
</dict>
</plist>
EOF

# Create .icns from the PNG icon — first rounding it into the macOS Big Sur
# icon shape (824pt squircle on a transparent 1024 canvas), so it sits in the
# Dock like every other app instead of a full-bleed square.
if [ -f "$ICON_SRC" ]; then
    echo "Creating app icon from walnut-icon.png..."
    ROUNDED_ICON="$SCRIPT_DIR/.icon-rounded.png"
    if swift "$SCRIPT_DIR/make-icon.swift" "$ICON_SRC" "$ROUNDED_ICON" 2>/dev/null; then
        ICON_SRC="$ROUNDED_ICON"
    else
        echo "  Warning: icon rounding failed, using the square source."
    fi
    ICONSET="$SCRIPT_DIR/AppIcon.iconset"
    mkdir -p "$ICONSET"
    sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      > /dev/null 2>&1
    sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   > /dev/null 2>&1
    sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      > /dev/null 2>&1
    sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   > /dev/null 2>&1
    sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    > /dev/null 2>&1
    sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" > /dev/null 2>&1
    sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    > /dev/null 2>&1
    sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" > /dev/null 2>&1
    sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    > /dev/null 2>&1
    sips -z 1024 1024 "$ICON_SRC" --out "$ICONSET/icon_512x512@2x.png" > /dev/null 2>&1
    iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"
    rm -rf "$ICONSET"
    echo "  Icon created."
else
    echo "  Warning: walnut-icon.png not found at $ICON_SRC, skipping icon."
fi

# Sign with a real identity when one exists (Developer ID > Apple Development),
# falling back to ad-hoc. This matters beyond Gatekeeper: macOS ties permission
# grants (microphone TCC) to the signing identity. Ad-hoc identity = the binary
# hash, so EVERY rebuild looked like a brand-new app and re-prompted for the
# mic. A certificate identity is stable across rebuilds — grant once, keep it.
# A REVOKED certificate is worse than no certificate: macOS refuses to launch
# the app with a misleading "can't use this version of the application" alert
# (and may quarantine it), so every candidate is signed then verified, and we
# fall back to ad-hoc unless the result actually passes assessment.
# (`|| true`: grep exits 1 on no-match, which set -euo pipefail would fatal.)
CANDIDATES=$(security find-identity -v -p codesigning 2>/dev/null \
    | { grep -o '"\(Developer ID Application\|Apple Development\)[^"]*"' || true; } | tr -d '"')

SIGNED_WITH=""
while IFS= read -r ID; do
    [ -n "$ID" ] || continue
    if ! codesign --force --sign "$ID" "$APP_BUNDLE" 2>/dev/null; then
        echo "  Skipping identity (codesign failed): $ID"
        continue
    fi
    # Only CERTIFICATE TRUST failures (CSSMERR_*: revoked, expired) make an app
    # unlaunchable. A plain "rejected" is expected for an Apple Development
    # cert — that assesses *distribution*, and the app still runs locally with
    # a stable identity, which is all the TCC grant needs.
    ASSESS=$(spctl -a -vv "$APP_BUNDLE" 2>&1 || true)
    case "$ASSESS" in
        *CSSMERR*)
            echo "  Skipping unusable identity: $ID ($ASSESS)" ;;
        *)
            SIGNED_WITH="$ID"
            echo "Code signing with: $ID"
            break ;;
    esac
done <<< "$CANDIDATES"

if [ -z "$SIGNED_WITH" ]; then
    echo "No usable signing identity — ad-hoc signing (permission prompts repeat after each rebuild)."
    codesign --force --sign - "$APP_BUNDLE"
fi

echo ""
echo "Done! Built: $APP_BUNDLE"
echo ""
echo "To install to ~/Applications:"
echo "  cp -r \"$APP_BUNDLE\" ~/Applications/"
echo ""
echo "Or launch directly:"
echo "  open \"$APP_BUNDLE\""
