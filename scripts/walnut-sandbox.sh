#!/usr/bin/env bash
# walnut-sandbox.sh — spin up a fully ISOLATED Walnut instance on :3457 for testing,
# onboarding demos, or trying any provider credential — WITHOUT Docker and WITHOUT ever
# touching the production server on :3456 or the real ~/.open-walnut data.
#
# Why not Docker: on locked-down corporate machines Docker Desktop refuses to pull images
# ("Membership in the [org] organization is required"). This reproduces the same isolation
# with `env -i` + a throwaway HOME instead — verified equivalent for data/credential isolation.
#
# Isolation model:
#   - env -i            → start from an EMPTY environment; re-add only what each mode needs,
#                         so the dev's exported AWS_*/ANTHROPIC_* never leak in by accident.
#   - OPEN_WALNUT_HOME  → throwaway dir (its own tasks/sessions/config/conversations).
#   - WALNUT_DAEMON_DIR → throwaway dir (its own session daemon; never adopts prod sessions).
#   - PORT 3457         → never 3456. The script refuses to act on 3456.
#
# HOME handling differs by auth mode (this is the subtle part):
#   - clean / token / keys  → FAKE HOME (so ~/.aws and ~/.claude are invisible → true first-run
#                             or a credential supplied ONLY via the injected env/config).
#   - profile               → REAL HOME (the SDK must read ~/.aws/config to resolve the profile),
#                             plus ~/.toolbox/bin on PATH so credential_process (e.g. `ada`) runs.
#
# Usage:
#   scripts/walnut-sandbox.sh clean                  # no creds → first-run onboarding banner
#   scripts/walnut-sandbox.sh token [REGION]         # use host AWS_BEARER_TOKEN_BEDROCK
#   scripts/walnut-sandbox.sh keys  [REGION]         # use host AWS_ACCESS_KEY_ID/SECRET
#   scripts/walnut-sandbox.sh profile <NAME> [REGION]# use a ~/.aws profile (incl. credential_process)
#   scripts/walnut-sandbox.sh test                   # POST /api/config/test-connection (real round-trip)
#   scripts/walnut-sandbox.sh chat ["message"]       # send one message to the butler, print its reply
#   scripts/walnut-sandbox.sh record <out.mp4>       # record the onboarding chain (needs a token; see below)
#   scripts/walnut-sandbox.sh status                 # health of the sandbox
#   scripts/walnut-sandbox.sh stop                   # stop + wipe the sandbox
#
# record uses scripts/onboarding-chain.mjs and needs a real bearer token in the env:
#   WALNUT_DEMO_BEARER_TOKEN=… scripts/walnut-sandbox.sh record demo/Final/onboarding-chain.mp4
set -uo pipefail

PORT=3457
URL="http://localhost:${PORT}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/walnut-sandbox"
FAKE_HOME="$ROOT/home"
PID_FILE="$ROOT/server.pid"
LOG="$ROOT/server.log"

cmd="${1:-help}"

# ── guards ──────────────────────────────────────────────────────────
refuse_prod() {
  if [ "$PORT" = "3456" ]; then echo "REFUSING to operate on production port 3456." >&2; exit 99; fi
}
build_once() {
  echo "==> building (web:build) …"
  ( cd "$HERE" && npm run web:build >"$ROOT/build.log" 2>&1 ) \
    || { echo "build failed:"; tail -15 "$ROOT/build.log"; exit 1; }
}
wait_health() {
  for _ in $(seq 1 40); do
    sleep 1
    H=$(curl -s "${URL}/api/system/health" 2>/dev/null) && [ -n "$H" ] && { echo "$H"; return 0; }
  done
  echo "(server did not become healthy; tail of log:)"; tail -20 "$LOG"; return 1
}
stop_server() {
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
  lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true   # never 3456
  rm -f "$PID_FILE"
}

# Launch with a chosen HOME and an explicit, minimal env. Extra KEY=VAL pairs ($@) are
# appended to the env (used to inject a token / keys for the token|keys modes).
launch() {
  local home_dir="$1"; shift
  local path_val="$1"; shift
  refuse_prod
  mkdir -p "$home_dir"
  echo "==> HOME=$home_dir  OPEN_WALNUT_HOME=$ROOT/.open-walnut  PORT=$PORT"
  env -i \
    HOME="$home_dir" \
    PATH="$path_val" \
    NODE_ENV=production \
    WALNUT_DISABLE_SEARCH=1 \
    OPEN_WALNUT_HOME="$ROOT/.open-walnut" \
    WALNUT_DAEMON_DIR="$ROOT/daemon" \
    "$@" \
    node "$HERE/dist/cli.js" web --port "$PORT" > "$LOG" 2>&1 &
  echo $! > "$PID_FILE"; disown
  echo "==> pid $(cat "$PID_FILE")  log: $LOG"
}

# Write a providers.bedrock config.yaml into the sandbox's OPEN_WALNUT_HOME.
write_bedrock_config() {  # $1 = yaml body under `bedrock:`
  mkdir -p "$ROOT/.open-walnut"
  cat > "$ROOT/.open-walnut/config.yaml" <<YAML
version: 1
providers:
  bedrock:
    api: bedrock
$1
agent:
  main_provider: bedrock
YAML
}

reset_root() { stop_server; sleep 1; rm -rf "$ROOT"; mkdir -p "$ROOT"; }

case "$cmd" in
  clean)
    reset_root; build_once
    # Fake HOME + no creds = genuine first-run. PATH kept minimal (no ~/.toolbox).
    launch "$FAKE_HOME" "$PATH"
    wait_health ;;

  token)
    region="${2:-${AWS_REGION:-us-west-2}}"
    [ -z "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && { echo "need AWS_BEARER_TOKEN_BEDROCK in env"; exit 2; }
    reset_root; build_once
    write_bedrock_config "    region: $region
    bearer_token: $AWS_BEARER_TOKEN_BEDROCK"
    launch "$FAKE_HOME" "$PATH"
    wait_health ;;

  keys)
    region="${2:-${AWS_REGION:-us-west-2}}"
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] && { echo "need AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"; exit 2; }
    reset_root; build_once
    write_bedrock_config "    region: $region
    aws_access_key_id: $AWS_ACCESS_KEY_ID
    aws_secret_access_key: $AWS_SECRET_ACCESS_KEY"
    launch "$FAKE_HOME" "$PATH"
    wait_health ;;

  profile)
    prof="${2:-}"; region="${3:-us-west-2}"
    [ -z "$prof" ] && { echo "usage: walnut-sandbox.sh profile <NAME> [REGION]"; exit 2; }
    reset_root; build_once
    write_bedrock_config "    region: $region
    aws_profile: $prof"
    # REAL HOME so ~/.aws/config resolves; ~/.toolbox/bin on PATH so credential_process (ada) runs.
    launch "$HOME" "$HOME/.toolbox/bin:$PATH"
    wait_health ;;

  test)
    body="${2:-{}}"
    curl -s -X POST "${URL}/api/config/test-connection" \
      -H 'content-type: application/json' -d "$body" | (python3 -m json.tool 2>/dev/null || cat) ;;

  chat)
    msg="${2:-in one sentence, what can you help me with?}"
    node "$HERE/scripts/walnut-sandbox-chat.mjs" "$URL" "$msg" ;;

  record)
    out="${2:-demo/Final/onboarding-chain.mp4}"
    [ -z "${WALNUT_DEMO_BEARER_TOKEN:-${AWS_BEARER_TOKEN_BEDROCK:-}}" ] && { echo "need WALNUT_DEMO_BEARER_TOKEN (or AWS_BEARER_TOKEN_BEDROCK)"; exit 2; }
    # Ensure a clean first-run server is up, then drive + record the onboarding chain.
    reset_root; build_once; launch "$FAKE_HOME" "$PATH"; wait_health >/dev/null
    WALNUT_DEMO_BEARER_TOKEN="${WALNUT_DEMO_BEARER_TOKEN:-$AWS_BEARER_TOKEN_BEDROCK}" \
    WALNUT_DEMO_REGION="${WALNUT_DEMO_REGION:-${AWS_REGION:-us-west-2}}" \
      node "$HERE/scripts/onboarding-chain.mjs" --url "$URL" --out "$out" ;;

  status)
    curl -s "${URL}/api/system/health" | (python3 -m json.tool 2>/dev/null || cat) ;;

  stop)
    stop_server; rm -rf "$ROOT"; echo "stopped + wiped." ;;

  *)
    sed -n '2,40p' "$0" ;;
esac
