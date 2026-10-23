#!/usr/bin/env bash
# Install the bridge monitor LaunchAgents on this Mac. Idempotent: every run
# refreshes the code snapshot, re-renders the plists and reloads the agents.
#
#   scripts/bridge-monitor/install.sh               collector + daily summary
#   scripts/bridge-monitor/install.sh --with-probe  also the control probe (needs
#                                                   probe.enabled + a token file
#                                                   in the local config first)
#   scripts/bridge-monitor/install.sh --no-load     render and copy only
#
# Agents are loaded with `launchctl bootstrap gui/<uid>`. Never with
# `launchctl submit`: a submitted job is KeepAlive and relaunches forever.
# The agents run a COPY of the code under Application Support, so edits in
# this shared worktree never change a running monitor until the next install.
# They run on bun: BRIDGE_MONITOR_BUN, else a bun of the version package.json
# pins or newer (scripts/lib/find-bun.sh: WALNUT_BUN, PATH, ~/.bun/bin/bun,
# /opt/homebrew/bin/bun, /usr/local/bin/bun).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "bridge monitor: macOS only" >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SRC/../.." && pwd)"
SUPPORT="${BRIDGE_MONITOR_SUPPORT_DIR:-$HOME/Library/Application Support/Walnut}"
APP="$SUPPORT/bridge-monitor/app"
STATE="$SUPPORT/bridge-monitor/state"
CONFIG="$SUPPORT/bridge-monitor.json"
LOGDIR="${BRIDGE_MONITOR_LOG_DIR:-$HOME/Library/Logs/Walnut/bridge-monitor}"
AGENTS="${BRIDGE_MONITOR_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
# BRIDGE_MONITOR_BUN wins as given; else a bun of the pinned version or newer
# (scripts/lib/find-bun.sh), which the launchd plists then name.
BUN="${BRIDGE_MONITOR_BUN:-}"
if [ -z "$BUN" ]; then
  # shellcheck source=../lib/find-bun.sh
  . "$REPO/scripts/lib/find-bun.sh"
  if walnut_find_bun "$REPO"; then BUN="$BUN_BIN"; fi
fi
DOMAIN="gui/$(id -u)"
LABELS=(dev.openwalnut.bridge-monitor dev.openwalnut.bridge-monitor-summary)
PROBE_LABEL=dev.openwalnut.bridge-monitor-probe

WITH_PROBE=0
NO_LOAD=0
for a in "$@"; do
  case "$a" in
    --with-probe) WITH_PROBE=1 ;;
    --no-load) NO_LOAD=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# It must print bun's own version: an exit code alone would pass for any binary.
if [ -z "$BUN" ] || [ -z "$("$BUN" -e 'process.stdout.write(process.versions.bun || "")' 2>/dev/null)" ]; then
  if [ -n "${BRIDGE_MONITOR_BUN:-}" ]; then
    echo "bridge monitor: BRIDGE_MONITOR_BUN=$BRIDGE_MONITOR_BUN is not a bun" >&2
  else
    echo "bridge monitor: $(walnut_bun_missing) (or set BRIDGE_MONITOR_BUN)" >&2
  fi
  exit 1
fi
if [ ! -f "$REPO/node_modules/ws/package.json" ]; then
  echo "bridge monitor: $REPO/node_modules/ws is missing; run bun install first" >&2
  exit 1
fi

# The record dir can be overridden, and it gets chmod 700: only ever a
# directory of our own, named bridge-monitor (never $HOME, never /).
LOGDIR="${LOGDIR%/}"
case "$LOGDIR" in
  /*/bridge-monitor) ;;
  *) echo "bridge monitor: refusing record dir '$LOGDIR' (it must be an absolute path ending in /bridge-monitor)" >&2; exit 1 ;;
esac

mkdir -p "$APP" "$STATE" "$LOGDIR" "$AGENTS"
chmod 700 "$SUPPORT/bridge-monitor" "$APP" "$STATE" "$LOGDIR"

# Code snapshot: the scripts, their lib, and the one runtime dependency.
rsync -a --delete --exclude 'launchd/' --exclude '*.sh' --exclude 'node_modules/' "$SRC/" "$APP/"
mkdir -p "$APP/node_modules"
rsync -a --delete "$REPO/node_modules/ws/" "$APP/node_modules/ws/"

# The local config is created once and never overwritten: it holds the
# machine-specific values that must stay out of the repo.
if [ ! -f "$CONFIG" ]; then
  cp "$SRC/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG"
  echo "created config $CONFIG"
fi

render() {
  local label="$1"
  local out="$AGENTS/$label.plist"
  sed -e "s#__BUN__#$BUN#g" -e "s#__APP__#$APP#g" -e "s#__LOGDIR__#$LOGDIR#g" \
    "$SRC/launchd/$label.plist.in" > "$out.tmp"
  plutil -lint "$out.tmp" > /dev/null
  mv "$out.tmp" "$out"
  chmod 644 "$out"
}

load() {
  local label="$1"
  case "$label" in
    dev.openwalnut.bridge-monitor*) ;;
    *) echo "refusing to touch launchd label $label" >&2; exit 1 ;;
  esac
  if launchctl print "$DOMAIN/$label" > /dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$label" 2> /dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "$DOMAIN/$label" > /dev/null 2>&1 || break
      sleep 1
    done
  fi
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
  echo "loaded $DOMAIN/$label"
}

probe_ready() {
  BRIDGE_MONITOR_CONFIG="$CONFIG" "$BUN" -e "
    import fs from 'node:fs'
    const { loadConfig } = await import('$APP/lib/config.mjs')
    const p = loadConfig().cfg.probe
    let ok = p.enabled === true && typeof p.url === 'string'
    try { ok = ok && fs.readFileSync(p.tokenFile, 'utf-8').trim().length > 0 } catch { ok = false }
    process.exit(ok ? 0 : 1)"
}

for label in "${LABELS[@]}"; do render "$label"; done
if [ "$WITH_PROBE" = 1 ]; then
  if ! probe_ready; then
    echo "probe not installed: set probe.enabled, probe.url and probe.tokenFile in $CONFIG first" >&2
    exit 1
  fi
  render "$PROBE_LABEL"
fi

if [ "$NO_LOAD" = 1 ]; then
  echo "rendered plists in $AGENTS (not loaded)"
  exit 0
fi

for label in "${LABELS[@]}"; do load "$label"; done
if [ "$WITH_PROBE" = 1 ]; then load "$PROBE_LABEL"; fi

echo "bridge monitor installed: app $APP, records $LOGDIR, config $CONFIG"
