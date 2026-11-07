#!/usr/bin/env bash
# Removes the push gate's refs whose run is over: `refs/gate/<sha>` and the older
# `refs/heads/gate/<sha>` branches (scripts/push-gate.sh). The hook deletes its own ref when it
# ends; a hook that was killed (SIGKILL, a host that went away) cannot, and each such branch put a
# "had recent pushes / Compare & pull request" banner on the repository's page (2026-11-07, the
# user: "why has so many of this").
#
#   push-gate-sweep.sh <remote> <owner/repo>
#
# A ref goes when every Push gate run of its commit has ended and the newest ended more than
# WALNUT_GATE_SWEEP_AFTER_MINUTES (60) ago, or when no run of it is listed and its commit is
# older than WALNUT_GATE_SWEEP_NORUN_HOURS (6). A ref with a run still queued or in progress
# stays, and so does one pushed under 15 minutes ago (the hook names it
# refs/gate/<sha12>-<push epoch>), whose run may not be listed yet. Only gate refs are ever
# deleted, and a failed delete only warns, so the hourly run never fails (a failed run mails).
# Needs gh (signed in, or GH_TOKEN) and jq. Run by push-gate.sh before each gate and hourly by
# .github/workflows/push-gate-sweep.yml.
set -uo pipefail
remote=${1:?remote}
repo=${2:?owner/repo}
after=$(( ${WALNUT_GATE_SWEEP_AFTER_MINUTES:-60} * 60 ))
norun=$(( ${WALNUT_GATE_SWEEP_NORUN_HOURS:-6} * 3600 ))
now=$(date +%s)
# Every GitHub call has a time limit (perl ends it), so a hung one never leaves this running.
ghc() {
  if command -v perl >/dev/null 2>&1; then
    perl -e '$t = shift; $p = fork; defined $p or exit 125; if (!$p) { exec @ARGV; exit 127 }
      $SIG{ALRM} = sub { kill "TERM", $p; sleep 2; kill "KILL", $p; exit 124 }; alarm $t;
      waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' 60 gh "$@"
  else gh "$@"; fi
}
epoch() { # ISO 8601 UTC -> seconds
  date -u -j -f %Y-%m-%dT%H:%M:%SZ "$1" +%s 2>/dev/null || date -u -d "$1" +%s
}

refs=$(git ls-remote "$remote" 'refs/gate/*' 'refs/heads/gate/*') || { echo "could not list $remote's refs" >&2; exit 1; }
[ -n "$refs" ] || exit 0
# The gate's recent runs, each with the commit it judged: a dispatched run names it in its title
# ("Push gate <sha>"), a branch run in its head.
runs=$(ghc api "repos/$repo/actions/workflows/push-gate.yml/runs?per_page=100" \
  | jq -c '[.workflow_runs[] | {sha: (if .event == "workflow_dispatch" then (.display_title | sub("^Push gate "; "")) else .head_sha end), status, updated_at}]') \
  || { echo "could not read $repo's push gate runs" >&2; exit 1; }

gone=
while read -r sha ref; do
  case $ref in refs/gate/*|refs/heads/gate/*) ;; *) continue ;; esac
  # Pushed under 15 minutes ago (its name ends in the push epoch): its run may not be listed yet.
  case $ref in *-[0-9]*) pushed=${ref##*-}; [ $(( now - pushed )) -gt 900 ] || continue ;; esac
  mine=$(printf '%s' "$runs" | jq -c --arg s "$sha" '[.[] | select(.sha == $s)]')
  if [ "$(printf '%s' "$mine" | jq length)" -gt 0 ]; then
    [ "$(printf '%s' "$mine" | jq '[.[] | select(.status != "completed")] | length')" = 0 ] || continue
    ended=$(epoch "$(printf '%s' "$mine" | jq -r 'max_by(.updated_at).updated_at')") || continue
    [ $(( now - ended )) -gt "$after" ] || continue
  else
    made=$(ghc api "repos/$repo/commits/$sha" --jq .commit.committer.date 2>/dev/null) || continue
    made=$(epoch "$made") || continue
    [ $(( now - made )) -gt "$norun" ] || continue
  fi
  gone="$gone :$ref"
done <<< "$refs"
for g in $gone; do
  if git push -q --no-verify "$remote" "$g" 2>/dev/null; then echo "removed ${g#:}"
  else echo "::warning::could not remove ${g#:} (gone already, or no right to)"; fi
done
exit 0
