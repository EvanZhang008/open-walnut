#!/usr/bin/env bash
# DECISIVE probe for the "unbounded keyboard-repin ring" hypothesis behind the
# 2026-08-07 build-35 0x8BADF00D freezes.
#
# Hypothesis (static lane): KeyboardBottomRepin.finishTransition()
# (ios-native/Walnut/Views/ScrollBottomTracking.swift) clears
# `keyboardGeometryFrozen` BEFORE calling the re-entrant `repin()`, so every
# geometry consequence of repin arrives with the arming gate OPEN and re-arms
# `pendingRepin` (isPinned() = bottomPinned, default true). There is no cycle
# counter and no debounce, and the closing edge is believed to be
# `scrollTo(edge:.bottom)` on a ScrollView carrying
# `.scrollDismissesKeyboard(.interactively)` emitting keyboardWillChangeFrame.
#
# What this measures, WITHOUT touching product code: the rate of UIKit keyboard
# geometry events the app actually receives, read from the simulator's own log
# stream (KeyboardArbiter / UIKit keyboard subsystems). The app's own
# FreezeContext.keyboardTransitions() counter rides any freeze report too.
#
#   Healthy:  a keyboard show or hide is a short burst then silence (0-2 /s at rest).
#   Ring:     a sustained >2 /s with no user input = the loop.
#
# Arms (run both — this is the scale discriminator):
#   MODE=field    117 rows / ~220KB — what the crashing phones really received.
#   MODE=history  505 rows / ~1.2MB — the /history-derived overshoot.
# A freeze at FIELD scale means the defect is unbounded CYCLE COUNT, not payload.
#
# ── RESULTS (2026-08-07) — THE RING IS REAL AND SIM-REPRODUCIBLE ──────────────
# ⚠️ THIS PROBE'S OWN ARMS NEVER CAUGHT IT. The proof came from the fix agent's
# artifacts in a DIFFERENT evidence store (`/tmp/freeze-fix/`), which is itself
# the lesson: three agents wrote to three /tmp directories and both reviewers
# concluded "no evidence" from the one they happened to search.
#
# CONFIRMED (verified by re-deriving from the raw artifacts, not from a summary):
#   * `/tmp/freeze-fix/mock.log` — the APP's own uploaded telemetry (`[client-log]`
#     lines, not XCTest stdout) — carries FIVE `repin ring broken` records, each
#     `m_repins:13 m_totalRepins:12 m_windowSeconds:5.0`, at 18:47:31 / 18:49:15 /
#     18:51:52 / 18:55:13 / 18:56:10Z. So with a fixed 300ms hold the ring RAN on a
#     booted simulator, repeatedly, and the cycle breaker is the only reason it
#     stopped. The ring's closing edge therefore EXISTS on the sim.
#   * `/tmp/freeze-fix/app.oslog` independently shows the self-driven signature this
#     probe was built to detect: last touch 11:48:07, then SIX keyboard machinery
#     events at 11:48:10-11:48:12 with ZERO user input over an 8s captured window —
#     `KeyboardArbiter startConnection`, `handleKeyboardChange`, and
#     `KeyboardSceneDelegate forceReloadInputViews` (a full input-view reload, i.e.
#     real keyboard geometry work the app did to itself).
#
# WHY THIS PROBE MISSED IT (both defects are fixed below, keep them):
#   * the old predicate matched 2 of ~460 real keyboard events (UIKit logs the
#     MACHINERY, never the notification names), and
#   * the process-scoped `log stream` died with the app ~2-3s after the last
#     gesture, so the 30s "quiet window" was never actually recorded.
#   A `no ring` verdict from the pre-fix probe is worthless. Do not cite one.
#
# STILL OPEN: the ring-break records carry no `ctx*` fields (that AppLog call site
# doesn't merge FreezeContext.snapshotMeta()), so they prove the ring ran but not
# the keyboard state or flip count at that moment. And nothing here is field data
# from a real phone — the field emitter is still unidentified, though it no longer
# needs build 36's `ctxKbFlips10s` to be investigated.
#
# Usage: MODE=field scripts/ios-perf/kb-loop-probe.sh
# Never touches port 3456 (production). One simulator, serial.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${FREEZE_WORK:-/tmp/ios-freeze}"
SIM_NAME="iPhone 16 Pro"
BUNDLE="dev.openwalnut.ios"
PORT="${FREEZE_PORT:-3511}"
APP="${FREEZE_APP:-/tmp/walnut-freeze-dd/Build/Products/Debug-iphonesimulator/Walnut.app}"
MODE="${MODE:-field}"
# Per-run artifact tag. 2026-08-07: a failed re-run silently OVERWROTE the
# field-arm oslog/maestro files, so a histogram taken from the history arm got
# cited as the field arm and the substitution was invisible for hours. Artifacts
# that back a conclusion must be immutable — every run gets its own filenames,
# plus a `latest` symlink for convenience.
RUN="${MODE}-$(date +%H%M%S)"
export PATH="$HOME/.maestro/bin:$PATH"

mkdir -p "$WORK/flows" "$WORK/shots"
UDID="$(xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1 | grep -oE '[0-9A-F-]{36}')"
[ -z "$UDID" ] && { echo "no '$SIM_NAME' simulator"; exit 1; }

LOAD="$(sysctl -n vm.loadavg | awk '{print $2}')"
echo "== sim $UDID | mode $MODE | port $PORT | host load $LOAD"
awk -v l="$LOAD" 'BEGIN{ if (l+0 > 25) print "   ⚠️  load > 25 — a UI-query timeout may be STARVATION, not the bug (round-2 lesson)" }'

MODE="$MODE" node "$REPO/scripts/ios-perf/make-idle-fixture.mjs" "$WORK/$MODE-fixture.json" || exit 1
pkill -f "mock-server.mjs" 2>/dev/null; sleep 0.5
IDLE=1 PORT=$PORT FIXTURE="$WORK/$MODE-fixture.json" \
  node "$REPO/scripts/ios-perf/mock-server.mjs" > "$WORK/mock-$RUN.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
[ -d "$APP" ] || { echo "no app bundle at $APP — build first"; exit 1; }
xcrun simctl install "$UDID" "$APP" || exit 1
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$PORT"
xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "kbloop"
xcrun simctl spawn "$UDID" defaults delete "$BUNDLE" walnut.composerDrafts 2>/dev/null

# 148-char CJK burst = the exact size the field freeze followed
# (`voice transcribed chars=148` → 5s later `main thread unresponsive`).
BURST='请帮我检查一下这个会话里所有失败的部署记录并且把每一个失败的原因整理成一个表格然后告诉我哪些是需要立刻处理的哪些可以先放一放另外顺便看下监控指标有没有异常波动谢谢你辛苦了这个任务比较着急'

cat > "$WORK/flows/kb-loop-$RUN.yaml" <<YAML
appId: $BUNDLE
---
- tapOn: "Tasks"
- waitForAnimationToEnd
- tapOn:
    text: "All"
    optional: true
- waitForAnimationToEnd
- tapOn: "Perf check session"
- waitForAnimationToEnd
# PHASE A (idle baseline): page open, keyboard down, nothing happening.
- waitForAnimationToEnd
# PHASE B (ignition): raise the keyboard, then land the 148-char burst — the
# field sequence is focused=true + an inset height change in one transition.
- tapOn:
    id: "chat.composer"
- waitForAnimationToEnd
- inputText: "$BURST"
# PHASE C (observation): NO further user input. Any keyboard geometry event
# from here on is the app talking to itself — the ring.
- waitForAnimationToEnd
YAML

echo "== streaming keyboard/UIKit geometry events"
# `log stream` attaches to the PROCESS; Maestro relaunching the app can orphan it,
# which silently truncates the log. Two defenses: restart the stream AFTER the app
# is up, and hard-verify coverage at the end (see COVERAGE CHECK below).
xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1
sleep 4
xcrun simctl spawn "$UDID" log stream --style syslog \
  --predicate 'process == "Walnut"' > "$WORK/kb-$RUN.oslog" 2>&1 &
LOGPID=$!
sleep 2

T_FLOW_START=$(date +%s)
maestro --udid "$UDID" test "$WORK/flows/kb-loop-$RUN.yaml" > "$WORK/kb-$RUN.maestro" 2>&1
RC=$?
T_FLOW_END=$(date +%s)
echo "== gestures done (rc=$RC, $((T_FLOW_END-T_FLOW_START))s). Observing 30s with ZERO user input…"
# Quiet observation window: the ring, if real, keeps running with no input, and
# the watchdog needs >5s of continuous stall before it reports.
sleep 30
QUIET_END=$(date +%s)
xcrun simctl io "$UDID" screenshot "$WORK/shots/kb-$RUN.png" >/dev/null 2>&1
kill $LOGPID 2>/dev/null
sleep 1
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null

# ---- PRECONDITION CHECK: did the scenario actually happen? ----
# 2026-08-07: a re-run failed navigation ("Element not found: Perf check session")
# and so never opened the session and never raised a keyboard — yet it still wrote
# an oslog that a reader could mistake for a clean "no ring" observation. The field
# arm's artifacts on disk were exactly this. A probe must refuse to be read as
# evidence when its own scenario never ran.
KB_MACHINERY=$(grep -cE 'endPlacementForInputViewSet|UIKit:KeyboardUI|UIKit:UIPeripheralHost' "$WORK/kb-$RUN.oslog" 2>/dev/null || echo 0)
echo "== keyboard machinery lines captured: $KB_MACHINERY (maestro rc=$RC)"
if [ "$RC" != 0 ] || [ "$KB_MACHINERY" -lt 10 ]; then
  echo "❌ SCENARIO FAIL: the flow did not complete (rc=$RC) and/or no keyboard was"
  echo "   ever raised ($KB_MACHINERY machinery lines). This run observed NOTHING —"
  echo "   it is NOT evidence of an absent ring. Fix navigation and re-run."
  grep -iE 'Element not found|FAILED' "$WORK/kb-$RUN.maestro" 2>/dev/null | head -3
fi

# ---- COVERAGE CHECK (a null result is worthless without it) ----
# 2026-08-07: the original probe's log stream DIED at gesture-end, so the file
# never contained the quiet window at all — yet the counter happily printed
# "no sustained ring". An absence-of-evidence result MUST prove it was actually
# looking. Compare the log's last timestamp against the wall clock at quiet-end.
LAST_TS=$(grep -oE '^[0-9-]+ [0-9]{2}:[0-9]{2}:[0-9]{2}' "$WORK/kb-$RUN.oslog" | tail -1)
if [ -z "$LAST_TS" ]; then
  echo "❌ COVERAGE FAIL: log is empty — every conclusion below is void."
else
  LAST_EPOCH=$(date -j -f '%Y-%m-%d %H:%M:%S' "$LAST_TS" +%s 2>/dev/null || echo 0)
  GAP=$(( QUIET_END - LAST_EPOCH ))
  echo "== log ends $LAST_TS, quiet window ended $(date -r $QUIET_END '+%Y-%m-%d %H:%M:%S') (gap ${GAP}s)"
  if [ "$GAP" -gt 8 ]; then
    echo "❌ COVERAGE FAIL: the log stopped ${GAP}s before the observation window ended."
    echo "   A 'no ring' verdict below is UNSUPPORTED — the probe stopped watching."
  else
    echo "✅ COVERAGE OK: the log spans the full quiet window, so silence is real evidence."
  fi
fi

echo
echo "===== RESULTS ($MODE arm) ====="
python3 - "$WORK/kb-$RUN.oslog" "$WORK/mock-$RUN.log" <<'PY'
import re, sys, json, collections
oslog, mocklog = sys.argv[1], sys.argv[2]
# Keyboard geometry chatter the app receives, bucketed per second.
# WIDENED 2026-08-07. The original pattern matched only 2 of 502 keyboard-related
# lines: UIKit does NOT log the notification names, it logs the machinery that
# emits them. The load-bearing one is UIPeripheralHost's
# `endPlacementForInputViewSet` (each placement = one keyboard frame change =
# one willChangeFrame/didChangeFrame pair delivered to the app), plus KeyboardUI
# animation/geometry chatter. Missing these is how a real ring could run while
# the counter read ~2 — so match by CATEGORY, not by guessed symbol names.
pat = re.compile(r'endPlacementForInputViewSet|UIKit:KeyboardUI|UIKit:UIPeripheralHost|'
                 r'BackBoard:Keyboard|KeyboardArbiter|UIKit:KeyboardSceneDelegate|'
                 r'UIKit:KeyboardLayoutGuide|KeyboardTrackingCoordinator|'
                 r'handleKeyboardChange|keyboardWillChangeFrame|keyboardDidChangeFrame|'
                 r'KBWillChangeFrame|setKeyboardFrame|UIKeyboardWillChange|'
                 r'deferring environment did change', re.I)
per_sec = collections.Counter()
total = 0
for line in open(oslog, errors='replace'):
    if not pat.search(line): continue
    m = re.match(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)', line)
    if not m: continue
    per_sec[m.group(1)] += 1
    total += 1
print(f"keyboard geometry events: total={total}")
if per_sec:
    order = sorted(per_sec)
    print("busiest seconds:", ", ".join(f"{t.split()[1]}={n}"
                                       for t, n in per_sec.most_common(8)))
    peak = max(per_sec.values())
    print(f"peak/sec={peak}  seconds with >2 events={sum(1 for n in per_sec.values() if n > 2)}")
    # A keyboard RAISE legitimately produces a dense multi-second burst (measured
    # ~85/s for 6s), so "busy seconds" alone cannot distinguish ignition from a
    # ring. The ring's signature is activity that CONTINUES after the burst — so
    # judge on the TAIL: the last 15s of captured log, which is inside the
    # zero-user-input observation window.
    last = order[-1]
    from datetime import datetime
    fmt = '%Y-%m-%d %H:%M:%S'
    end = datetime.strptime(last, fmt)
    tail = {t: n for t, n in per_sec.items()
            if 0 <= (end - datetime.strptime(t, fmt)).total_seconds() <= 15}
    tail_total = sum(tail.values())
    tail_active = sum(1 for n in tail.values() if n > 2)
    print(f"TAIL (last 15s of capture, zero user input): {tail_total} events "
          f"across {len(tail)} active seconds, {tail_active} of them >2/s")
    if tail_active >= 3:
        print("VERDICT: RING SIGNAL — keyboard geometry churn CONTINUES with no user input")
    elif tail_total > 0:
        print("VERDICT: trailing activity but not sustained — inspect the tail seconds by hand")
    else:
        print("VERDICT: no ring — all keyboard traffic confined to the ignition burst, "
              "then total silence through the observation window")
else:
    print("VERDICT: no keyboard geometry events captured (log predicate may not cover them)")

# The app's own freeze telemetry — filter by each LINE's own ts, because AppLog
# persists its buffer and re-uploads old backlog on the next launch.
print()
seen = set()
for line in open(mocklog, errors='replace'):
    if not line.startswith('[client-log]'): continue
    try: d = json.loads(line[len('[client-log] '):])
    except Exception: continue
    for l in d.get('lines', []):
        if l.get('subsystem') != 'freeze': continue
        key = (l.get('ts'), l.get('message'))
        if key in seen: continue
        seen.add(key)
        print(f"  {l.get('ts')} {l.get('message')} stalled={l.get('m_stalledSeconds')} "
              f"hang={l.get('m_hangSeconds')} repins={l.get('m_repins')} "
              f"kbFlips10s={l.get('m_ctxKbFlips10s')} "
              f"draftChars={l.get('m_ctxDraftChars')} rows={l.get('m_ctxHistoryRows')} "
              f"kb={l.get('m_ctxKeyboard')} screen={l.get('m_ctxScreen')}")
if not seen: print("  (no freeze telemetry lines)")
PY
echo
grep -iE 'Timed out while evaluating UI query|failed' "$WORK/kb-$RUN.maestro" | head -3
echo "screenshot: $WORK/shots/kb-$RUN.png"
echo "artifacts:  $WORK/kb-$RUN.{oslog,maestro}  (run-unique — safe to cite)"

# ---- CROSS-STORE SWEEP (prove you looked EVERYWHERE, not just here) ----
# 2026-08-07: the decisive `repin ring broken` evidence sat in ANOTHER agent's
# /tmp directory the whole time, and two reviewers independently reported "no such
# evidence exists" after grepping only their own. Absence-of-evidence claims must
# state which stores were searched — so the probe searches them all and says so.
#
# ⚠️ MATCH THE TELEMETRY SHAPE, NOT THE PHRASE. The first version of this sweep
# grepped the bare string and its LARGEST hit (91 lines) was this investigation's
# own CLI transcript — agents quoting "repin ring broken" to each other. A sweep
# for evidence that indexes the DISCUSSION of the evidence is a citation loop, and
# it puts the biggest number on the least real file. So a hit must carry the
# uploaded-record shape: the phrase AND `"subsystem":"freeze"` AND `"m_repins":"`.
# All five genuine records satisfy it; all 91 transcript lines fail it.
echo
echo "== cross-store sweep for ring evidence (never conclude 'absent' from one store)"
# Session/transcript stores are excluded by path too: /tmp/claude-* (agent
# transcripts) and /tmp/open-walnut-streams (LIVE production session state — a
# recursive grep there is slow, races the daemon's writes, and yields only prose).
SWEEP_SHAPE='repin ring broken'
FOUND=0
# THREE shell traps this block fell into — keep all three fixes, they were each
# a real wrong answer, not hypothetical:
#  1. `for f in $HITS` word-splits on spaces and silently drops paths.
#  2. `… | while read` runs the body in a SUBSHELL, so a counter incremented
#     inside it is lost — the sweep printed "5x mock.log" then totalled 0.
#  3. `… | head -20` under `set -o pipefail`: head closes the pipe, grep takes
#     SIGPIPE, pipefail turns the whole pipeline into a failure. Cap AFTER the
#     list is written, never inside the producing pipeline.
#  4. THE REAL ONE (3 was a red herring I had already written down as "the real
#     one" — it wasn't): a blanket `grep -r … /tmp` returns rc=1 with ZERO hits
#     and EMPTY stderr when run from a script here, while the identical command
#     run interactively returns 5 files. Recursing a NAMED subdirectory from the
#     same script works. So the whole-/tmp walk is restricted, not the grep — and
#     it fails SILENTLY, i.e. it manufactures exactly the "no evidence anywhere"
#     answer this block exists to prevent. Fix: enumerate the stores explicitly,
#     which is also self-documenting about what was actually searched.
#     A FALSE NEGATIVE here is strictly worse than the false positive the shape
#     filter was added to remove: it re-creates the very "concluded absence"
#     mistake this sweep exists to prevent. Verified after the fix: 5x
#     /tmp/freeze-fix/mock.log out of 5 candidate files.
#
# POSITIVE CONTROL (the general lesson from trap 4): any probe that walks a broad
# filesystem root from a script must assume it may be reading NOTHING, and must
# prove it can see a hit it KNOWS is there before a null is reportable. Failure 4
# was silent — rc=1, no hits, empty stderr — so only a control distinguishes
# "searched and found nothing" from "never actually read anything".
SWEEP_CONTROL='/tmp/freeze-fix/mock.log'   # known to contain 5 genuine records
SWEEP_CONTROL_OK=0
if [ -f "$SWEEP_CONTROL" ]; then
  c=$(grep -c 'repin ring broken' "$SWEEP_CONTROL" 2>/dev/null || echo 0)
  [ "${c:-0}" -gt 0 ] && SWEEP_CONTROL_OK=1
else
  SWEEP_CONTROL_OK=2   # control file gone; cannot self-check (not a failure)
fi

SWEEP_LIST="$(mktemp)"
: > "$SWEEP_LIST"
# Known evidence stores (add new ones here — an unlisted store is an unsearched
# store, which is precisely how the decisive artifact was missed the first time).
#     `--binary-files=without-match`: the phrase is a source string literal, so
#     every compiled .o/.dylib/.swiftdoc in the DerivedData store "matches" it.
#     Those are the code, not a record of the code running.
for store in /tmp/freeze-fix /tmp/ios-freeze /tmp/ios-fix /tmp/ios-watchdog-fix \
             /tmp/ios-freeze-repro /tmp/ios-perf-check /tmp/walnut-freeze-dd; do
  [ -d "$store" ] || continue
  grep -rl --binary-files=without-match --exclude-dir=Intermediates.noindex \
       --exclude-dir='*.swiftmodule' --exclude-dir='*.app' \
       "$SWEEP_SHAPE" "$store" 2>/dev/null >> "$SWEEP_LIST" || true
done
# Loose per-run logs that live directly in /tmp (globs, not a recursive walk).
for f in /tmp/freeze-fix*.log /tmp/ios-*.log /tmp/walnut-*.log; do
  [ -f "$f" ] || continue
  grep -lq "$SWEEP_SHAPE" "$f" 2>/dev/null && echo "$f" >> "$SWEEP_LIST"
done
sort -u "$SWEEP_LIST" -o "$SWEEP_LIST" 2>/dev/null || true
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # Count only lines carrying a real uploaded telemetry record.
  n=$(grep "$SWEEP_SHAPE" "$f" 2>/dev/null | grep '"subsystem":"freeze"' | grep -c '"m_repins":"')
  [ "${n:-0}" -gt 0 ] || continue
  echo "   ${n}x  $f"
  FOUND=$((FOUND + n))
done < "$SWEEP_LIST"
SWEEP_FILES=$(wc -l < "$SWEEP_LIST" | tr -d ' ')
rm -f "$SWEEP_LIST"
if [ "$FOUND" -gt 0 ]; then
  echo "   → $FOUND genuine ring-break record(s): the ring HAS been reproduced."
  echo "     Read them before claiming absence. (Verify provenance: a real record"
  echo "     arrives inside a [client-log] upload envelope, not as test stdout.)"
elif [ "$SWEEP_CONTROL_OK" = "1" ]; then
  echo "   no genuine ring-break records in the enumerated stores (scanned ${SWEEP_FILES:-0} candidate file(s))"
  echo "   positive control OK (can read $SWEEP_CONTROL), so this null is INSTRUMENTED"
  echo "   (searched the store list in this script — NOT all of /tmp, which a script"
  echo "    cannot walk here. If a new agent used a new /tmp dir, ADD IT ABOVE before"
  echo "    reading this line as absence. Excluded: agent transcripts, live session"
  echo "    streams, build products. Required the freeze/m_repins record shape.)"
else
  echo "   ❌ SWEEP UNSUPPORTED — the positive control did not read a file known to"
  echo "      contain hits ($SWEEP_CONTROL, state=$SWEEP_CONTROL_OK). This sweep"
  echo "      found nothing, but it also cannot show that it read anything, so it"
  echo "      is NOT evidence of absence. Re-run interactively and compare."
fi
