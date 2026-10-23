#!/bin/sh
# install-rcodesign.sh <dir>
#
# Put rcodesign (apple-codesign, a static Linux build) at <dir>/rcodesign, so a
# Linux machine can give the compiled darwin-x64 file its ad-hoc signature
# (scripts/build-binary.mjs, signDarwin). macOS builds use codesign instead.
# The version and checksums are pinned; a mismatch stops the install.
set -eu

[ $# -eq 1 ] || { echo "usage: install-rcodesign.sh <dir>" >&2; exit 2; }
dir="$1"
version=0.29.0
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64; sha=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 ;;
  aarch64|arm64) arch=aarch64; sha=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f ;;
  *) echo "install-rcodesign: no build for $(uname -m)" >&2; exit 1 ;;
esac
name="apple-codesign-$version-$arch-unknown-linux-musl"
url="https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$version/$name.tar.gz"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rcodesign.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM
curl -fsSL --retry 3 -o "$tmp/r.tgz" "$url"
actual="$(sha256sum "$tmp/r.tgz" | cut -d' ' -f1)"
[ "$actual" = "$sha" ] || { echo "install-rcodesign: checksum mismatch for $name ($actual)" >&2; exit 1; }
tar -xzf "$tmp/r.tgz" -C "$tmp"
mkdir -p "$dir"
cp "$tmp/$name/rcodesign" "$dir/rcodesign"
chmod +x "$dir/rcodesign"
"$dir/rcodesign" --version
