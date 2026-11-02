# shellcheck shell=bash
# Stop a process by the pid a script recorded when it started it. Source it.
#
# Never by name or pattern (pkill, killall, pgrep piped to kill): a pattern matches
# every process whose command line carries the text, and on 2026-10-31 one such kill
# matched the command line of every agent session on the machine and ended them all.
# A script records the pid it started ($!) and kills exactly that one.
#
#   walnut_pid_record <file> <pid>
#       writes the pid and its start time, then the recording script's own pid ($$)
#       and start time, where a later run can read them (the script's work dir).
#   walnut_pid_stop_recorded <file> <marker>
#       stops the process an earlier run recorded in <file>, if it is still alive,
#       still has the recorded start time, and its command line still contains
#       <marker> (a pid is reused once its process is gone, so a stale file never
#       signals someone else's process), waits for it to exit (about 5 s), and
#       removes the file. 1 when it would not exit. A process whose recording run
#       is still alive is that run's, not an earlier one's: it is left running and
#       its record kept (the caller's port check then refuses to start).
#   walnut_pid_stop_child <pid>
#       stops a child this shell started, and waits for it (about 5 s). Safe with an
#       empty or dead pid, and under set -e; 1 when it would not exit.

walnut_pid_valid() { [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -gt 1 ]; }

# The process's start time as ps prints it, spaces squeezed; empty when it is gone.
walnut_pid_start() {
  ps -o lstart= -p "$1" 2>/dev/null | awk '{ $1 = $1; print }' || true
}

walnut_pid_record() {
  walnut_pid_valid "${2:-}" || return 0
  printf '%s\n%s\n%s\n%s\n' "$2" "$(walnut_pid_start "$2")" "$$" "$(walnut_pid_start "$$")" > "$1"
}

# Wait up to $2 seconds (wall clock, default 5) for a pid to go away; 0 when it did.
walnut_pid_wait_gone() {
  local pid="$1" end=$((SECONDS + ${2:-5}))
  while :; do
    kill -0 "$pid" 2>/dev/null || return 0
    # An exited child of this shell stays a zombie until it is waited for.
    case "$(ps -o stat= -p "$pid" 2>/dev/null || true)" in Z*) return 0 ;; esac
    [ "$SECONDS" -lt "$end" ] || break
    sleep 0.1
  done
  ! kill -0 "$pid" 2>/dev/null
}

walnut_pid_stop_recorded() {
  local file="$1" marker="$2" pid start owner owner_start cmd
  pid="$(sed -n 1p "$file" 2>/dev/null || true)"
  start="$(sed -n 2p "$file" 2>/dev/null || true)"
  owner="$(sed -n 3p "$file" 2>/dev/null || true)"
  owner_start="$(sed -n 4p "$file" 2>/dev/null || true)"
  if ! walnut_pid_valid "$pid" || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"; return 0
  fi
  # Recorded by a run that is still going (its pid with its own start time): that
  # run's process, not debris. Leave both alone.
  if walnut_pid_valid "$owner" && [ "$owner" != "$$" ] && [ -n "$owner_start" ] \
     && [ "$(walnut_pid_start "$owner")" = "$owner_start" ]; then
    printf '%s\n' "recorded-pid: pid $pid ($marker) belongs to the run of pid $owner, which is still going; left running" >&2
    return 0
  fi
  # The pid now belongs to another process: a different start time, or a command
  # without the marker. Forget the record, signal nothing.
  if [ -n "$start" ] && [ "$(walnut_pid_start "$pid")" != "$start" ]; then
    rm -f "$file"; return 0
  fi
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in
    *"$marker"*) ;;
    *) rm -f "$file"; return 0 ;;
  esac
  kill "$pid" 2>/dev/null || true
  if ! walnut_pid_wait_gone "$pid" 5; then
    printf '%s\n' "recorded-pid: pid $pid ($marker) did not exit after SIGTERM; left running" >&2
    return 1
  fi
  rm -f "$file"
}

walnut_pid_stop_child() {
  local pid="${1:-}"
  walnut_pid_valid "$pid" || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  if walnut_pid_wait_gone "$pid" 5; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi
  printf '%s\n' "recorded-pid: child $pid did not exit after SIGTERM; left running" >&2
  return 1
}
