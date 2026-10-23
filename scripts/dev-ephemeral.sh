#!/usr/bin/env bash
# The isolated test server agents use for live checks (`bun run dev:ephemeral`).
#
#   bun run dev:ephemeral                    build dist/ from this tree, run `bun dist/cli.js web --ephemeral`
#   bun run dev:ephemeral --file <path>      run a compiled walnut file instead: `<path> web --ephemeral`
#   bun run dev:ephemeral --file             build this tree's file for this machine first
#                                            (bun scripts/build-binary.mjs, about a minute), then run it
#   WALNUT_EPHEMERAL_FILE=<path>             same as --file <path>
#
# The default stays the source build: the compiled file costs a minute of build
# on top of the dist. Either way the launcher is the same code
# (src/commands/web.ts runEphemeralLauncher), so the isolation is the same: its
# own copy of the data, its own local daemon, the copied cron jobs paused, the
# phone push tokens removed, no remote hosts unless WALNUT_EPHEMERAL_REMOTE_HOSTS=1.
# The file also unpacks its runtime tree (the web app, data files); that goes to
# $TMPDIR/walnut-ephemeral-runtime/<build>, never into the real data home, and
# the test server's own daemon is handed the same tree (src/providers/local-daemon.ts).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

file="${WALNUT_EPHEMERAL_FILE:-}"
build_file=0
while (( $# > 0 )); do
  case "$1" in
    --file)
      if [[ $# -ge 2 && "$2" != -* ]]; then file="$2"; shift 2; else build_file=1; shift; fi ;;
    --file=*) file="${1#--file=}"; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "dev-ephemeral: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
done

# The bun that builds and runs the source build: WALNUT_BUN, PATH, then the usual
# install places (a `bash scripts/dev-ephemeral.sh` from a thin PATH finds it too).
find_bun() {
  local cand
  for cand in "${WALNUT_BUN:-}" "$(command -v bun || true)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [[ -n "$cand" && -x "$cand" && ! -d "$cand" ]]; then printf '%s' "$cand"; return 0; fi
  done
  return 1
}

if [[ -z "$file" && "$build_file" == 0 ]]; then
  if ! BUN="$(find_bun)"; then
    echo "dev-ephemeral: no bun found (WALNUT_BUN, PATH, ~/.bun/bin); install it: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
  # Progress to stderr: stdout carries only the launcher's one JSON line.
  PATH="$(dirname "$BUN"):$PATH" "$BUN" --bun run web:build >&2
  exec "$BUN" dist/cli.js web --ephemeral
fi

if [[ "$build_file" == 1 ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Darwin-x86_64) target=darwin-x64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
    *) echo "dev-ephemeral: no compiled walnut file is built for $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  if [[ "$(uname -s)" == Linux ]]; then
    libc="$(ldd --version 2>&1 || true)"
    if [[ "$libc" == *musl* ]]; then target="$target-musl"; fi
  fi
  if ! BUN="$(find_bun)"; then
    echo "dev-ephemeral: building the file needs bun (WALNUT_BUN, PATH, ~/.bun/bin); install it: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
  # Progress to stderr: stdout carries only the launcher's one JSON line.
  "$BUN" scripts/build-binary.mjs --target "$target" >&2
  file="$REPO/dist-bin/walnut-$target"
fi

if [[ ! -x "$file" ]]; then
  echo "dev-ephemeral: $file is not an executable walnut file" >&2
  exit 1
fi
# Parent of the per-build runtime trees (src/binary/runtime-tree.ts); not the data home.
export WALNUT_RUNTIME_DIR="${TMPDIR:-/tmp}"
WALNUT_RUNTIME_DIR="${WALNUT_RUNTIME_DIR%/}/walnut-ephemeral-runtime"
mkdir -p "$WALNUT_RUNTIME_DIR"

# One tree per build lands here (about 20 MB each) and the file prunes nothing
# under WALNUT_RUNTIME_DIR, so this launcher does: it keeps the newest few, and
# any tree made in the last day (a test server started from it may still run).
KEEP_TREES="${WALNUT_EPHEMERAL_KEEP_TREES:-3}"
prune_runtime_trees() {
  local dir="$1" keep="$2" n=0 tree
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=3
  # Newest first; tree names are <version>-<hash>, never with spaces or newlines.
  for tree in $(ls -1t "$dir" 2>/dev/null); do
    [[ -d "$dir/$tree" && ! -L "$dir/$tree" ]] || continue
    n=$(( n + 1 ))
    (( n > keep )) || continue
    if [[ -n "$(find "$dir/$tree" -maxdepth 0 -mtime -1 2>/dev/null)" ]]; then continue; fi
    rm -rf "${dir:?}/$tree"
  done
}
prune_runtime_trees "$WALNUT_RUNTIME_DIR" "$KEEP_TREES"
# BUN_BE_BUN=1 would make the file run as the bun CLI instead of Walnut.
unset BUN_BE_BUN
exec "$file" web --ephemeral
