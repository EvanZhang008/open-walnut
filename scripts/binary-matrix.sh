#!/bin/sh
# binary-matrix.sh <walnut file> <image>...
#
# Rehearse a compiled Walnut file inside each Linux image, the way CI's binary
# matrix does (.github/workflows/binary-matrix.yml): the image gets the file and
# the rehearsal's own files read-only (package.json, scripts/, the mock CLI) and
# nothing else: no Node, no bun, no node_modules a stray lookup could fall back
# on. The file runs the rehearsal itself as bun (BUN_BE_BUN=1), as an
# unprivileged user.
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
work="$(mktemp -d "${TMPDIR:-/tmp}/walnut-matrix.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM
tar -C "$repo" -cf - package.json scripts tests/providers/mock-claude.mjs tests/providers/mock-claude-flags.mjs | tar -C "$work" -xf -
chmod -R a+rX "$work"

# Pull an image the runner lacks, three tries: Docker Hub answers a pull with a 500 now
# and then (2026-10-29: two rows failed on one, before the file ever ran), and `docker
# run` gives up on the first. BINARY_MATRIX_PULL_DELAY is the first wait, in seconds.
pull_image() {
  docker image inspect "$1" >/dev/null 2>&1 && return 0
  delay="${BINARY_MATRIX_PULL_DELAY:-10}"
  for try in 1 2 3; do
    docker pull -q "$1" >/dev/null && return 0
    [ "$try" -lt 3 ] || break
    printf 'pull of %s failed (try %s of 3); again in %ss\n' "$1" "$try" "$delay" >&2
    sleep "$delay"
    delay=$((delay * 3))
  done
  return 1
}

# bun's musl build links the C++ runtime dynamically: on Alpine it needs the
# libstdc++ and libgcc packages, as bun itself does (install.sh names them).
musl_image() {
  tag="walnut-matrix-$(printf '%s' "$1" | tr -c 'a-zA-Z0-9.\n' '-')"
  printf 'FROM %s\nRUN apk add --no-cache libstdc++ libgcc >/dev/null\n' "$1" | docker build -q -t "$tag" - >/dev/null
  printf '%s' "$tag"
}

failed=0
for image in "$@"; do
  printf '\n=== %s ===\n' "$image"
  run_image="$image"
  pull_image "$image" || { printf 'FAIL %s (could not pull the image: the registry, not Walnut)\n' "$image"; failed=$((failed + 1)); continue; }
  case "$image" in
    alpine*) run_image="$(musl_image "$image")" || { printf 'FAIL %s (could not add libstdc++)\n' "$image"; failed=$((failed + 1)); continue; } ;;
  esac
  if docker run --rm --user 1000:1000 -e BUN_BE_BUN=1 -e HOME=/tmp \
    -v "$work:/w:ro" -v "$bin:/opt/walnut:ro" -w /w "$run_image" \
    /opt/walnut scripts/release-rehearsal/run.mjs --binary /opt/walnut --work /tmp/rehearsal; then
    printf 'PASS %s\n' "$image"
  else
    printf 'FAIL %s\n' "$image"
    failed=$((failed + 1))
  fi
done
[ "$failed" -eq 0 ] || { printf '\n%s image(s) failed\n' "$failed" >&2; exit 1; }
