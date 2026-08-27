#!/usr/bin/env bash
# Create-into-a-group iOS E2E (LIVE layer) — real isolated server, real app on a
# simulator, Maestro-driven taps.
#
#   group-add-e2e.sh [simulator-udid]
#
# What it proves end to end (things no unit test can):
#   1. Every group header carries a `+` — project sections AND pin-tier groups —
#      and tapping one is addressable by id (not swallowed by the section).
#   2. The `+` on a header opens an inline add row IN that section, and a task
#      typed there is FILED INTO that group in one write. Asserted over HTTP
#      against the server's own tier split, not by reading the UI back.
#   3. The Focus case specifically: a task created from the Focus header lands in
#      FOCUS, not Satellite. That silent downgrade is the bug this feature exists
#      to kill, so it gets its own server-side assertion.
#   4. The full sheet's Pin section can pick every tier, including a registered
#      custom (ct_*) one, and the created task lands there.
#
# Isolation: own port (:3521) + throwaway OPEN_WALNUT_HOME under $WORK, launched
# with `env -i` so it can never read real credentials. Never touches :3456
# (production), :3457 (Playwright), :3459/:3461 (voice), :3463 (inbox), :3519
# (calendar). Serialized machine-wide via /tmp/maestro-ios.lock.
#
# Artifacts: /tmp/walnut-groupadd/*.png + logs (kept for review, never deleted).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="dev.openwalnut.ios"
PORT=3521
WORK=/tmp/walnut-groupadd
HOME_DIR="$WORK/server-home"
APP="${WALNUT_APP:-/tmp/walnut-groupadd-dd/Build/Products/Debug-iphonesimulator/Walnut.app}"
LOCK=/tmp/maestro-ios.lock
MAESTRO="${MAESTRO_CLI:-$HOME/.maestro/bin/maestro}"
UDID="${1:-}"

[ "$PORT" = "3456" ] && { echo "refusing to act on port 3456 (production)" >&2; exit 1; }
[ -x "$MAESTRO" ] || { echo "maestro CLI not found at $MAESTRO" >&2; exit 1; }
[ -n "$UDID" ] || { echo "usage: group-add-e2e.sh <simulator-udid>" >&2; exit 1; }

mkdir -p "$WORK"
FAIL=0
log() { echo "[groupadd-e2e $(date +%H:%M:%S)] $*"; }
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

# ── the dist must actually contain the server half ───────────────────────────
# This flow asserts `focus_tier` behaviour, which lives in dist/cli.js. A dist
# built before that landed answers 201 and files EVERYTHING in Satellite, so the
# run fails looking exactly like an app bug (it cost a whole debugging round).
# Prove the server code is present before blaming the client.
if ! grep -q "resolveNewTaskTier" "$REPO/dist/cli.js" 2>/dev/null; then
  echo "dist/cli.js predates create-time focus_tier — run \`npx tsup\` first" >&2
  exit 1
fi

# ── isolated Walnut server ───────────────────────────────────────────────────
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

api() { curl -sf -X "$1" "http://localhost:$PORT/api/v1$2" \
  -H 'content-type: application/json' ${3:+--data-binary "$3"}; }

# ── seed: two projects with a task each (so two project sections exist, and the
#    `+` is proven per-header rather than once), plus a custom tier ───────────
api POST /tasks '{"title":"existing marina work","project":"marina"}' > "$WORK/seed-1.json" \
  || { log "seed create failed"; exit 1; }
api POST /tasks '{"title":"acme kickoff","project":"acme"}' > "$WORK/seed-2.json" \
  || { log "seed create failed"; exit 1; }
SEED_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"]["id"])' "$WORK/seed-1.json")"
log "seeded task $SEED_ID in project marina (+ one in acme)"

# A registered custom tier — the sheet's Pin section must offer it, and a task
# created into it must come back in that bucket (not normalized to Satellite).
curl -sf -X POST "http://localhost:$PORT/api/v1/focus/tiers" \
  -H 'content-type: application/json' \
  --data-binary '{"label":"Deep Work"}' > "$WORK/tier.json" 2>/dev/null
CUSTOM_TIER="$(python3 - "$WORK/tier.json" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit
for key in ("tier", "created"):
    if isinstance(d.get(key), dict) and d[key].get("id"):
        print(d[key]["id"]); raise SystemExit
for t in (d.get("tiers") or []):
    if t.get("label") == "Deep Work":
        print(t["id"]); raise SystemExit
PY
)"
[ -n "$CUSTOM_TIER" ] && log "custom tier: $CUSTOM_TIER" || log "no custom tier endpoint — built-ins only"

# ── install + point the app at the isolated server ───────────────────────────
[ -d "$APP" ] || { log "app not built at $APP"; exit 1; }
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "groupadd-e2e"

export PATH="$HOME/.maestro/bin:$PATH"

# ── ONE flow, one driver session (a second `maestro test` relaunches the app) ─
cat > "$WORK/flow-groupadd.yaml" <<YAML
appId: $BUNDLE
---
- launchApp

# The app opens on Chat; the Tasks tab is where every group lives.
- tapOn: "Tasks"
- extendedWaitUntil:
    visible:
      id: "tasks.card.sessions"
    timeout: 25000

# The smart-list card strip scrolls HORIZONTALLY and "All Open" starts off the
# right edge — it is not merely off-screen, it is absent from the hierarchy, so
# it must be swiped into view BEFORE any assertion can see it.
- swipe:
    start: 350, 290
    end: 40, 290
- swipe:
    start: 350, 290
    end: 40, 290
- extendedWaitUntil:
    visible:
      id: "tasks.card.all"
    timeout: 25000

# ── the project section header has a + (and it is addressable) ──────────────
- tapOn:
    id: "tasks.card.all"
- extendedWaitUntil:
    visible: "existing marina work"
    timeout: 25000
- takeScreenshot: $WORK/01-project-sections
- assertVisible:
    id: "tasks.groupAdd.default_marina"

# The tab bar FLOATS over the bottom ~83pt of the list, so a header sitting down
# there swallows the tap (measured: the marina + at y=835-861 under a tab bar at
# y=791-874 navigated to Settings instead). Scroll it to mid-screen first.
- swipe:
    start: 200, 700
    end: 200, 330

# ── the + opens an inline add row IN that section; a task typed there is filed
#    into that project ───────────────────────────────────────────────────────
- tapOn:
    id: "tasks.groupAdd.default_marina"
- extendedWaitUntil:
    visible:
      id: "tasks.groupAdd.default_marina.row.field"
    timeout: 15000
- takeScreenshot: $WORK/02-project-add-row-open
- inputText: "filed from the marina header"
- pressKey: Enter
- extendedWaitUntil:
    visible: "filed from the marina header"
    timeout: 25000
- takeScreenshot: $WORK/03-project-task-created

# ── the top quick-add row can retarget its destination in one tap ───────────
# The group add row left the list scrolled down with a keyboard up, and the top
# quick-add row is a LIST ROW — it is genuinely off-screen (absent from the
# hierarchy), not merely hidden. Scroll back up to reach it. (The compact bar's
# chip would also do it, but the bar only exists past the collapse threshold,
# which a short seeded list may never cross — so this uses plain scrolling.)
- swipe:
    start: 200, 300
    end: 200, 750
- swipe:
    start: 200, 300
    end: 200, 750
- swipe:
    start: 200, 300
    end: 200, 750
- extendedWaitUntil:
    visible:
      id: "tasks.quickAdd.destination"
    timeout: 15000
- tapOn:
    id: "tasks.quickAdd.destination"
- extendedWaitUntil:
    visible: "Deep Work"
    timeout: 10000
- takeScreenshot: $WORK/04-destination-menu
- tapOn: "Backlog"
- extendedWaitUntil:
    visible: "Add to Backlog…"
    timeout: 10000
- tapOn:
    id: "tasks.quickAdd.field"
- inputText: "quickadd into backlog"
- pressKey: Enter
- extendedWaitUntil:
    visible: "quickadd into backlog"
    timeout: 25000
- takeScreenshot: $WORK/05-backlog-created

# ── the FULL SHEET can pick a tier at create time ───────────────────────────
- tapOn:
    id: "sessions.new"
- tapOn:
    id: "tasks.create"
- extendedWaitUntil:
    visible:
      id: "newTask.title"
    timeout: 15000
- takeScreenshot: $WORK/06-sheet-pin-section
# Every built-in tier is a visible, individually addressable row — plus the
# registered custom one, which is the dynamic half of the picker.
- assertVisible:
    id: "newTask.pin.focus"
- assertVisible:
    id: "newTask.pin.satellite"
- assertVisible:
    id: "newTask.pin.backlog"
- assertVisible:
    id: "newTask.pin.wait"
- assertVisible:
    id: "newTask.pin.none"
- tapOn:
    id: "newTask.title"
- inputText: "born in focus from the sheet"
# Getting the keyboard out of the way is the fiddly part on iOS 26: it survives
# hideKeyboard AND survives tapping the nav title, and while it is up it covers
# the Pin rows so taps land on KEYS instead (measured: rows at y=594-919 under a
# keyboard from y=529). Scrolling the Form lifts them clear (rows to y=54-314).
- swipe:
    start: 200, 300
    end: 200, 120
- swipe:
    start: 200, 300
    end: 200, 120
# And the FIRST tap after that only dismisses the keyboard — the Form re-lays out
# and the row moves, so the tap never reaches the button. Retry until the footer
# says a tier is selected: the footer is the assertion, not the tap count.
- retry:
    maxRetries: 3
    commands:
      - tapOn:
          id: "newTask.pin.focus"
      - extendedWaitUntil:
          visible: "Born in this tier, in one write."
          timeout: 6000
- takeScreenshot: $WORK/07-sheet-focus-picked
- tapOn:
    id: "newTask.add"
- extendedWaitUntil:
    notVisible:
      id: "newTask.pin.focus"
    timeout: 20000
- extendedWaitUntil:
    visible: "born in focus from the sheet"
    timeout: 25000
- takeScreenshot: $WORK/08-focus-task-created
YAML

if "$MAESTRO" --udid "$UDID" test "$WORK/flow-groupadd.yaml" > "$WORK/maestro.log" 2>&1; then
  log "flow PASS"
else
  fail "flow — see $WORK/maestro.log"
fi

# ── server-side assertions: the phone really filed them where it said ────────
log "asserting server state"
api GET /tasks > "$WORK/tasks-after.json" || fail "could not re-read the task list"
api GET /focus/tasks > "$WORK/split-after.json" || fail "could not read the tier split"

python3 - "$WORK/tasks-after.json" "$WORK/split-after.json" <<'PY' || FAIL=1
import json, sys
tasks = json.load(open(sys.argv[1]))["tasks"]
split = json.load(open(sys.argv[2]))
by_title = {t["title"]: t for t in tasks}
problems = []

# 1. The project-header add filed into that project.
t = by_title.get("filed from the marina header")
if not t:
    problems.append("project-header task never reached the server")
elif t["project"] != "marina":
    problems.append("project-header task landed in project %r, not 'marina'" % t["project"])

focus = set(split.get("focus_tasks") or [])
sat = set(split.get("satellite_tasks") or [])
backlog = set(split.get("backlog_tasks") or [])
pinned = set(split.get("pinned_tasks") or [])

# 2. THE POINT OF THE FEATURE: a task created into Focus is in FOCUS, not
#    Satellite. Read the server's own split, which is what the board renders.
#    The simulator keyboard can append an autocorrect character, so match on a
#    prefix rather than an exact title.
def find(prefix):
    for title, task in by_title.items():
        if title.startswith(prefix):
            return task
    return None

t = find("born in focus from the sheet")
if not t:
    problems.append("sheet task never reached the server")
else:
    if t["id"] not in pinned:
        problems.append("focus task is not pinned at all (a tier implies pinned)")
    if t["id"] in sat:
        problems.append("focus task SILENTLY DOWNGRADED to Satellite — the exact bug")
    if t["id"] not in focus:
        problems.append("focus task not in the focus bucket: %s" % sorted(focus))

# 3. The quick-add row's destination chip files into the tier it names.
t = find("quickadd into backlog")
if not t:
    problems.append("quick-add backlog task never reached the server")
elif t["id"] not in backlog:
    problems.append("quick-add task not in the backlog bucket: %s" % sorted(backlog))

if problems:
    print("SERVER-STATE MISMATCH:")
    for p in problems: print("  -", p)
    raise SystemExit(1)
print("server state ok: project-header task in 'marina'; sheet task pinned in FOCUS; "
      "quick-add task in BACKLOG")
PY

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
log "screenshots: $(ls "$WORK"/*.png 2>/dev/null | tr '\n' ' ')"
[ "$FAIL" = 0 ] && log "PASS" || log "FAILED"
exit "$FAIL"
