#!/bin/sh
# Rehearsal (b), after the cleanup: the files (not folders) this account wrote on the other machine since the run
# began, in its temp folders and its home, for the evidence (real-world.ts; read only, nothing is opened or changed):
#
#   ssh <host> sh -s -- <epoch seconds> < scripts/leader-switch/real/written-since.sh
#
# The machine's own Walnut writes its own files all the time; its home and its daemon dir (~/.open-walnut,
# /tmp/open-walnut) are never read, so this lists what else changed: a file of the run outside its root would be here.
# At most 60 s each, one filesystem each; a folder that took longer says its list is partial.
set -u
SINCE=${1:-}
case "$SINCE" in
  ''|*[!0-9]*) echo "written-since: no start ($SINCE)"; exit 2 ;;
esac
H=$(getent passwd "$(id -u)" | cut -d: -f6)
for d in /tmp /var/tmp "$H"; do
  [ -d "$d" ] || continue
  timeout 60 find "$d" -xdev \( -path "$H/.open-walnut" -o -path /tmp/open-walnut \) -prune -o \
    -user "$(id -u)" ! -type d -newermt "@$SINCE" -print 2>/dev/null
  [ $? -eq 124 ] && echo "written-since: $d timed out after 60 s: the list of $d is partial"
done | sort -u
