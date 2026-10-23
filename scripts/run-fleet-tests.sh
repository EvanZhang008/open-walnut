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
# With dist/daemon-binaries built (npm run build:daemon) the Mac deploys the
# prebuilt Linux binary; without it, the daemon's source under the host's node.

set -euo pipefail
cd "$(dirname "$0")/.."

TSX=./node_modules/.bin/tsx

if ! docker info >/dev/null 2>&1; then
  cat <<'EOF'

  FLEET TESTS SKIPPED: Docker is not available (docker info failed).
  This run is NOT authoritative: real SSH, the daemon's deploy over SSH and
  the link faults were not exercised. Start Docker and run it again.

EOF
  exit 0
fi

if [ "${1:-}" = "clean" ]; then
  "$TSX" --input-type=module -e "const d = await import('./tests/fleet/docker.ts'); const swept = await d.sweep(); const images = await d.removeImages(); console.log(JSON.stringify({ swept, images }))"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  exec ./node_modules/.bin/vitest run --config vitest.fleet.config.ts
fi
exec ./node_modules/.bin/vitest run --config vitest.fleet.config.ts "$@"
