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
#   scripts/walnut-sandbox.sh export ["CMD"] [REGION] # use an awsCredentialExport command (temp creds)
#   scripts/walnut-sandbox.sh subscription [MODEL]   # text-only Claude Code subscription (claude -p)
#   scripts/walnut-sandbox.sh test                   # POST /api/config/test-connection (real round-trip)
#   scripts/walnut-sandbox.sh chat ["message"]       # send one message to the butler, print its reply
#   scripts/walnut-sandbox.sh record <out.mp4>       # record the onboarding chain (needs a token; see below)
#   scripts/walnut-sandbox.sh status                 # health of the sandbox
#   scripts/walnut-sandbox.sh stop                   # stop + wipe the sandbox
#
# record uses scripts/onboarding-chain.mjs and needs a real bearer token in the env:
#   WALNUT_DEMO_BEARER_TOKEN=… scripts/walnut-sandbox.sh record demo/Final/onboarding-chain.mp4
set -uo pipefail

# Overridable: :3457 doubles as the Playwright fixture port, whose orphan sweep
# (pw-gate) reaps anything it finds listening there — a sandbox parked on 3457
# during a concurrent Playwright run gets SIGTERMed mid-use. Pick 3458+ then.
PORT="${WALNUT_SANDBOX_PORT:-3457}"
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
  # Confirm the death, then escalate. The lsof fallback only sees servers that
  # BOUND the port — one SIGTERMed mid-boot holds none, so it would leak silently
  # with its background loops running (2026-08-09: 43 such leaks starved the Mac).
  if [ -f "$PID_FILE" ]; then
    spid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$spid" ]; then
      kill -15 "$spid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$spid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$spid" 2>/dev/null; then
        echo "==> sandbox server pid $spid ignored SIGTERM — SIGKILL" >&2
        kill -9 "$spid" 2>/dev/null || true
      fi
    fi
  fi
  lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -15 2>/dev/null || true   # never 3456
  sleep 1
  lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true    # never 3456
  rm -f "$PID_FILE"
  reap_session_groups
}

# Kill any claude CLI process groups the sandbox daemon left behind. The daemon's
# own cleanup() handles the graceful-exit path, but a hard-killed daemon (or a
# pre-fix leak) leaves CLIs parented to launchd forever — 15 were found running
# 8 days on 2026-07-25.
#
# SAFETY: a .pgid file's provenance ($ROOT, sandbox-only) proves nothing about the
# pid NUMBER inside it — nothing unlinks .pgid on session death, so a days-old file
# can name a pid macOS has since recycled as some unrelated group leader (another
# agent's daemon, a prod CLI, a browser). So we verify IDENTITY before signalling:
# the leader's command must look like a claude CLI. Mirrors the daemon-side
# start-time drift check in daemon-core.ts.
sandbox_pgids() {
  for f in "$ROOT"/daemon-streams/*.pgid "$ROOT"/daemon/*.pgid; do
    [ -f "$f" ] || continue
    pgid=$(cat "$f" 2>/dev/null)
    case "$pgid" in ''|*[!0-9]*) continue ;; esac
    # Identity gate: leader pid must still be a claude process.
    cmd=$(ps -o command= -p "$pgid" 2>/dev/null) || continue
    case "$cmd" in *claude*) echo "$pgid" ;; esac
  done
}
reap_session_groups() {
  pgids=$(sandbox_pgids)
  [ -z "$pgids" ] && return 0
  # SIGINT first so the CLI's on-stop / SessionEnd hooks get to run (CLAUDE.md:
  # never force-kill Claude Code). Budget > the CLI's ~3.5-5s shutdown window.
  for pgid in $pgids; do
    kill -INT -- "-$pgid" 2>/dev/null && echo "==> reaping sandbox session group $pgid (SIGINT)"
  done
  for _ in 1 2 3 4 5 6; do
    sleep 1
    [ -z "$(sandbox_pgids)" ] && return 0
  done
  # Stragglers: SIGTERM, then SIGKILL (orphan CLIs blocked on FIFO stdin ignore
  # SIGTERM outright — observed 2026-07-25).
  for pgid in $(sandbox_pgids); do kill -TERM -- "-$pgid" 2>/dev/null || true; done
  sleep 2
  for pgid in $(sandbox_pgids); do
    kill -KILL -- "-$pgid" 2>/dev/null && echo "==> SIGKILLed sandbox session group $pgid"
  done
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
  main_provider: bedrock${WALNUT_SANDBOX_MAIN_MODEL:+
  main_model: $WALNUT_SANDBOX_MAIN_MODEL}
YAML
}

# Write a providers.claude_cli config.yaml (text-only subscription provider).
write_subscription_config() {  # $1 = model alias (default|opus|sonnet|haiku)
  mkdir -p "$ROOT/.open-walnut"
  cat > "$ROOT/.open-walnut/config.yaml" <<YAML
version: 1
providers:
  claude_cli:
    api: claude-cli
agent:
  main_provider: claude_cli
  main_model: ${1:-default}
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
    # AWS_PROFILE: the cloud-setup wizard shells out to the bare `aws` CLI (detectCreds,
    # cdk deploy) — without it, a machine whose [default] profile is stale shows
    # "installed but has no usable credentials" even though the chosen profile works.
    launch "$HOME" "$HOME/.toolbox/bin:$PATH" AWS_PROFILE="$prof"
    wait_health ;;

  export)
    # awsCredentialExport path: a shell command prints {Credentials:{...,SessionToken}}.
    # Default to Claude Code's own exporter. REAL HOME + ~/.toolbox/bin so the command
    # (which reads ~/.aws / runs credential_process helpers) can resolve.
    xcmd="${2:-\"$HOME/.toolbox/bin/claude\" default-credential-export}"
    region="${3:-us-west-2}"
    # Emit as a YAML single-quoted scalar (double any embedded single quotes) so a
    # command like `"/path/claude" default-credential-export` — a double-quoted path
    # followed by an arg — doesn't break YAML parsing and silently drop the block.
    xcmd_yaml="'${xcmd//\'/\'\'}'"
    reset_root; build_once
    write_bedrock_config "    region: $region
    aws_credential_export: $xcmd_yaml"
    launch "$HOME" "$HOME/.toolbox/bin:$PATH"
    wait_health ;;

  subscription)
    # Text-only Claude Code SUBSCRIPTION provider (spawns `claude -p`, no key).
    # REAL HOME so the CLI finds the logged-in subscription (keychain/.credentials);
    # ~/.toolbox/bin on PATH so a logged-in `claude` resolves. We deliberately do
    # NOT inject AWS_BEARER_TOKEN_BEDROCK — the adapter strips it anyway, and its
    # absence keeps the config purely subscription.
    model="${2:-default}"
    reset_root; build_once
    write_subscription_config "$model"
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
