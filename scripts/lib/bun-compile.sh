#!/bin/sh
# bun_compile <bun build --compile args...>: runs "$BUN build --compile" and, when bun
# could not download the runtime of the cross-compile target, runs it again, up to
# BUN_COMPILE_TRIES (3) times, waiting BUN_COMPILE_RETRY_SECS (10) seconds times the try.
# Bun fetches each target's runtime on first use, the only network step of the build:
# 2026-11-23 (Nightly extra tests run 45131663248) "Failed to download
# 'bun-linux-x64-v1.4.4': DNSResolveFailed" on a GitHub runner ended the build. Any other
# failure (a type or bundle error) fails at once. The wording is the one
# scripts/lib/bun-compile-retry.mjs matches for Bun.build (tests/scripts/bun-compile-retry.test.ts).
bun_compile() {
  _bc_tries="${BUN_COMPILE_TRIES:-3}"
  case "$_bc_tries" in ''|*[!0-9]*) _bc_tries=3 ;; esac
  _bc_i=1
  _bc_log="$(mktemp)"
  while :; do
    _bc_rc=0
    "$BUN" build --compile "$@" >"$_bc_log" 2>&1 || _bc_rc=$?
    if [ "$_bc_rc" -eq 0 ]; then
      cat "$_bc_log"; rm -f "$_bc_log"; return 0
    fi
    cat "$_bc_log" >&2
    if ! grep -q "Failed to download 'bun-" "$_bc_log"; then
      rm -f "$_bc_log"; return "$_bc_rc"
    fi
    if [ "$_bc_i" -ge "$_bc_tries" ]; then
      echo "bun_compile: gave up after $_bc_tries tries: bun could not download its runtime" >&2
      rm -f "$_bc_log"; return "$_bc_rc"
    fi
    echo "bun_compile: try $_bc_i of $_bc_tries could not download the bun runtime; trying again" >&2
    sleep $(( ${BUN_COMPILE_RETRY_SECS:-10} * _bc_i ))
    _bc_i=$((_bc_i + 1))
  done
}
