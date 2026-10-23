#!/bin/sh
# binary-matrix.sh <walnut file> <image>...
#
# Rehearse a compiled Walnut file inside each Linux image, the way CI's binary
# matrix does (.github/workflows/binary-matrix.yml): the image gets the file and
# this checkout read-only and nothing else, no Node and no bun. The file runs
# the rehearsal itself as bun (BUN_BE_BUN=1), as an unprivileged user.
#
#   scripts/binary-matrix.sh dist-bin/walnut-linux-x64 centos:7 opensuse/leap:15.2 ubuntu:24.04
#
# Needs docker. Exits non-zero when any image fails; prints a line per image.
set -eu

[ $# -ge 2 ] || { echo "usage: binary-matrix.sh <walnut file> <image>..." >&2; exit 2; }
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
shift
[ -x "$bin" ] || { echo "binary-matrix: $bin is not an executable file" >&2; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd)"

failed=0
for image in "$@"; do
  printf '\n=== %s ===\n' "$image"
  if docker run --rm --user 1000:1000 -e BUN_BE_BUN=1 -e HOME=/tmp \
    -v "$repo:/w:ro" -v "$bin:/opt/walnut:ro" -w /w "$image" \
    /opt/walnut scripts/release-rehearsal/run.mjs --binary /opt/walnut --work /tmp/rehearsal; then
    printf 'PASS %s\n' "$image"
  else
    printf 'FAIL %s\n' "$image"
    failed=$((failed + 1))
  fi
done
[ "$failed" -eq 0 ] || { printf '\n%s image(s) failed\n' "$failed" >&2; exit 1; }
