#!/usr/bin/env bash
# Installs Playwright's browsers and the system packages they need on a CI runner, bounded.
#
# Where the time went (runs 44183551860 and 44223991725, 32 browser shards): the browsers
# themselves take a few seconds from Playwright's host; the cost is apt. A runner whose apt mirror
# list starts with its own region's mirror on one cloud fetched the 125 MB of packages at about
# 100 kB/s (15 to 22 minutes, 17 of 18 such shards), while the other cloud's mirror gave 5 to
# 25 MB/s (35 to 55 s, every shard). apt takes one mirror and fetches one file after another, and
# never leaves a mirror that is slow but alive. So:
#   - only the packages the runner lacks are installed, and apt is skipped when it lacks none;
#   - before apt fetches, one package is timed from each mirror and the packages are fetched in
#     parallel from the fastest, into a cache apt then installs from (it checks every hash, and
#     fetches whatever is still missing itself);
#   - the browsers download while apt works;
#   - every network step is bounded (a mirror can also stall with no output: run 42763058265 sat
#     58 minutes in apt-get update), runs as root under its own timeout so a kill reaches apt-get,
#     and the next try waits for dpkg's lock first.
# A package that still did not install is named in an error annotation, never skipped quietly;
# the browsers alone are then installed from Playwright's host, as a runner whose mirror is out of
# reach still has what a browser needs to start (nightly-extra-tests run 43041166867).
# Guard: tests/scripts/ci-playwright-install.test.ts.
set -u
[ "$#" -gt 0 ] || { echo "usage: install-browsers.sh <browser>..." >&2; exit 2; }
t0=$SECONDS
say() { echo "install-browsers: $* ($((SECONDS - t0)) s)"; }
count() { echo $#; }
sudo tee /etc/apt/apt.conf.d/99-ci-network >/dev/null <<'CONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "5";
DPkg::Lock::Timeout "300";
CONF
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/install-browsers.XXXXXX")
mkdir -p "$work/debs/partial"

# The browsers come from Playwright's own host and need no root: fetch them while apt works.
timeout 600 bun x playwright install "$@" >"$work/browsers.log" 2>&1 &
browsers=$!

wait_for_dpkg() {
  for _ in $(seq 60); do
    sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || return 0
    sleep 5
  done
}

# Times two packages from each mirror (the runner's own list first, then two public ones) and
# fetches every Ubuntu package apt is about to fetch, 8 at a time, from the fastest that has it.
prefetch() {
  local bases ranked b f pids=() i=0
  # Only Ubuntu's own pool (the runner's mirror list or an ubuntu.com host): "<path> <file> <size>".
  awk '$1 ~ /^.(mirror\+file:|https?:\/\/[^\/]*ubuntu\.com\/ubuntu)/ && $1 ~ /\/pool\// { print $1, $2, $3 }' \
    "$work/uris" | tr -d "'" | sed 's#^[^ ]*/pool/#pool/#' >"$work/pool"
  bases=$( { sed -n 's#^\(https\{0,1\}://[^[:space:]]*\).*#\1#p' /etc/apt/apt-mirrors.txt 2>/dev/null
    echo http://azure.archive.ubuntu.com/ubuntu; echo http://archive.ubuntu.com/ubuntu; } |
    sed 's#/*$##' | awk '!seen[$0]++')
  rm -f "$work"/probe.*
  for f in $(awk '$3 > 300000 && $3 < 3000000 { print $1 }' "$work/pool" | head -2); do
    for b in $bases; do
      curl -s -o /dev/null --connect-timeout 3 --max-time 5 -w "%{http_code} %{speed_download} $b\n" \
        "$b/$f" >"$work/probe.$i" 2>/dev/null &
      pids+=($!); i=$((i + 1))
    done
  done
  [ "$i" -gt 0 ] && wait "${pids[@]}"
  ranked=$(cat "$work"/probe.* 2>/dev/null |
    awk '$1 == 200 && int($2) > best[$3] { best[$3] = int($2) } END { for (m in best) print best[m], m }' |
    sort -rn)
  MIRRORS=$(echo "$ranked" | awk 'NF { print $2 }')
  if [ -z "$MIRRORS" ]; then
    echo "::warning::no apt mirror answered the probe; apt fetches the packages itself"
    return 0
  fi
  say "mirror speeds (bytes/s): $(echo $ranked)"
  export MIRRORS
  fetch_one() {
    local m
    [ -s "$2" ] && return 0
    for m in $MIRRORS; do
      curl -fsS --connect-timeout 5 --speed-limit 30000 --speed-time 15 --max-time 120 \
        -o "$2.part" "$m/$1" 2>/dev/null && [ "$(wc -c <"$2.part")" -eq "$3" ] &&
        mv "$2.part" "$2" && return 0
    done
    rm -f "$2.part"
  }
  export -f fetch_one
  (cd "$work/debs" && timeout 180 xargs -r -P 8 -n 3 bash -c 'fetch_one "$1" "$2" "$3"' _ <"$work/pool")
  say "prefetched $(find "$work/debs" -maxdepth 1 -name '*.deb' | grep -c .) of $(grep -c . "$work/uris") packages"
}

apt_try() {
  local A=(-o "Dir::Cache::Archives=$work/debs/")
  # A try killed mid-unpack leaves dpkg "interrupted", and every later apt-get refuses to run.
  wait_for_dpkg
  sudo timeout 300 dpkg --configure -a
  sudo timeout 180 apt-get update -qq || return 1
  say "apt lists updated"
  timeout 60 apt-get install --print-uris -qq -y --no-install-recommends $missing >"$work/uris" || return 1
  prefetch
  # The network part, safe to kill; the install after it reads only the cache.
  sudo timeout 300 apt-get "${A[@]}" install --download-only -y -q --no-install-recommends $missing || return 1
  sudo timeout 600 apt-get "${A[@]}" install -y -q --no-install-recommends $missing
}

# What --with-deps would install, from Playwright's own dry run, minus what the runner has.
want=$(timeout 120 bun x playwright install-deps --dry-run "$@" 2>/dev/null |
  sed -n 's/.*--no-install-recommends \([^"]*\)".*/\1/p')
missing=""
for p in $want; do
  dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing="$missing $p"
done
apt_ok=0
if [ -z "$want" ]; then
  # The dry run's shape changed: let Playwright install them itself, once, bounded.
  echo "::warning::playwright install-deps --dry-run listed no packages; using --with-deps"
  missing=" (the ones playwright install --with-deps $* names)"
  wait "$browsers"; browsers_done=$?
  timeout 900 bun x playwright install --with-deps "$@" && apt_ok=1
  [ "$apt_ok" = 1 ] || { wait_for_dpkg; sudo timeout 300 dpkg --configure -a; }
elif [ -z "$missing" ]; then
  say "all $(count $want) system packages are already installed"
  apt_ok=1
else
  say "$(count $missing) of $(count $want) system packages to install:$missing"
  for try in 1 2; do
    apt_try && { apt_ok=1; break; }
    echo "::warning::apt try $try did not finish"
  done
fi
[ "$apt_ok" = 1 ] && say "system packages ready" ||
  echo "::error::these system packages did not install, a browser may not start:$missing"

[ -n "${browsers_done:-}" ] || { wait "$browsers"; browsers_done=$?; }
[ "$browsers_done" = 0 ] && { say "browsers ready"; exit 0; }
cat "$work/browsers.log"
echo "::warning::the browser download did not finish; trying it once more"
timeout 600 bun x playwright install "$@" && exit 0
exit 1
