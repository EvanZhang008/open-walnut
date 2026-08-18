#!/usr/bin/env bash
# Voice Quick Action E2E (LIVE layer of the T54 ladder) — real isolated server,
# real app, real AVAudioSession + simulator microphone, Maestro-driven.
#
#   voice-quickaction-e2e.sh <simulator-udid>
#
# What it proves end-to-end (things no unit test can):
#   1. The quick action lands the app on the CHAT tab already RECORDING — no tap
#      on the mic button, no tab switch. The recording row's caption reads
#      "Recording — stop to send", i.e. auto-send is armed.
#   2. Stopping uploads the take to POST /api/v1/stt/transcribe (verified in the
#      SERVER's log, not just by a UI guess) — so the mic really captured and the
#      transcription request really left the phone.
#   3. The transcript is SENT to the MAIN agent with no confirmation step: it
#      appears as a user message in GET /api/v1/conversations/:id/messages under
#      agentId=general. This is the assertion the whole feature exists for.
#   4. Auto-send is ONE-SHOT: an ordinary mic tap afterwards fills the DRAFT
#      instead of sending (the caption reads plain "Recording…").
#
# Why a launch ARGUMENT and not a real long-press: `simctl` has no verb for the
# Home-screen quick-action menu (and Maestro drives the app, not SpringBoard), so
# a real long-press cannot be automated here. `-voice-quick-action` (DEBUG only)
# enters through the SAME `VoiceQuickAction.handle()` call the UIKit delegate
# uses, so everything downstream of delivery is the production path.
#
# What therefore stays MANUAL-ONLY verification on a real device / by hand:
#   - the long-press menu actually SHOWING "Voice to Walnut" with the mic glyph
#     (SpringBoard renders it from Info.plist; the unit test pins the plist entry
#     and its title, which is as far as automation reaches);
#   - which UIKit callback fires per app state — `didFinishLaunchingWithOptions`
#     (cold) vs `performActionFor` (warm). The armed request's `source` field is
#     logged for exactly this, so a field log answers it after the fact;
#   - AirPods / wired-headset mic routing, and recording across a real screen
#     lock (the simulator enforces neither).
#
# STT: a stub OpenAI-compatible transcription server on :3461 returns a fixed
# sentence, so the assertion is deterministic and no real speech (or real STT
# engine / API key) is needed. The phone's upload, the server's engine dispatch,
# and the agent send are all real.
#
# Isolation: own server port (:3459) + own stub port (:3461) + throwaway
# OPEN_WALNUT_HOME — never touches :3456 (prod), :3457 (Playwright) or :3519
# (calendar E2E). Serialized machine-wide via the /tmp/maestro-ios.lock mutex.
#
# Artifacts: /tmp/t54-voice-qa/*.png + logs (kept for review, never deleted).
set -uo pipefail

UDID="${1:-}"
[ -n "$UDID" ] || { echo "usage: $0 <simulator-udid>"; exit 2; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="dev.openwalnut.ios"
PORT=3459
STUB_PORT=3461
WORK=/tmp/t54-voice-qa
HOME_DIR="$WORK/server-home"
APP="$WORK/dd/Build/Products/Debug-iphonesimulator/Walnut.app"
LOCK=/tmp/maestro-ios.lock
MAESTRO="${MAESTRO_CLI:-$HOME/.maestro/bin/maestro}"
# What the stub STT returns — the exact string asserted in chat history.
TRANSCRIPT="Remind me to water the plants tonight"
[ -x "$MAESTRO" ] || { echo "maestro CLI not found at $MAESTRO"; exit 1; }

mkdir -p "$WORK"
FAIL=0
log() { echo "[voice-e2e $(date +%H:%M:%S)] $*"; }
fail() { log "FAIL: $*"; FAIL=1; }

# ── mutex: one Maestro run at a time on this machine ─────────────────────────
acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    if [ -f "$LOCK/pid" ]; then
      local holder; holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        log "reaping stale maestro lock (dead pid $holder)"; rm -rf "$LOCK"; continue
      fi
    fi
    [ "$waited" -ge 2700 ] && { log "gave up waiting for $LOCK"; exit 1; }
    sleep 10; waited=$((waited + 10))
  done
  echo $$ > "$LOCK/pid"
}
release_lock() { rm -rf "$LOCK"; }
acquire_lock

SERVER_PID=""
STUB_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  release_lock
}
trap cleanup EXIT

for p in $PORT $STUB_PORT; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    log "port $p already in use — refusing to continue"; exit 1
  fi
done

# ── stub STT (OpenAI-compatible /v1/audio/transcriptions) ────────────────────
# Deterministic text + an upload-size log line, so "the phone really sent audio"
# is provable rather than inferred.
cat > "$WORK/stt-stub.mjs" <<'JS'
import { createServer } from 'node:http'
const port = Number(process.argv[2])
const text = process.argv[3]
createServer((req, res) => {
  let bytes = 0
  req.on('data', (c) => { bytes += c.length })
  req.on('end', () => {
    console.log(`[stt-stub] ${req.method} ${req.url} bytes=${bytes}`)
    if (req.url.includes('/audio/transcriptions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text }))
      return
    }
    res.writeHead(404); res.end('{}')
  })
}).listen(port, '127.0.0.1', () => console.log(`[stt-stub] listening on ${port}`))
JS
node "$WORK/stt-stub.mjs" "$STUB_PORT" "$TRANSCRIPT" > "$WORK/stt-stub.log" 2>&1 &
STUB_PID=$!
sleep 1

# ── isolated Walnut server (:3459, throwaway HOME + data dir) ────────────────
# env -i + fake HOME so it can never read real credentials or ~/.open-walnut.
# The stub is wired in as the `openai` STT engine; the transcribe route then
# runs its REAL primary-box dispatch path against it.
rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/fake-home" "$HOME_DIR/.open-walnut"
cat > "$HOME_DIR/.open-walnut/config.yaml" <<YAML
stt:
  engine: openai
  openai_api_key: stub-key
  openai_base_url: http://127.0.0.1:$STUB_PORT/v1
  openai_model: stub-whisper
YAML
log "starting isolated server on :$PORT (home: $HOME_DIR)"
env -i \
  HOME="$HOME_DIR/fake-home" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" \
  NODE_ENV=production \
  WALNUT_DISABLE_SEARCH=1 \
  OPEN_WALNUT_HOME="$HOME_DIR/.open-walnut" \
  node "$REPO/dist/cli.js" web --port $PORT > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null \
  || { log "server did not come up — see $WORK/server.log"; exit 1; }

# ── simulator: fresh install, mic GRANTED, pointed at the isolated server ────
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
[ -d "$APP" ] || { log "app not built at $APP"; exit 1; }
xcrun simctl install "$UDID" "$APP"
# Granting up front keeps the flow about the FEATURE. The denied path is covered
# by the unit test (start() fails → auto-send disarms) — reproducing a
# SpringBoard permission alert here would only re-test AVFoundation.
xcrun simctl privacy "$UDID" grant microphone "$BUNDLE"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "voice-e2e"

export PATH="$HOME/.maestro/bin:$PATH"
run_flow() { # name, flow-file
  if "$MAESTRO" --udid "$UDID" test "$2" > "$WORK/maestro-$1.log" 2>&1; then
    log "flow $1 PASS"
  else
    fail "flow $1 — see $WORK/maestro-$1.log"
  fi
}

# ── flow 1: quick action → already recording, armed for auto-send ────────────
cat > "$WORK/flow-quickaction.yaml" <<YAML
appId: $BUNDLE
---
# No taps at all before this assertion: the launch alone must land on Chat with
# the mic already open. "stop to send" is the auto-send arming, visible.
- extendedWaitUntil:
    visible: "Recording — stop to send"
    timeout: 15000
- takeScreenshot: $WORK/01-recording-armed
- assertVisible:
    id: "chat.voiceStop"
- assertVisible:
    id: "chat.voiceCancel"
YAML
log "cold launch with -voice-quick-action"
xcrun simctl launch "$UDID" "$BUNDLE" -voice-quick-action >/dev/null
sleep 4
run_flow "quickaction" "$WORK/flow-quickaction.yaml"

# ── flow 2: stop → upload → transcript auto-sent to the main agent ───────────
# The simulator mic records silence; the stub returns text regardless, which is
# exactly the point (the assertion is about ROUTING, not speech recognition).
cat > "$WORK/flow-send.yaml" <<YAML
appId: $BUNDLE
---
- tapOn:
    id: "chat.voiceStop"
# The transcript must appear as a SENT message, never as composer text.
- extendedWaitUntil:
    visible: "$TRANSCRIPT"
    timeout: 30000
- takeScreenshot: $WORK/02-transcript-sent
YAML
sleep 3   # let a little audio accumulate (>1KB, the too-short floor)
run_flow "send" "$WORK/flow-send.yaml"

# ── server-side proof: the upload happened AND the agent got the message ─────
if grep -q "audio/transcriptions" "$WORK/stt-stub.log"; then
  UP_BYTES="$(grep -o 'bytes=[0-9]*' "$WORK/stt-stub.log" | tail -1 | cut -d= -f2)"
  log "STT upload verified at the stub (bytes=$UP_BYTES)"
  [ "${UP_BYTES:-0}" -gt 1000 ] || fail "upload was only ${UP_BYTES}B — the mic captured nothing"
else
  fail "no transcription request reached the stub — see $WORK/stt-stub.log"
fi

sleep 3
CONV="$(curl -sf "http://localhost:$PORT/api/v1/conversations?agentId=general&limit=5" \
  | /usr/bin/python3 -c "import json,sys; c=json.load(sys.stdin); print(c[0]['id'] if c else '')")"
if [ -z "$CONV" ]; then
  fail "no conversation was created on the main agent — the transcript never got sent"
else
  log "main-agent conversation: $CONV"
  SENT="$(curl -sf "http://localhost:$PORT/api/v1/conversations/$CONV/messages?agentId=general&limit=20" \
    | /usr/bin/python3 -c "import json,sys; ms=json.load(sys.stdin); \
print('YES' if any(m['role']=='user' and \"$TRANSCRIPT\" in m['text'] for m in ms) else 'NO')")"
  if [ "$SENT" = "YES" ]; then
    log "transcript verified as a USER message on agent 'general' (no confirmation step)"
  else
    fail "transcript is not in main-agent history — it was left in the draft or lost"
  fi
fi

# ── flow 3: auto-send is one-shot — the next mic tap fills the DRAFT ─────────
cat > "$WORK/flow-oneshot.yaml" <<YAML
appId: $BUNDLE
---
- tapOn:
    id: "chat.mic"
- extendedWaitUntil:
    visible: "Recording…"
    timeout: 15000
- assertNotVisible: "Recording — stop to send"
- takeScreenshot: $WORK/03-manual-take-not-armed
- tapOn:
    id: "chat.voiceStop"
# Composer text, NOT a sent bubble: the field now holds the transcript.
- extendedWaitUntil:
    visible: "$TRANSCRIPT"
    timeout: 30000
- assertVisible:
    id: "chat.send"
- takeScreenshot: $WORK/04-draft-awaiting-send
YAML
sleep 2
run_flow "oneshot" "$WORK/flow-oneshot.yaml"

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
log "screenshots: $(ls "$WORK"/*.png 2>/dev/null | tr '\n' ' ')"
[ "$FAIL" = 0 ] && log "RESULT: PASS" || log "RESULT: FAIL"
exit "$FAIL"
