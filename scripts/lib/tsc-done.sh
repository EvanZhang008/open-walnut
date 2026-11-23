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
