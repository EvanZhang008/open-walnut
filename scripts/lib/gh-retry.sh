#!/bin/sh
# gh_retry <command...>: runs a GitHub read again after a failure, up to
# GH_RETRY_TRIES (5) times, waiting GH_RETRY_SECS (10) seconds times the try between them.
# 2026-11-07 (Leak audit run 42419194376): one HTTP 500 from GitHub on a release asset
# ended the audit of 0.6.28. Its curl reads already retried; its gh reads did not.
# A command that writes a file is rerun whole, so it must overwrite (`> file`, --clobber).
gh_retry() {
  _tries="${GH_RETRY_TRIES:-5}"
  _i=1
  while :; do
    "$@" && return 0
    _rc=$?
    [ "$_i" -ge "$_tries" ] && { echo "gh_retry: gave up after $_tries tries: $*" >&2; return "$_rc"; }
    echo "gh_retry: try $_i of $_tries failed (exit $_rc); trying again: $*" >&2
    sleep $(( ${GH_RETRY_SECS:-10} * _i ))
    _i=$((_i + 1))
  done
}
