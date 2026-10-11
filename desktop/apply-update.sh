#!/bin/sh
# Puts a downloaded Walnut.app in place of the running one and opens it: the
# step Squirrel's ShipIt does for an Electron app's quitAndInstall (T3 Code).
# AppUpdater.swift copies the verified new app NEXT TO the old one first (same
# folder, same volume, so both moves below are renames) and starts this script;
# the app then stops its server and quits. Nothing is replaced while it runs.
#
#   apply-update.sh <app pid> <installed Walnut.app> <staged new app> <log file>
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
case "$target" in *.app) ;; *) say "refusing a target that is not an .app: $target"; exit 2 ;; esac
[ -d "$staged" ] || { say "no staged app at $staged"; exit 2; }

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

backup="${target%.app}.previous-$$.app"
if ! mv "$target" "$backup"; then
  say "could not move $target aside"
  "$open_app" "$target"
  exit 1
fi
if ! mv "$staged" "$target"; then
  say "could not move $staged into place; putting the old app back"
  mv "$backup" "$target"
  "$open_app" "$target"
  exit 1
fi
rm -rf "$backup"
say "updated $target"
"$open_app" "$target"
exit 0
