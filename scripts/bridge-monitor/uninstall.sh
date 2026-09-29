#!/usr/bin/env bash
# Remove the bridge monitor LaunchAgents. Idempotent.
#
#   scripts/bridge-monitor/uninstall.sh              unload + remove the plists
#   scripts/bridge-monitor/uninstall.sh --purge      also the code snapshot and state
#   scripts/bridge-monitor/uninstall.sh --purge-all  also the records and the local config
#
# Only the three dev.openwalnut.bridge-monitor* labels are ever touched.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "bridge monitor: macOS only" >&2
  exit 1
fi

SUPPORT="${BRIDGE_MONITOR_SUPPORT_DIR:-$HOME/Library/Application Support/Walnut}"
LOGDIR="${BRIDGE_MONITOR_LOG_DIR:-$HOME/Library/Logs/Walnut/bridge-monitor}"
AGENTS="${BRIDGE_MONITOR_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
DOMAIN="gui/$(id -u)"
LABELS=(dev.openwalnut.bridge-monitor dev.openwalnut.bridge-monitor-summary dev.openwalnut.bridge-monitor-probe)

# --purge-all deletes the record dir, which can be overridden: only ever a
# directory of our own, named bridge-monitor (never $HOME, never /).
LOGDIR="${LOGDIR%/}"
case "$LOGDIR" in
  /*/bridge-monitor) ;;
  *) echo "bridge monitor: refusing record dir '$LOGDIR' (it must be an absolute path ending in /bridge-monitor)" >&2; exit 1 ;;
esac

PURGE=0
PURGE_ALL=0
NO_LOAD=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --purge-all) PURGE=1; PURGE_ALL=1 ;;
    --no-load) NO_LOAD=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

for label in "${LABELS[@]}"; do
  if [ "$NO_LOAD" = 0 ] && launchctl print "$DOMAIN/$label" > /dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$label" 2> /dev/null || true
    echo "unloaded $DOMAIN/$label"
  fi
  rm -f "$AGENTS/$label.plist"
done

if [ "$PURGE" = 1 ]; then
  rm -rf "$SUPPORT/bridge-monitor"
  echo "removed $SUPPORT/bridge-monitor"
fi
if [ "$PURGE_ALL" = 1 ]; then
  rm -rf "$LOGDIR"
  rm -f "$SUPPORT/bridge-monitor.json"
  echo "removed $LOGDIR and $SUPPORT/bridge-monitor.json"
fi
echo "bridge monitor uninstalled"
