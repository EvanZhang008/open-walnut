#!/usr/bin/env bash
# Build libwalnut_connect.a for the iOS app, as the Walnut target's first build phase
# (ios-native/project.yml) or by hand:
#
#   native/walnut-connect/build-apple.sh <platform> <archs> <out dir>
#     platform  iphoneos | iphonesimulator   (Xcode's PLATFORM_NAME)
#     archs     "arm64" | "arm64 x86_64"     (Xcode's ARCHS)
#     out dir   where libwalnut_connect.a goes (the app links it from there)
#
# With cargo and Rust's targets for that platform installed (rustup target add
# aarch64-apple-ios aarch64-apple-ios-sim), it builds the real library (iroh). Without
# them it builds the stub (stub/walnut_connect_stub.c): the app works, with no Walnut
# Connect route. A device Release build (what TestFlight and the App Store get) refuses the
# stub, as WALNUT_CONNECT_REQUIRE=1 does for any build; WALNUT_CONNECT_STUB=1 always builds
# the stub, the shipped kind included.
# `kind` beside the library says which one it is: real or stub.
set -euo pipefail

platform=${1:?platform}
archs=${2:?archs}
out=${3:?out dir}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
lib="$out/libwalnut_connect.a"

triple() {
  case "$platform/$1" in
    iphoneos/arm64) echo aarch64-apple-ios ;;
    iphonesimulator/arm64) echo aarch64-apple-ios-sim ;;
    iphonesimulator/x86_64) echo x86_64-apple-ios ;;
    *) echo "walnut-connect: no Rust target for $platform $1" >&2; return 1 ;;
  esac
}

# Xcode's environment is for the app's platform; cargo's build scripts are built for this Mac.
# Its SDK and deployment variables would point them at the iOS SDK, so they go.
clean_env=(env -u SDKROOT -u IPHONEOS_DEPLOYMENT_TARGET -u MACOSX_DEPLOYMENT_TARGET -u PLATFORM_NAME -u ARCHS
  -u LD -u CC -u CXX -u LDFLAGS -u CFLAGS -u CPPFLAGS -u OTHER_LDFLAGS -u TOOLCHAINS
  PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")

# A build that ships: the real library or nothing.
required() {
  [ "${WALNUT_CONNECT_STUB:-}" = 1 ] && return 1
  [ "${WALNUT_CONNECT_REQUIRE:-}" = 1 ] && return 0
  [ "$platform" = iphoneos ] && [ "${CONFIGURATION:-}" = Release ]
}

targets_hint() {
  local t=()
  for a in $archs; do t+=("$(triple "$a" 2>/dev/null || echo "$a")"); done
  echo "rustup target add ${t[*]}"
}

real_ok() {
  [ "${WALNUT_CONNECT_STUB:-}" = 1 ] && return 1
  "${clean_env[@]}" sh -c 'command -v cargo >/dev/null && command -v rustup >/dev/null' || return 1
  local installed
  installed=$("${clean_env[@]}" rustup target list --installed 2>/dev/null) || return 1
  for a in $archs; do
    grep -qx "$(triple "$a")" <<<"$installed" || return 1
  done
}

# Each step says its own failure: `set -e` does not hold inside a function an `if` runs.
build_real() {
  local parts=()
  for a in $archs; do
    local t
    t=$(triple "$a") || return 1
    # The app's deployment target: cc-rs builds iroh's C parts (ring) for it.
    local dep="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
    "${clean_env[@]}" IPHONEOS_DEPLOYMENT_TARGET="$dep" cargo build --release --locked --lib \
      --manifest-path "$here/Cargo.toml" --target "$t" >&2 || return 1
    parts+=("${CARGO_TARGET_DIR:-$here/target}/$t/release/libwalnut_connect.a")
  done
  if [ "${#parts[@]}" -gt 1 ]; then
    xcrun lipo -create "${parts[@]}" -output "$lib.tmp" || return 1
  else
    cp "${parts[0]}" "$lib.tmp" || return 1
  fi
  mv -f "$lib.tmp" "$lib" || return 1
  echo real > "$out/kind"
}

build_stub() {
  local sdk objs=()
  sdk=$(xcrun --sdk "$platform" --show-sdk-path)
  local tmp
  tmp=$(mktemp -d)
  for a in $archs; do
    local target
    if [ "$platform" = iphoneos ]; then target="$a-apple-ios${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
    else target="$a-apple-ios${IPHONEOS_DEPLOYMENT_TARGET:-18.0}-simulator"; fi
    xcrun clang -c -O2 -target "$target" -isysroot "$sdk" -I "$here/include" \
      "$here/stub/walnut_connect_stub.c" -o "$tmp/stub-$a.o"
    objs+=("$tmp/stub-$a.o")
  done
  rm -f "$lib.tmp"
  if [ "${#objs[@]}" -gt 1 ]; then
    local libs=()
    for o in "${objs[@]}"; do xcrun libtool -static -o "$o.a" "$o"; libs+=("$o.a"); done
    xcrun lipo -create "${libs[@]}" -output "$lib.tmp"
  else
    xcrun libtool -static -o "$lib.tmp" "${objs[0]}"
  fi
  mv -f "$lib.tmp" "$lib"
  rm -rf "$tmp"
  echo stub > "$out/kind"
}

if real_ok; then
  if build_real; then
    echo "walnut-connect: built the library for $platform ($archs)"
    exit 0
  fi
  if required; then
    echo "error: walnut-connect: the Rust build failed, and this build must have Walnut Connect (above: cargo's error)" >&2
    exit 1
  fi
  build_stub
  echo "warning: walnut-connect: the Rust build failed (above), so this build has no Walnut Connect"
elif required; then
  echo "error: walnut-connect: this build must have Walnut Connect, and cargo or Rust's targets are missing. Run: $(targets_hint)" >&2
  exit 1
else
  build_stub
  echo "warning: walnut-connect: cargo or Rust's targets for $platform are not installed, so this build has no Walnut Connect ($(targets_hint))"
fi
