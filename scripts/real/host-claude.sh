#!/usr/bin/env bash
# The `claude` the isolated host's sessions run in the C5e real-machine run (installed as
# <root>/bin/claude by scripts/real/c5e.py stage): the host account's real Claude Code CLI
# (C5E_CLI, an absolute path), with its config dir under <root> (CLAUDE_CONFIG_DIR, set by the
# launcher), and the model provider env of the account's own CLI config (C5E_CLI_ENV_FROM, read
# only, and only for a variable the session's env does not set already). C5E_REAL_SESSION marks the
# process as this run's, so the run's cleanup can tell its CLIs from every other one on the host.
set -euo pipefail
: "${C5E_CLI:?}" "${C5E_CLI_ENV_FROM:?}"
export C5E_REAL_SESSION=1
if [ -r "$C5E_CLI_ENV_FROM" ]; then
  while IFS= read -r -d '' pair; do
    key="${pair%%=*}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -n "${!key:-}" ] && continue
    export "$pair"
  done < <(jq -j '(.env // {}) | to_entries[] | "\(.key)=\(.value|tostring)\u0000"' "$C5E_CLI_ENV_FROM")
fi
exec "$C5E_CLI" "$@"
