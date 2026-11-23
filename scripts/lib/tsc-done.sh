# shellcheck shell=bash
# A web/ type check another tool already ran on an exact commit (a land check on another machine
# runs `tsc --noEmit` on web/ of the very tree it lands) is recorded as an empty file named after
# that commit in WALNUT_TSC_DONE_DIR (default ~/.cache/open-walnut/tsc-done). dev-prod.sh then skips
# its own web/ type check for that commit only, and only while the tree it builds is that commit
# unchanged: any other tree, or a record that is missing, is checked as before. The check costs a
# deploy 3 to 4 GB of memory and a minute of CPU on the machine that serves production.
walnut_tsc_done_dir() { printf '%s\n' "${WALNUT_TSC_DONE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/open-walnut/tsc-done}"; }
walnut_tsc_done() { # $1 = the repo root; 0 when web/ of its HEAD, unchanged, passed already
  local root=$1 head
  head=$(git -C "$root" rev-parse HEAD 2>/dev/null) || return 1
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -f "$(walnut_tsc_done_dir)/$head" ]] || return 1
  git -C "$root" diff --quiet HEAD -- web 2>/dev/null || return 1
  [[ -z "$(git -C "$root" ls-files --others --exclude-standard -- web 2>/dev/null)" ]]
}
# A check another tool is still running on that exact commit is marked by a file of the same name in
# pending/ (2026-11-23: a main written by a land on top of another gets its web/ check on another
# machine a few minutes after it lands, and the deploy that began meanwhile ran its own, 10 minutes
# at a load of 40). walnut_tsc_wait waits for that check's record, at most WALNUT_TSC_DONE_WAIT_SECS
# (300): 0 once the record is there (skip), 1 when nothing is pending for the commit, the pending
# mark goes (that check failed or was given up) or the wait runs out (check here as before). A
# pending mark older than WALNUT_TSC_PENDING_MAX_SECS (900) is no longer believed.
walnut_tsc_wait() { # $1 = the repo root
  local root=$1 head pend at now start=$SECONDS wait="${WALNUT_TSC_DONE_WAIT_SECS:-300}" max="${WALNUT_TSC_PENDING_MAX_SECS:-900}" poll="${WALNUT_TSC_DONE_POLL_SECS:-5}"
  [[ "$wait" =~ ^[0-9]+$ ]] || wait=300
  [[ "$max" =~ ^[0-9]+$ ]] || max=900
  [[ "$poll" =~ ^[0-9]+$ ]] && (( poll > 0 )) || poll=5
  head=$(git -C "$root" rev-parse HEAD 2>/dev/null) || return 1
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
  pend="$(walnut_tsc_done_dir)/pending/$head"
  [[ -f "$pend" ]] || return 1
  at=$(stat -c %Y "$pend" 2>/dev/null || stat -f %m "$pend" 2>/dev/null || echo 0)
  now=$(date +%s)
  (( now - at < max )) || return 1
  echo "web/ type-check: another machine is checking commit ${head:0:10}; waiting for its result (at most ${wait}s)."
  while (( SECONDS - start < wait )); do
    if walnut_tsc_done "$root"; then return 0; fi
    [[ -f "$pend" ]] || { echo "web/ type-check: that check gave no pass for ${head:0:10}; checking here."; return 1; }
    sleep "$poll"
  done
  walnut_tsc_done "$root" && return 0
  echo "web/ type-check: no result for ${head:0:10} after ${wait}s; checking here."
  return 1
}
