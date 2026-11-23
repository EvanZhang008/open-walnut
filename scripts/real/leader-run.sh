#!/usr/bin/env bash
# The leader of the C5e real-machine run (scripts/real/leader-boot.mts), inside the dev container:
#   walnut-dev run --bg <name> bash <code>/scripts/real/leader-run.sh <base>
# <base> holds the leader's data (data/, events.jsonl, runs.log, leader.log). Its home and daemon
# dir are in the container's own /tmp (unix socket paths must stay short); they last as long as the
# container, which this loop keeps: the leader is started again, on the same data, whenever it ends
# while <base>/restart exists (the restart scenario), and the loop ends when it ends without it.
# The env is the one tests/helpers/replica-cluster.ts (macEnvOf) gives its Mac, pointed at the
# real host's install root and app dir (C5E_HOST_ROOT, C5E_HOST_APP).
set -uo pipefail
base="$1"
code="$(cd "$(dirname "$0")/../.." && pwd)"
: "${C5E_HOST_KEY:?}" "${C5E_LINK_URL:?}" "${C5E_HOST_BUN:?}" "${C5E_HOST_ROOT:?}" "${C5E_HOST_APP:?}"
run=/tmp/c5e-leader
mkdir -p "$base/data" "$run/home" "$run/md" "$run/bin" "$run/tmp"
chmod 700 "$base/data" "$run" "$run/home" "$run/md"
# No local CLI and no ssh: nothing on this leader may reach a host but the link.
printf '#!/bin/sh\necho "claude is disabled on this leader" >&2\nexit 1\n' > "$run/bin/claude"
printf '#!/bin/sh\necho "ssh is disabled on this leader" >&2\nexit 255\n' > "$run/bin/ssh"
chmod 755 "$run/bin/claude" "$run/bin/ssh"
export PATH="$run/bin:$PATH" HOME="$run/home" USERPROFILE="$run/home" SHELL=/bin/sh TMPDIR="$run/tmp"
export OPEN_WALNUT_HOME="$base/data" WALNUT_DAEMON_DIR="$run/md" WALNUT_STREAMS_DIR="$run/md/streams"
export WALNUT_LEGACY_STREAMS_DIR="$run/md/no-legacy" WALNUT_SPAWN_JOURNAL="$run/md/spawn-journal.jsonl"
export WALNUT_DISABLE_BACKGROUND_AI=1 WALNUT_DISABLE_SEARCH=1 WALNUT_LOCAL_CLAUDE_PROBE=0 WALNUT_NO_AUTO_UPDATE=1
export WALNUT_HOST_SERVER_ROOT="$C5E_HOST_ROOT" WALNUT_HOST_SERVER_APP_DIR="$C5E_HOST_APP"
export NODE_ENV=production WALNUT_SERVICE_LAUNCHER=1 WALNUT_HOST_SERVICE_OFFER=1
export C5E_LEADER_EVENTS="$base/events.jsonl" C5E_LEADER_PORT="${C5E_LEADER_PORT:-39456}" C5E_LEADER_PROBE_PORT="${C5E_LEADER_PROBE_PORT:-39457}"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
cd "$code"
while true; do
  rm -f "$base/restart"
  bun "$code/scripts/real/leader-boot.mts" >> "$base/leader.log" 2>&1 &
  pid=$!
  echo "$(stamp) started pid=$pid" >> "$base/runs.log"
  echo "$pid" > "$base/leader.pid"
  wait "$pid"
  code_=$?
  echo "$(stamp) exited pid=$pid code=$code_" >> "$base/runs.log"
  if [ -f "$base/restart" ]; then sleep 1; continue; fi
  break
done
