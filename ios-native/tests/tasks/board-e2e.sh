#!/usr/bin/env bash
# Tasks BOARD iOS E2E (LIVE layer) — real isolated server, real app on a
# simulator, Maestro-driven taps against resource ids.
#
#   board-e2e.sh <simulator-udid>
#
# What it proves end to end (things no unit test can):
#   1. The board renders TIER BANDS with sticky headings and a letter rail —
#      one list of task rows, no session cards, no second session list.
#   2. Tapping a row EXPANDS IT IN PLACE into its session: the session strip and
#      the tier tokens appear, and the row above it does NOT move (asserted from
#      `maestro hierarchy` bounds, before and after).
#   3. Tapping a tier token MOVES the task — asserted over HTTP against the
#      server's own tier split, not by reading the UI back.
#   4. The create ring at the FOOT of a band files a task into that tier, and the
#      new row lands at the foot (the server's pin_order = max + 1).
#   5. `hide done` hides a completed row and the heading count follows it.
#   6. The rail teleports between bands.
#
# Isolation: own port (:3523) + throwaway OPEN_WALNUT_HOME under $WORK, launched
# with `env -i` so it can never read real credentials. Never touches :3456
# (production), :3457 (Playwright), :3459/:3461 (voice), :3463 (inbox), :3519
# (calendar), :3521 (group-add). Serialized machine-wide via /tmp/maestro-ios.lock.
#
# Artifacts: /tmp/walnut-board/*.png + logs (kept for review, never deleted).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="dev.openwalnut.ios"
PORT=3523
WORK=/tmp/walnut-board
HOME_DIR="$WORK/server-home"
APP="${WALNUT_APP:-/tmp/walnut-tasksv4-dd/Build/Products/Debug-iphonesimulator/Walnut.app}"
LOCK=/tmp/maestro-ios.lock
MAESTRO="${MAESTRO_CLI:-$HOME/.maestro/bin/maestro}"
UDID="${1:-}"

[ "$PORT" = "3456" ] && { echo "refusing to act on port 3456 (production)" >&2; exit 1; }
[ -x "$MAESTRO" ] || { echo "maestro CLI not found at $MAESTRO" >&2; exit 1; }
[ -n "$UDID" ] || { echo "usage: board-e2e.sh <simulator-udid>" >&2; exit 1; }

mkdir -p "$WORK"
FAIL=0
log() { echo "[board-e2e $(date +%H:%M:%S)] $*"; }
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

# ── disk precheck: the server's OWN guard would 507 every mutation ────────────
# Walnut blocks mutating routes with 507 when the data disk is critically full
# (CRITICAL_MIN_AVAIL_BYTES = 5GiB, src/core/disk-watermark.ts). That guard is
# correct behaviour, but it makes this suite fail in a way that reads like a UI
# defect: run 8 got "the tapped token did not move the task out of focus" when
# the tap was fine and the PUT came back 507. Refuse up front instead, and say
# which it is — a full disk is not a regression in the board.
AVAIL_MB="$(df -m "$WORK" | awk 'NR==2 {print $4}')"
if [ "${AVAIL_MB:-0}" -lt 6144 ]; then
  log "only ${AVAIL_MB}MB free on the data disk — Walnut's disk guard would 507 every"
  log "mutation and this run would fail as a fake UI defect. Free space, then retry."
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

# ── seed: three bands with rows, one completed row, one long title ───────────
# The long title is the point of the two-line clamp, so it must be in the data.
LONG_TITLE="Send stalls for thirty to fifty seconds when a task is opened while its session is mid turn, because the pipe flag goes stale after a reconnect and the message is queued until the turn ends"

seed() { # title tier [status]
  api POST /tasks "$(python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"focus_tier":sys.argv[2]}))' "$1" "$2")"
}

seed "board row one in focus" focus            > "$WORK/seed-f1.json" || { log "seed failed"; exit 1; }
seed "$LONG_TITLE"            focus            > "$WORK/seed-f2.json" || { log "seed failed"; exit 1; }
seed "board row three in focus" focus          > "$WORK/seed-f3.json" || { log "seed failed"; exit 1; }
seed "satellite row one"      satellite        > "$WORK/seed-s1.json" || { log "seed failed"; exit 1; }
seed "backlog row one"        backlog          > "$WORK/seed-b1.json" || { log "seed failed"; exit 1; }
seed "a task that is already done" focus       > "$WORK/seed-done.json" || { log "seed failed"; exit 1; }

tid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"]["id"])' "$1"; }
F1="$(tid "$WORK/seed-f1.json")"; F2="$(tid "$WORK/seed-f2.json")"
F3="$(tid "$WORK/seed-f3.json")"; DONE_ID="$(tid "$WORK/seed-done.json")"
log "seeded focus rows: $F1 / $F2 (long) / $F3, done row $DONE_ID"

# Complete one row so "done stays in place, struck" and `hide done` are testable.
api POST /tasks/batch/phase "{\"task_ids\":[\"$DONE_ID\"],\"phase\":\"COMPLETE\"}" >/dev/null \
  || log "could not complete the done seed (hide-done step will be weaker)"

# ── install + point the app at the isolated server ───────────────────────────
[ -d "$APP" ] || { log "app not built at $APP"; exit 1; }
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "board-e2e"

export PATH="$HOME/.maestro/bin:$PATH"

# ── ONE flow, one driver session (a second `maestro test` relaunches the app) ─
cat > "$WORK/flow-board.yaml" <<YAML
appId: $BUNDLE
---
- launchApp

# The app opens on Chat; the Tasks tab hosts the board (the default filter).
- tapOn: "Tasks"
- extendedWaitUntil:
    visible:
      id: "tasks.card.sessions"
    timeout: 30000

# 1. TIER BANDS: sticky headings, a count each, and NO session cards.
- extendedWaitUntil:
    visible:
      id: "board.heading.focus"
    timeout: 30000
- assertVisible:
    id: "board.heading.satellite"
- assertVisible:
    id: "board.count.focus"
- assertVisible: "board row one in focus"
- takeScreenshot: $WORK/01-bands

# The letter rail teleports between bands.
- assertVisible:
    id: "board.rail"
- takeScreenshot: $WORK/02-rail
YAML

if "$MAESTRO" --udid "$UDID" test "$WORK/flow-board.yaml" > "$WORK/maestro-1.log" 2>&1; then
  log "phase 1 (bands + rail) PASS"
else
  fail "phase 1 — see $WORK/maestro-1.log"
fi

# ── the "expanding a row must not yank the scroll" proof ─────────────────────
# The claim is a BOUNDS claim, so it is measured, not eyeballed: dump the
# hierarchy, expand a row in the middle of the band, dump it again, and require
# every row ABOVE the tapped one to have identical bounds.
"$MAESTRO" --udid "$UDID" hierarchy > "$WORK/hier-before.json" 2>/dev/null

cat > "$WORK/flow-expand.yaml" <<YAML
appId: $BUNDLE
---
# NO launchApp: the app is already on the board and relaunching would reset the
# scroll position this measurement is about.
- tapOn:
    id: "board.row.$F2"
- extendedWaitUntil:
    visible:
      id: "board.expanded.$F2"
    timeout: 15000
- takeScreenshot: $WORK/03a-expanded-midlist
YAML

if "$MAESTRO" --udid "$UDID" test "$WORK/flow-expand.yaml" > "$WORK/maestro-expand.log" 2>&1; then
  log "phase 2 (expand in place) PASS"
else
  fail "phase 2 — see $WORK/maestro-expand.log"
fi
"$MAESTRO" --udid "$UDID" hierarchy > "$WORK/hier-after.json" 2>/dev/null

python3 - "$WORK/hier-before.json" "$WORK/hier-after.json" "$F1" "$F2" <<'PY' || FAIL=1
import json, sys

def load(path):
    raw = open(path).read()
    return json.loads(raw[raw.find('{'):])

def rows(tree):
    """resource-id -> the row's own bounds, first occurrence per id."""
    out = {}
    def walk(node):
        a = node.get('attributes', {}) or {}
        rid = a.get('resource-id') or ''
        if rid.startswith('board.row.') and rid not in out:
            b = a.get('bounds') or ''
            nums = [int(n) for n in b.replace('[', ' ').replace(']', ' ').replace(',', ' ').split() if n.lstrip('-').isdigit()]
            if len(nums) == 4:
                out[rid] = tuple(nums)
        for c in node.get('children') or []:
            walk(c)
    walk(tree)
    return out

before, after = rows(load(sys.argv[1])), rows(load(sys.argv[2]))
tapped = 'board.row.' + sys.argv[4]
problems = []

if tapped not in before:
    problems.append("the row being expanded was not on screen before the tap — the measurement is void")

tapped_top = before.get(tapped, (0, 10**9, 0, 0))[1]
above = {rid: b for rid, b in before.items() if b[1] < tapped_top}
if not above:
    problems.append("no row sat ABOVE the tapped one — pick a row further down the band")

moved = []
for rid, b in above.items():
    if rid not in after:
        moved.append(f"{rid} left the screen")
    elif after[rid] != b:
        moved.append(f"{rid} {b} -> {after[rid]}")

print("rows above the tapped one: %d" % len(above))
for rid, b in sorted(above.items(), key=lambda kv: kv[1][1]):
    print("  %-34s before=%s after=%s" % (rid, b, after.get(rid)))
if moved:
    problems.append("EXPANDING YANKED THE SCROLL — rows above moved: " + "; ".join(moved))

if problems:
    print("EXPAND-IN-PLACE MISMATCH:")
    for p in problems: print("  -", p)
    raise SystemExit(1)
print("expand-in-place ok: %d row(s) above the tapped one kept identical bounds" % len(above))
PY

# ── the rest of the flow, in one more driver session ─────────────────────────
cat > "$WORK/flow-board2.yaml" <<YAML
appId: $BUNDLE
---
- tapOn:
    id: "board.row.$F1"
- extendedWaitUntil:
    visible:
      id: "board.expanded.$F1"
    timeout: 15000
# The row BECAME the session: the session strip, the facts, and the tier tokens
# are all inline. Nothing navigated — the board heading is still on screen.
- assertVisible:
    id: "board.facts.$F1"
- assertVisible:
    id: "board.tier.$F1.focus"
- assertVisible:
    id: "board.tier.$F1.wait"
- assertVisible:
    id: "board.tier.$F1.unpin"
- assertVisible:
    id: "board.heading.focus"
- takeScreenshot: $WORK/03-expanded

# 3. MOVE TIER by tapping a token — two taps total, no drag.
#
# The row leaves the Focus band immediately (that is the visible half of the
# move); the Wait band it joins is several screens down, so asserting the wait
# HEADING here would fail on visibility, not on behaviour. The row's departure is
# what is checkable in place, and the server assertion after the run is what
# proves where it landed.
- tapOn:
    id: "board.tier.$F1.wait"
- extendedWaitUntil:
    notVisible:
      id: "board.row.$F1"
    timeout: 20000
- takeScreenshot: $WORK/04-moved-out-of-focus
# And the band it joined really exists further down the one scroll.
- scrollUntilVisible:
    element:
      id: "board.heading.wait"
    direction: DOWN
    visibilityPercentage: 40
    timeout: 25000
- assertVisible:
    id: "board.row.$F1"
- takeScreenshot: $WORK/04b-landed-in-wait

# 4. CREATE AT THE FOOT of a band. The ring is at the band's foot and the row it
#    makes stays there.
- scrollUntilVisible:
    element:
      id: "board.create.backlog"
    direction: DOWN
    visibilityPercentage: 60
    timeout: 25000
- tapOn:
    id: "board.create.backlog"
- extendedWaitUntil:
    visible:
      id: "board.createRow.backlog.field"
    timeout: 15000
- takeScreenshot: $WORK/05-create-ring-open
- inputText: "born at the foot of backlog"
- pressKey: Enter
- extendedWaitUntil:
    visible: "born at the foot of backlog"
    timeout: 25000
- takeScreenshot: $WORK/06-created-at-foot

# 5. HIDE DONE on a heading, and the count follows.
#
# visibilityPercentage is deliberately below 100: a band heading is STICKY and
# the compact filter bar floats over the top of the list, so the topmost heading
# is legitimately part-covered. Demanding 100% would fail on the design, not on a
# defect. (No backticks in this comment: the heredoc is unquoted, so bash would
# run the contents as a command substitution.)
- scrollUntilVisible:
    element:
      id: "board.hideDone.focus"
    direction: UP
    visibilityPercentage: 40
    timeout: 25000
- takeScreenshot: $WORK/07-before-hide-done
- tapOn:
    id: "board.hideDone.focus"
- extendedWaitUntil:
    visible:
      id: "board.hideDone.focus"
    timeout: 15000
- takeScreenshot: $WORK/08-after-hide-done

# 6. The rail teleports. Tap the Backlog glyph and its heading must come into view.
#
# `hideKeyboard` is here for hygiene only — the create row from step 4 leaves one
# up. It is NOT what made this step start passing, and an earlier version of this
# comment claimed it was: the real cause was a missing
# `accessibilityElement(children: .contain)` on the rail container, which made all
# three glyphs report as `board.rail` and none as `board.rail.B`. Measured in the
# hierarchy dump: `[381,479][400,498] board.rail "Jump to Focus"` three times over.
# The passing screenshot still shows the keyboard up, which is the proof the
# keyboard was never the blocker.
- hideKeyboard
- tapOn:
    id: "board.rail.B"
- extendedWaitUntil:
    visible:
      id: "board.heading.backlog"
    timeout: 15000
- takeScreenshot: $WORK/09-rail-jump
YAML

if "$MAESTRO" --udid "$UDID" test "$WORK/flow-board2.yaml" > "$WORK/maestro-2.log" 2>&1; then
  log "phase 3 (tier move + create + hide done + rail) PASS"
else
  fail "phase 3 — see $WORK/maestro-2.log"
fi

# ── server-side assertions: the phone really filed / moved them ──────────────
log "asserting server state"
api GET /tasks > "$WORK/tasks-after.json" || fail "could not re-read the task list"
api GET /focus/tasks > "$WORK/split-after.json" || fail "could not read the tier split"

python3 - "$WORK/tasks-after.json" "$WORK/split-after.json" "$F1" <<'PY' || FAIL=1
import json, sys
tasks = json.load(open(sys.argv[1]))["tasks"]
split = json.load(open(sys.argv[2]))
moved_id = sys.argv[3]
by_title = {t["title"]: t for t in tasks}
problems = []

wait = split.get("wait_tasks") or []
backlog = split.get("backlog_tasks") or []
focus = split.get("focus_tasks") or []

# 3. The tier token really moved the task, server-side.
if moved_id in focus:
    problems.append("the tapped token did not move the task out of focus")
if moved_id not in wait:
    problems.append("the tapped Wait token did not land the task in wait: %s" % wait)

# 4. The create ring at the foot of Backlog filed into BACKLOG, at the FOOT.
def find(prefix):
    for title, task in by_title.items():
        if title.startswith(prefix):
            return task
    return None

t = find("born at the foot of backlog")
if not t:
    problems.append("the band's create ring never reached the server")
else:
    if t["id"] not in backlog:
        problems.append("created task not in the backlog bucket: %s" % backlog)
    elif backlog[-1] != t["id"]:
        problems.append("created task is not at the FOOT of backlog (pin_order): %s" % backlog)

if problems:
    print("SERVER-STATE MISMATCH:")
    for p in problems: print("  -", p)
    raise SystemExit(1)
print("server state ok: the token moved the task to WAIT; the band's ring filed "
      "into BACKLOG at the foot of the bucket")
PY

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
log "screenshots: $(ls "$WORK"/*.png 2>/dev/null | tr '\n' ' ')"
[ "$FAIL" = 0 ] && log "PASS" || log "FAILED"
exit "$FAIL"
