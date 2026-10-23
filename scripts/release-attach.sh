#!/bin/sh
# Attach a release's compiled files (scripts/release-build.mjs) to its GitHub
# Release, a draft or a published one: every walnut-<version>-<target>.gz and
# install.sh, then SHA256SUMS last, so the release never lists a checksum for a
# file that is not up yet.
#
#   sh scripts/release-attach.sh v0.7.0 <dir>/assets
#
# A release that has SHA256SUMS already has its files (an earlier attempt got
# that far): nothing is uploaded again, because a rebuild may not be byte for
# byte the build npm holds. GitHub failing to list the assets stops it: read as
# "no SHA256SUMS", an outage would upload over a finished release, and the
# formula would keep the sha of the .gz it replaced. Needs gh (GH_TOKEN, GH_REPO).
set -eu

tag="$1"
dir="$2"
here="$(cd "$(dirname "$0")" && pwd)"

assets="$(gh release view "$tag" --json assets --jq '.assets[].name')" \
  || { echo "release-attach: could not list $tag's assets; nothing uploaded" >&2; exit 1; }
if printf '%s\n' "$assets" | grep -qx SHA256SUMS; then
  echo "$tag already has its files"
  exit 0
fi
set -- "$dir"/walnut-*.gz
[ -f "$1" ] || { echo "release-attach: no walnut-*.gz in $dir" >&2; exit 1; }
gh release upload "$tag" "$@" "$here/install.sh" --clobber
gh release upload "$tag" "$dir/SHA256SUMS" --clobber
echo "attached $# files, install.sh and SHA256SUMS to $tag"
