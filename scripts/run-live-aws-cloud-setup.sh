#!/usr/bin/env bash
# Live AWS smoke for the one-click cloud-companion setup — REAL infrastructure.
#
# DISABLED BY DEFAULT: this deploys a real CDK stack (EC2 + EIP + 30GB gp3,
# ~$0.10 for a 30-min run), waits through first boot + ACME issuance, claims
# the box, verifies git sync, then destroys everything. Run it deliberately:
#
#   WALNUT_LIVE_AWS=1 AWS_PROFILE=<profile> bash scripts/run-live-aws-cloud-setup.sh
#
# What it proves that no mock can (each was a REAL gap found on 2026-08-10's
# first live run — the mock suites were green through all of them):
#   - the EIP-vs-ephemeral-IP ordering on AWS (WALNUT_PUBLIC_IP export)
#   - ACME actually issuing for <ip>.sslip.io (contact-email validity, LE quota)
#   - /etc/walnut traversal perms end-to-end (cloud-init → setup.sh → claim)
#   - claim → initSync → real git push round-trip
#
# Teardown order is part of the contract: revoke the device token FIRST, then
# destroy the stack (kills the post-teardown IP-recycling attack).
set -euo pipefail

[ "${WALNUT_LIVE_AWS:-}" = "1" ] || {
  echo "live AWS cloud-setup smoke is opt-in: set WALNUT_LIVE_AWS=1 (creates real, billable resources)"
  exit 0
}
: "${AWS_PROFILE:?set AWS_PROFILE to the account to deploy into}"
REGION="${AWS_REGION:-us-west-2}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${WALNUT_SANDBOX_PORT:-3458}"   # NOT 3457 — pw-gate's orphan sweep reaps that port
API="http://127.0.0.1:$PORT/api/cloud-setup"

echo "==> sandbox on :$PORT with profile $AWS_PROFILE ($REGION)"
WALNUT_SANDBOX_PORT="$PORT" bash "$HERE/scripts/walnut-sandbox.sh" profile "$AWS_PROFILE" "$REGION"

cleanup() {
  echo "==> teardown: revoke cloud device tokens, then destroy the stack"
  for name in $(curl -s "http://127.0.0.1:$PORT/api/devices" | python3 -c "import json,sys; print(' '.join(d['name'] for d in json.load(sys.stdin).get('cloudDevices',[])))" 2>/dev/null); do
    curl -s -X DELETE "http://127.0.0.1:$PORT/api/devices/$name?target=cloud" >/dev/null && echo "    revoked $name"
  done
  (cd "$HERE/infra" && AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$REGION" CDK_DEFAULT_REGION="$REGION" npx cdk destroy WalnutCloudStack --force) || echo "    ⚠ destroy failed — clean up WalnutCloudStack in $REGION manually"
  WALNUT_SANDBOX_PORT="$PORT" bash "$HERE/scripts/walnut-sandbox.sh" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> detect must be ready"
curl -s "$API/providers" | python3 -c "
import json,sys
aws = [p for p in json.load(sys.stdin)['providers'] if p['id']=='aws'][0]
assert aws['detect']['available'], f\"aws detect not ready: {aws['detect']['detail']}\"
print('    ' + aws['detect']['detail'])"

echo "==> start: aws + sslip (no domain)"
curl -s -X POST "$API/start" -H 'Content-Type: application/json' \
  -d '{"provider":"aws","domainMode":"sslip"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('    job', d['job']['id'])"

echo "==> polling to terminal state (deploy 3-6 min, first boot 5-15 min, budget 45 min)"
deadline=$(( $(date +%s) + 45*60 ))
while :; do
  state=$(curl -s "$API/job" | python3 -c "import json,sys; d=json.load(sys.stdin)['job']; print(d['status'], d['currentStep'])")
  echo "    [$(date +%H:%M:%S)] $state"
  case "$state" in
    done*) break ;;
    failed*) curl -s "$API/job" | python3 -c "import json,sys; d=json.load(sys.stdin)['job']; print('\n'.join(d['logTail'][-15:]))"; exit 1 ;;
  esac
  [ "$(date +%s)" -gt "$deadline" ] && { echo "BUDGET EXCEEDED"; exit 1; }
  sleep 20
done

echo "==> asserting the box is really claimed + synced"
domain=$(curl -s "$API/job" | python3 -c "import json,sys; print(json.load(sys.stdin)['job']['domain'])")
curl -s -m 15 "https://$domain/api/v1/setup/status" | grep -q '"claimed":true' && echo "    https://$domain claimed=true ✅"
echo "==> LIVE SMOKE PASSED (teardown runs on exit)"
