#!/usr/bin/env bash
# Calendar E2E (LIVE layer of the calendar test ladder) — real isolated server,
# real app, real EventKit permission dialogs, Maestro-driven.
#
#   calendar-e2e.sh <simulator-udid>
#
# What it proves end-to-end:
#   1. Tasks seeded over /api/v1 (due dates across TWO months) appear as month
#      grid dots + day agenda rows.
#   2. EventKit permission DENIED path: the lazy first-open prompt, "Don't
#      Allow" → the Settings hint shows and the task layer keeps working.
#   3. Month navigation (chevron) reaches next month's seeded task.
#   4. Day quick-add creates a task pre-dated to the selected day (verified
#      back through the API, not just the UI).
#   5. Permission GRANTED path (simctl privacy grant + relaunch): hint gone.
#
# Isolation: own server port (:3519) + throwaway OPEN_WALNUT_HOME — never
# touches :3456 (prod) or :3457 (Playwright). Serialized machine-wide via the
# /tmp/maestro-ios.lock mutex (mkdir-based; macOS has no flock).
#
# Artifacts: /tmp/ios-calendar/*.png + logs (kept for review, never deleted).
set -uo pipefail

UDID="${1:-}"
[ -n "$UDID" ] || { echo "usage: $0 <simulator-udid>"; exit 2; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="dev.openwalnut.ios"
PORT=3519
WORK=/tmp/ios-calendar
HOME_DIR="$WORK/server-home"
APP="$WORK/dd/Build/Products/Debug-iphonesimulator/Walnut.app"
LOCK=/tmp/maestro-ios.lock
# The REAL Maestro binary (~/.maestro/bin) — NOT the skill's tools-call shim.
MAESTRO="${MAESTRO_CLI:-$HOME/.maestro/bin/maestro}"
[ -x "$MAESTRO" ] || { echo "maestro CLI not found at $MAESTRO"; exit 1; }

mkdir -p "$WORK"
FAIL=0

log() { echo "[calendar-e2e $(date +%H:%M:%S)] $*"; }

# ── mutex: one Maestro run at a time on this machine ─────────────────────────
acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    # Self-heal a stale lock (holder pid gone or >45 min old).
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
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  release_lock
}
trap cleanup EXIT

# ── isolated server (:3519, throwaway HOME + data dir) ───────────────────────
# Same isolation recipe as scripts/walnut-sandbox.sh: env -i + fake HOME so the
# server can never see real credentials or the prod ~/.open-walnut data.
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  log "port $PORT already in use — refusing to continue"; exit 1
fi
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
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/v1/status" >/dev/null \
  || { log "server did not come up — see $WORK/server.log"; exit 1; }

# ── seed tasks across two months over the API ────────────────────────────────
TODAY="$(date +%Y-%m-%d)"
NEXT_MONTH="$(date -v+1m -v15d +%Y-%m-%d)"
seed() { # title, due
  curl -sf -X POST "http://localhost:$PORT/api/v1/tasks" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"$1\",\"due_date\":\"$2\"}" >/dev/null \
    || { log "seed failed: $1"; FAIL=1; }
}
log "seeding tasks: today=$TODAY next-month=$NEXT_MONTH"
seed "Cal E2E due today" "$TODAY"
seed "Cal E2E timed today" "${TODAY}T09:30:00"
seed "Cal E2E next month" "$NEXT_MONTH"

# ── simulator: install fresh, reset calendar permission, point at server ─────
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
[ -d "$APP" ] || { log "app not built at $APP"; exit 1; }
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" reset calendar "$BUNDLE" 2>/dev/null || true
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "calendar-e2e"

export PATH="$HOME/.maestro/bin:$PATH"
run_flow() { # name, flow-file
  if "$MAESTRO" --udid "$UDID" test "$2" > "$WORK/maestro-$1.log" 2>&1; then
    log "flow $1 PASS"
  else
    log "flow $1 FAIL — see $WORK/maestro-$1.log"; FAIL=1
  fi
}

# ── flow 1: permission DENIED path + grid dots + agenda + month nav ──────────
NEXT_MONTH_TITLE="$(date -v+1m +'%B %Y')"
cat > "$WORK/flow-denied.yaml" <<YAML
appId: $BUNDLE
---
# The EventKit ask is a SpringBoard alert — invisible to Maestro's app-scoped
# hierarchy (probe-verified). Screenshot it as the artifact, then blind-tap
# the full-width "Don't Allow" button (bottom sheet button, ~80% down); the
# in-app deniedHint assertion right after proves the tap landed.
- takeScreenshot: $WORK/01-permission-prompt
- tapOn:
    point: 50%,80%
- extendedWaitUntil:
    visible:
      id: "calendar.deniedHint"
    timeout: 10000
- extendedWaitUntil:                     # task layer unblocked by the denial
    visible: "Cal E2E due today"
    timeout: 15000
- assertVisible:
    id: "calendar.day.$TODAY"
- takeScreenshot: $WORK/02-month-grid-denied-hint
- tapOn:
    id: "calendar.day.$TODAY"
- assertVisible: "Cal E2E timed today"
- assertVisible: ".*9:30.*"               # timed row shows the clock time
- takeScreenshot: $WORK/03-day-agenda
- tapOn:
    id: "calendar.nextMonth"
- assertVisible: "$NEXT_MONTH_TITLE"
- tapOn:
    id: "calendar.day.$NEXT_MONTH"
- extendedWaitUntil:
    visible: "Cal E2E next month"
    timeout: 5000
- takeScreenshot: $WORK/04-next-month-agenda
YAML
log "launching app with -calendar-harness (fresh permission state)"
xcrun simctl launch "$UDID" "$BUNDLE" -calendar-harness >/dev/null
sleep 4
run_flow "denied" "$WORK/flow-denied.yaml"

# ── flow 2: quick-add pre-dated to the selected (next-month) day ─────────────
QA_TITLE="Cal E2E quickadd $(date +%s)"
cat > "$WORK/flow-quickadd.yaml" <<YAML
appId: $BUNDLE
---
- tapOn:
    id: "calendar.quickAdd.field"
- inputText: "$QA_TITLE"
- pressKey: Enter
- extendedWaitUntil:
    visible: "$QA_TITLE"
    timeout: 10000
- takeScreenshot: $WORK/05-quickadd-agenda
YAML
run_flow "quickadd" "$WORK/flow-quickadd.yaml"

# API-verify the quick-added task actually carries the selected day's date.
sleep 2
QA_DUE="$(curl -sf "http://localhost:$PORT/api/v1/tasks" \
  | /usr/bin/python3 -c "import json,sys; ts=json.load(sys.stdin)['tasks']; \
m=[t for t in ts if t['title']==\"$QA_TITLE\"]; print(m[0].get('due_date','') if m else 'MISSING')")"
if [ "$QA_DUE" = "$NEXT_MONTH" ]; then
  log "quick-add due_date verified via API: $QA_DUE"
else
  log "quick-add due_date WRONG: got '$QA_DUE', want '$NEXT_MONTH'"; FAIL=1
fi

# ── flow 3: permission GRANTED path (simctl grant + relaunch) ────────────────
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl privacy "$UDID" grant calendar "$BUNDLE"
xcrun simctl launch "$UDID" "$BUNDLE" -calendar-harness >/dev/null
sleep 4
cat > "$WORK/flow-granted.yaml" <<YAML
appId: $BUNDLE
---
- extendedWaitUntil:
    visible: "Cal E2E due today"
    timeout: 15000
- assertNotVisible:
    id: "calendar.deniedHint"
- takeScreenshot: $WORK/06-granted-no-hint
YAML
run_flow "granted" "$WORK/flow-granted.yaml"

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
log "screenshots: $(ls "$WORK"/*.png 2>/dev/null | tr '\n' ' ')"
[ "$FAIL" = 0 ] && log "RESULT: PASS" || log "RESULT: FAIL"
exit "$FAIL"
