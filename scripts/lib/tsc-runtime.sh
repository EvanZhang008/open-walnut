# shellcheck shell=bash
# The runtime a script's TypeScript type check runs under: a node that starts and is new enough
# for the repo's TypeScript, else the bun the script found ($1). Sets TSC_RUNTIME.
#
# Why node first (2026-11-22): web/'s `tsc --noEmit` peaked at 8.3 GB under bun and 3.7 GB under
# node on the same tree, in about the same time; two such checks and a deploy's held 11.2 GB on a
# 48 GB Mac whose memory was already tight. A node that cannot run (one built for a newer glibc, or
# one too old) is passed over, so a machine with only bun, or a broken node, type-checks as before.
# Tested by tests/scripts/typecheck-runtime.test.ts.
WALNUT_TSC_MIN_NODE=${WALNUT_TSC_MIN_NODE:-18}
walnut_tsc_runtime() {
  local node
  TSC_RUNTIME=$1
  node=$(command -v node 2>/dev/null) || return 0
  [[ -n "$node" ]] || return 0
  if "$node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $WALNUT_TSC_MIN_NODE ? 0 : 1)" >/dev/null 2>&1; then
    TSC_RUNTIME=$node
  fi
  return 0
}
