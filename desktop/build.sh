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
swiftc -O -o "$MACOS/$APP_NAME" "$SCRIPT_DIR/main.swift" \
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

echo ""
echo "Done! Built: $APP_BUNDLE"
echo ""
echo "To install to ~/Applications:"
echo "  cp -r \"$APP_BUNDLE\" ~/Applications/"
echo ""
echo "Or launch directly:"
echo "  open \"$APP_BUNDLE\""
