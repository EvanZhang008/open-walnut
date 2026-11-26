#!/bin/sh
# Rehearsal (b)'s cleanup on the other machine (scripts/leader-switch/real-world.ts runs it at every end, also
# after a failure; a person runs the same file by hand when the driver died):
#
#   ssh <host> sh -s -- <root> [--keep-root] < scripts/leader-switch/real/cleanup.sh
#
# Ends every process of the rehearsal there, by pid only, and removes <root>. A process is the rehearsal's when
#   - it belongs to this account, and
#   - its working directory or its program is under <root> (read from /proc/<pid>/cwd and /proc/<pid>/exe), and
#   - it started after <root>/run/started (the start of the shell that made <root>, in this machine's clock
#     ticks since boot, the unit /proc/<pid>/stat counts a start in: no wall clock is compared).
# and it has no terminal (a process with one is a person's, who went into <root>: left alone).
# Every check is made again right before each signal, with the start tick read before and after it (a pid that
# ended and was reused in between is not signalled). The pids the driver's agent recorded (<root>/run/pids.jsonl)
# are checked too: one still running as recorded (the same start tick) but no longer under <root> is named and
# keeps <root>. Each pid is printed, then sent SIGTERM; one still there after 20 s is checked again and sent
# SIGKILL. A pid that fails a check is left alone and printed. Nothing is ever signalled by its name or command
# line, and no process group is signalled.
# <root> is removed (made writable first: the standby copies are read-only on purpose) only once no process of the
# rehearsal is left, unless --keep-root. Exit 0: clean; 3: a process is left (named), <root> kept; 2: refused.
set -u
ROOT=${1:-}
KEEP=${2:-}
case "$ROOT" in
  /*/*) ;;
  *) echo "cleanup: refusing root '$ROOT': an absolute folder at least two levels deep"; exit 2 ;;
esac
case "/$ROOT/" in
  */./*|*/../*) echo "cleanup: refusing root '$ROOT': no . or .. parts"; exit 2 ;;
esac
ROOT=${ROOT%/}
if [ ! -f "$ROOT/run/started" ] || [ ! -f "$ROOT/run/id" ]; then
  echo "cleanup: $ROOT/run/started or $ROOT/run/id is missing: not a root this rehearsal made; nothing done"
  exit 2
fi
# The path /proc names (cwd and exe are resolved): the root through no symlink.
ROOT=$(cd "$ROOT" && pwd -P) || { echo "cleanup: cannot resolve the root"; exit 2; }
case "$ROOT" in
  /*/*) ;;
  *) echo "cleanup: refusing root '$ROOT' (resolved): an absolute folder at least two levels deep"; exit 2 ;;
esac
START=$(cat "$ROOT/run/started")
case "$START" in
  ''|*[!0-9]*) echo "cleanup: $ROOT/run/started holds no start ($START); nothing done"; exit 2 ;;
esac
ME=$$
cd / || exit 2

# (The functions use names of their own, _x: sh has no local variables, and the loops below keep theirs.)
# The start of a pid in clock ticks since boot, or nothing when it is gone.
started_at() {
  _s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  _r=${_s##*) }
  # Field 22 of stat is the start time; after "pid (comm) " it is the 20th (comm may hold spaces).
  _t=$(echo "$_r" | awk '{print $20}')
  [ -n "$_t" ] || return 1
  echo "$_t"
}
# Gone, or a zombie its parent has not reaped yet (it runs nothing any more).
gone() {
  _s=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  _r=${_s##*) }
  [ "${_r%% *}" = Z ]
}
under_root() {
  _cwd=$(readlink "/proc/$1/cwd" 2>/dev/null)
  _exe=$(readlink "/proc/$1/exe" 2>/dev/null)
  case "$_cwd/" in "$ROOT"/*) return 0 ;; esac
  case "$_exe" in "$ROOT"/*) return 0 ;; esac
  return 1
}
mine() { [ -O "/proc/$1" ]; }
# A terminal's process (stat field 7, tty_nr, not 0): a person's shell or what it runs.
on_tty() {
  _s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  _r=${_s##*) }
  _y=$(echo "$_r" | awk '{print $5}')
  [ -n "$_y" ] && [ "$_y" != 0 ]
}
# Every check for a signal, with the start tick the same before and after them: still the same process.
ours_now() {
  _a=$(started_at "$1") || return 1
  [ "$_a" = "$2" ] || return 1
  mine "$1" && under_root "$1" && ! on_tty "$1" || return 1
  _b=$(started_at "$1") || return 1
  [ "$_b" = "$2" ]
}
describe() {
  echo "pid $1 started $(started_at "$1" 2>/dev/null) cwd $(readlink "/proc/$1/cwd" 2>/dev/null) exe $(readlink "/proc/$1/exe" 2>/dev/null) cmd $(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | cut -c1-200)"
}

# Every candidate: each process of this account under <root>, and each recorded pid.
cands=""
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" -gt 1 ] 2>/dev/null || continue
  [ "$pid" = "$ME" ] && continue
  mine "$pid" || continue
  under_root "$pid" && cands="$cands $pid"
done
recorded_left=""
if [ -f "$ROOT/run/pids.jsonl" ]; then
  for e in $(sed -n 's/.*"pid":\([0-9][0-9]*\),"tick":\([0-9][0-9]*\).*/\1:\2/p' "$ROOT/run/pids.jsonl" | sort -u); do
    pid=${e%%:*}
    [ -d "/proc/$pid" ] || continue
    case " $cands " in *" $pid "*) continue ;; esac
    if [ "$(started_at "$pid")" = "${e#*:}" ] && ! gone "$pid"; then
      echo "LEFT ALONE (recorded and still running, but its cwd and program are not under $ROOT): $(describe "$pid")"
      recorded_left="$recorded_left $pid"
    else
      echo "LEFT ALONE (a recorded pid now another process's): $(describe "$pid")"
    fi
  done
fi

killed=""
for pid in $cands; do
  st=$(started_at "$pid") || continue
  if [ "$st" -lt "$START" ]; then
    echo "LEFT ALONE (under $ROOT but started before the rehearsal, tick $START): $(describe "$pid")"
    continue
  fi
  if on_tty "$pid"; then
    echo "LEFT ALONE (a terminal's process: a person's): $(describe "$pid")"
    continue
  fi
  ours_now "$pid" "$st" || { echo "LEFT ALONE (changed while checked): pid $pid"; continue; }
  echo "TERM $(describe "$pid")"
  if kill -TERM "$pid" 2>/dev/null; then killed="$killed $pid:$st"; else echo "TERM failed: pid $pid"; fi
done

i=0
while [ $i -lt 20 ]; do
  left=""
  for e in $killed; do gone "${e%%:*}" || left="$left $e"; done
  [ -z "$left" ] && break
  sleep 1
  i=$((i + 1))
done
for e in $killed; do
  pid=${e%%:*}
  gone "$pid" && continue
  # The same process (its start time), still the rehearsal's: SIGKILL.
  if ours_now "$pid" "${e#*:}"; then
    echo "KILL $(describe "$pid")"
    kill -KILL "$pid" 2>/dev/null || echo "KILL failed: pid $pid"
  fi
done
sleep 1

left_over="$recorded_left"
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$ME" ] && continue
  gone "$pid" && continue
  case " $left_over " in *" $pid "*) continue ;; esac
  mine "$pid" 2>/dev/null && under_root "$pid" && left_over="$left_over $pid"
done
if [ -n "$left_over" ]; then
  for pid in $left_over; do echo "LEFT $(describe "$pid")"; done
  echo "cleanup: a process of the rehearsal is still there; $ROOT kept"
  exit 3
fi
echo "cleanup: no process of the rehearsal left"
if [ "$KEEP" = "--keep-root" ]; then
  echo "cleanup: $ROOT kept (--keep-root)"
  exit 0
fi
chmod -R u+w "$ROOT" 2>/dev/null
rm -rf "$ROOT" && echo "cleanup: $ROOT removed"
[ ! -e "$ROOT" ]
