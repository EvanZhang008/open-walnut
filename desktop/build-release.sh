#!/bin/bash
set -euo pipefail

# Distributable build: universal binary (arm64 + x86_64), packaged into a DMG
# with an /Applications drag target. For a quick local dev build, use build.sh.
#
# Signed with a Developer ID Application identity when there is one (ad-hoc
# otherwise), with the hardened runtime and desktop/Walnut.entitlements, which
# notarization requires. Knobs (the release workflow, .github/workflows/mac-app.yml,
# sets them all):
#   WALNUT_APP_VERSION            CFBundleShortVersionString (default: package.json)
#   WALNUT_SIGN_IDENTITY          the identity to use, instead of searching
#   WALNUT_SIGN_KEYCHAIN          the keychain that holds it
#   WALNUT_REQUIRE_DEVELOPER_ID=1 fail rather than fall back to ad-hoc
#   WALNUT_NOTARY_KEY, WALNUT_NOTARY_KEY_ID, WALNUT_NOTARY_ISSUER
#                                 an App Store Connect API key (.p8 path, key id,
#                                 issuer id): notarize and staple the app, then
#                                 the DMG

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Walnut"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
# Icon ships in the repo's web assets (source-controlled — no build required).
ICON_SRC="$SCRIPT_DIR/../web/public/walnut-icon.png"
DMG_OUT="$SCRIPT_DIR/$APP_NAME.dmg"
ENTITLEMENTS="$SCRIPT_DIR/Walnut.entitlements"
# A bundle version is numbers and dots only: a nightly's "-nightly.…" goes.
APP_VERSION="${WALNUT_APP_VERSION:-$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/../package.json" | head -1)}"
APP_VERSION="${APP_VERSION%%-*}"
case "$APP_VERSION" in
    '' | *[!0-9.]*) echo "Not a version: '$APP_VERSION'" >&2; exit 1 ;;
esac

echo "=== Building $APP_NAME.app (Universal Binary) ==="

rm -rf "$APP_BUNDLE" "$DMG_OUT"
mkdir -p "$MACOS" "$RESOURCES"

# Compile for both architectures and create a universal binary
echo "Compiling for arm64..."
swiftc -O -o "$MACOS/${APP_NAME}_arm64" \
    "$SCRIPT_DIR/main.swift" "$SCRIPT_DIR/DesktopDiagnostics.swift" "$SCRIPT_DIR/GlobalDictation.swift" \
    "$SCRIPT_DIR/WebContentPolicy.swift" "$SCRIPT_DIR/WebContentWatchdog.swift" "$SCRIPT_DIR/LinkPolicy.swift" \
    "$SCRIPT_DIR/SessionHost.swift" "$SCRIPT_DIR/CalendarBridge.swift" "$SCRIPT_DIR/ReaderBridge.swift" \
    "$SCRIPT_DIR/BundledRuntime.swift" \
    "$SCRIPT_DIR/../src/data/walnut-calendar.swift" "$SCRIPT_DIR/../src/data/walnut-reader.swift" -D WALNUT_APP \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -target arm64-apple-macos12.0

echo "Compiling for x86_64..."
swiftc -O -o "$MACOS/${APP_NAME}_x86_64" \
    "$SCRIPT_DIR/main.swift" "$SCRIPT_DIR/DesktopDiagnostics.swift" "$SCRIPT_DIR/GlobalDictation.swift" \
    "$SCRIPT_DIR/WebContentPolicy.swift" "$SCRIPT_DIR/WebContentWatchdog.swift" "$SCRIPT_DIR/LinkPolicy.swift" \
    "$SCRIPT_DIR/SessionHost.swift" "$SCRIPT_DIR/CalendarBridge.swift" "$SCRIPT_DIR/ReaderBridge.swift" \
    "$SCRIPT_DIR/BundledRuntime.swift" \
    "$SCRIPT_DIR/../src/data/walnut-calendar.swift" "$SCRIPT_DIR/../src/data/walnut-reader.swift" -D WALNUT_APP \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Carbon -framework EventKit -target x86_64-apple-macos12.0

echo "Creating universal binary..."
lipo -create "$MACOS/${APP_NAME}_arm64" "$MACOS/${APP_NAME}_x86_64" \
    -output "$MACOS/$APP_NAME"
rm "$MACOS/${APP_NAME}_arm64" "$MACOS/${APP_NAME}_x86_64"

lipo -archs "$MACOS/$APP_NAME"

# The installer a first launch runs (BundledRuntime.swift): the same install.sh
# every release attaches, so the app and `curl … | sh` install the same way.
cp "$SCRIPT_DIR/../scripts/install.sh" "$RESOURCES/install.sh"
chmod 755 "$RESOURCES/install.sh"

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
    <string>@APP_VERSION@</string>
    <key>CFBundleShortVersionString</key>
    <string>@APP_VERSION@</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>Walnut</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
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
sed -i '' "s/@APP_VERSION@/$APP_VERSION/g" "$CONTENTS/Info.plist"

# Create .icns from the PNG icon — first rounding it into the macOS Big Sur
# icon shape (824pt squircle on a transparent 1024 canvas), so it sits in the
# Dock like every other app instead of a full-bleed square.
if [ -f "$ICON_SRC" ]; then
    echo "Creating app icon..."
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
fi

# Sign with a Developer ID Application identity when one exists, falling back
# to ad-hoc. macOS ties permission grants (microphone TCC) to the signing
# identity, so a real one keeps grants across updates.
# DISTRIBUTABLE build: only "Developer ID Application" is acceptable — never an
# "Apple Development" cert. A Development cert buys other users nothing (it is
# not a Gatekeeper-trusted distribution identity), and it is an active hazard:
# it expires yearly, and an expired/revoked identity makes the app refuse to
# launch on EVERY user's machine behind a misleading "can't use this version of
# the application" alert. Ad-hoc never expires, so it is the safer fallback.
# A REVOKED certificate is still checked for below (sign, then assess).
# (`|| true`: grep exits 1 on no-match, which set -euo pipefail would fatal.)
KEYCHAIN_ARGS=()
[ -n "${WALNUT_SIGN_KEYCHAIN:-}" ] && KEYCHAIN_ARGS=(--keychain "$WALNUT_SIGN_KEYCHAIN")
if [ -n "${WALNUT_SIGN_IDENTITY:-}" ]; then
    CANDIDATES="$WALNUT_SIGN_IDENTITY"
else
    CANDIDATES=$(security find-identity -v -p codesigning ${WALNUT_SIGN_KEYCHAIN:+"$WALNUT_SIGN_KEYCHAIN"} 2>/dev/null \
        | { grep -o '"Developer ID Application[^"]*"' || true; } | tr -d '"')
fi

SIGNED_WITH=""
while IFS= read -r ID; do
    [ -n "$ID" ] || continue
    # The hardened runtime and a secure timestamp: notarization takes nothing less.
    if ! codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
            "${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"}" --sign "$ID" "$APP_BUNDLE"; then
        echo "  Skipping identity (codesign failed): $ID"
        continue
    fi
    # Only CERTIFICATE TRUST failures (CSSMERR_*: revoked, expired) make an app
    # unlaunchable. "rejected (Unnotarized Developer ID)" is expected until it
    # is notarized below.
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
    if [ "${WALNUT_REQUIRE_DEVELOPER_ID:-}" = 1 ]; then
        echo "No usable Developer ID Application identity, and WALNUT_REQUIRE_DEVELOPER_ID=1." >&2
        exit 1
    fi
    echo "No Developer ID Application certificate — ad-hoc signing."
    echo "  Recipients will hit Gatekeeper on first open (right-click → Open, or"
    echo "  xattr -dr com.apple.quarantine Walnut.app). This is expected and safe;"
    echo "  an Apple Development cert is deliberately NOT used here (see above)."
    codesign --force --sign - "$APP_BUNDLE"
fi
codesign --verify --strict --verbose=2 "$APP_BUNDLE"

# notarize <file>: submit to Apple's notary service and wait; print its log and
# fail when it is not accepted.
notarize() {
    local file="$1" out id
    out=$(xcrun notarytool submit "$file" --key "$WALNUT_NOTARY_KEY" --key-id "$WALNUT_NOTARY_KEY_ID" \
        --issuer "$WALNUT_NOTARY_ISSUER" --wait --timeout 45m --output-format json) || true
    echo "$out"
    case "$out" in
        *'"status":"Accepted"'*) ;;
        *)
            id=$(printf '%s' "$out" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
            if [ -n "$id" ]; then
                xcrun notarytool log "$id" --key "$WALNUT_NOTARY_KEY" \
                    --key-id "$WALNUT_NOTARY_KEY_ID" --issuer "$WALNUT_NOTARY_ISSUER" || true
            fi
            echo "Notarization of $(basename "$file") was not accepted." >&2
            return 1 ;;
    esac
}
NOTARIZE=""
if [ -n "${WALNUT_NOTARY_KEY:-}" ]; then
    [ -n "$SIGNED_WITH" ] || { echo "Notarization needs a Developer ID signature." >&2; exit 1; }
    NOTARIZE=1
    echo ""
    echo "=== Notarizing $APP_NAME.app ==="
    APP_ZIP="$SCRIPT_DIR/.notarize-$APP_NAME.zip"
    rm -f "$APP_ZIP"
    ditto -c -k --keepParent "$APP_BUNDLE" "$APP_ZIP"
    notarize "$APP_ZIP"
    rm -f "$APP_ZIP"
    # The ticket goes into the app too, so a copy dragged out of the DMG opens offline.
    xcrun stapler staple "$APP_BUNDLE"
fi

echo ""
echo "=== Creating DMG ==="
# Create a DMG with the app and a symlink to /Applications
DMG_TEMP="$SCRIPT_DIR/dmg_staging"
rm -rf "$DMG_TEMP"
mkdir -p "$DMG_TEMP"
# ditto keeps the signature, the stapled ticket and every attribute as they are.
ditto "$APP_BUNDLE" "$DMG_TEMP/$APP_NAME.app"
ln -s /Applications "$DMG_TEMP/Applications"

hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDZO \
    "$DMG_OUT" > /dev/null

rm -rf "$DMG_TEMP"

if [ -n "$SIGNED_WITH" ]; then
    codesign --force --timestamp "${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"}" --sign "$SIGNED_WITH" "$DMG_OUT"
fi
if [ -n "$NOTARIZE" ]; then
    echo ""
    echo "=== Notarizing $APP_NAME.dmg ==="
    notarize "$DMG_OUT"
    xcrun stapler staple "$DMG_OUT"
    # What Gatekeeper decides for a DMG a browser downloaded.
    spctl -a -vv -t open --context context:primary-signature "$DMG_OUT"
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Distributable: $DMG_OUT"
echo "Size: $(du -h "$DMG_OUT" | cut -f1)"
echo "Version: $APP_VERSION"
echo "Signed with: ${SIGNED_WITH:-ad-hoc}${NOTARIZE:+, notarized and stapled}"
echo ""
echo "Users open the DMG and drag Walnut.app into Applications."
