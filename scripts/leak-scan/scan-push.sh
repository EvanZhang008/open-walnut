#!/usr/bin/env bash
# scan-push.sh: the leak scan of a push (scan-git.mjs over every commit and tag the push makes
# public). Reads what a git pre-push hook reads on stdin ("local_ref local_sha remote_ref
# remote_sha" lines); $1 $2 are the remote's name and url. Run by .husky/pre-push, by the
# maintainer's private push scanner (so a clone with no husky hooks runs it too) and by every
# land. Exit 0 clean, 1 blocked (hits, or the scan could not run). There is no way to skip it.
set -uo pipefail

ZERO=0000000000000000000000000000000000000000
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "scan-push: not in a git repository" >&2; exit 1; }
# the scanner beside this file (a caller may run a copy taken from a commit it trusts); it judges
# each range with the base commit's own scanner whenever that commit has one
scanner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-git.mjs"
[ -f "$scanner" ] || { echo "Push blocked: $scanner is missing, so this push cannot be scanned for leaks." >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "Push blocked: bun is not installed, so this push cannot be scanned for leaks." >&2; exit 1; }

refs=$(cat)
have_listed=0 have=""
rc=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_ref:-}" ] || continue
  [ "$local_sha" != "$ZERO" ] || continue   # a delete publishes nothing
  tip=$(git rev-parse -q --verify "$local_sha^{commit}" 2>/dev/null) || tip=
  # An annotated tag's message and tagger are as public as a commit's.
  if [ "$(git cat-file -t "$local_sha" 2>/dev/null)" = tag ]; then
    msg=$(mktemp "${TMPDIR:-/tmp}/scan-push-tag.XXXXXX")
    git cat-file tag "$local_sha" | sed '1,/^tagger /{/^tagger /!d;}' > "$msg"
    bun "$scanner" --repo "$top" --message-file "$msg" || rc=1
    rm -f "$msg"
  fi
  if [ -z "$tip" ]; then
    # a ref to a tree or a blob publishes content no commit range shows: refused
    echo "Push blocked: $local_ref points at a $(git cat-file -t "$local_sha" 2>/dev/null || echo "missing object"), not a commit; push only commits and tags of commits." >&2
    rc=1; continue
  fi
  if [ "$remote_sha" != "$ZERO" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    base=$remote_sha
  else
    # A new ref, or a remote tip this clone lacks: from the parent of the oldest commit the remote
    # does not hold. What it holds comes from the remote itself (ls-remote), never from this
    # clone's remote-tracking refs, which in an agent's clone name unpublished commits.
    if [ $have_listed = 0 ]; then
      have_listed=1
      for s in $(git ls-remote "${2:-${1:-origin}}" 2>/dev/null | awk '{print $1}'); do
        git cat-file -e "$s^{commit}" 2>/dev/null && have="$have $s"
      done
    fi
    # shellcheck disable=SC2086
    list=$(git rev-list --reverse --topo-order "$tip" ${have:+--not $have}) || { echo "Push blocked: could not list the commits of $local_ref." >&2; rc=1; continue; }
    first=$(printf '%s\n' "$list" | head -1)
    if [ -z "$first" ]; then continue
    elif git rev-parse -q --verify "$first^" >/dev/null; then base=$(git rev-parse "$first^")
    else base=$ZERO
    fi
  fi
  [ "$base" != "$tip" ] || continue
  if [ "$base" = "$ZERO" ]; then n=$(git rev-list --count "$tip"); else n=$(git rev-list --count "$base..$tip"); fi
  echo "Scanning $local_ref for leaks ($n new commit(s))…"
  bun "$scanner" --repo "$top" --range "$base..$tip" || rc=1
done <<< "$refs"

if [ $rc != 0 ]; then
  echo ""
  echo "Push blocked by the leak scan (above: the rule and the file and line of each hit)."
fi
exit $rc
