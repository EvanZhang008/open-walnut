#!/usr/bin/env bash
#
# pw-cleanup.sh — inspect and reclaim Playwright test debris.
#
# Playwright browser runs (tests/e2e/browser/) can leave three kinds of debris
# behind when a run is SIGKILLed — an agent session timing out, Ctrl-C during a
# hang, or the OOM killer. None are reaped by Playwright itself:
#
#   1. Chromium processes (~385 MB each) reparented to launchd (ppid=1).
#   2. The fixture server holding :3457 (node + vite + an isolated session daemon).
#   3. A stale port lease in $TMPDIR/walnut-pw-lease that makes the next run queue
#      behind a holder that no longer exists (the TTL clears it after 45m).
#
# Left to accumulate these starve the whole Mac — 2026-07-25: load avg 225 on 14
# cores with 1210 processes, which surfaced as "Walnut is slow" and as Playwright
# runs failing with "Timed out waiting 30000ms from config.webServer".
#
# Usage:
#   scripts/pw-cleanup.sh status     what's running / held right now (default)
#   scripts/pw-cleanup.sh clean      reap orphans + stale leases (safe: skips live runs)
#   scripts/pw-cleanup.sh force      also reap debris owned by a LIVE playwright run
#
# Safety: `clean` never touches processes belonging to a running `playwright test`
# (it walks up to check), never touches prod on :3456, and SIGTERMs the fixture
# server rather than SIGKILLing it so its own handler reaps its isolated daemon
# and tmpdir. Prod-safety is a hard rule here: :3456 is production.

set -uo pipefail

PORT="${PW_TEST_PORT:-3457}"
PROD_PORT=3456
# Match node's os.tmpdir(), which strips the trailing slash macOS puts on $TMPDIR.
LEASE_DIR="${PW_LEASE_DIR:-${TMPDIR%/}/walnut-pw-lease}"
LEASE_DIR="${LEASE_DIR:-/tmp/walnut-pw-lease}"
CMD="${1:-status}"
FORCE=0
[[ "$CMD" == "force" ]] && { FORCE=1; CMD=clean; }

# ── helpers ────────────────────────────────────────────────────────────────

# Is pid (or any ancestor) a live `playwright test` runner?
belongs_to_live_run() {
  local pid="$1" depth=0
  while [[ -n "$pid" && "$pid" -gt 1 && "$depth" -lt 12 ]]; do
    local cmd
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    [[ "$cmd" == *"playwright"*"test"* ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    depth=$((depth + 1))
  done
  return 1
}

orphan_browsers() {
  # Two flavors of automation browser debris, matched so we never touch the
  # user's real Chrome/Chromium (whose profile lives in ~/Library/Application
  # Support and never carries these markers):
  #   1. Playwright's own browsers under ~/Library/Caches/ms-playwright.
  #   2. Real Chrome driven by puppeteer/playwright via a THROWAWAY profile dir
  #      ($TMPDIR/puppeteer_dev_chrome_profile-* / playwright_chromiumdev_profile-*).
  #      2026-07-31: 12 such trees (75 procs, ~5 GB) leaked by killed MCP
  #      web-search servers pushed load to 120 — invisible to the old matcher.
  ps -eo pid=,ppid=,rss=,etime=,command= \
    | grep -E 'ms-playwright/(chromium|chrome-headless-shell)|user-data-dir=[^ ]*(puppeteer_dev_chrome_profile|playwright_chromiumdev_profile)' \
    | grep -v grep
}

# `lsof` walks every fd of every process; on a loaded machine with EDR hooks it
# measured 12-37s here. A connect() probe answers in ~200ms, so only pay for lsof
# when something is actually listening.
port_busy() {
  nc -z -G 1 127.0.0.1 "$1" >/dev/null 2>&1
}

fixture_listeners() {
  port_busy "$PORT" || return 0
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null
}

isolated_daemons() {
  # Session daemons whose WALNUT_DAEMON_DIR is NOT prod (/tmp/open-walnut).
  # Prod daemons intentionally survive restarts — never touch them.
  local pid
  for pid in $(pgrep -f 'daemon-darwin-arm64 --start' 2>/dev/null); do
    local dir
    dir="$(ps eww "$pid" 2>/dev/null | tr ' ' '\n' | grep '^WALNUT_DAEMON_DIR=' | head -1 | cut -d= -f2-)"
    [[ -z "$dir" || "$dir" == "/tmp/open-walnut" ]] && continue
    echo "$pid $dir"
  done
}

stale_leases() {
  [[ -d "$LEASE_DIR" ]] || return 0
  local f pid
  for f in "$LEASE_DIR"/*.lease; do
    [[ -e "$f" ]] || continue
    pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9]*\).*/\1/p' "$f" 2>/dev/null)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      echo "$f (holder pid ${pid:-?} is gone)"
    fi
  done
}

# ── status ─────────────────────────────────────────────────────────────────

if [[ "$CMD" == "status" ]]; then
  echo "load average:$(sysctl -n vm.loadavg | tr -d '{}')   cores: $(sysctl -n hw.ncpu)   processes: $(( $(ps -e | wc -l) - 1 ))"
  echo
  echo "── Playwright browsers ──"
  bmem=0; bn=0
  while read -r pid ppid rss etime _rest; do
    [[ -z "${pid:-}" ]] && continue
    bn=$((bn + 1)); bmem=$((bmem + rss))
    tag="orphan"; belongs_to_live_run "$pid" && tag="live run"
    printf '  pid %-7s ppid %-7s %5s MB  up %-12s  [%s]\n' "$pid" "$ppid" "$((rss / 1024))" "$etime" "$tag"
  done < <(orphan_browsers)
  [[ "$bn" -eq 0 ]] && echo "  none"
  [[ "$bn" -gt 0 ]] && echo "  → $bn processes, $((bmem / 1024)) MB total"
  echo
  echo "── fixture server on :$PORT ──"
  fl="$(fixture_listeners)"
  if [[ -z "$fl" ]]; then echo "  none"; else
    for pid in $fl; do
      tag="orphan"; belongs_to_live_run "$pid" && tag="live run"
      printf '  pid %-7s up %-12s [%s]\n' "$pid" "$(ps -o etime= -p "$pid" | tr -d ' ')" "$tag"
    done
  fi
  echo
  echo "── isolated (non-prod) session daemons ──"
  idl="$(isolated_daemons)"
  [[ -z "$idl" ]] && echo "  none" || echo "$idl" | sed 's/^/  pid /'
  echo
  echo "── port leases in $LEASE_DIR ──"
  if [[ -d "$LEASE_DIR" ]] && compgen -G "$LEASE_DIR/*.lease" >/dev/null; then
    for f in "$LEASE_DIR"/*.lease; do echo "  $(basename "$f"): $(cat "$f")"; done
    sl="$(stale_leases)"
    [[ -n "$sl" ]] && echo "  STALE:" && echo "$sl" | sed 's/^/    /'
  else
    echo "  none (no run holds the fixture port)"
  fi
  echo
  echo "Run 'scripts/pw-cleanup.sh clean' to reap the orphans above."
  exit 0
fi

if [[ "$CMD" != "clean" ]]; then
  echo "usage: scripts/pw-cleanup.sh [status|clean|force]" >&2
  exit 2
fi

# ── clean ──────────────────────────────────────────────────────────────────

killed_b=0 skipped_b=0 freed=0
while read -r pid ppid rss etime rest; do
  [[ -z "${pid:-}" ]] && continue
  if [[ "$FORCE" -eq 0 ]] && belongs_to_live_run "$pid"; then
    skipped_b=$((skipped_b + 1)); continue
  fi
  # Temp-profile Chrome (puppeteer/CDP-driven real Chrome) is only an orphan once
  # reparented to launchd — a live parent (e.g. an MCP web-search server mid-query)
  # still owns it, and its helpers (ppid = main chrome) die with the main anyway.
  if [[ "$FORCE" -eq 0 && "$rest" == *"_dev_chrome_profile"* || "$FORCE" -eq 0 && "$rest" == *"_chromiumdev_profile"* ]]; then
    if [[ "$ppid" -gt 1 ]] && kill -0 "$ppid" 2>/dev/null; then
      skipped_b=$((skipped_b + 1)); continue
    fi
  fi
  # Browsers have no cleanup handler worth waiting for; SIGKILL is correct here
  # (SIGTERM is frequently ignored by a wedged renderer).
  kill -9 "$pid" 2>/dev/null && { killed_b=$((killed_b + 1)); freed=$((freed + rss)); }
done < <(orphan_browsers)
echo "browsers: reaped $killed_b (~$((freed / 1024)) MB), skipped $skipped_b belonging to live runs"

# Resolve prod's pid ONCE (lsof is expensive here) so the guard below is free.
# :3456 is production — refusing to touch it is a hard rule, not an optimization.
prod_pids=""
if port_busy "$PROD_PORT"; then
  prod_pids="$(lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN 2>/dev/null)"
fi

for pid in $(fixture_listeners); do
  if [[ -n "$prod_pids" ]] && grep -qx "$pid" <<<"$prod_pids"; then
    echo "fixture: REFUSING to touch pid $pid — it is prod on :$PROD_PORT" >&2
    continue
  fi
  if [[ "$FORCE" -eq 0 ]] && belongs_to_live_run "$pid"; then
    echo "fixture: skipped pid $pid (live playwright run)"
    continue
  fi
  # SIGTERM so test-server.ts's handler reaps its isolated daemon + tmpdir.
  echo "fixture: SIGTERM pid $pid on :$PORT"
  kill -TERM "$pid" 2>/dev/null
done

while read -r pid dir; do
  [[ -z "${pid:-}" ]] && continue
  if [[ "$FORCE" -eq 0 ]] && belongs_to_live_run "$pid"; then continue; fi
  echo "daemon: SIGTERM pid $pid (isolated dir $dir)"
  kill -TERM "$pid" 2>/dev/null
done < <(isolated_daemons)

if [[ -d "$LEASE_DIR" ]]; then
  for f in "$LEASE_DIR"/*.lease; do
    [[ -e "$f" ]] || continue
    pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9]*\).*/\1/p' "$f" 2>/dev/null)"
    if [[ "$FORCE" -eq 1 ]] || [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" && echo "lease: cleared $(basename "$f") (holder ${pid:-?} gone)"
    fi
  done
fi

# Fixture tmpdirs from runs that died before their own rm -rf. `-maxdepth 1` keeps
# this from descending into $TMPDIR's ~10k entries.
stale_dirs=$(find "${TMPDIR%/}" /tmp -maxdepth 1 -type d -name 'walnut-pw-*' -mmin +120 2>/dev/null | sort -u)
if [[ -n "$stale_dirs" ]]; then
  n=$(echo "$stale_dirs" | wc -l | tr -d ' ')
  echo "$stale_dirs" | while read -r d; do [[ -n "$d" ]] && rm -rf "$d"; done
  echo "tmpdirs: removed $n fixture dir(s) older than 2h"
fi

echo "done. 'scripts/pw-cleanup.sh status' to confirm."
