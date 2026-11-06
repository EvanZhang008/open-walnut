#!/usr/bin/env bash
# The test gate before a push to main: CI's quick and frontend tiers, and the browser specs the
# push touches, run on the commit being pushed BEFORE main moves. A push that fails them is
# refused and told which tests failed and which commits it carries.
#
# Why: every team pushed to main without CI's checks, so one team's red test turned every later
# run red and mailed "Run failed" every hour for a day (2026-11-04, the user: "this happens every
# day"). CI's quick tier alone caught most of those (new ratchets and guards a commit missed).
#
# It runs from .husky/pre-push (args: the remote's name and URL; stdin: the pre-push lines
# `<local ref> <local sha> <remote ref> <remote sha>`), and only judges a push to main.
#
# Off unless asked for, so a contributor's push is untouched (GitHub's CI judges a pull request):
#   git config walnut.pushGate true     on (or WALNUT_PUSH_GATE=1 for one push)
#   WALNUT_PUSH_GATE=0                  off for one push (say why in the commit or the task)
#
# Where the tests run:
#   on GitHub (the default, for a GitHub remote): the commit goes to a `gate/<sha>` branch of the
#     same remote, where .github/workflows/push-gate.yml runs the tiers on CI's own runners and
#     writes commit statuses; this waits for its own run's `walnut/push-gate`
#     (WALNUT_PUSH_GATE_TIMEOUT minutes, default 75), then deletes the branch. A commit whose
#     newest `walnut/push-gate` already reads success passes at once. Needs `gh` signed in and jq.
#     It tests the pushed commit itself. A push to another remote is not judged.
#   git config walnut.testRunner '<prefix>': a command prefix (split on spaces, no quoted
#     arguments) that runs the rest of the line in a copy of this checkout on a test host and
#     exits 255 when it could not; then the push must come from a clean checkout of the commit.
#     WALNUT_PUSH_GATE_WORKERS=N sets its vitest workers (default 4).
#
# What it runs, each judged against the committed baseline like CI does:
#   the quick tier (scripts/test-baseline.mjs check, tests/setup/known-failures.json),
#   the frontend tier (test:frontend:ci),
#   the browser specs the pushed commits touch (a changed spec, or a spec importing a changed
#   browser helper directly), after CI's build, with CI's one retry, through
#   scripts/browser-baseline.mjs. Specs a side config owns, a change to the shared fixture or a
#   config, and a helper so shared it maps to more than MAX_SPECS specs are left to CI's browser
#   shards, and the gate says so.
# A gate that cannot judge (no runner, no answer in time) refuses the push too: an unchecked push
# is what this stops.
#
#   push-gate.sh --specs <base> <target>   only print the browser specs <target> touches since
#                                          <base> (the workflow's browser job uses it)
#   push-gate.sh --run <remote URL> <commit>   run the GitHub gate for a commit's files outside a
#                                              push (as one commit on GitHub's main)
# A pass is kept by the files it judged (WALNUT_PUSH_GATE_VERDICTS, default
# ~/.cache/walnut-push-gate/<tree>, 14 days), so the same files pushed as another commit pass.
set -uo pipefail
MAX_SPECS=${WALNUT_PUSH_GATE_MAX_SPECS:-30}
B=tests/e2e/browser

# Browser specs <target> touches since <base>: sets specs (space separated) and left (notes).
pick_specs() { # base target
  local base=$1 target=$2 changed f rel users side n
  specs= left=
  changed=$(git diff --name-only --diff-filter=AMR "$base" "$target" -- $B)
  specs=$(printf '%s\n' "$changed" | grep -E '\.spec\.ts$' || true)
  for f in $(printf '%s\n' "$changed" | grep -E '\.ts$' | grep -vE '\.spec\.ts$' || true); do
    case $f in
      *.config.ts|$B/test-server.ts|$B/pw-*.ts) left="$left ${f#$B/}"; continue ;;
    esac
    rel=${f#$B/}; rel=${rel%.ts}
    users=$(git grep -l -E "from '\./$rel(\.js)?'" "$target" -- "$B/*.spec.ts" | sed "s/^$target://")
    [ -n "$users" ] || { left="$left ${f#$B/}"; continue; }
    specs="$specs
$users"
  done
  # Specs a side config's testMatch owns run under that config, never the main one.
  side=$(git ls-tree --name-only "$target" $B/ | grep -E '\.config\.ts$' | while read -r c; do
    git show "$target:$c" | perl -0777 -ne 'if (/^\s*testMatch:\s*(\[[^\]]*\]|\x27[^\x27]+\x27|"[^"]+")/m) { my $s = $1; print "$1\n" while $s =~ /[\x27"]([^\x27"]+)[\x27"]/g }'
  done)
  specs=$(printf '%s\n' "$specs" | grep -v '^$' | sort -u | while read -r s; do
    printf '%s\n' "$side" | grep -qxF "$(basename "$s")" && continue
    [ -n "$(git ls-tree --name-only "$target" -- "$s")" ] || continue   # renamed away or deleted
    printf '%s\n' "$s"
  done)
  n=$(printf '%s\n' "$specs" | grep -c . || true)
  if [ "$n" -gt "$MAX_SPECS" ]; then left="$left ($n specs, over $MAX_SPECS)"; specs=; fi
  specs=$(printf '%s\n' "$specs" | tr '\n' ' ' | sed 's/ *$//')
}

if [ "${1:-}" = --specs ]; then
  pick_specs "$2" "$3"
  [ -z "$left" ] || echo "left to CI's browser shards:$left" >&2
  printf '%s\n' "$specs"
  exit 0
fi

# `--run <remote URL> <commit>`: the GitHub gate for one commit's files, outside a push.
# walnut-cloud runs it before it takes its push lock, so no push waits behind another's 25 minutes
# of tests. What it pushes to GitHub is the commit's files as ONE new commit on GitHub's main:
# the Mac's main and GitHub's carry the same files under other commits (walnut-cloud replays
# them), so the commit itself would put hundreds of commits GitHub never had on a public branch,
# and its verdict would name a commit the push never sends. The verdict is kept by files (the
# tree, below), so the push's own hook passes the commit it sends at once.
if [ "${1:-}" = --run ]; then
  remote_url=${2:-}
  t=$(git rev-parse -q --verify "${3:-}^{commit}") || { echo "push-gate --run: no commit ${3:-}" >&2; exit 2; }
  b=$(git ls-remote "$remote_url" refs/heads/main 2>/dev/null | cut -f1)
  [ -n "$b" ] || { echo "push-gate --run: could not read main from $remote_url" >&2; exit 1; }
  git cat-file -e "$b^{commit}" 2>/dev/null || git fetch -q "$remote_url" main 2>/dev/null || { echo "push-gate --run: could not fetch main from $remote_url" >&2; exit 1; }
  if [ "$(git rev-parse "$b^{tree}")" = "$(git rev-parse "$t^{tree}")" ]; then echo "Test gate: GitHub's main already has these files; nothing to judge."; exit 0; fi
  # What the push will carry, as the Mac's own commits: the ones GitHub has no copy of (by patch).
  carried=$(git log --cherry-pick --right-only --no-merges --format='  %h %s' "$b...$t" 2>/dev/null | head -40)
  t=$(git commit-tree "$t^{tree}" -p "$b" -m "push gate: the files of $(git rev-parse --short "$t")") \
    || { echo "push-gate --run: could not write the gate commit" >&2; exit 1; }
  refs="refs/heads/main $t refs/heads/main $b"
  # The gate branch is public: what it carries is scanned first, as the pre-push hook scans before
  # its gate (the private scanner walnut.prepushScanner names, where one is set).
  scanner=$(git config --get walnut.prepushScanner 2>/dev/null || true)
  if [ -n "$scanner" ]; then
    [ -x "$scanner" ] || { echo "push-gate --run: walnut.prepushScanner names $scanner, which is not there." >&2; exit 1; }
    printf '%s\n' "$refs" | "$scanner" origin "$remote_url" || exit 1
  fi
  WALNUT_PUSH_GATE=1
else
  remote_url=${2:-}
  refs=$(cat)
fi
on=${WALNUT_PUSH_GATE:-$(git config --bool --get walnut.pushGate 2>/dev/null || echo false)}
case $on in 1|true|yes|on) ;; *) exit 0 ;; esac

target= base=
while read -r _lref lsha rref rsha; do
  [ "$rref" = refs/heads/main ] || continue
  case $lsha in *[!0]*) target=$lsha; base=$rsha ;; esac   # an all-zero sha deletes the ref: nothing to test
done <<< "$refs"
[ -n "$target" ] || exit 0

refuse() { echo ""; echo "Push blocked: $*"; echo "Skip once, with a reason in the task: WALNUT_PUSH_GATE=0 git push …"; exit 1; }

# Passing verdicts, kept by the files they judged (the commit's tree) on this machine: the same
# files pushed as another commit (a replay, a join) pass at once. Written only after GitHub's
# runners said success.
verdicts=${WALNUT_PUSH_GATE_VERDICTS:-${XDG_CACHE_HOME:-$HOME/.cache}/walnut-push-gate}
tree=$(git rev-parse "$target^{tree}")
if [ -f "$verdicts/$tree" ]; then echo "✓ Test gate passed on these files ($(head -1 "$verdicts/$tree"))."; exit 0; fi
passed_files() { # the run URL
  mkdir -p "$verdicts" && printf '%s\n' "$1" > "$verdicts/$tree"
  find "$verdicts" -type f -mtime +14 -delete 2>/dev/null || true
}

# The commits this push carries. GitHub's main may be missing here (a new branch, a clone
# that never fetched it): then only the tip is named and no browser spec is picked.
have_base=0
case $base in *[!0]*) git cat-file -e "$base^{commit}" 2>/dev/null && have_base=1 ;; esac
if [ -n "${carried:-}" ]; then commits=$carried
elif [ $have_base = 1 ]; then commits=$(git log --format='  %h %an: %s' "$base..$target"); else commits=$(git log -1 --format='  %h %an: %s' "$target"); fi
blocked() { # what happened (the details are above)
  echo ""
  echo "Push blocked: $*"
  echo "This push carries:"
  printf '%s\n' "$commits"
  echo "Fix the failure (or hand it to the commit's owner) and push again."
  echo "Skip once, with a reason in the task: WALNUT_PUSH_GATE=0 git push …"
  exit 1
}
short=$(git rev-parse --short "$target")
runner=$(git config --get walnut.testRunner 2>/dev/null || true)

if [ -z "$runner" ]; then
  # ── On GitHub: CI's own runners judge the pushed commit (.github/workflows/push-gate.yml).
  # Only a push to GitHub is judged: a push to a local or another remote reaches no CI.
  plain=$(printf '%s' "$remote_url" | sed -E 's#^(https?://)[^@/]+@#\1#')   # never print a token
  plain=${plain%/}; plain=${plain%.git}
  repo=$(printf '%s' "$plain" | sed -nE 's#^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\2#p')
  [ -n "$repo" ] || { echo "Test gate: $plain is not a GitHub repository, so there is nothing to judge here."; exit 0; }
  command -v jq >/dev/null 2>&1 || refuse "the test gate reads its verdict with jq, which is not installed here."
  command -v gh >/dev/null 2>&1 || refuse "the test gate reads its verdict with the GitHub CLI (gh), which is not installed here."
  gh auth status >/dev/null 2>&1 || refuse "the GitHub CLI (gh) is not signed in here (gh auth login), so the test gate cannot read its verdict."
  errf=$(mktemp)
  # Every GitHub read has its own time limit: one gh call that hung for most of an hour once left
  # the gate blind to verdicts already written, until its deadline said "did not answer"
  # (2026-11-06). A call past the limit counts as one failed read and the loop polls again.
  # The Mac has no timeout command, so perl runs the call as its child and ends that pid at the
  # limit (TERM, then KILL): gh is a Go program, which may not die of a plain SIGALRM. Plain gh
  # without perl.
  ghcall() {
    if command -v perl >/dev/null 2>&1; then
      perl -e '$t = shift; $p = fork; defined $p or exit 125; if (!$p) { exec @ARGV; exit 127 }
        $SIG{ALRM} = sub { kill "TERM", $p; sleep 2; kill "KILL", $p; exit 124 }; alarm $t;
        waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "${WALNUT_PUSH_GATE_CALL_SECS:-60}" gh "$@"
    else gh "$@"; fi
  }
  # A verdict this commit already has (walnut-cloud runs the gate before its push lock): the
  # newest walnut/push-gate status, when it reads success.
  passed=$(ghcall api "repos/$repo/commits/$target/statuses?per_page=100" 2>"$errf" \
    | jq -r '[.[] | select(.context == "walnut/push-gate")][0] | select(.state == "success") | .target_url // empty' 2>/dev/null)
  if [ -n "$passed" ]; then echo "✓ Test gate passed on $short ($passed)."; passed_files "$passed"; rm -f "$errf"; exit 0; fi

  branch=gate/$(git rev-parse --short=12 "$target")
  # The run this push starts (2 minutes of slack for the runners' clock against this one).
  since=$(date -u -r $(( $(date +%s) - 120 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(( $(date +%s) - 120 ))" +%Y-%m-%dT%H:%M:%SZ)
  trap 'git push -q --no-verify "$remote_url" ":refs/heads/$branch" >/dev/null 2>&1 || true; rm -f "$errf"' EXIT
  # The commit already passed this push's other hooks (the type check, the leak scan): the branch
  # push only carries it to the runners, so it does not run them again.
  git push -q --no-verify "$remote_url" "+$target:refs/heads/$branch" \
    || refuse "could not push $branch to $plain for the test gate."
  echo "Test gate on $short: quick tier, frontend tier and the browser specs it touches, on GitHub's runners ($branch)…"
  mins=${WALNUT_PUSH_GATE_TIMEOUT:-75}
  # How many tiers the run writes (push-gate-status.sh, as the pushed commit has it).
  tiers=$(git show "$target:scripts/push-gate-status.sh" 2>/dev/null | sed -n 's/^TIERS=\([0-9][0-9]*\).*/\1/p')
  tiers=${tiers:-5}
  deadline=$(( $(date +%s) + mins * 60 )) run= state=pending statuses='[]' fails=0
  ghq() { ghcall api "$@" 2>"$errf" && { fails=0; return 0; }; fails=$((fails + 1)); return 1; }
  while :; do
    # Only what this push's own run wrote: an earlier or a cancelled gate of the same commit
    # may still be writing its own verdict.
    if [ -z "$run" ] && r=$(ghq "repos/$repo/actions/runs?branch=$branch&head_sha=$target&event=push&per_page=20"); then
      run=$(printf '%s' "$r" | jq -r --arg t "$since" '[.workflow_runs[] | select(.created_at >= $t)] | max_by(.created_at) | .id // empty')
    fi
    if [ -n "$run" ] && r=$(ghq "repos/$repo/commits/$target/statuses?per_page=100"); then
      statuses=$(printf '%s' "$r" | jq -c --arg u "https://github.com/$repo/actions/runs/$run" '[.[] | select(.context | startswith("walnut/push-gate")) | select(.target_url == $u)] | group_by(.context) | map(max_by(.created_at))')
      state=$(printf '%s' "$statuses" | jq -r '[.[] | select(.context == "walnut/push-gate")][0].state // "pending"')
      [ "$state" = pending ] || break
      # The tiers decide without the verdict job, which may queue behind a busy CI for minutes:
      # one failed tier refuses at once, every tier passed lets the push through.
      bad=$(printf '%s' "$statuses" | jq '[.[] | select(.context != "walnut/push-gate" and (.state == "failure" or .state == "error"))] | length')
      good=$(printf '%s' "$statuses" | jq '[.[] | select(.context != "walnut/push-gate" and .state == "success")] | length')
      # One line each time the run writes something new, so a log shows when the gate last heard.
      seen="$good passed, $bad failed"
      [ "$seen" = "${shown:-}" ] || { shown=$seen; echo "  $(date -u +%H:%M:%SZ)  $seen of $tiers tiers"; }
      if [ "$bad" -gt 0 ]; then state=failure; break; fi
      if [ "$good" -ge "$tiers" ]; then state=success; break; fi
    fi
    [ $fails -lt 10 ] || blocked "GitHub did not answer the test gate 10 times in a row ($(tail -1 "$errf")), so nothing was judged."
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep "${WALNUT_PUSH_GATE_POLL:-30}"
  done
  printf '%s' "$statuses" | jq -r '.[] | select(.context != "walnut/push-gate") | "  \(.state)  \(.context | sub("^walnut/push-gate "; ""))  \(.description // "")"'
  [ "$state" = success ] && { echo "✓ Test gate passed."; passed_files "https://github.com/$repo/actions/runs/$run"; exit 0; }
  [ "$state" != pending ] || blocked "the test gate did not answer within $mins minutes, so nothing was judged ($branch${run:+, run $run})."
  # The failing tests, from each failed tier's job log.
  for tier in $(printf '%s' "$statuses" | jq -r '.[] | select(.state != "success" and .context != "walnut/push-gate") | .context | sub("^walnut/push-gate \\("; "") | sub("\\)$"; "") | gsub(" "; "_")'); do
    tier=${tier//_/ }
    job=$(ghcall api "repos/$repo/actions/runs/$run/jobs?per_page=50" 2>/dev/null | jq -r --arg n "Gate ($tier)" '.jobs[] | select(.name == $n) | .id' | head -1)
    [ -n "$job" ] || continue
    echo ""; echo "── $tier (https://github.com/$repo/actions/runs/$run/job/$job)"
    ghcall api "repos/$repo/actions/jobs/$job/logs" 2>/dev/null | sed -E 's/^[0-9T:.-]+Z //; s/\x1b\[[0-9;]*[A-Za-z]//g' \
      | awk '/^Fix them|^##\[error\]|^##\[group\]Run /{if (p) exit} /NEW failure|New failures|FAIL |✗/{p=1} p{print; if (++n > 60) exit}' | grep -avE '^[0-9]{2}:[0-9]{2}:[0-9]{2} '
  done
  blocked "the test gate failed on $short. The failing tests are listed above."
fi

# ── Through a runner prefix: it tests this checkout, so the checkout must be the pushed commit.
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$target^{commit}")" ] && [ -z "$(git status --porcelain)" ] \
  || refuse "the test gate's runner tests this checkout, and it is not a clean checkout of the commit being pushed ($short). Push from a clean checkout of it (walnut-cloud push does)."
specs= left=
[ $have_base = 0 ] || pick_specs "$base" "$target"

workers=${WALNUT_PUSH_GATE_WORKERS:-4}
steps="bun run build:plugins >/dev/null && bun scripts/test-baseline.mjs check --maxWorkers=$workers && bun run test:frontend:ci"
[ -z "$specs" ] || steps="$steps && bun run build >/dev/null && (cd web && bun x vite build >/dev/null) && bun x playwright install chromium >/dev/null && CI=1 bun scripts/browser-baseline.mjs check --run --retries=1 $specs"

echo "Test gate on $short: quick tier, frontend tier${specs:+, browser specs: $specs} (via $runner)…"
[ -z "$left" ] || echo "Left to CI's browser shards (no direct spec to run here):$left"
rc=0
# A hook's GIT_DIR (and friends) would point the tests' own git calls at this repository.
# shellcheck disable=SC2086 # the runner is a command prefix, split as written
(unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX; $runner sh -c "$steps") || rc=$?
[ $rc = 0 ] && { echo "✓ Test gate passed."; exit 0; }
[ $rc != 255 ] || blocked "the test runner ($runner) could not run the tests (exit 255), so nothing was checked."
blocked "the test gate failed (exit $rc). The failing tests are listed above (if none ran, the runner's own error is there)."
