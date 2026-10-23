#!/bin/sh
# release-unpack.sh <assets dir> <version> <out dir> [target...]
#
# The plain compiled files out of a release's assets (what release-files.mjs
# writes: walnut-<version>-<target>.gz and SHA256SUMS), each checked by BOTH of
# its SHA256SUMS lines: the .gz before it is unpacked, the plain file after.
# Writes <out dir>/walnut-<target>, build-binary.mjs's own name, so whatever
# reads dist-bin/ reads these. With no target: every walnut-<version>-*.gz in
# the dir.
#
# A release builds its files once (release.yml, jobs `*-build`), the binary
# matrix runs those very bytes (binary-matrix.yml with `files`), and the job
# that publishes packs those same bytes into the npm packages: each of them
# unpacks through here, so nothing the matrix did not run can reach npm.
set -eu

[ $# -ge 3 ] || { echo "usage: release-unpack.sh <assets dir> <version> <out dir> [target...]" >&2; exit 2; }
assets="$1"
version="$2"
out="$3"
shift 3
sums="$assets/SHA256SUMS"
[ -f "$sums" ] || { echo "release-unpack: no SHA256SUMS in $assets" >&2; exit 1; }

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# <file> must have the one sha256 SHA256SUMS gives <name> (sha256sum's format:
# "<sha>  <name>", or "<sha> *<name>").
check() {
  expected="$(awk -v n="$2" 'NF == 2 { f = $2; sub(/^\*/, "", f); if (f == n) print $1 }' "$sums")"
  [ -n "$expected" ] || { echo "release-unpack: SHA256SUMS does not list $2" >&2; return 1; }
  [ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" = 1 ] || { echo "release-unpack: SHA256SUMS lists $2 more than once" >&2; return 1; }
  actual="$(sha256 "$1")"
  [ "$actual" = "$expected" ] || { echo "release-unpack: $2 has sha256 ${actual:-(none)}, SHA256SUMS says $expected" >&2; return 1; }
}

if [ $# -eq 0 ]; then
  for gz in "$assets"/walnut-"$version"-*.gz; do
    [ -f "$gz" ] || { echo "release-unpack: no walnut-$version-*.gz in $assets" >&2; exit 1; }
    t=${gz##*/}
    t=${t#walnut-"$version"-}
    set -- "$@" "${t%.gz}"
  done
fi

mkdir -p "$out"
for t in "$@"; do
  # The targets release-files.mjs ships (TARGETS), and nothing that could name a path.
  case "$t" in
    darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64 | linux-arm64-musl | linux-x64-musl) ;;
    *) echo "release-unpack: $t is not a release target" >&2; exit 1 ;;
  esac
  name="walnut-$version-$t"
  [ -f "$assets/$name.gz" ] || { echo "release-unpack: no $name.gz in $assets" >&2; exit 1; }
  check "$assets/$name.gz" "$name.gz" || exit 1
  dest="$out/walnut-$t"
  rm -f "$dest.part"
  gzip -dc "$assets/$name.gz" > "$dest.part" || { rm -f "$dest.part"; echo "release-unpack: $name.gz does not unpack" >&2; exit 1; }
  check "$dest.part" "$name" || { rm -f "$dest.part"; exit 1; }
  chmod 755 "$dest.part"
  mv -f "$dest.part" "$dest"
  echo "$dest: $name, both of its SHA256SUMS lines match"
done
