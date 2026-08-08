#!/usr/bin/env bash
# ROBOT USER probe for the 2026-08-07 (build 35) iOS freeze class: three
# 0x8BADF00D watchdog kills in 10 minutes on IDLE giant sessions, stack
# fingerprint = UIFoundation text measurement -> SwiftUICore x6 ->
# AttributeGraph -> QuartzCore CA-commit (LAYOUT, not markdown parsing).
# User phenomenology: composer frozen with the keyboard FLASHING in/out, and a
# post-crash screenshot showing the bar stranded mid-screen over a blank region
# (keyboard inset reserved, keyboard gone).
#
# Unlike ios-perf-check.sh --sim (which drives an aggressive LIVE stream), this
# probe holds the session IDLE (IDLE=1) and hammers the COMPOSER + KEYBOARD:
#   S1 open + scroll churn        — baseline: is an idle 500-row page alone enough?
#   S2 keyboard show/hide churn   — safeAreaInset geometry cycling over a tall list
#   S3 char-by-char typing        — per-keystroke draft invalidation fan-out
#   S4 148-char burst             — mimics `voice transcribed chars=148` (freeze #2
#                                   fired 5s after exactly this)
#   S5 giant draft + focus churn  — TextField(axis:.vertical) measurement cost
#   S6 background/foreground      — re-arm + first-frame relayout
#
# Detection: the app's own MainThreadWatchdog "main thread unresponsive" line,
# echoed by mock-server.mjs from /api/v1/client-logs, PLUS simctl-side hang
# diagnostics. A sim main-thread stall of 1.5-2s ~= a 5-10s field watchdog kill
# (M-series sim is 3-5x faster than the A-series phones that died).
#
# Usage: scripts/ios-perf/freeze-probe.sh [scenario|all]
# Never touches port 3456 (production). One simulator, serial.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${FREEZE_WORK:-/tmp/ios-freeze}"
SIM_NAME="iPhone 16 Pro"
BUNDLE="dev.openwalnut.ios"
PORT="${FREEZE_PORT:-3511}"
APP="${FREEZE_APP:-/tmp/walnut-freeze-dd/Build/Products/Debug-iphonesimulator/Walnut.app}"
WANT="${1:-all}"
export PATH="$HOME/.maestro/bin:$PATH"

mkdir -p "$WORK/flows" "$WORK/shots"
UDID="$(xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1 | grep -oE '[0-9A-F-]{36}')"
[ -z "$UDID" ] && { echo "no '$SIM_NAME' simulator"; exit 1; }
echo "== sim $UDID  port $PORT  work $WORK"

# ---------- fixture + mock server (IDLE session, real field scale) ----------
node "$REPO/scripts/ios-perf/make-idle-fixture.mjs" "$WORK/idle-fixture.json" "${API_ROWS:-286}" || exit 1
pkill -f "mock-server.mjs" 2>/dev/null; sleep 0.5
IDLE=1 PORT=$PORT FIXTURE="$WORK/idle-fixture.json" \
  node "$REPO/scripts/ios-perf/mock-server.mjs" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1
grep -q mock-server "$WORK/mock.log" || { echo "mock server failed:"; cat "$WORK/mock.log"; exit 1; }

# ---------- install + point at the mock ----------
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
[ -d "$APP" ] || { echo "no app bundle at $APP — build first"; exit 1; }
xcrun simctl install "$UDID" "$APP" || exit 1
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "freezeprobe"
# Start every run from a clean composer draft (drafts persist in UserDefaults).
xcrun simctl spawn "$UDID" defaults delete "$BUNDLE" walnut.composerDrafts 2>/dev/null

# ---------- flow files (Maestro 2.1 cannot read flows from stdin) ----------
NAV='- tapOn: "Tasks"
- waitForAnimationToEnd
- tapOn:
    text: "All"
    optional: true
- waitForAnimationToEnd
- tapOn: "Perf check session"
- waitForAnimationToEnd'

flow() { printf 'appId: %s\n---\n%s\n' "$BUNDLE" "$2" > "$WORK/flows/$1.yaml"; }

flow s1-open-scroll "$NAV
$(for i in 1 2 3 4 5 6; do echo "- swipe:
    direction: DOWN
    duration: 120"; done)
$(for i in 1 2 3 4 5 6; do echo "- swipe:
    direction: UP
    duration: 120"; done)"

# S2: keyboard show/hide churn. Tapping the composer raises it; tapping the
# transcript area (scrollDismissesKeyboard is .interactively, so a TAP alone
# won't dismiss) -> use hideKeyboard, the same first-responder resign the OS
# performs. Each cycle re-runs safeAreaInset geometry over the tall list.
KBCYCLE='- tapOn:
    id: "chat.composer"
- waitForAnimationToEnd
- hideKeyboard
- waitForAnimationToEnd'
flow s2-keyboard-churn "$NAV
$(for i in $(seq 1 12); do echo "$KBCYCLE"; done)"

# S3: char-by-char typing (each keystroke = one setDraft -> UserDefaults
# persist + ComposerBar invalidation + possible TextField height change).
flow s3-type-chars "$NAV
- tapOn:
    id: \"chat.composer\"
$(for c in 检 查 一 下 这 个 会 话 的 状 态 然 后 汇 报 结 果 给 我 谢 谢; do echo "- inputText: \"$c\""; done)"

# S4: the field trigger — a 148-char burst into the draft, exactly like
# appendToDraft() after `voice transcribed chars=148` (freeze #2 fired 5s later).
BURST148='请帮我检查一下这个会话里所有失败的部署记录并且把每一个失败的原因整理成一个表格然后告诉我哪些是需要立刻处理的哪些可以先放一放另外顺便看下监控指标有没有异常波动谢谢你辛苦了这个任务比较着急'
flow s4-voice-burst "$NAV
- tapOn:
    id: \"chat.composer\"
- waitForAnimationToEnd
- inputText: \"$BURST148\"
- waitForAnimationToEnd
- hideKeyboard
- waitForAnimationToEnd
- tapOn:
    id: \"chat.composer\"
- waitForAnimationToEnd"

# S5: grow the draft well past the 6-line clamp, then churn focus. If the
# TextField measures the FULL draft (not the clamped 6 lines) each focus
# transition pays UIFoundation text measurement over the whole string.
flow s5-giant-draft "$NAV
- tapOn:
    id: \"chat.composer\"
$(for i in 1 2 3 4 5 6 7 8; do echo "- inputText: \"$BURST148\""; done)
- waitForAnimationToEnd
$(for i in 1 2 3 4 5 6; do echo "$KBCYCLE"; done)
- swipe:
    direction: DOWN
    duration: 150
- swipe:
    direction: UP
    duration: 150"

# S6: background/foreground with a live draft + keyboard up (re-arms the
# watchdog and forces a first-frame relayout of the whole page).
flow s6-bg-fg "$NAV
- tapOn:
    id: \"chat.composer\"
- inputText: \"$BURST148\"
$(for i in 1 2 3; do echo "- pressKey: Home
- waitForAnimationToEnd
- launchApp:
    appId: $BUNDLE
    stopApp: false
- waitForAnimationToEnd"; done)"

# ---------- run one scenario, measure ----------
run() {
  local name="$1"
  echo
  echo "===== $name ====="
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null; sleep 1
  : > "$WORK/mock.log.mark"; wc -l < "$WORK/mock.log" > "$WORK/mock.log.mark"
  xcrun simctl spawn "$UDID" log stream --style compact \
    --predicate 'process == "Walnut" OR (subsystem == "com.apple.runningboard" AND eventMessage CONTAINS "Walnut")' \
    > "$WORK/$name.oslog" 2>&1 &
  local LOGPID=$!
  xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1
  sleep 5
  local t0=$(date +%s)
  maestro --udid "$UDID" test "$WORK/flows/$name.yaml" > "$WORK/$name.maestro" 2>&1
  local rc=$?
  local elapsed=$(( $(date +%s) - t0 ))
  # The watchdog pings every 2s and only reports past 5s, so give it room to
  # observe (and to report a RECOVERED stall) after the gestures stop.
  sleep 12
  xcrun simctl io "$UDID" screenshot "$WORK/shots/$name.png" >/dev/null 2>&1
  kill $LOGPID 2>/dev/null
  local mark=$(cat "$WORK/mock.log.mark")
  local freeze=$(tail -n +$((mark+1)) "$WORK/mock.log" | grep -c 'unresponsive')
  local recov=$(tail -n +$((mark+1)) "$WORK/mock.log" | grep -c 'recovered')
  local hang=$(grep -ciE 'hang detected|watchdog|unresponsive|scene-update' "$WORK/$name.oslog" 2>/dev/null)
  echo "  maestro rc=$rc  gestures took ${elapsed}s"
  echo "  app freeze telemetry: unresponsive=$freeze recovered=$recov   oslog hang-ish lines=$hang"
  tail -n +$((mark+1)) "$WORK/mock.log" | grep -E 'unresponsive|recovered' | head -5
  [ "$rc" != 0 ] && grep -iE 'failed|error|assertion' "$WORK/$name.maestro" | head -5
  echo "  screenshot: $WORK/shots/$name.png"
}

for s in s1-open-scroll s2-keyboard-churn s3-type-chars s4-voice-burst s5-giant-draft s6-bg-fg; do
  case "$WANT" in all) ;; "$s") ;; *) continue ;; esac
  run "$s"
done
echo
echo "== done. logs in $WORK"
