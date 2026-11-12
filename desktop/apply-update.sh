#!/bin/sh
# Puts a downloaded Walnut.app in place of the running one and opens it: the
# step Squirrel's ShipIt does for an Electron app's quitAndInstall.
# AppUpdater.swift copies the verified new app NEXT TO the old one first (same
# folder, same volume, so both moves below are renames) and starts this script;
# the app then stops its server and quits. Nothing is replaced while it runs.
#
#   apply-update.sh <app pid> <installed Walnut.app> <new app> <log file>
#
# A pid of 0 means no app to wait for: how a build you made yourself goes in
# place (desktop/README.md, "Putting a build in place"). It refuses while the
# app itself still runs, and opens the new app in the background.
#
# Never keep the old app as a copy: every copy is one more app with Walnut's
# identity, and a process left running from one asks macOS for permissions
# (Local Network, files) as that copy (2026-11-12). The old app is renamed
# aside only for the swap and deleted in the same run, and the session hosts
# that ran from it (the daemon's, a deploy's server) are ended so they start
# again under the new app.
#
# Any failure puts the old app back and opens it, so the user is never left
# without a Walnut. Exit codes: 0 updated, 1 the old app kept, 2 bad arguments.

pid="$1"; target="$2"; staged="$3"; log="${4:-/dev/null}"
# Tests swap the opener for a stub (tests/scripts/apply-update.test.ts).
open_app="${WALNUT_APPLY_UPDATE_OPEN:-/usr/bin/open}"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$log"; }

if [ -z "$pid" ] || [ -z "$target" ] || [ -z "$staged" ]; then
  say "usage: apply-update.sh <pid> <target> <staged> <log>"; exit 2
fi
case "$pid" in *[!0-9]*) say "refusing a pid that is not a number: $pid"; exit 2 ;; esac
case "$target" in *.app) ;; *) say "refusing a target that is not an .app: $target"; exit 2 ;; esac
[ -d "$staged" ] || { say "no staged app at $staged"; exit 2; }

exe="$target/Contents/MacOS/Walnut"
# Processes started from the app's executable: "<pid> host" for a session host
# (`Walnut --session-host -- <program>`), "<pid> app" for anything else. Of a
# host's two generations (it re-execs itself once to disclaim) only the outer
# one is listed: a signal to it reaches the inner one and the program below.
app_processes() {
  ps -A -o pid= -o ppid= -o command= 2>/dev/null | awk -v exe="$exe" '
    { cmd = $0; sub(/^ *[0-9]+ +[0-9]+ /, "", cmd)
      if (cmd != exe && index(cmd, exe " ") != 1) next
      if (index(cmd, exe " --session-host ") == 1) host[$1] = $2; else other[$1] = 1 }
    END { for (p in host) if (!(host[p] in host)) print p " host"
          for (p in other) print p " app" }' || true
}

if [ "$pid" = 0 ]; then
  if app_processes | grep -q ' app$'; then
    say "Walnut is still running from $target; quit it first"
    exit 1
  fi
  open_flags="-g"
else
  open_flags=""
  say "waiting for pid $pid to quit"
  # 600 ticks of 0.1 s; a test shortens the wait.
  ticks="${WALNUT_APPLY_UPDATE_WAIT_TICKS:-600}"
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt "$ticks" ]; then
      # The app never quit (an alert, a hang): leave everything as it is.
      say "pid $pid still running after $ticks ticks; update not applied"
      exit 1
    fi
    sleep 0.1
  done
fi

# Taken before the swap: after it, a host the new app starts has the same command line.
old_hosts="$(app_processes | awk '$2 == "host" { print $1 }')"

backup="${target%.app}.previous-$$.app"
if ! mv "$target" "$backup"; then
  say "could not move $target aside"
  "$open_app" $open_flags "$target"
  exit 1
fi
if ! mv "$staged" "$target"; then
  say "could not move $staged into place; putting the old app back"
  mv "$backup" "$target"
  "$open_app" $open_flags "$target"
  exit 1
fi

# The new app is in place, so whatever starts a host again (the server for its
# daemon, launchd for a deploy's server) starts it from the new app. SIGTERM:
# the host passes it on, the daemon keeps its sessions for the next one.
if [ -n "$old_hosts" ]; then
  say "ending the session hosts of the old app: $(echo $old_hosts)"
  for h in $old_hosts; do
    [ "$h" -gt 1 ] 2>/dev/null && kill -TERM "$h" 2>/dev/null
  done
  # 200 ticks of 0.1 s; a test shortens the wait.
  host_ticks="${WALNUT_APPLY_UPDATE_HOST_TICKS:-200}"
  i=0
  while :; do
    alive=""
    for h in $old_hosts; do kill -0 "$h" 2>/dev/null && alive="$alive $h"; done
    [ -z "$alive" ] && break
    i=$((i + 1))
    if [ "$i" -gt "$host_ticks" ]; then
      say "session hosts still running from the old app after $host_ticks ticks:$alive"
      break
    fi
    sleep 0.1
  done
fi

rm -rf "$backup"
# An old app a run before this one could not delete (it was stopped mid-swap).
for left in "${target%.app}".previous-*.app; do
  [ -d "$left" ] || continue
  owner="${left##*.previous-}"; owner="${owner%.app}"
  kill -0 "$owner" 2>/dev/null && continue
  rm -rf "$left" && say "removed a leftover old app: $left"
done
say "updated $target"
"$open_app" $open_flags "$target"
exit 0
