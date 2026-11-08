#!/usr/bin/env bash
# The push gate's commit statuses (.github/workflows/push-gate.yml), which scripts/push-gate.sh
# reads before it lets a push to main through.
#
#   push-gate-status.sh <output file>   one tier's status: CONTEXT names it, OUTCOME is its test
#                                       step's outcome (success, failure, cancelled, skipped)
#   push-gate-status.sh --verdict       the whole gate's, `walnut/push-gate`: success only when
#                                       every tier wrote success in this run (an earlier gate of the
#                                       same commit may have said otherwise) and every job ended
#                                       well (NEEDS)
#
# Runs on a runner, with GH_TOKEN and GitHub's GITHUB_* variables.
set -uo pipefail
TIERS=10  # quick 1/8 .. 8/8, frontend, browser specs
repo=$GITHUB_REPOSITORY sha=$GITHUB_SHA
url="$GITHUB_SERVER_URL/$repo/actions/runs/$GITHUB_RUN_ID"

post() { # state context description
  local n
  for n in 1 2 3; do
    gh api -X POST "repos/$repo/statuses/$sha" -f state="$1" -f context="$2" \
      -f description="$(printf '%s' "$3" | cut -c1-139)" -f target_url="$url" >/dev/null && return 0
    sleep $((n * 5))
  done
  echo "could not write the status $2" >&2
  return 1
}

if [ "${1:-}" = --verdict ]; then
  latest=$(gh api "repos/$repo/commits/$sha/statuses?per_page=100" \
    | jq -c --arg u "$url" '[.[] | select(.context | startswith("walnut/push-gate (")) | select(.target_url == $u)] | group_by(.context) | map(max_by(.updated_at))') \
    || { post failure walnut/push-gate "could not read the tiers' statuses"; exit 0; }
  n=$(printf '%s' "$latest" | jq length)
  bad=$(printf '%s' "$latest" | jq -r '[.[] | select(.state != "success") | .context | sub("^walnut/push-gate \\("; "") | sub("\\)$"; "")] | join(", ")')
  jobs_ok=1; for r in ${NEEDS:-}; do [ "$r" = success ] || jobs_ok=0; done
  if [ -z "$bad" ] && [ "$n" -ge $TIERS ] && [ $jobs_ok = 1 ]; then
    post success walnut/push-gate "all $n tiers passed"
  elif [ -n "$bad" ]; then
    post failure walnut/push-gate "failed: $bad"
  else
    post failure walnut/push-gate "$n of $TIERS tiers reported (jobs: ${NEEDS:-none})"
  fi
  exit 0
fi

out=${1:-/dev/null}
[ -f "$out" ] || out=/dev/null
case ${OUTCOME:-} in
  success)
    post success "$CONTEXT" "passed" ;;
  failure)
    # test-baseline's verdict line ("✗ 2 NEW failure(s) ..."), else the last line that says failed.
    # test-baseline's verdict line ("✗ N NEW failure(s)"), else the last line that says failed;
    # never a log group's header that names a failing test.
    clean=$(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' "$out" | grep -avE '^[0-9]{2}:[0-9]{2}:[0-9]{2} |^(::|##\[)group')
    line=$(printf '%s\n' "$clean" | grep -aE '✗ [0-9]+ NEW failure' | head -1)
    [ -n "$line" ] || line=$(printf '%s\n' "$clean" | grep -aE 'NEW failure|failed' | tail -1)
    post failure "$CONTEXT" "${line:-failed}" ;;
  *)
    post failure "$CONTEXT" "did not run (${OUTCOME:-no outcome}): an earlier step failed" ;;
esac
exit 0
