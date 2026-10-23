# shellcheck shell=bash
# Sourced, never run: the one way the repo's bash scripts pick a bun.
#
#   . "$REPO_ROOT/scripts/lib/find-bun.sh"
#   walnut_find_bun "$REPO_ROOT" || { echo "$(walnut_bun_missing)" >&2; exit 1; }
#   "$BUN_BIN" ...
#
# A bun counts when it is the version package.json pins (packageManager
# "bun@X.Y.Z") or newer: an older bun builds a different runtime than the code
# was written for, and a script run through `bun run` can find an older bun
# first on PATH (seen: ~/.bun/bin/bun 1.3.9 while bun 1.4.4 ran the script).
# Candidates, in order: $WALNUT_BUN, the bun running this script
# ($npm_execpath under `bun run`), every bun on PATH, then the usual install
# places. The same order as src/core/host-server/host-file-build.ts findBun.
# bash 3.2 (macOS) compatible.

# The bun package.json in $1 pins, or empty.
walnut_bun_pin() {
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    "$1/package.json" 2>/dev/null | head -n 1
  return 0
}

# True when version $1 is $2 or newer (both X.Y.Z).
walnut_version_at_least() {
  local IFS=. i
  local -a a b
  read -r -a a <<< "$1"
  read -r -a b <<< "$2"
  for i in 0 1 2; do
    if (( 10#${a[i]:-0} != 10#${b[i]:-0} )); then
      (( 10#${a[i]:-0} > 10#${b[i]:-0} ))
      return
    fi
  done
  return 0
}

# Pick a bun for the repo at $1. Sets BUN_BIN and BUN_VERSION (empty when none
# fits), BUN_PIN (the pinned version, or empty) and BUN_SEEN (the older buns it
# passed over). Returns 1 when none fits.
walnut_find_bun() {
  local root="${1:-.}" cand v dir tried="|"
  local -a cands=()
  BUN_PIN="$(walnut_bun_pin "$root")"
  BUN_BIN="" BUN_VERSION="" BUN_SEEN=""
  if [[ -n "${WALNUT_BUN:-}" ]]; then cands+=("$WALNUT_BUN"); fi
  case "${npm_execpath:-}" in */bun) cands+=("$npm_execpath") ;; esac
  local IFS=:
  for dir in $PATH; do
    if [[ -n "$dir" ]]; then cands+=("$dir/bun"); fi
  done
  unset IFS
  cands+=("$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun)
  for cand in "${cands[@]}"; do
    [[ "$cand" == /* && -x "$cand" && ! -d "$cand" ]] || continue
    [[ "$tried" != *"|$cand|"* ]] || continue
    tried="$tried$cand|"
    v="$("$cand" --version 2>/dev/null || true)"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || continue
    v="${BASH_REMATCH[0]}"
    if [[ -z "$BUN_PIN" ]] || walnut_version_at_least "$v" "$BUN_PIN"; then
      BUN_BIN="$cand"
      BUN_VERSION="$v"
      return 0
    fi
    BUN_SEEN="${BUN_SEEN:+$BUN_SEEN, }$v at $cand"
  done
  return 1
}

# One sentence for a script to print when walnut_find_bun found none.
walnut_bun_missing() {
  local want="bun"
  if [[ -n "${BUN_PIN:-}" ]]; then want="bun $BUN_PIN or newer (package.json packageManager)"; fi
  if [[ -n "${BUN_SEEN:-}" ]]; then
    printf 'this needs %s; found only %s. Set WALNUT_BUN to a newer one, or run: bun upgrade' "$want" "$BUN_SEEN"
  else
    printf 'this needs %s, and none was found (WALNUT_BUN, PATH, ~/.bun/bin). Install it: curl -fsSL https://bun.sh/install | bash' "$want"
  fi
}
