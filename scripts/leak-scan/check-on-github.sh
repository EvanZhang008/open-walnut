#!/usr/bin/env bash
#
# The Leak gate's check of a commit BEFORE it becomes GitHub's main (pre-push; stdin: the pre-push
# lines `<local ref> <local sha> <remote ref> <remote sha>`, $1 $2: the remote's name and URL).
#
# GitHub's "main leak gate" ruleset refuses a push of main whose commit has not passed the
# "Scan new commits" check. Lands push straight to main, so the check must come first: for each
# commit that would become main, this puts it on a hidden ref (refs/leak-check/<sha>, outside
# refs/heads, so GitHub shows it nowhere and the ruleset does not judge it), dispatches
# .github/workflows/leak-gate.yml on main with `commit=<sha>` (main's own copy of that workflow,
# never the pushed one, scans the commits main does not have yet), and waits for the
# "Scan new commits" status it writes. A pass lets the push go on; a fail refuses it and names
# the run. The hidden ref is deleted again on every way out.
#
# Only for a push of main to a GitHub repository whose main's Leak gate takes `commit` (forks and
# other remotes are untouched). When the ruleset does not require the check yet, trouble reaching
# GitHub (no gh, no answer in time) is said and the push goes on; a failed scan is refused always.
#   WALNUT_LEAK_CHECK_TIMEOUT   seconds to wait for the check (default 600)
#   WALNUT_LEAK_CHECK_POLL      seconds between looks (default 5)
#   WALNUT_LEAK_CHECK_SLUG      owner/repo on GitHub, when the push URL is not a GitHub URL (tests).
#                               Naming another repository skips nothing: GitHub's own ruleset
#                               judges the commit on the repository main is pushed to.
set -uo pipefail
CHECK='Scan new commits'
ACTIONS_APP=15368 # GitHub Actions
ZERO=0000000000000000000000000000000000000000
TIMEOUT=${WALNUT_LEAK_CHECK_TIMEOUT:-600}
POLL=${WALNUT_LEAK_CHECK_POLL:-5}
url=${2:-${1:-}}
refs_in=$(cat)

slug=${WALNUT_LEAK_CHECK_SLUG:-}
[ -n "$slug" ] || slug=$(printf '%s' "$url" | sed -nE 's#^(https://([^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\3#p' | sed -E 's#\.git$##; s#/$##')
[ -n "$slug" ] || exit 0

shas=()
while read -r lref lsha rref rsha; do
  [ -n "${lsha:-}" ] || continue
  [ "$rref" = refs/heads/main ] && [ "$lsha" != "$ZERO" ] || continue
  t=$(git cat-file -t "$lsha" 2>/dev/null) || { echo "Push blocked: cannot read $lsha" >&2; exit 1; }
  [ "$t" = commit ] || continue # scan-push.sh refuses main pointing at a non-commit
  shas+=("$lsha")
done <<< "$refs_in"
[ ${#shas[@]} -gt 0 ] || exit 0

say() { echo "leak check: $*" >&2; }
required=unknown
trouble() { # $1 = what went wrong: refuse when GitHub requires the check, else say it and go on
  if [ "$required" = no ]; then
    say "$1; main does not require the check yet, so the push goes on (the Leak gate scans it after the push)"
    exit 0
  fi
  echo "Push blocked: the Leak gate's check of this commit could not run ($1). GitHub refuses a push of main without it; try again, or see scripts/leak-scan/README.md." >&2
  exit 1
}

if ! { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }; then
  say "gh is not installed or not signed in, so the Leak gate cannot check this commit first; GitHub refuses the push of main if its ruleset requires that check"
  exit 0
fi
r=$(gh api "repos/$slug/rules/branches/main" --jq "[.[] | select(.type == \"required_status_checks\") | .parameters.required_status_checks[].context] | index(\"$CHECK\") != null" 2>/dev/null) \
  && { [ "$r" = true ] && required=yes || required=no; }
wf=$(gh api "repos/$slug/contents/.github/workflows/leak-gate.yml?ref=main" --jq .content 2>/dev/null | base64 --decode 2>/dev/null)
[ -n "$wf" ] || trouble "GitHub's main has no readable .github/workflows/leak-gate.yml"
printf '%s\n' "$wf" | grep -qE '^      commit:' || trouble "the Leak gate on GitHub's main takes no commit to check yet"

# success, failure, pending or none: the newest "Scan new commits" status on the commit, else the
# GitHub Actions check run of that name (a push of the same commit to another branch made one).
state_of() {
  local s c
  s=$(gh api "repos/$slug/commits/$1/status" --jq "[.statuses[] | select(.context == \"$CHECK\")][0].state // \"none\"" 2>/dev/null) || s=none
  case $s in success|failure|error) [ "$s" = error ] && s=failure; echo "$s"; return ;; pending) echo pending; return ;; esac
  c=$(gh api "repos/$slug/commits/$1/check-runs?check_name=$(printf '%s' "$CHECK" | sed 's/ /%20/g')&per_page=20" \
    --jq "[.check_runs[] | select(.app.id == $ACTIONS_APP)] | if length == 0 then \"none\" elif any(.conclusion == \"success\") then \"success\" elif any(.status != \"completed\") then \"pending\" else \"failure\" end" 2>/dev/null) || c=none
  echo "$c"
}

hidden=()
cleanup() {
  local h
  for h in ${hidden[@]+"${hidden[@]}"}; do git push -q --no-verify "$url" ":$h" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

for sha in "${shas[@]}"; do
  short=${sha:0:10}
  st=$(state_of "$sha")
  if [ "$st" = success ]; then say "$short already passed \"$CHECK\" on GitHub"; continue; fi
  ref=refs/leak-check/$sha
  git push -q --no-verify "$url" "$sha:$ref" 2>/dev/null || trouble "could not put $short on $ref"
  hidden+=("$ref")
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run leak-gate.yml -R "$slug" --ref main -f commit="$sha" >/dev/null 2>&1 || trouble "could not start the Leak gate for $short"
  say "checking $short on GitHub (the Leak gate on main, up to ${TIMEOUT}s)…"
  start=$(date +%s) st=pending
  while :; do
    sleep "$POLL"
    st=$(state_of "$sha")
    case $st in success|failure) break ;; esac
    [ $(( $(date +%s) - start )) -lt "$TIMEOUT" ] || break
  done
  run=$(gh run list -R "$slug" --workflow leak-gate.yml --event workflow_dispatch --created ">=$since" --limit 5 --json url --jq '.[0].url // ""' 2>/dev/null || true)
  case $st in
    success) say "$short passed \"$CHECK\" on GitHub in $(( $(date +%s) - start ))s" ;;
    failure)
      echo "Push blocked: the Leak gate on GitHub found something in $short that must not be public (\"$CHECK\" failed${run:+: $run}). Fix the commits it names and push again." >&2
      exit 1 ;;
    *) trouble "no answer from the Leak gate for $short within ${TIMEOUT}s${run:+ ($run)}" ;;
  esac
done
exit 0
