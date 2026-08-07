#!/usr/bin/env bash
# Runs the LIVE cloud mobile-journey tests against the real cloud companion.
#
# Same policy as run-live-daemon-tests.sh:
#   - Auto-derives the cloud URL + device token from the data repo's git
#     remote (no config, no secrets in the repo).
#   - Probes /api/v1/status with an 8s timeout first.
#   - Unreachable / no remote: LOUD yellow SKIPPED banner, exit 0 — the run
#     is NOT authoritative for the mobile path; say so in verification.
#   - Reachable: runs the live suite (creates REAL sessions on the primary —
#     each one spawns a real `claude` CLI turn; idle reaper cleans them up).
#
# Usage:
#   bash scripts/run-live-cloud-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

# Cheap preflight in shell so the banner appears even if vitest can't boot:
# pull the credentialed cloud remote straight from the data repo config.
DATA_REPO="${WALNUT_HOME:-$HOME/.open-walnut}"
REMOTE_URL=$(git -C "$DATA_REPO" config --get remote.origin.url 2>/dev/null || true)
if [[ -z "$REMOTE_URL" || "$REMOTE_URL" != *"/git/"* ]]; then
  echo -e "${YELLOW}⚠️  SKIPPED: no cloud git remote on $DATA_REPO — live cloud tests need a configured companion.${NC}"
  echo -e "${YELLOW}   This run is NOT authoritative for the phone→cloud path.${NC}"
  exit 0
fi
HOSTPART=$(sed -E 's#https?://([^@]*@)?([^/]+)/.*#\2#' <<<"$REMOTE_URL")
TOKEN=$(sed -E 's#https?://[^:]*:([^@]+)@.*#\1#' <<<"$REMOTE_URL")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $TOKEN" "https://$HOSTPART/api/v1/status" || true)
if [[ "$CODE" != "200" ]]; then
  echo -e "${YELLOW}⚠️  SKIPPED: cloud companion https://$HOSTPART unreachable (status: ${CODE:-none}).${NC}"
  echo -e "${YELLOW}   This run is NOT authoritative for the phone→cloud path.${NC}"
  exit 0
fi

echo -e "${GREEN}Cloud companion reachable — running LIVE mobile-journey tests (real sessions, real CLI turns).${NC}"
# URL + token ride env vars: the test process can't derive them itself —
# under VITEST, WALNUT_HOME is force-pointed at a temp dir (constants.ts
# test guard), so in-process getCloudRemoteCredentials() sees an empty repo.
WALNUT_LIVE_CLOUD=1 \
WALNUT_LIVE_CLOUD_URL="https://$HOSTPART" \
WALNUT_LIVE_CLOUD_TOKEN="$TOKEN" \
npx vitest run --config vitest.live.config.ts \
  tests/e2e/cloud-mobile-journey.live.test.ts
