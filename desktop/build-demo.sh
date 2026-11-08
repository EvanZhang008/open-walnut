#!/bin/bash
set -euo pipefail


SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_APP="${1:?Pass the Walnut.app whose resources Demo should carry}"
DEMO_APP="${2:?Pass where Walnut Demo.app goes}"
USES_PARENT_RELEASE=0
case "${3:-}" in
    '') ;;
    --uses-parent-release) USES_PARENT_RELEASE=1 ;;
    *) printf 'Unknown option: %s\n' "$3" >&2; exit 1 ;;
esac
case "$DEMO_APP" in
    */'Walnut Demo.app') ;;
    *) printf '%s\n' 'The output must be named Walnut Demo.app.' >&2; exit 1 ;;
esac
if [ ! -f "$PARENT_APP/Contents/Info.plist" ]; then
    printf '%s\n' 'The parent Walnut app is missing.' >&2
    exit 1
fi
rm -rf "$DEMO_APP"
mkdir -p "$DEMO_APP/Contents/MacOS" "$DEMO_APP/Contents/Resources"
ARCHS=("$(uname -m)")
if [ "${WALNUT_DEMO_UNIVERSAL:-0}" = 1 ]; then ARCHS=(arm64 x86_64); fi
for ARCH in "${ARCHS[@]}"; do
    swiftc -O -target "$ARCH-apple-macos12.0" -Xlinker -random_uuid \
        -o "$DEMO_APP/Contents/MacOS/Demo-$ARCH" \
        "$SCRIPT_DIR/DemoApp.swift" "$SCRIPT_DIR/BundledRuntime.swift" "$SCRIPT_DIR/ClaudeSignInBridge.swift" \
        "$SCRIPT_DIR/QuietKeyWindow.swift" "$SCRIPT_DIR/WebContentProcess.swift" \
        -framework Cocoa -framework WebKit
done
if [ "${#ARCHS[@]}" = 2 ]; then
    lipo -create "$DEMO_APP/Contents/MacOS/Demo-arm64" "$DEMO_APP/Contents/MacOS/Demo-x86_64" -output "$DEMO_APP/Contents/MacOS/Walnut Demo"
else
    mv "$DEMO_APP/Contents/MacOS/Demo-${ARCHS[0]}" "$DEMO_APP/Contents/MacOS/Walnut Demo"
fi
for ARCH in "${ARCHS[@]}"; do rm -f "$DEMO_APP/Contents/MacOS/Demo-$ARCH"; done
cp "$PARENT_APP/Contents/Resources/install.sh" "$DEMO_APP/Contents/Resources/install.sh"
if [ "$USES_PARENT_RELEASE" = 0 ] && [ -d "$PARENT_APP/Contents/Resources/release" ]; then
    ditto "$PARENT_APP/Contents/Resources/release" "$DEMO_APP/Contents/Resources/release"
fi
if [ -f "$PARENT_APP/Contents/Resources/AppIcon.icns" ]; then
    cp "$PARENT_APP/Contents/Resources/AppIcon.icns" "$DEMO_APP/Contents/Resources/AppIcon.icns"
fi
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PARENT_APP/Contents/Info.plist")"
/usr/bin/plutil -create xml1 "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleName -string 'Walnut Demo' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleDisplayName -string 'Walnut Demo' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleIdentifier -string 'com.local.walnut-demo' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleExecutable -string 'Walnut Demo' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundlePackageType -string 'APPL' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleVersion -string "$VERSION" "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleShortVersionString -string "$VERSION" "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleIconFile -string 'AppIcon' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert LSMinimumSystemVersion -string '12.0' "$DEMO_APP/Contents/Info.plist"
/usr/bin/plutil -insert NSAppTransportSecurity -json '{"NSAllowsLocalNetworking":true}' "$DEMO_APP/Contents/Info.plist"
# Demo's own scheme for Walnut.app's Open Demo and Reset Demo (DemoCommand). Never
# open-walnut: those links belong to the real Walnut. A reset through it only asks.
/usr/bin/plutil -insert CFBundleURLTypes -json '[{"CFBundleURLName":"Walnut Demo command","CFBundleURLSchemes":["walnut-demo"]}]' "$DEMO_APP/Contents/Info.plist"
if [ -n "${WALNUT_SIGN_IDENTITY:-}" ] && [ "$WALNUT_SIGN_IDENTITY" != '-' ]; then
    KEYCHAIN_ARGS=()
    [ -n "${WALNUT_SIGN_KEYCHAIN:-}" ] && KEYCHAIN_ARGS=(--keychain "$WALNUT_SIGN_KEYCHAIN")
    codesign --force --options runtime --timestamp "${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"}" --sign "$WALNUT_SIGN_IDENTITY" "$DEMO_APP"
else
    codesign --force --sign - "$DEMO_APP"
fi
codesign --verify --strict "$DEMO_APP"
printf 'Built: %s\n' "$DEMO_APP"
