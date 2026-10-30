#!/bin/sh
# The release gate: what a release is about to publish (its npm packages, every file and
# the notes of its GitHub Release) is leak scanned first, with the rules and flags of the
# leak audit (.github/workflows/leak-audit.yml). A hit, or a scan that could not run (no
# rules, nothing to scan, a file it could not open), stops the job before it publishes,
# so neither npm nor the GitHub Release gets it. Every step that publishes runs it first
# (tests/scripts/release-leak-gate.test.ts).
#
#   sh scripts/release-leak-gate.sh [--npm <npm packages dir>] [<release file or dir>]...
#
# Needs LEAK_SCAN_RULES (the rules, kept as a repository secret) in the environment.
set -eu
npm_dir=
if [ "${1:-}" = --npm ]; then
  [ $# -ge 2 ] || { echo "release-leak-gate: --npm needs a directory" >&2; exit 2; }
  npm_dir=$2
  shift 2
fi
[ -n "$npm_dir" ] || [ $# -gt 0 ] || { echo "usage: release-leak-gate.sh [--npm <dir>] [<path>]..." >&2; exit 2; }
scan="$(dirname "$0")/leak-scan/leak-scan.mjs"

refuse() {
  if [ "$1" -eq 1 ]; then
    echo "::error::the leak scan found a hit in $2 (rule and place above); it was not published. Remove it from the source, then publish again."
  else
    echo "::error::the leak scan could not check $2 (exit $1, reason above); it was not published."
  fi
  exit 1
}

code=0
if [ -n "$npm_dir" ]; then
  bun "$scan" --rules-env LEAK_SCAN_RULES --redact --min-files 2 "$npm_dir" || code=$?
  [ "$code" -eq 0 ] || refuse "$code" "the npm packages"
fi
if [ $# -gt 0 ]; then
  bun "$scan" --rules-env LEAK_SCAN_RULES --redact --skip-deps "$@" || code=$?
  [ "$code" -eq 0 ] || refuse "$code" "the GitHub Release files"
fi
echo "release-leak-gate: no hit in what this release publishes"
