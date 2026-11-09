#!/bin/sh
# Is the host network connector this tree pins out? The release a daemon downloads it from
# (src/providers/net-binary.ts: NET_BIN_VERSION under RELEASE_BASE) is complete once it has
# its SHA256SUMS, which .github/workflows/walnut-net.yml uploads last.
#
# 2026-11-09: the join workflows of a commit that moved NET_BIN_VERSION to 0.2.1 started two
# minutes before walnut-net-v0.2.1 was out, got a 404 for its SHA256SUMS and failed.
# walnut-net.yml now builds a new version on its own, and whatever needs the release first
# asks here.
#
#   sh scripts/net-release-ready.sh               exit 0 when it is out, 1 when not
#   sh scripts/net-release-ready.sh --wait 3300   waits up to that many seconds for it
#   sh scripts/net-release-ready.sh --at <rev>    the connector that commit pins
#
# Exit 2: net-binary.ts names no version or no release (its format changed under this).
set -eu

wait_s=0
rev=
while [ $# -gt 0 ]; do
  case "$1" in
    --wait|--at)
      [ $# -ge 2 ] || { echo "usage: net-release-ready.sh [--wait SECONDS] [--at REV]" >&2; exit 2; }
      if [ "$1" = --wait ]; then wait_s=$2; else rev=$2; fi
      shift 2 ;;
    *) echo "usage: net-release-ready.sh [--wait SECONDS] [--at REV]" >&2; exit 2 ;;
  esac
done

pins() {
  if [ -n "$rev" ]; then git show "$rev:src/providers/net-binary.ts"; else cat src/providers/net-binary.ts; fi
}
version=$(pins | sed -n "s/^export const NET_BIN_VERSION = '\(.*\)'$/\1/p")
base=${WALNUT_NET_RELEASE_BASE_URL-$(pins | sed -n "s/^const RELEASE_BASE = '\(.*\)'$/\1/p")}
if [ -z "$version" ] || [ -z "$base" ]; then
  echo "net-release-ready: src/providers/net-binary.ts${rev:+ at $rev} names no NET_BIN_VERSION or RELEASE_BASE" >&2
  exit 2
fi

tag="walnut-net-v$version"
url="${base%/}/$tag/SHA256SUMS"
sums=$(mktemp)
trap 'rm -f "$sums"' EXIT
deadline=$(( $(date +%s) + wait_s ))
while :; do
  # A 404 answers at once; a dropped connection is tried again.
  code=$(curl -sL --retry 2 --retry-all-errors --max-time 30 -o "$sums" -w '%{http_code}' "$url" 2>/dev/null) || code=000
  if [ "$code" = 200 ] && grep -qF "  walnut-net-$version-" "$sums"; then
    echo "$tag is out"
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  echo "waiting for $tag (HTTP $code for $url)"
  sleep 30
done
echo "$tag is not out (HTTP $code for $url). walnut-net.yml builds it when the version in native/walnut-net/Cargo.toml changes on main." >&2
exit 1
