#!/bin/bash
set -euo pipefail

LOG_DIR="${WALNUT_MONITOR_LOG_DIR:-$HOME/.open-walnut/logs}"
LOG_FILE="$LOG_DIR/desktop-health.log"
PREVIOUS_LOG="$LOG_DIR/desktop-health.previous.log"
MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(stat -f %z "$LOG_FILE")" -ge "$MAX_BYTES" ]; then
    rm -f "$PREVIOUS_LOG"
    mv "$LOG_FILE" "$PREVIOUS_LOG"
fi

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
battery="$(pmset -g batt | tail -1 | tr -s ' ' | sed 's/^[[:space:]]*//')"
load="$(sysctl -n vm.loadavg | tr -d '{}')"
listener="$(ps -axo pid=,command= | awk '/dist\/cli.js web --port 3456/ && !/awk/ && first == "" { first=$1 } END { print first }')"
walnut="$(ps -axo pid=,ppid=,%cpu=,%mem=,rss=,comm= | awk '$6 == "/Applications/Walnut.app/Contents/MacOS/Walnut" { print }' | xargs || true)"
contacts="$(ps -axo pid=,%cpu=,%mem=,comm= | awk '/AddressBookManager|AddressBookSourceSync|Contacts.framework\/Support\/contactsd$/ { printf "%s%s", sep, $0; sep=" | " }' || true)"
top_cpu="$(ps -axo pid=,%cpu=,%mem=,comm= | sort -k2 -nr | sed -n '1,8p' | tr '\n' '|' | sed 's/|$//')"

{
    printf 'timestamp=%s load="%s" port3456_pid="%s"\n' "$timestamp" "$load" "$listener"
    printf 'battery="%s"\n' "$battery"
    printf 'walnut="%s"\n' "$walnut"
    printf 'contacts="%s"\n' "$contacts"
    printf 'top_cpu="%s"\n' "$top_cpu"
    printf '%s\n' '---'
} >> "$LOG_FILE"
