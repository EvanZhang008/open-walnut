#!/bin/bash
# Build the prebuilt dtach the npm package ships for the session terminal.
#
# Usage:
#   bash scripts/build-dtach.sh [outdir]     # default outdir: dist/daemon-binaries
#   bash scripts/build-dtach.sh --print-hash # print the vendored-source hash only
#
# Output (host platform only, plus the other Mac arch when building on a Mac):
#   <outdir>/dtach-<platform>-<arch>              stripped, `--help` verified
#   <outdir>/dtach-<platform>-<arch>.source-hash  sha256 of vendor/dtach sources
#
# Why: the terminal runs each shell under dtach so it survives a disconnect. A Mac
# without the Xcode Command Line Tools can't compile the vendored source, so the
# maintainer's build (which has cc) compiles it once and the tarball ships the
# result. The runtime copies it into place and verifies it before trusting it
# (src/web/terminal/dtach-prebuilt.ts); compiling on the target stays the fallback.
#
# The sidecar is deliberately NOT named `.version`: daemon-version-check.ts and
# daemon-source.ts read EVERY `*.version` in dist/daemon-binaries as the daemon's
# own version, so a dtach hash there would read as a stale daemon build.
#
# Never fails the build: no compiler, an unsupported platform or a failed compile
# prints one info line and exits 0. scripts/check-publish.mjs is the gate that
# refuses to publish without the Mac prebuilt.
set -u

cd "$(dirname "$0")/.."

VENDOR="vendor/dtach"
# Same order and framing as the daemon hash in build-daemon.sh: name NUL content NUL.
FILES=(attach.c main.c master.c dtach.h config.h)
C_FILES=(attach.c main.c master.c)

if command -v sha256sum >/dev/null 2>&1; then
  HASHER="sha256sum"
else
  HASHER="shasum -a 256"
fi

source_hash() {
  for f in "${FILES[@]}"; do
    [ -f "$VENDOR/$f" ] || { echo "build-dtach.sh: missing $VENDOR/$f" >&2; return 1; }
    printf '%s\0' "$f"
    cat "$VENDOR/$f"
    printf '\0'
  done | $HASHER | cut -c1-64
}

if [ "${1:-}" = "--print-hash" ]; then
  source_hash
  exit $?
fi

info() { echo "build-dtach.sh: $*" >&2; }

OUTDIR="${1:-dist/daemon-binaries}"

case "$(uname -s 2>/dev/null)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) info "no prebuilt dtach for $(uname -s 2>/dev/null) (the terminal compiles it on demand)."; exit 0 ;;
esac
case "$(uname -m 2>/dev/null)" in
  x86_64|amd64) HOST_ARCH=x64 ;;
  arm64|aarch64) HOST_ARCH=arm64 ;;
  *) info "no prebuilt dtach for $(uname -m 2>/dev/null) (the terminal compiles it on demand)."; exit 0 ;;
esac

# A Mac's /usr/bin/cc is a stub until the Command Line Tools exist, so "found on
# PATH" is not enough: the compiler must answer --version.
CC_BIN=""
for c in cc clang gcc; do
  if command -v "$c" >/dev/null 2>&1 && "$c" --version >/dev/null 2>&1; then CC_BIN="$c"; break; fi
done
if [ -z "$CC_BIN" ]; then
  info "no C compiler on this machine, skipping the prebuilt dtach (the terminal compiles it on demand)."
  exit 0
fi

HASH="$(source_hash)" || { info "cannot hash the vendored dtach source, skipping the prebuilt."; exit 0; }
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t walnut-dtach)" || { info "mktemp failed, skipping the prebuilt dtach."; exit 0; }
trap 'rm -rf "$WORK"' EXIT
for f in "${FILES[@]}"; do cp "$VENDOR/$f" "$WORK/"; done
mkdir -p "$OUTDIR" || { info "cannot create $OUTDIR, skipping the prebuilt dtach."; exit 0; }

# True when $1 is a working dtach. The exact banner, not just "dtach": a file the
# kernel can't exec falls back to sh, whose error line names the file.
is_dtach() { "$1" --help 2>&1 | grep -q 'dtach - version'; }
arch_matches() {
  # A cross-built Mac arch can't always run here (no Rosetta), so check the slice.
  command -v lipo >/dev/null 2>&1 && lipo -archs "$1" 2>/dev/null | grep -qw "$2"
}

# build_one <arch> [extra cc flags...]
build_one() {
  local arch="$1"; shift
  local name="dtach-$PLATFORM-$arch"
  local out="$WORK/$name"
  local log="$WORK/$name.log"
  if [ "$PLATFORM" = linux ]; then
    # Static first: a binary linked against a new glibc (CI) refuses to start on
    # an older one (glibc 2.26 dev hosts). Fall back to dynamic without static libs.
    (cd "$WORK" && "$CC_BIN" -O2 -I. -static -o "$out" "${C_FILES[@]}" -lutil) >"$log" 2>&1 \
      || (cd "$WORK" && "$CC_BIN" -O2 -I. -o "$out" "${C_FILES[@]}" -lutil) >"$log" 2>&1
  else
    (cd "$WORK" && "$CC_BIN" -O2 -I. "$@" -o "$out" "${C_FILES[@]}" -lutil) >"$log" 2>&1
  fi || { info "compiling $name failed, skipping it: $(tail -n 3 "$log" | tr '\n' ' ')"; return 1; }
  if command -v strip >/dev/null 2>&1; then strip "$out" 2>/dev/null || true; fi
  if [ "$PLATFORM" = darwin ] && command -v codesign >/dev/null 2>&1; then
    # strip keeps the linker's ad hoc signature today; re-sign if it ever doesn't,
    # because Apple Silicon kills an unsigned binary on exec.
    codesign --verify "$out" 2>/dev/null || codesign --force --sign - "$out" 2>/dev/null || true
  fi
  local lipo_arch="$arch"; [ "$arch" = x64 ] && lipo_arch=x86_64
  if ! is_dtach "$out"; then
    if [ "$arch" = "$HOST_ARCH" ] || ! arch_matches "$out" "$lipo_arch"; then
      info "$name failed its --help check, skipping it."
      return 1
    fi
  fi
  chmod 755 "$out"
  mv -f "$out" "$OUTDIR/$name" && echo "$HASH" > "$OUTDIR/$name.source-hash" && chmod 644 "$OUTDIR/$name.source-hash" \
    || { info "cannot write $OUTDIR/$name"; return 1; }
  echo "build-dtach.sh: built $OUTDIR/$name ($(wc -c < "$OUTDIR/$name" | tr -d ' ') bytes)"
}

if [ "$PLATFORM" = darwin ]; then
  # Both Mac arches from one Mac: clang cross-builds with -arch, so an Intel Mac
  # needs no compiler either.
  build_one arm64 -arch arm64 || true
  build_one x64 -arch x86_64 || true
else
  build_one "$HOST_ARCH" || true
fi
exit 0
