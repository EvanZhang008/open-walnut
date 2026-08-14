#!/bin/bash
set -euo pipefail

# Distributable build: universal binary (arm64 + x86_64), ad-hoc code-signed,
# packaged into a DMG with an /Applications drag target. For a quick local
# dev build, use build.sh instead.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Walnut"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
# Icon ships in the repo's web assets (source-controlled — no build required).
ICON_SRC="$SCRIPT_DIR/../web/public/walnut-icon.png"
DMG_OUT="$SCRIPT_DIR/$APP_NAME.dmg"

echo "=== Building $APP_NAME.app (Universal Binary) ==="

rm -rf "$APP_BUNDLE" "$DMG_OUT"
mkdir -p "$MACOS" "$RESOURCES"

# Compile for both architectures and create a universal binary
echo "Compiling for arm64..."
swiftc -O -o "$MACOS/${APP_NAME}_arm64" "$SCRIPT_DIR/main.swift" \
    -framework Cocoa -framework WebKit -target arm64-apple-macos12.0

echo "Compiling for x86_64..."
swiftc -O -o "$MACOS/${APP_NAME}_x86_64" "$SCRIPT_DIR/main.swift" \
    -framework Cocoa -framework WebKit -target x86_64-apple-macos12.0

echo "Creating universal binary..."
lipo -create "$MACOS/${APP_NAME}_arm64" "$MACOS/${APP_NAME}_x86_64" \
    -output "$MACOS/$APP_NAME"
rm "$MACOS/${APP_NAME}_arm64" "$MACOS/${APP_NAME}_x86_64"

lipo -archs "$MACOS/$APP_NAME"

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
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

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

# Ad-hoc code sign (allows the app to run without an Apple Developer ID)
echo "Ad-hoc code signing..."
codesign --force --deep --sign - "$APP_BUNDLE"

echo ""
echo "=== Creating DMG ==="
# Create a DMG with the app and a symlink to /Applications
DMG_TEMP="$SCRIPT_DIR/dmg_staging"
rm -rf "$DMG_TEMP"
mkdir -p "$DMG_TEMP"
cp -r "$APP_BUNDLE" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"

hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDZO \
    "$DMG_OUT" > /dev/null

rm -rf "$DMG_TEMP"

echo ""
echo "=== Done! ==="
echo ""
echo "Distributable: $DMG_OUT"
echo "Size: $(du -h "$DMG_OUT" | cut -f1)"
echo ""
echo "Users open the DMG and drag Walnut.app into Applications."
