#!/bin/bash
# Build walnut-net (native/walnut-net, Rust): the host network connector each daemon runs
# (src/providers/net-core.ts). Output: dist/daemon-binaries/walnut-net-<platform>-<arch>,
# beside the daemon binaries, where the daemon looks for it.
#
# Needs cargo (https://rustup.rs). Without it this prints why and exits 0: a daemon with
# no local build downloads the pinned release build instead (src/providers/net-binary.ts;
# releases: .github/workflows/walnut-net.yml). WALNUT_REQUIRE_NET=1 makes a miss fatal.
#
# The build output lives outside the checkout (WALNUT_NET_TARGET_DIR, default
# ~/.cache/walnut-net-target), so a deploy from a fresh clone builds incrementally.
set -euo pipefail
cd "$(dirname "$0")/.."

CARGO=""
if command -v cargo >/dev/null 2>&1; then CARGO=cargo
elif [ -x "$HOME/.cargo/bin/cargo" ]; then CARGO="$HOME/.cargo/bin/cargo"
fi
if [ -z "$CARGO" ]; then
  echo "build-walnut-net.sh: no cargo found; skipping walnut-net (install Rust from https://rustup.rs for the host network)" >&2
  if [ "${WALNUT_REQUIRE_NET:-0}" = 1 ]; then echo "build-walnut-net.sh: WALNUT_REQUIRE_NET=1 is set, so this is fatal" >&2; exit 1; fi
  exit 0
fi

case "$(uname -s)" in Darwin) PLATFORM=darwin ;; Linux) PLATFORM=linux ;; *) echo "build-walnut-net.sh: $(uname -s) is not supported yet" >&2; exit 0 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "build-walnut-net.sh: $(uname -m) is not supported yet" >&2; exit 0 ;; esac

export CARGO_TARGET_DIR="${WALNUT_NET_TARGET_DIR:-$HOME/.cache/walnut-net-target}"
OUTDIR=dist/daemon-binaries
mkdir -p "$OUTDIR"
if ! "$CARGO" build --release --locked --manifest-path native/walnut-net/Cargo.toml; then
  echo "build-walnut-net.sh: cargo build failed" >&2
  if [ "${WALNUT_REQUIRE_NET:-0}" = 1 ]; then exit 1; fi
  exit 0
fi
OUT="$OUTDIR/walnut-net-$PLATFORM-$ARCH"
cp "$CARGO_TARGET_DIR/release/walnut-net" "$OUT.tmp" && chmod 755 "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"
"$OUT" --version
