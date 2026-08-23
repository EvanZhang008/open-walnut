#!/usr/bin/env bash
# Human Inbox iOS E2E (LIVE layer) — real isolated server, real app on a
# simulator, Maestro-driven taps. Todo item M7.
#
#   inbox-e2e.sh [simulator-udid]      (default: the booted iPhone 16 Pro)
#
# What it proves end to end (things no unit test can):
#   1. Letters an AGENT sent (POST /api/v1/human-inbox, exactly how `wn` does it,
#      caller sid in the header) reach the phone's Inbox tab as envelope rows,
#      with the badge counting the unread ones.
#   2. Opening a row renders the DOCUMENT: an html letter through the WKWebView,
#      and the inline <script> an agent may have written does NOT run — the
#      visible text is the letter, never the script's output. This is the
#      security floor the unit test can only pin as configuration.
#   3. One tap on a decision button answers the letter: the server records
#      `answered` (asserted over HTTP, not by reading the UI back), and the
#      reader flips to the answered record.
#   4. A free-text reply from the human lands in the letter's thread server-side.
#   5. Reading a letter marks THAT letter read (server state), which is the
#      letter-vs-notification distinction the whole feature rests on.
#
# Isolation: own port (:3463) + throwaway OPEN_WALNUT_HOME under $WORK, launched
# with `env -i` so it can never read real credentials. Never touches :3456
# (production), :3457 (Playwright), :3459/:3461 (voice E2E) or :3519 (calendar).
# Serialized machine-wide via the /tmp/maestro-ios.lock mutex, like the voice E2E.
#
# Artifacts: /tmp/human-inbox-ios/*.png + logs (kept for review, never deleted).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="dev.openwalnut.ios"
PORT=3463
WORK=/tmp/human-inbox-ios
HOME_DIR="$WORK/server-home"
APP="$WORK/dd/Build/Products/Debug-iphonesimulator/Walnut.app"
LOCK=/tmp/maestro-ios.lock
MAESTRO="${MAESTRO_CLI:-$HOME/.maestro/bin/maestro}"
DEVICE_NAME="${DEVICE_NAME:-iPhone 16 Pro}"
UDID="${1:-}"

# The letter body carries a script an agent could plausibly have written. If the
# web view ever executes it, SCRIPT_OUTPUT appears on screen; the flow asserts it
# does not, while BODY_MARKER (ordinary text) must be visible.
BODY_MARKER="Sync freeze root cause"
SCRIPT_OUTPUT="PWNEDBYSCRIPT"

[ "$PORT" = "3456" ] && { echo "refusing to act on port 3456 (production)" >&2; exit 1; }
[ -x "$MAESTRO" ] || { echo "maestro CLI not found at $MAESTRO" >&2; exit 1; }

mkdir -p "$WORK"
FAIL=0
log() { echo "[inbox-e2e $(date +%H:%M:%S)] $*"; }
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
    [ "$waited" -ge 1800 ] && { log "gave up waiting for $LOCK"; exit 1; }
    sleep 10; waited=$((waited + 10))
  done
  echo $$ > "$LOCK/pid"
}
release_lock() { rm -rf "$LOCK"; }
acquire_lock

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  local listener; listener="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$listener" ] && kill -15 $listener 2>/dev/null
  release_lock
  log "artifacts: $WORK"
}
trap cleanup EXIT

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  log "port $PORT already in use — refusing to continue"; exit 1
fi

# ── simulator ────────────────────────────────────────────────────────────────
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices booted -j | python3 -c "
import json,sys
for rt in json.load(sys.stdin)['devices'].values():
    for d in rt:
        if d['name'] == '$DEVICE_NAME': print(d['udid']); raise SystemExit
")"
fi
[ -n "$UDID" ] || { log "no booted '$DEVICE_NAME' — boot one or pass a udid"; exit 1; }
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

# ── isolated Walnut server ───────────────────────────────────────────────────
# env -i + fake HOME so it can never read real credentials or ~/.open-walnut.
rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/fake-home" "$HOME_DIR/.open-walnut"
log "starting isolated server on :$PORT (home: $HOME_DIR)"
env -i \
  HOME="$HOME_DIR/fake-home" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" \
  NODE_ENV=production \
  WALNUT_DISABLE_SEARCH=1 \
  OPEN_WALNUT_HOME="$HOME_DIR/.open-walnut" \
  node "$REPO/dist/cli.js" web --port $PORT > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 90); do
  curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null \
  || { log "server did not come up — see $WORK/server.log"; exit 1; }

# ── seed letters exactly the way an agent does ───────────────────────────────
# The caller sid is a header, never a body field, so the sender can't be spoofed
# by the letter itself. No session exists on this throwaway server, so the
# server stamps the `external` sender — which is itself the behaviour under test.
send_letter() { # json-file → letter id
  curl -sf -X POST "http://localhost:$PORT/api/v1/human-inbox" \
    -H 'content-type: application/json' \
    -H 'x-walnut-caller-sid: e2e-agent-session' \
    --data-binary @"$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}

python3 - "$WORK" "$BODY_MARKER" "$SCRIPT_OUTPUT" <<'PY'
import json, sys
work, marker, script_out = sys.argv[1:4]
decision = {
    "subject": "Decision needed: retry window for the nightly fetch",
    "type": "action_required",
    "text": "Two ways to stop the post-compaction fetch from being killed. A widens the window, B retries with backoff.",
    "html": (
        "<h2>%s</h2>"
        "<p>The nightly fetch is killed at 15s after a compaction, which buries the disk in temp packs.</p>"
        "<p>Pick one and I will land it tonight.</p>"
        # An agent could plausibly write this. The web view must render it as
        # nothing at all — if scripting were on, the marker below would appear.
        "<script>document.body.innerHTML = '%s'</script>"
    ) % (marker, script_out),
    "actions": [
        {"id": "widen-window", "label": "Widen the window to 10 minutes",
         "description": "Simplest, one constant"},
        {"id": "retry-backoff", "label": "Retry with backoff",
         "description": "More code, survives a slow network too"},
    ],
}
digest = {
    "subject": "Overnight run finished: 42 files migrated",
    "type": "completion",
    "text": "All tests green. Three files needed a manual touch; they are listed in the letter.",
    "markdown": "## Migration done\n\n- 42 files migrated\n- tests: **green**\n- 3 manual touches: `a.ts`, `b.ts`, `c.ts`\n",
}
heads_up = {
    "subject": "Heads up: the build host disk is at 70%",
    "type": "info",
    "text": "Not urgent. Cleaning the old artifact cache would free about 20GB.",
    "markdown": "Nothing to do yet. The artifact cache is the biggest chunk.\n",
    "pin": True,
}
for name, payload in (("decision", decision), ("digest", digest), ("headsup", heads_up)):
    with open("%s/letter-%s.json" % (work, name), "w") as fh:
        json.dump(payload, fh)
PY

DECISION_ID="$(send_letter "$WORK/letter-decision.json")"
DIGEST_ID="$(send_letter "$WORK/letter-digest.json")"
HEADSUP_ID="$(send_letter "$WORK/letter-headsup.json")"
for id in "$DECISION_ID" "$DIGEST_ID" "$HEADSUP_ID"; do
  case "$id" in lt-*) ;; *) log "seed failed (got '$id') — see $WORK/server.log"; exit 1 ;; esac
done
log "seeded letters: $DECISION_ID $DIGEST_ID $HEADSUP_ID"

UNREAD="$(curl -sf "http://localhost:$PORT/api/v1/human-inbox" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["unreadCount"])')"
[ "$UNREAD" = "3" ] || fail "expected 3 unread letters server-side, got '$UNREAD'"

# ── install + point the app at the isolated server ───────────────────────────
[ -d "$APP" ] || { log "app not built at $APP — run: xcodebuild -scheme Walnut -configuration Debug -destination 'platform=iOS Simulator,name=$DEVICE_NAME' -derivedDataPath $WORK/dd build"; exit 1; }
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
# The simulator reaches the host over loopback, and loopback skips auth, so any
# non-empty token satisfies AppConfig.isConfigured (same hook the voice E2E uses).
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "inbox-e2e"

export PATH="$HOME/.maestro/bin:$PATH"
run_flow() { # name, flow-file
  if "$MAESTRO" --udid "$UDID" test "$2" > "$WORK/maestro-$1.log" 2>&1; then
    log "flow $1 PASS"
  else
    fail "flow $1 — see $WORK/maestro-$1.log"
    return 1
  fi
}

# ── ONE flow, one driver session ────────────────────────────────────────────
# Deliberately not five `maestro test` invocations: each one implicitly
# RELAUNCHES the app, which resets the navigation stack, so a step that expects
# to already be inside the reader (the decision note, the composer) finds
# nothing. It also pays the XCUITest driver's startup five times, which is the
# part that starves first when the machine is loaded.
cat > "$WORK/flow-inbox.yaml" <<YAML
appId: $BUNDLE
---
- launchApp

# ── the letters an agent sent are on the phone ──────────────────────────────
- tapOn: "Inbox"
- extendedWaitUntil:
    visible: "Decision needed: retry window for the nightly fetch"
    timeout: 25000
- assertVisible: "Overnight run finished: 42 files migrated"
- assertVisible: "Heads up: the build host disk is at 70%"
# Stamped envelope, not agent-written: the external sender label.
- assertVisible: "External agent"
- takeScreenshot: $WORK/01-inbox-list

# ── the reader renders the DOCUMENT, and the letter's script does not run ───
- tapOn:
    id: "inbox.row.$DECISION_ID"
- extendedWaitUntil:
    visible:
      id: "inbox.letter.subject"
    timeout: 25000
# This assertion is the CONTROL for the next one: it proves Maestro can read the
# web view's text at all, so "the script output is not visible" is meaningful
# rather than vacuous.
- extendedWaitUntil:
    visible: "$BODY_MARKER"
    timeout: 25000
- assertNotVisible: "$SCRIPT_OUTPUT"
- assertVisible: "This letter needs a decision"
- assertVisible: "Widen the window to 10 minutes"
- takeScreenshot: $WORK/02-reader-html-body

# ── one tap answers it, and the note rides with the choice ──────────────────
- tapOn:
    id: "inbox.letter.decisionNote"
- inputText: "only after the tests pass"
- hideKeyboard
- tapOn:
    id: "inbox.letter.action.retry-backoff"
- extendedWaitUntil:
    visible:
      id: "inbox.letter.answered"
    timeout: 25000
- assertVisible: "Retry with backoff"
- takeScreenshot: $WORK/03-answered

# ── a human free-text reply lands in the thread ─────────────────────────────
- tapOn:
    id: "inbox.letter.replyField"
- inputText: "does this also explain the Tuesday incident"
- hideKeyboard
- tapOn:
    id: "inbox.letter.send"
- extendedWaitUntil:
    visible: "does this also explain the Tuesday incident"
    timeout: 25000
- takeScreenshot: $WORK/04-thread-reply

# ── back to the list: this letter is read, the other two are not ────────────
# NOT Maestro's \`back\`: on iOS that is a left-edge swipe, and it does not pop a
# NavigationStack whose child is a ScrollView (it scrolls instead) — verified,
# the reader stayed on screen. The real chevron carries the id \`BackButton\`.
- tapOn:
    id: "BackButton"
- extendedWaitUntil:
    visible: "Heads up: the build host disk is at 70%"
    timeout: 25000
- assertNotVisible:
    id: "inbox.letter.subject"
- takeScreenshot: $WORK/05-inbox-after-read
YAML
run_flow inbox "$WORK/flow-inbox.yaml"

# ── server-side assertions: the phone really changed the letter ─────────────
log "asserting server state for $DECISION_ID"
curl -sf "http://localhost:$PORT/api/v1/human-inbox/$DECISION_ID" > "$WORK/letter-after.json" \
  || fail "could not re-read the letter"
python3 - "$WORK/letter-after.json" <<'PY' || FAIL=1
import json, sys
letter = json.load(open(sys.argv[1]))["letter"]
problems = []
answered = letter.get("answered") or {}
if answered.get("actionId") != "retry-backoff":
    problems.append("answered.actionId = %r" % answered.get("actionId"))
if "tests pass" not in (answered.get("freeText") or ""):
    problems.append("answer note missing: %r" % answered.get("freeText"))
if letter.get("read") is not True:
    problems.append("opening the letter did not mark it read")
human = [t for t in letter.get("thread", []) if t.get("from") == "human"]
if not any("Tuesday incident" in (t.get("text") or "") for t in human):
    problems.append("human reply not in thread: %r" % [t.get("text") for t in human])
if problems:
    print("SERVER-STATE MISMATCH:"); [print("  -", p) for p in problems]; raise SystemExit(1)
print("server state ok: answered=%s note=%r read=%s human turns=%d"
      % (answered.get("actionId"), answered.get("freeText"), letter.get("read"), len(human)))
PY

# The other two letters must still be unread: reading one letter marks ONE.
STILL="$(curl -sf "http://localhost:$PORT/api/v1/human-inbox" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["unreadCount"])')"
[ "$STILL" = "2" ] || fail "expected 2 letters still unread, got '$STILL'"

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
log "screenshots: $(ls "$WORK"/*.png 2>/dev/null | tr '\n' ' ')"
[ "$FAIL" = 0 ] && log "PASS" || log "FAILED"
exit "$FAIL"
