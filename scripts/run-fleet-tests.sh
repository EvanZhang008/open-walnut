#!/usr/bin/env bash
# The fleet tier (tests/fleet/README.md): Walnut's real programs on separate
# machines (Linux containers for the hosts, this machine for the Mac) with real
# SSH and real link faults. Opt-in, never part of quick/unit/integration/e2e/CI.
#
# Usage:
#   bash scripts/run-fleet-tests.sh                      # every tests/fleet/*.fleet.ts
#   bash scripts/run-fleet-tests.sh tests/fleet/mac-and-host.fleet.ts
#   bash scripts/run-fleet-tests.sh clean                # remove the fleet's leftovers and its cached images
#
# Docker missing or not running: a SKIPPED banner and exit 0 (not authoritative).
# The first run builds the host image (a minute or two); later runs reuse it.
# With dist/daemon-binaries built (bun run build:daemon) the Mac deploys the
# prebuilt Linux binary; without it, the daemon's source under the host's node.

set -euo pipefail
cd "$(dirname "$0")/.."


if ! docker info >/dev/null 2>&1; then
  cat <<'EOF'

  FLEET TESTS SKIPPED: Docker is not available (docker info failed).
  This run is NOT authoritative: real SSH, the daemon's deploy over SSH and
  the link faults were not exercised. Start Docker and run it again.

EOF
  exit 0
fi

if [ "${1:-}" = "clean" ]; then
  bun --eval "const d = await import('./tests/fleet/docker.ts'); const swept = await d.sweep(); const images = await d.removeImages(); console.log(JSON.stringify({ swept, images }))"
  exit 0
fi

# host-faults C1 proves the chunked BINARY deploy, and C2 runs on its session: a tree
# with no Linux daemon binary (a fresh clone) deploys the source instead and fails
# both for that reason alone. Build them first; without Bun they stay missing.
if ! ls dist/daemon-binaries/*linux* >/dev/null 2>&1; then
  echo "[fleet] no Linux daemon binary in dist/daemon-binaries: building them (bash scripts/build-daemon.sh)"
  bash scripts/build-daemon.sh
  ls dist/daemon-binaries/*linux* >/dev/null 2>&1 || echo "[fleet] still no Linux daemon binary (Bun missing?): host-faults C1 and C2 will fail"
fi

# On bun, as every tier (tests/setup/runtime-deps.ts refuses a run on Node).
if [ "$#" -eq 0 ]; then
  exec bun --bun vitest run --config vitest.fleet.config.ts
fi
exec bun --bun vitest run --config vitest.fleet.config.ts "$@"
