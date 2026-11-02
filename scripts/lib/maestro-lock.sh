# shellcheck shell=bash
# One Maestro run at a time on this machine: a lock directory holding its holder's
# pid. Source it, then walnut_maestro_lock_acquire <max-wait-seconds> and, when the
# run ends, walnut_maestro_lock_release.
#
# A lock is removed only by its own holder, or as a stale lock whose holder is gone,
# judged the way the machine's simulator queue judges a lease: the lock is held while
# its pid file names a live process, or while the pid file is still empty and the
# directory is younger than 60 s (its holder is between mkdir and writing the pid).
# A stale lock is removed under a short mutex ($lock.mutex, itself broken after 30 s),
# after the holder is read again, so two waiters never remove a lock a third just took.
#
# The lock directory only ever holds its `pid` file, so it is removed with
# `rm -f <lock>/pid; rmdir <lock>`, never recursively: a directory holding anything
# else is not a lock this helper made, and is reported and left alone.
#
# WALNUT_MAESTRO_LOCK names the lock (default /tmp/maestro-ios.lock; tests point it
# at a temp dir). WALNUT_MAESTRO_LOCK_POLL is the wait between tries, in whole
# seconds (default 10).

WALNUT_MAESTRO_LOCK="${WALNUT_MAESTRO_LOCK:-/tmp/maestro-ios.lock}"
WALNUT_MAESTRO_LOCK_HOLDER=""

walnut_maestro_lock_say() { printf 'maestro-lock: %s\n' "$*" >&2; }

walnut_maestro_lock_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || date +%s
}

# 0 while the lock is held (sets WALNUT_MAESTRO_LOCK_HOLDER), 1 when it is free or stale.
walnut_maestro_lock_live() {
  local l="$WALNUT_MAESTRO_LOCK" age
  WALNUT_MAESTRO_LOCK_HOLDER=""
  [ -d "$l" ] || return 1
  WALNUT_MAESTRO_LOCK_HOLDER="$(cat "$l/pid" 2>/dev/null || true)"
  if [ -n "$WALNUT_MAESTRO_LOCK_HOLDER" ]; then
    kill -0 "$WALNUT_MAESTRO_LOCK_HOLDER" 2>/dev/null
    return
  fi
  age=$(( $(date +%s) - $(walnut_maestro_lock_mtime "$l") ))
  [ "$age" -lt 60 ]
}

# The short mutex around a reclaim; bounded by the wall clock (about 5 s).
walnut_maestro_lock_mutex() {
  local m="$WALNUT_MAESTRO_LOCK.mutex" end=$((SECONDS + 5)) age
  while :; do
    mkdir "$m" 2>/dev/null && return 0
    [ -d "$m" ] || return 1
    age=$(( $(date +%s) - $(walnut_maestro_lock_mtime "$m") ))
    if [ "$age" -gt 30 ]; then rmdir "$m" 2>/dev/null || true; fi
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 0.1
  done
}

# Remove a stale lock: only under the mutex, only while it is still stale, and only
# when it holds nothing but its pid file. 0 removed (or already gone), 1 still held
# or the mutex is busy (wait and try again), 2 not removable (report, do not wait).
walnut_maestro_lock_reclaim() {
  local m="$WALNUT_MAESTRO_LOCK.mutex" rc=1 extra
  walnut_maestro_lock_mutex || return 1
  if [ ! -d "$WALNUT_MAESTRO_LOCK" ]; then
    rc=0
  elif walnut_maestro_lock_live; then
    rc=1
  else
    extra="$(ls -A "$WALNUT_MAESTRO_LOCK" 2>/dev/null | grep -vx pid | head -3 | tr '\n' ' ' || true)"
    if [ -n "$extra" ]; then
      walnut_maestro_lock_say "$WALNUT_MAESTRO_LOCK has no live holder but holds more than a pid file (${extra% }); it is not a lock this helper made, so it is left as it is. Remove it yourself if it is debris."
      rc=2
    else
      walnut_maestro_lock_say "removing a stale lock (holder ${WALNUT_MAESTRO_LOCK_HOLDER:-none recorded} is gone)"
      rm -f "$WALNUT_MAESTRO_LOCK/pid"
      if rmdir "$WALNUT_MAESTRO_LOCK" 2>/dev/null; then
        rc=0
      else
        walnut_maestro_lock_say "could not remove the stale lock $WALNUT_MAESTRO_LOCK; left as it is"
        rc=2
      fi
    fi
  fi
  rmdir "$m" 2>/dev/null || true
  return "$rc"
}

walnut_maestro_lock_acquire() {
  local max="${1:-1800}" poll="${WALNUT_MAESTRO_LOCK_POLL:-10}" waited=0 said="" retried="" parent rc
  case "$poll" in ''|*[!0-9]*) walnut_maestro_lock_say "WALNUT_MAESTRO_LOCK_POLL must be a whole number of seconds, got '$poll'"; return 1 ;; esac
  case "$max" in ''|*[!0-9]*) walnut_maestro_lock_say "the longest wait must be a whole number of seconds, got '$max'"; return 1 ;; esac
  [ "$poll" -ge 1 ] || { walnut_maestro_lock_say "WALNUT_MAESTRO_LOCK_POLL must be at least 1 second"; return 1; }
  parent="$(dirname "$WALNUT_MAESTRO_LOCK")"
  while :; do
    if mkdir "$WALNUT_MAESTRO_LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$WALNUT_MAESTRO_LOCK/pid"
      return 0
    fi
    # mkdir failing for a reason waiting cannot fix: say so now instead of spinning.
    if [ ! -d "$parent" ]; then
      walnut_maestro_lock_say "cannot take $WALNUT_MAESTRO_LOCK: its directory $parent does not exist"
      return 1
    fi
    if [ -e "$WALNUT_MAESTRO_LOCK" ] && [ ! -d "$WALNUT_MAESTRO_LOCK" ]; then
      walnut_maestro_lock_say "cannot take $WALNUT_MAESTRO_LOCK: it exists and is not a directory"
      return 1
    fi
    if [ ! -e "$WALNUT_MAESTRO_LOCK" ] && [ ! -w "$parent" ]; then
      walnut_maestro_lock_say "cannot take $WALNUT_MAESTRO_LOCK: $parent is not writable"
      return 1
    fi
    if [ -d "$WALNUT_MAESTRO_LOCK" ] && ! walnut_maestro_lock_live; then
      rc=0
      walnut_maestro_lock_reclaim || rc=$?
      [ "$rc" -eq 2 ] && return 1
      # Removed: take it at once, but only once before the next wait.
      if [ "$rc" -eq 0 ] && [ -z "$retried" ]; then retried=1; continue; fi
    fi
    retried=""
    if [ "$waited" -ge "$max" ]; then
      walnut_maestro_lock_say "gave up after ${waited}s; $WALNUT_MAESTRO_LOCK is held by pid ${WALNUT_MAESTRO_LOCK_HOLDER:-?}"
      return 1
    fi
    [ -n "$said" ] || { walnut_maestro_lock_say "$WALNUT_MAESTRO_LOCK is held by pid ${WALNUT_MAESTRO_LOCK_HOLDER:-?}; waiting"; said=1; }
    sleep "$poll"; waited=$((waited + poll))
  done
}

# Give the lock back: only when this shell holds it.
walnut_maestro_lock_release() {
  [ -d "$WALNUT_MAESTRO_LOCK" ] || return 0
  if [ "$(cat "$WALNUT_MAESTRO_LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$WALNUT_MAESTRO_LOCK/pid"
    rmdir "$WALNUT_MAESTRO_LOCK" 2>/dev/null \
      || walnut_maestro_lock_say "$WALNUT_MAESTRO_LOCK holds files other than its pid; its pid is cleared and the directory is left in place"
  else
    walnut_maestro_lock_say "$WALNUT_MAESTRO_LOCK is not this run's (pid $$); left as it is"
  fi
  return 0
}
