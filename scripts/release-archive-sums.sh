#!/bin/sh
# release-archive-sums.sh <tag> <version> <archives dir> <out file>
#
# The SHA256SUMS a stable release gets with its Node archives
# (release-archives.yml, job `publish`, which uploads <out file>): every line
# the release's SHA256SUMS has, except this version's archive lines, which
# become those of the open-walnut-<version>-<target>.tar.gz in <archives dir>.
#
# The release's lines are its compiled files' (scripts/release-attach.sh), and
# install.sh, the Homebrew formula and the Mac app read them. A SHA256SUMS that
# lost them stays that way: install.sh then falls back to the archive (none for
# musl), the formula and the app follow, and release-attach.sh never puts them
# back, because the release has a SHA256SUMS. So GitHub failing to answer stops
# this script instead of reading as "no lines": it lists the release's assets
# first, downloads SHA256SUMS only when the release has one and fails when that
# download does, and before it writes anything requires every walnut-<version>-*.gz
# the release holds, and every walnut line its SHA256SUMS had, to be listed still.
# Needs gh (GH_TOKEN, GH_REPO).
set -eu

[ $# -eq 4 ] || { echo "usage: release-archive-sums.sh <tag> <version> <archives dir> <out file>" >&2; exit 2; }
tag="$1"
version="$2"
dir="$3"
out="$4"
work="$(mktemp -d "${TMPDIR:-/tmp}/archive-sums.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

set -- "$dir"/open-walnut-"$version"-*.tar.gz
[ -f "$1" ] || { echo "release-archive-sums: no open-walnut-$version-*.tar.gz in $dir" >&2; exit 1; }

assets="$(gh release view "$tag" --json assets --jq '.assets[].name')" \
  || { echo "release-archive-sums: could not list $tag's assets; SHA256SUMS left as it is" >&2; exit 1; }
: > "$work/old"
if printf '%s\n' "$assets" | grep -qx SHA256SUMS; then
  mkdir "$work/listed"
  gh release download "$tag" --pattern SHA256SUMS --dir "$work/listed" \
    || { echo "release-archive-sums: could not download $tag's SHA256SUMS; left as it is" >&2; exit 1; }
  [ -f "$work/listed/SHA256SUMS" ] || { echo "release-archive-sums: $tag's SHA256SUMS did not download" >&2; exit 1; }
  cp "$work/listed/SHA256SUMS" "$work/old"
fi

# Every line but this version's archives (sha256sum's "<sha>  <name>" or "<sha> *<name>").
awk -v p="open-walnut-$version-" '
  NF == 0 { next }
  { f = $2; sub(/^\*/, "", f) }
  index(f, p) == 1 && substr(f, length(p) + 1) ~ /^(darwin|linux)-(arm64|x64)\.tar\.gz$/ { next }
  { print }
' "$work/old" > "$work/new"
for a in "$@"; do
  sha="$(sha256 "$a")"
  [ "${#sha}" -eq 64 ] || { echo "release-archive-sums: could not hash $a" >&2; exit 1; }
  printf '%s  %s\n' "$sha" "${a##*/}" >> "$work/new"
done

# Nothing of the compiled files' may go: each .gz the release holds keeps a line,
# and each walnut line the release's SHA256SUMS had is there as it was.
printf '%s\n' "$assets" | awk -v p="walnut-$version-" '
  NR == FNR { f = $2; sub(/^\*/, "", f); listed[f] = 1; next }
  index($0, p) == 1 && /\.gz$/ && !listed[$0] { print }
' "$work/new" - > "$work/lost"
awk '
  NR == FNR { kept[$0] = 1; next }
  { f = $2; sub(/^\*/, "", f) }
  f ~ /^walnut-/ && !kept[$0] { print f }
' "$work/new" "$work/old" >> "$work/lost"
if [ -s "$work/lost" ]; then
  echo "release-archive-sums: $tag's SHA256SUMS would not list $(tr '\n' ' ' < "$work/lost"); nothing written" >&2
  exit 1
fi
cp "$work/new" "$out"
