#!/bin/sh
# Rehearsal (b): this account's Walnut-shaped processes on the other machine that are NOT the rehearsal's (none of
# them is ever signalled), to compare before, during and after a run (real-world.ts):
#
#   ssh <host> sh -s -- <root> [<also not production>...] < scripts/leader-switch/real/snapshot.sh
#
# One line per process, sorted: `<pid> <start tick> <kind> <command line>`. kind `turn` is a session's CLI
# (claude, an ACP worker: they come and go with the machine's own sessions, and are not compared), `service` a
# Walnut one (its service, daemon, servers: a command line that names walnut, or a daemon twin's program). Other
# bun and node processes (an editor's servers, tools) come and go on a dev desk and are not listed. A process whose cwd or program is under <root> is the rehearsal's and is left out, as
# is this shell and what it runs, and a process under any further folder named (the driver's own test, where the
# "other machine" is this computer: its rehearsal processes are no production). The name match only picks what to
# list; nothing is signalled from it.
set -u
ROOT=${1:-}
ROOT=${ROOT%/}
# The path /proc names (cwd and exe are resolved).
[ -n "$ROOT" ] && [ -d "$ROOT" ] && ROOT=$(cd "$ROOT" && pwd -P)
[ $# -gt 0 ] && shift
ALSO="$*"
ME=$$
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$ME" ] && continue
  [ -O "$p" ] || continue
  s=$(cat "$p/stat" 2>/dev/null) || continue
  rest=${s##*) }
  set -- $rest
  ppid=$2
  [ "$ppid" = "$ME" ] && continue
  if [ -n "$ROOT" ]; then
    cwd=$(readlink "$p/cwd" 2>/dev/null)
    exe=$(readlink "$p/exe" 2>/dev/null)
    case "$cwd/" in "$ROOT"/*) continue ;; esac
    case "$exe" in "$ROOT"/*) continue ;; esac
    skip=no
    for d in $ALSO; do
      case "$cwd/" in "${d%/}"/*) skip=yes ;; esac
      case "$exe" in "${d%/}"/*) skip=yes ;; esac
    done
    [ "$skip" = yes ] && continue
  fi
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-300)
  case "$cmd" in
    *claude*|*acp*) kind=turn ;;
    *walnut*|*daemon-linux-*|*daemon-darwin-*) kind=service ;;
    *) continue ;;
  esac
  tick=$(echo "$rest" | awk '{print $20}')
  echo "$pid $tick $kind $cmd"
done | sort -n
