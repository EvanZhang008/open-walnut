# Sourced by build.sh and build-release.sh: the extra steps that list the app's Spotlight and
# Shortcuts actions (WalnutIntents.swift). Xcode does these itself; the app is built with plain
# swiftc, so they are spelled out here. The metadata processor ships only with full Xcode: on a
# Mac without it the app builds the same, and its actions are not listed (a warning says so).

# app_intents_swift_flags <obj dir>: prints, one per line, the swiftc flags that make the compiler
# write the intents' constant values and the linker the list of frameworks it used.
app_intents_swift_flags() {
    local obj="$1"
    mkdir -p "$obj"
    printf '%s\n' '["AppIntent","EntityQuery","AppEntity","TransientEntity","AppEnum","AppShortcutProviding","AppShortcutsProvider","AnyResolverProviding","AppIntentsPackage","DynamicOptionsProvider","_IntentValueRepresentable","_AssistantIntentsProvider","_GenerativeFunctionExtractable","IntentValueQuery","Resolver","AppExtension","ExtensionPointDefining"]' > "$obj/protocols.json"
    # Whole-module: one constant-values file for the module, which is what the processor reads.
    printf '%s\n' -wmo -emit-const-values-path "$obj/Walnut.swiftconstvalues" \
        -Xfrontend -const-gather-protocols-file -Xfrontend "$obj/protocols.json" \
        -Xlinker -dependency_info -Xlinker "$obj/dependency_info.dat"
}

# app_intents_metadata <app bundle> <binary> <obj dir> <target triple> <bundle id> <source files...>
# writes Contents/Resources/Metadata.appintents. Never fails the build.
app_intents_metadata() {
    local app="$1" binary="$2" obj="$3" triple="$4" bundle_id="$5"
    shift 5
    local tool sdk xcode_version
    tool=$(xcrun --find appintentsmetadataprocessor 2>/dev/null || true)
    if [ -z "$tool" ] || [ ! -x "$tool" ]; then
        echo "  Warning: appintentsmetadataprocessor not found (it comes with Xcode): the app's Spotlight actions are not listed."
        return 0
    fi
    sdk=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
    if [ -z "$sdk" ]; then
        echo "  Warning: no macOS SDK found: the app's Spotlight actions are not listed."
        return 0
    fi
    xcode_version=$( { xcodebuild -version 2>/dev/null || true; } | sed -n 's/^Build version //p' | head -1)
    # The processor matches the constants to source files by absolute path.
    : > "$obj/sources.txt"
    local f
    for f in "$@"; do
        (cd "$(dirname "$f")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$f")") >> "$obj/sources.txt"
    done
    printf '%s\n' "$obj/Walnut.swiftconstvalues" > "$obj/constvalues.txt"
    : > "$obj/metadata.txt"
    : > "$obj/static-metadata.txt"
    if "$tool" --toolchain-dir "$(dirname "$(dirname "$(dirname "$tool")")")" \
        --module-name Walnut --sdk-root "$sdk" ${xcode_version:+--xcode-version "$xcode_version"} \
        --platform-family macOS --deployment-target "${triple##*macos}" \
        --bundle-identifier "$bundle_id" --output "$app/Contents/Resources" \
        --target-triple "$triple" --binary-file "$binary" \
        --dependency-file "$obj/dependency_info.dat" \
        --stringsdata-file "$obj/ExtractedAppShortcutsMetadata.stringsdata" \
        --source-file-list "$obj/sources.txt" --metadata-file-list "$obj/metadata.txt" \
        --static-metadata-file-list "$obj/static-metadata.txt" \
        --swift-const-vals-list "$obj/constvalues.txt" \
        --compile-time-extraction --deployment-aware-processing --no-app-shortcuts-localization \
        > "$obj/metadata.log" 2>&1 && [ -d "$app/Contents/Resources/Metadata.appintents" ]; then
        echo "  Spotlight actions listed (Metadata.appintents)."
    else
        echo "  Warning: the Spotlight actions could not be listed; see $obj/metadata.log"
        tail -5 "$obj/metadata.log" | sed 's/^/    /'
    fi
    return 0
}
