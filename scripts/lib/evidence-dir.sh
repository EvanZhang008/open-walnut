# shellcheck shell=sh
# Where a script keeps evidence and reports someone reads after the run: the
# calling session's task directory when there is one (src/lib/task-dir.ts),
# else the user's state dir. Never /tmp, which a reboot empties (2026-10-25).
# Twin of scripts/lib/evidence-dir.mjs. Usage: dir="$(walnut_evidence_dir <name>)"
walnut_evidence_dir() {
  case "${WALNUT_TASK_DIR:-}" in
    /*) printf '%s/evidence/%s\n' "${WALNUT_TASK_DIR%/}" "$1"; return ;;
  esac
  case "${XDG_STATE_HOME:-}" in
    /*) printf '%s/open-walnut/evidence/%s\n' "${XDG_STATE_HOME%/}" "$1" ;;
    *) printf '%s/.local/state/open-walnut/evidence/%s\n' "$HOME" "$1" ;;
  esac
}
