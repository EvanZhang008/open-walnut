#!/usr/bin/env bash
# The isolated host of the C5e real-machine run: a launcher of its own (not the machine's), started
# by hand on the real host, running `<bun> one-service-runner.ts --service` from the staged code and
# starting it again a second after it ends, as tests/helpers/replica-cluster.ts (startHostLauncher)
# plays a launcher. The entry runs as the session daemon until the mode file names the leader's
# Walnut, then as the host's one Walnut service (src/binary/service-entry.ts).
#
#   setsid nohup bash <root>/code/scripts/real/host-launcher.sh <root> </dev/null >/dev/null 2>&1 &
#
# Every path is under <root>: HOME, the XDG dirs, TMPDIR, the daemon dir, the state dir, the launcher
# dir, the CLI's config dir (so its machine id, door credential, transcripts and logs are all there).
# PATH is <root>/bin first (bun, the `claude` wrapper, and stand-ins for crontab, systemctl and ssh
# that refuse) and the system dirs, nothing of the account's own. `touch <root>/stop` and a SIGTERM
# to this launcher end it: the entry is told to stop, and no new one starts.
set -uo pipefail
root="$1"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
mkdir -p "$root/home/.local/state" "$root/home/.local/share" "$root/home/.config" "$root/home/.cache" "$root/home/.claude" \
  "$root/tmp" "$root/daemon" "$root/state/launcher" "$root/logs" "$root/work"
chmod 700 "$root" "$root/home" "$root/daemon" "$root/state"
export HOME="$root/home" TMPDIR="$root/tmp" SHELL=/bin/sh LANG=C.UTF-8
export XDG_STATE_HOME="$root/home/.local/state" XDG_DATA_HOME="$root/home/.local/share" XDG_CONFIG_HOME="$root/home/.config" XDG_CACHE_HOME="$root/home/.cache"
export PATH="$root/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export WALNUT_DAEMON_DIR="$root/daemon" WALNUT_STREAMS_DIR="$root/daemon/streams" WALNUT_SPAWN_JOURNAL="$root/daemon/spawn-journal.jsonl"
export WALNUT_LEGACY_STREAMS_DIR="$root/daemon/no-legacy" WALNUT_DAEMON_KEEP_SESSIONS=1
export WALNUT_DAEMON_STATE_DIR="$root/state" WALNUT_DAEMON_SUPERVISOR=launcher WALNUT_LAUNCHER_DIR="$root/state/launcher"
export WALNUT_TEST_SERVICE_DAEMON=1 WALNUT_TEST_SERVICE_AFTER="$root/code/scripts/real/host-probe.mts"
export WALNUT_HOST_RUNS_SESSIONS=1 CLAUDE_CONFIG_DIR="$root/home/.claude"
export C5E_REAL="$root" C5E_HOST_PROBE_PORT="${C5E_HOST_PROBE_PORT:-47911}" C5E_HOST_EVENTS="$root/logs/host-events.jsonl"
unset WALNUT_HOME_OVERRIDE OPEN_WALNUT_HOME WALNUT_SESSION_ID WALNUT_TASK_DIR
cd "$root/code"
echo $$ > "$root/launcher.pid"
child=0
trap 'touch "$root/stop"; [ "$child" -gt 1 ] && kill -TERM "$child" 2>/dev/null' TERM INT
echo "$(stamp) launcher $$ started" >> "$root/logs/entries.log"
while [ ! -f "$root/stop" ]; do
  "$root/bin/bun" tests/providers/fixtures/one-service-runner.ts --service >> "$root/logs/entry-stdout.log" 2>> "$root/logs/entry-stderr.log" &
  child=$!
  echo "$(stamp) entry $child started ($(LC_ALL=C ps -o lstart= -p "$child" 2>/dev/null))" >> "$root/logs/entries.log"
  wait "$child"
  rc=$?
  # A trapped signal ends the first wait early: wait for the entry itself.
  while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done
  echo "$(stamp) entry $child exited rc=$rc" >> "$root/logs/entries.log"
  child=0
  [ -f "$root/stop" ] && break
  sleep 1
done
echo "$(stamp) launcher $$ ended" >> "$root/logs/entries.log"
