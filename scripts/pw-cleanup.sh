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
# Safety: `clean` signals only what this repo's own runs recorded: a browser that
# carries a recorded run's WALNUT_PW_RUN token, a fixture server that wrote its pid
# to walnut-pw-*/owner.pid, an isolated daemon that wrote walnut-pw-*/daemon/daemon.pid.
# Everything else (another agent's Playwright MCP browser, the onboarding sandbox on
# :3457) is listed and left alone. It never touches processes belonging to a running
# `playwright test` (it walks up to check), never touches prod on :3456, and SIGTERMs
# the fixture server rather than SIGKILLing it so its own handler reaps its isolated
# daemon and tmpdir. Prod-safety is a hard rule here: :3456 is production.

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
  # Two flavors of automation browser, LISTED here (never reaped on this match
  # alone: another agent's Playwright MCP or puppeteer browser looks the same):
  #   1. Playwright's own browsers under ~/Library/Caches/ms-playwright.
  #   2. Real Chrome driven by puppeteer/playwright via a THROWAWAY profile dir
  #      ($TMPDIR/puppeteer_dev_chrome_profile-* / playwright_chromiumdev_profile-*).
  #      2026-07-31: 12 such trees (75 procs, ~5 GB) leaked by killed MCP
  #      web-search servers pushed load to 120 — invisible to the old matcher.
  ps -eo pid= -o ppid= -o rss= -o etime= -o command= \
    | grep -E 'ms-playwright/(chromium|chrome-headless-shell)|user-data-dir=[^ ]*(puppeteer_dev_chrome_profile|playwright_chromiumdev_profile)' \
    | grep -v grep
}

# Which browsers are this repo's: each run of this repo's Playwright config marks
# itself (tests/e2e/browser/pw-gate.ts). The runner puts WALNUT_PW_RUN=<token> in its
# environment, which its workers and every browser they launch inherit, and records
# its own pid in $PW_RUNS_DIR/<token>. A browser carrying a recorded token is this
# repo's; any other is someone else's and is only listed.
_pw_tmp="${TMPDIR:-/tmp}"; _pw_tmp="${_pw_tmp%/}"
PW_RUNS_DIR="${PW_RUNS_DIR:-$_pw_tmp/walnut-pw-runs}"

# The WALNUT_PW_RUN token in a process's environment, or nothing.
run_token_of() {
  ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' \
    | sed -n 's/^WALNUT_PW_RUN=\([A-Za-z0-9-][A-Za-z0-9-]*\)$/\1/p' | head -1 || true
}

# A recorded run's state: "live" while its runner pid is alive, "gone" once it is
# not, nothing when this repo recorded no such run.
run_state() {
  local rec="$PW_RUNS_DIR/$1" pid
  [[ -n "$1" && -f "$rec" ]] || return 0
  pid="$(tr -dc '0-9' < "$rec" 2>/dev/null || true)"
  if [[ -n "$pid" && "$pid" -gt 1 ]] && kill -0 "$pid" 2>/dev/null; then echo live; else echo gone; fi
}

# owned|live|foreign for one browser pid: owned = this repo's run, which is gone.
browser_owner() {
  local state
  state="$(run_state "$(run_token_of "$1")")"
  case "$state" in
    gone) belongs_to_live_run "$1" && echo live || echo owned ;;
    live) echo live ;;
    *) echo foreign ;;
  esac
}

# Reap this repo's browsers whose run is gone (FORCE: also a live run's). Every other
# browser is listed with a hint, never signalled.
reap_browsers() {
  local pid ppid rss etime rest owner killed=0 skipped=0 freed=0 foreign=""
  while read -r pid ppid rss etime rest; do
    [[ -z "${pid:-}" ]] && continue
    owner="$(browser_owner "$pid")"
    if [[ "$owner" == foreign ]]; then foreign="$foreign $pid"; continue; fi
    if [[ "$owner" == live && "$FORCE" -eq 0 ]]; then skipped=$((skipped + 1)); continue; fi
    # Browsers have no cleanup handler worth waiting for; SIGKILL is correct here
    # (SIGTERM is frequently ignored by a wedged renderer).
    kill -9 "$pid" 2>/dev/null && { killed=$((killed + 1)); freed=$((freed + rss)); }
  done < <(orphan_browsers)
  echo "browsers: reaped $killed of this repo's (~$((freed / 1024)) MB), skipped $skipped belonging to live runs"
  if [[ -n "$foreign" ]]; then
    echo "browsers: left alone, not started by a recorded run of this repo:$foreign"
    echo "  (another agent's Playwright MCP or puppeteer browser looks the same; if one is your debris, stop that pid yourself)"
  fi
}

# Pids the browser fixture servers recorded in their homes (<tmp>/walnut-pw-*/owner.pid,
# tests/setup/stale-tmp.ts), one per line.
fixture_owner_pids() {
  local f
  for f in "$_pw_tmp"/walnut-pw-*/owner.pid /tmp/walnut-pw-*/owner.pid; do
    [[ -f "$f" ]] && tr -dc '0-9' < "$f" 2>/dev/null && echo
  done | grep -E '^[0-9]+$' | sort -u || true
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
  # The session daemons of Playwright fixtures: each fixture runs one in
  # <tmp>/walnut-pw-<n>/daemon, and the daemon records its pid there (daemon.pid).
  # Found by that record, never by process name or pattern: a pattern matches every
  # process whose command line carries the text (2026-10-31: one such kill ended every
  # agent session on the Mac). Prod daemons (/tmp/open-walnut, ~/.cache/open-walnut)
  # have no such dir and are never touched. A recorded pid counts only while that
  # process still names the same WALNUT_DAEMON_DIR, since a pid is reused once its
  # process is gone.
  local pidfile pid dir env_dir
  for pidfile in "${TMPDIR%/}"/walnut-pw-*/daemon/daemon.pid /tmp/walnut-pw-*/daemon/daemon.pid; do
    [[ -f "$pidfile" ]] || continue
    pid="$(tr -dc '0-9' < "$pidfile" 2>/dev/null)"
    [[ -n "$pid" && "$pid" -gt 1 ]] && kill -0 "$pid" 2>/dev/null || continue
    dir="$(dirname "$pidfile")"
    env_dir="$(ps eww "$pid" 2>/dev/null | tr ' ' '\n' | grep '^WALNUT_DAEMON_DIR=' | head -1 | cut -d= -f2-)"
    [[ -n "$env_dir" && "${env_dir%/}" == "${dir%/}" ]] || continue
    echo "$pid $dir"
  done | sort -u
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

# Sourced (tests call the helpers above): stop here.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

# ── status ─────────────────────────────────────────────────────────────────

if [[ "$CMD" == "status" ]]; then
  echo "load average:$(sysctl -n vm.loadavg | tr -d '{}')   cores: $(sysctl -n hw.ncpu)   processes: $(( $(ps -e | wc -l) - 1 ))"
  echo
  echo "── Playwright browsers ──"
  bmem=0; bn=0
  while read -r pid ppid rss etime _rest; do
    [[ -z "${pid:-}" ]] && continue
    bn=$((bn + 1)); bmem=$((bmem + rss))
    case "$(browser_owner "$pid")" in
      owned) tag="this repo's, run gone" ;; live) tag="this repo's, live run" ;; *) tag="not this repo's: left alone" ;;
    esac
    printf '  pid %-7s ppid %-7s %5s MB  up %-12s  [%s]\n' "$pid" "$ppid" "$((rss / 1024))" "$etime" "$tag"
  done < <(orphan_browsers)
  [[ "$bn" -eq 0 ]] && echo "  none"
  [[ "$bn" -gt 0 ]] && echo "  → $bn processes, $((bmem / 1024)) MB total"
  echo
  echo "── fixture server on :$PORT ──"
  fl="$(fixture_listeners)"
  if [[ -z "$fl" ]]; then echo "  none"; else
    owners="$(fixture_owner_pids)"
    for pid in $fl; do
      tag="orphan"; belongs_to_live_run "$pid" && tag="live run"
      grep -qx "$pid" <<<"$owners" || tag="not a recorded fixture: left alone"
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

reap_browsers

# Resolve prod's pid ONCE (lsof is expensive here) so the guard below is free.
# :3456 is production — refusing to touch it is a hard rule, not an optimization.
prod_pids=""
if port_busy "$PROD_PORT"; then
  prod_pids="$(lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN 2>/dev/null)"
fi

owners="$(fixture_owner_pids)"
for pid in $(fixture_listeners); do
  if [[ -n "$prod_pids" ]] && grep -qx "$pid" <<<"$prod_pids"; then
    echo "fixture: REFUSING to touch pid $pid — it is prod on :$PROD_PORT" >&2
    continue
  fi
  # Only a server a browser fixture recorded as its own (walnut-pw-*/owner.pid): the
  # port is shared with the onboarding sandbox and anyone's hand-started server.
  if ! grep -qx "$pid" <<<"$owners"; then
    echo "fixture: left pid $pid on :$PORT alone: no browser fixture recorded it (walnut-pw-*/owner.pid); stop it yourself if it is debris"
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

# Run records whose runner is gone and that are a day old: no browser of theirs
# survived the reap above for long.
if [[ -d "$PW_RUNS_DIR" ]]; then
  for f in "$PW_RUNS_DIR"/*; do
    [[ -f "$f" ]] || continue
    [[ "$(run_state "$(basename "$f")")" == gone ]] || continue
    [[ -n "$(find "$f" -mmin +1440 2>/dev/null)" ]] && rm -f "$f"
  done
fi

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
