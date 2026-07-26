#!/usr/bin/env bash
# CI failure triage — the "how do I learn CI broke, and how does an AI fix it" entry point.
#
# GitHub already emails you when a run you pushed fails, and shows a red X on the
# commit. This script is the other half: it pulls the failure DOWN to your machine
# in a form a local AI session can act on, so fixing costs nothing but your own
# local model. No API keys, no paid actions running inside CI.
#
#   scripts/ci-status.sh              # last 10 runs, one line each
#   scripts/ci-status.sh watch        # block until the in-flight run finishes
#   scripts/ci-status.sh fail         # failing steps of the most recent failed run
#   scripts/ci-status.sh fail <id>    # ... of a specific run
#   scripts/ci-status.sh brief        # a paste-ready failure digest for an AI session
#
# Requires the GitHub CLI (`gh auth login` once).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install with: brew install gh   (then: gh auth login)" >&2
  exit 1
fi

cmd="${1:-list}"

latest_failed_run() {
  gh run list --status failure --limit 1 --json databaseId --jq '.[0].databaseId'
}

case "$cmd" in
  list)
    echo "Recent CI runs (newest first):"
    gh run list --limit 10
    ;;

  watch)
    # Exits non-zero if the run fails, so it composes: `scripts/ci-status.sh watch || ...`
    echo "Waiting for the in-flight run to finish…"
    gh run watch --exit-status
    ;;

  fail)
    run_id="${2:-$(latest_failed_run)}"
    if [ -z "$run_id" ] || [ "$run_id" = "null" ]; then
      echo "No failed runs found — CI is green."
      exit 0
    fi
    echo "── Failed run $run_id ──"
    gh run view "$run_id"
    echo
    echo "── Failing step logs ──"
    # --log-failed prints only the failed steps, which is usually 50-200 lines
    # instead of the ~10k-line full log.
    gh run view "$run_id" --log-failed
    ;;

  brief)
    # A compact digest: what failed, on which commit, plus the error lines only.
    # Designed to be handed straight to a local AI session ("fix this").
    run_id="${2:-$(latest_failed_run)}"
    if [ -z "$run_id" ] || [ "$run_id" = "null" ]; then
      echo "CI is green — nothing to fix."
      exit 0
    fi

    gh run view "$run_id" --json headSha,displayTitle,conclusion,jobs \
      --jq '"run: \(.displayTitle)\ncommit: \(.headSha[0:8])\nresult: \(.conclusion)\nfailed jobs: \([.jobs[] | select(.conclusion=="failure") | .name] | join(", "))"'
    echo
    echo "── error lines ──"
    # Keep only lines that look like real diagnostics; the raw log is mostly setup noise.
    gh run view "$run_id" --log-failed 2>/dev/null \
      | grep -Ei '##\[error\]|error TS[0-9]+|AssertionError|FAIL |✗ |Error:|✘|Cannot find|not a function' \
      | sed -E 's/^[^\t]*\t[^\t]*\t//; s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //; s/^##\[error\]//' \
      | sort -u \
      | head -60
    echo
    echo "── next step ──"
    echo "Hand the above to a local Claude session:  \"CI run $run_id failed, fix it\""
    ;;

  *)
    echo "usage: scripts/ci-status.sh [list|watch|fail|brief] [run-id]" >&2
    exit 2
    ;;
esac
