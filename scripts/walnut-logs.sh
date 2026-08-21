#!/usr/bin/env bash
#
# walnut-logs.sh — investigation toolkit for Walnut logs & sessions.
#
# Log layout (all under $LOG_DIR, default /tmp/open-walnut):
#   open-walnut-<YYYY-MM-DD>.log   structured JSON, one obj per line (PRIMARY — has time/traceId/reqId)
#   server.log                     human-readable mirror (HH:MM:SS LVL [subsystem] msg {json})
#   daemon-d-<pid>-<id>.log        per-daemon-instance JSON logs (remote/local session spawns)
#   sessions.json                  session registry
# Streams ($STREAMS_DIR, default ~/.open-walnut/tmp/streams; legacy /tmp fallback):
#   <sid>.jsonl / .jsonl.err / .pipe / .pgid   per-session CLI output (source of truth)
#
# Usage:
#   scripts/walnut-logs.sh diagnose [sid]       ⭐⭐ AUTO-CLASSIFY each send's slowness → names the bug (event-loop / Bug D mid-turn stall / slow resume) + p50/p90 summary
#   scripts/walnut-logs.sh busstorm [sid]       ⭐ quantify high-freq streaming fan-out per global subscriber (verify interest-set; spot a new storm source)
#   scripts/walnut-logs.sh trace <sid>          per-message timeline: dispatch→RPC→enqueue→route→delivered, w/ deltas + hasPipe/path
#   scripts/walnut-logs.sh pipe <sid>           hasPipe/lifecycle transitions (start vs attach, exit, reap) — why a send was queued
#   scripts/walnut-logs.sh session <sid>        full timeline for a session (enqueue→deliver→result)
#   scripts/walnut-logs.sh delivery [sid]       message enqueue→delivered latency table (all or one sid)
#   scripts/walnut-logs.sh slow [ms]            deliveries slower than <ms> (default 3000)
#   scripts/walnut-logs.sh req <reqId|traceId>  every log line carrying a request/trace id
#   scripts/walnut-logs.sh task <taskId>        every log line for a task
#   scripts/walnut-logs.sh daemon <sid>         which daemon log serves a sid + its lines
#   scripts/walnut-logs.sh jsonl <sid>          locate + tail a session's CLI .jsonl stream
#   scripts/walnut-logs.sh bundle <sid> [mins]  freeze an all-layer evidence bundle for a sid (mirrors the in-process captureBundle)
#   scripts/walnut-logs.sh metrics [pfx] [mins] windowed latency histograms (http/llm/tool/search/eventloop; prefix filter, default 60min; live: GET /api/metrics)
#   scripts/walnut-logs.sh ttft [sid] [mins]    ⭐ time-to-first-text per turn: turn wide-event firstThinking/Text/Tool + per-layer first-emit/arrival lines — attributes "text shows late" to model vs pipeline
#   scripts/walnut-logs.sh errors [n]           last n ERR/WARN lines (default 40)
#   scripts/walnut-logs.sh grep <pattern>       raw grep across today's JSON log
#   scripts/walnut-logs.sh tail [n]             follow the live JSON log (n lines back, default 40)
#
# No `-e`: this is an interactive query tool, and a grep that matches nothing
# (exit 1) is a normal "no results" outcome, not a fatal error — `-e` would
# abort the whole script and print nothing for a valid-but-empty query.
set -uo pipefail

LOG_DIR="${WALNUT_LOG_DIR:-/tmp/open-walnut}"
# Prod streams moved to ~/.open-walnut/tmp/streams (2026-08, reboot-surviving);
# fall back to the legacy /tmp dir for pre-move sessions still writing there.
if [[ -n "${WALNUT_STREAMS_DIR:-}" ]]; then
  STREAMS_DIR="$WALNUT_STREAMS_DIR"
elif [[ -d "$HOME/.open-walnut/tmp/streams" ]]; then
  STREAMS_DIR="$HOME/.open-walnut/tmp/streams"
else
  STREAMS_DIR="/tmp/open-walnut-streams"
fi
JSON_LOG="$LOG_DIR/open-walnut-$(date +%Y-%m-%d).log"

# Fall back to most recent dated log if today's doesn't exist yet.
if [[ ! -f "$JSON_LOG" ]]; then
  JSON_LOG="$(ls -t "$LOG_DIR"/open-walnut-*.log 2>/dev/null | head -1 || true)"
fi

die() { echo "error: $*" >&2; exit 1; }
need_log() { [[ -f "$JSON_LOG" ]] || die "no JSON log found in $LOG_DIR"; }

# Timestamps are UTC but the filename uses the LOCAL date, so a session active
# across UTC-midnight has rows split over two files. Commands that stitch a
# whole session timeline scan the two most-recent dated logs, oldest-first.
recent_logs() { ls -t "$LOG_DIR"/open-walnut-*.log 2>/dev/null | head -2 | tail -r 2>/dev/null || ls -t "$LOG_DIR"/open-walnut-*.log 2>/dev/null | head -2; }

# Pretty-print selected fields from matching JSON lines: HH:MM:SS LVL [sub] message  {extras}
fmt() {
  jq -rc 'select(.time) |
    ((.time | sub("^.*T";"") | sub("\\..*$";""))) as $t |
    "\($t) \(.level[0:3]|ascii_upcase) [\(.subsystem // "?")] \(.message)" +
    ( [ to_entries[] | select(.key|test("^(time|level|subsystem|message)$")|not)
        | "\(.key)=\(.value|tostring)" ] | if length>0 then "  {"+join(" ")+"}" else "" end )'
}

cmd="${1:-}"; shift || true

case "$cmd" in
  session)
    sid="${1:?usage: session <sid>}"; need_log
    echo "── timeline for session $sid (from $JSON_LOG) ──"
    grep -aF "$sid" "$JSON_LOG" | fmt
    ;;

  delivery)
    need_log
    sid="${1:-}"
    echo "── enqueue→delivered latency (deliveryMs from 'message delivered' lines) ──"
    if [[ -n "$sid" ]]; then
      grep -aF "$sid" "$JSON_LOG" | grep -aF '"message delivered"' | \
        jq -rc '"\(.time|sub("^.*T";"")|sub("\\..*$";""))  path=\(.path)  deliveryMs=\(.deliveryMs)  count=\(.count)  msg=\(.messageId)  sid=\(.sessionId)"'
    else
      grep -aF '"message delivered"' "$JSON_LOG" | \
        jq -rc '"\(.time|sub("^.*T";"")|sub("\\..*$";""))  path=\(.path)  deliveryMs=\(.deliveryMs)  count=\(.count)  sid=\(.sessionId)"'
    fi
    ;;

  slow)
    need_log
    thresh="${1:-3000}"
    echo "── deliveries slower than ${thresh}ms ──"
    grep -aF '"message delivered"' "$JSON_LOG" | \
      jq -rc --argjson t "$thresh" 'select(.deliveryMs >= $t) |
        "\(.time|sub("^.*T";"")|sub("\\..*$";""))  deliveryMs=\(.deliveryMs)  path=\(.path)  sid=\(.sessionId)  msg=\(.messageId)"'
    ;;

  diagnose)
    # Auto-classify WHY a send was slow, per message, then summarize. This is the
    # "tell me which bug it is" entry point — pairs enqueue→route→delivered by
    # messageId (qm-…), measures the felt wait, and labels the cause so we don't
    # have to eyeball the raw trace every time.
    # Usage: diagnose [sid] [mins]  — mins defaults to 30 (recent window so old
    # historical stalls don't pollute "is it happening NOW?"); pass 0 for all-time.
    sid="${1:-}"; mins="${2:-30}"
    echo "── send-latency diagnosis${sid:+ for $sid} (last ${mins}min; 0=all) — auto-labelled cause ──"
    # shellcheck disable=SC2046
    python3 - "$sid" "$mins" $(recent_logs) <<'PY'
import sys,json
from datetime import datetime,timezone
sid=sys.argv[1]; mins=float(sys.argv[2]); files=sys.argv[3:]
# Log timestamps are UTC ('...Z'); parse as UTC so the window math matches wall clock.
cutoff = (datetime.now(timezone.utc).timestamp()*1000 - mins*60000) if mins>0 else 0
def ms(t):
    try: return datetime.strptime(t[:23],'%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp()*1000
    except: return None
# Per-message timeline keyed by messageId (qm-…). The routing-send + cannot-inject
# logs carry sessionId but NOT messageId, so we attach them to the most-recent
# not-yet-routed enqueue for that sid. Once a message is tagged with a routing
# decision (path/hasPipe) or a stall, those fields are LOCKED so a later
# processNext routing-send for the same message can't overwrite the mid-turn path.
msgs={}   # messageId -> {enq, deliv, sid, path, hasPipe, stall, locked, ...}
for f in files:
    for l in open(f,errors='ignore'):
        if sid and sid[:8] not in l: continue
        try: d=json.loads(l)
        except: continue
        m=d.get('message',''); tm=ms(d.get('time',''))
        if tm is None or tm<cutoff: continue
        s=d.get('sessionId') or ''
        mid=d.get('messageId')
        if m=='message enqueued' and mid:
            msgs.setdefault(mid,{})['enq']=tm; msgs[mid]['sid']=s
        elif m=='handleSend: routing send' and mid is None:
            cand=[k for k,v in msgs.items() if v.get('sid')==s and not v.get('routed')]
            if cand:
                last=max(cand,key=lambda k:msgs[k].get('enq',0))
                msgs[last]['routed']=True
                for k in ('path','hasPipe','activeProcessing','pid'):
                    if k in d: msgs[last][k]=d[k]
        elif 'cannot inject' in m:   # Bug D fingerprint (only emitted pre-fix)
            cand=[k for k,v in msgs.items() if v.get('sid')==s and not v.get('stall')]
            if cand:
                last=max(cand,key=lambda k:msgs[k].get('enq',0)); msgs[last]['stall']=True
        elif 'delegating to processNext' in m:  # Bug D post-fix fingerprint
            cand=[k for k,v in msgs.items() if v.get('sid')==s and not v.get('delegated')]
            if cand:
                last=max(cand,key=lambda k:msgs[k].get('enq',0)); msgs[last]['delegated']=True
        elif m=='message delivered' and mid:
            msgs.setdefault(mid,{})['deliv']=tm
            # delivery path is the FINAL path; keep the earlier routing path separately
            msgs[mid]['dpath']=d.get('path'); msgs[mid]['deliveryMs']=d.get('deliveryMs')
rows=[]
for mid,v in msgs.items():
    enq=v.get('enq'); deliv=v.get('deliv')
    e2d = (deliv-enq) if (enq and deliv) else None     # enqueue→delivered (the felt wait)
    path=v.get('path'); hp=v.get('hasPipe'); stall=v.get('stall'); deleg=v.get('delegated')
    # ---- classify (most specific first) ----
    label='ok'
    if e2d is None and 'deliv' not in v:
        label='STUCK (enqueued, not delivered in window)'
    elif stall:
        label='BUG D: mid-turn stall (cannot-inject on stale hasPipe=False)'
    elif deleg and e2d is not None and e2d>3000:
        label='Bug D path (delegated to processNext) but still slow — investigate'
    elif path=='injectMidTurn' and str(hp)=='False' and e2d is not None and e2d>3000:
        label='BUG D: mid-turn stall (injectMidTurn, stale hasPipe=False)'
    elif e2d is not None and e2d>3000 and v.get('dpath')=='resume':
        label='SLOW RESUME (CLI dead → --resume cold path)'
    elif e2d is not None and e2d>3000:
        label=f'SLOW DELIVER (enqueue→delivered, path={v.get("dpath") or path})'
    rows.append((enq or 0,mid,e2d,(path or v.get('dpath')),hp,v.get('deliveryMs'),label))
rows.sort()
def fmt(x): return f'{x:8.0f}ms' if isinstance(x,(int,float)) else '        ?'
print(f"  {'time':10} {'enq→deliv':>11} {'route-path':>13} {'hasPipe':>7}  cause")
worst={}
for enq,mid,e2d,path,hp,dms,label in rows:
    ts=datetime.fromtimestamp(enq/1000,timezone.utc).strftime('%H:%M:%S') if enq else '   ?    '
    print(f"  {ts:10} {fmt(e2d):>11} {str(path):>13} {str(hp):>7}  {label}")
    if label!='ok': worst[label]=worst.get(label,0)+1
def pct(vals,p):
    vals=sorted(v for v in vals if v is not None)
    return vals[min(len(vals)-1,int(len(vals)*p/100))] if vals else None
e2ds=[r[2] for r in rows]
print(f"\n  n={len(rows)} messages")
print(f"  enqueue→delivered: p50={fmt(pct(e2ds,50))} p90={fmt(pct(e2ds,90))} max={fmt(max([x for x in e2ds if x is not None],default=0))}")
if worst:
    print("  ── causes seen (count × label) ──")
    for k,c in sorted(worst.items(),key=lambda x:-x[1]): print(f"    {c:3}×  {k}")
else:
    print("  ✅ no slow sends in window")
if not rows: print("  (no messages found — check sid / log window)")
PY
    ;;

  busstorm)
    # Quantify how many high-frequency streaming events each GLOBAL subscriber was
    # woken for. After the interest-set fix only main-ai + session-hooks should have
    # nonzero counts; a narrow subscriber showing up = interest regression or a new
    # global subscriber added without an interest array. Also totals raw fan-out.
    # Usage: busstorm [sid] [mins] — mins defaults to 30 so historical pre-fix counts
    # don't pollute "is a storm happening NOW?"; pass 0 for all-time. NOTE: needs the
    # bus 'event delivered' debug log — only present when LOG_LEVEL includes debug.
    sid="${1:-}"; mins="${2:-30}"
    echo "── streaming fan-out per subscriber${sid:+ for $sid} (last ${mins}min; 0=all) — only main-ai + session-hooks expected ──"
    # shellcheck disable=SC2046
    python3 - "$sid" "$mins" $(recent_logs) <<'PY'
import sys,json
from datetime import datetime,timezone
from collections import Counter
sid=sys.argv[1]; mins=float(sys.argv[2]); files=sys.argv[3:]
cutoff = (datetime.now(timezone.utc).timestamp()*1000 - mins*60000) if mins>0 else 0
def ms(t):
    try: return datetime.strptime(t[:23],'%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp()*1000
    except: return None
STREAM={'session:text-delta','session:thinking-delta','session:tool-use','session:tool-result','session:usage-update'}
per=Counter(); total=Counter()
for f in files:
    for l in open(f,errors='ignore'):
        if '"event delivered"' not in l: continue
        if sid and sid[:8] not in l: continue
        try: d=json.loads(l)
        except: continue
        if cutoff and (ms(d.get('time','')) or 0)<cutoff: continue
        nm=d.get('name'); sub=d.get('subscriber')
        if nm in STREAM:
            per[sub]+=1; total[nm]+=1
if not per:
    print("  (no streaming 'event delivered' lines in window — bus debug logging may be off, or no active streaming)")
else:
    # The narrow {global:true} subscribers interest-set was supposed to silence.
    # If ANY of these show up on streaming events, the interest array regressed
    # (or a new global subscriber was added without one) — that's the real alarm.
    REGRESSION={'audio-transcriber','qmd-task-sync','qmd-session-sync','dependency-unblock','git-versioning'}
    print("  per subscriber (woken count for streaming events):")
    for sub,c in per.most_common():
        if sub in ('main-ai','session-hooks'):
            flag='   ✅ expected (needs streaming)'
        elif sub in REGRESSION:
            flag='   🚨 INTEREST REGRESSION — global subscriber back on streaming fan-out'
        else:
            # named subscriber reached via destinations:['*'] broadcast — normal, not
            # an interest-set concern (interest only gates {global:true}). Watch volume.
            flag='   (named, via wildcard broadcast — normal)'
        print(f"    {c:8}  {sub}{flag}")
    print("  per event type (raw fan-out):")
    for nm,c in total.most_common(): print(f"    {c:8}  {nm}")
PY
    ;;

  trace)
    sid="${1:?usage: trace <sid>}"
    echo "── per-message trace for $sid (dispatch → RPC → enqueue → route → delivered) ──"
    # shellcheck disable=SC2046
    python3 - "$sid" $(recent_logs) <<'PY'
import sys,json
from datetime import datetime
sid=sys.argv[1]; files=sys.argv[2:]
def ms(t):
    try: return datetime.strptime(t[:23],'%Y-%m-%dT%H:%M:%S.%f').timestamp()*1000
    except: return None
rows=[]
for f in files:
    for l in open(f,errors='ignore'):
        if sid[:8] not in l: continue
        try: d=json.loads(l)
        except: continue
        if (d.get('sessionId') or '')[:len(sid)]!=sid and sid not in l: continue
        t=d.get('time',''); m=d.get('message','')
        rows.append((ms(t),t,d))
rows=[r for r in rows if r[0] is not None]
rows.sort(key=lambda r:r[0])
# stages we care about, in order
STAGES=['[send] dispatching','session message via RPC','message enqueued','handleSend: routing send',
        'messages batched for delivery','message sent via stdin','injected mid-turn','message delivered',
        'cannot inject','no FIFO pipe','triggering processNext','rehydrating','forcing --resume','consuming pending']
prev=None
for tm,t,d in rows:
    m=d.get('message','')
    if not any(s in m for s in STAGES): continue
    dt=f"+{tm-prev:7.0f}ms" if prev is not None else "        start"
    extra=''
    for k in ('path','hasPipe','activeProcessing','pid','deliveryMs','count','messageId','found','model','mode'):
        if k in d: extra+=f" {k}={d[k]}"
    print(f"  {t[11:23]} {dt}  {m[:46]:46}{extra}")
    prev=tm
if not rows: print("  (no rows — check sid; logs scanned:", ", ".join(files)+")")
PY
    ;;

  pipe)
    sid="${1:?usage: pipe <sid>}"
    echo "── hasPipe / lifecycle (start sets hasPipe=true; attach historically did NOT) for $sid ──"
    # shellcheck disable=SC2046
    python3 - "$sid" $(recent_logs) <<'PY'
import sys,json
sid=sys.argv[1]; files=sys.argv[2:]
KEYS=['session started','attached to session','RemoteSessionManager: send failed','exit','session_state',
      'reap','onExit','no FIFO pipe','cannot inject','routing send','stopped']
for f in files:
    for l in open(f,errors='ignore'):
        if sid[:8] not in l: continue
        try: d=json.loads(l)
        except: continue
        m=d.get('message','')
        if not any(k in m for k in KEYS): continue
        extra=''
        for k in ('hasPipe','alive','pid','path','activeProcessing','reason','state','process_status'):
            if k in d: extra+=f" {k}={d[k]}"
        print(f"  {d.get('time','')[11:23]} [{d.get('subsystem','?')}] {m[:50]:50}{extra}")
PY
    ;;

  req)
    id="${1:?usage: req <reqId|traceId>}"; need_log
    echo "── lines carrying id $id ──"
    grep -aF "$id" "$JSON_LOG" | fmt
    ;;

  task)
    tid="${1:?usage: task <taskId>}"; need_log
    echo "── lines for task $tid ──"
    grep -aF "$tid" "$JSON_LOG" | fmt
    ;;

  daemon)
    sid="${1:?usage: daemon <sid>}"
    echo "── daemon logs serving $sid ──"
    for f in "$LOG_DIR"/daemon-d-*.log; do
      [[ -f "$f" ]] || continue
      if grep -aqF "$sid" "$f"; then
        echo; echo "### $f"
        grep -aF "$sid" "$f" | jq -rc '"\(.ts|sub("^.*T";"")|sub("\\..*$";""))  \(.msg)  \( {state:.newState,reason:.reason,pid:.pid}|tostring )"' 2>/dev/null \
          || grep -aF "$sid" "$f"
      fi
    done
    ;;

  jsonl)
    sid="${1:?usage: jsonl <sid>}"
    f="$STREAMS_DIR/$sid.jsonl"
    [[ -f "$f" ]] || die "no stream file at $f"
    echo "── $f ($(wc -l < "$f") lines, $(du -h "$f" | cut -f1)) — last 20 ──"
    tail -20 "$f"
    [[ -s "$STREAMS_DIR/$sid.jsonl.err" ]] && { echo "── stderr ($sid.jsonl.err) ──"; tail -20 "$STREAMS_DIR/$sid.jsonl.err"; }
    ;;

  bundle)
    # Freeze an all-layer evidence bundle for a sid. Mirrors the in-process
    # captureBundle (src/core/observability/bundle.ts): same dir layout + same
    # six artifacts, so a bundle made here is interchangeable with an auto-made
    # one. We replicate with grep/tail rather than importing dist/ because the
    # observability module is inlined into the big cli.js/server.js bundles —
    # there's no standalone dist/core/observability/bundle.js to import.
    sid="${1:?usage: bundle <sid> [mins]}"; mins="${2:-60}"
    # Bundles live under LOG_DIR (/tmp/open-walnut/incidents), next to the source
    # logs — NOT under OPEN_WALNUT_HOME, which git-sync commits. Matches bundle.ts.
    ts="$(date +%s)000"   # epoch ms (matches Date.now() in the in-process version)
    dir="$LOG_DIR/incidents/$sid-$ts"
    mkdir -p "$dir"
    cutoff_ms=$(( ($(date +%s) - mins * 60) * 1000 ))
    included=(); missing=()

    # 1. server.log.txt — sid lines from the 2 most-recent dated logs, windowed.
    #    UTC time field vs local filename: scan both recent files (recent_logs).
    : > "$dir/server.log.txt"
    for f in $(recent_logs); do
      # Keep lines newer than cutoff. jq's fromdateiso8601 only accepts whole-second
      # ISO ('…40Z'), so strip the '.222' millis first. A line whose time we can't
      # parse is KEPT (don't drop evidence over a parse miss) by defaulting to $c.
      grep -aF "$sid" "$f" 2>/dev/null | jq -rc --argjson c "$cutoff_ms" \
        'select((try ((.time | sub("\\.[0-9]+";"")) | fromdateiso8601 * 1000) catch $c) >= $c)' \
        2>/dev/null >> "$dir/server.log.txt" || true
    done
    if [[ -s "$dir/server.log.txt" ]]; then included+=("server.log.txt"); else
      rm -f "$dir/server.log.txt"; missing+=("server.log.txt: no $sid lines in last ${mins}min"); fi

    # 2. cli.jsonl.tail.txt — last 200 lines of the CLI stream (+ .err), probing
    #    both stream dirs (local embedded vs remote daemon write to different ones).
    jsonl=""
    for d in "$STREAMS_DIR" "$LOG_DIR/streams"; do
      [[ -f "$d/$sid.jsonl" ]] && { jsonl="$d/$sid.jsonl"; break; }
    done
    if [[ -n "$jsonl" ]]; then
      { echo "### $jsonl (last 200 lines)"; tail -200 "$jsonl"; } > "$dir/cli.jsonl.tail.txt"
      if [[ -s "$jsonl.err" ]]; then
        { echo; echo "### $jsonl.err (stderr, last 200 lines)"; tail -200 "$jsonl.err"; } >> "$dir/cli.jsonl.tail.txt"
      fi
      included+=("cli.jsonl.tail.txt")
    else
      missing+=("cli.jsonl.tail.txt: no .jsonl stream for $sid")
    fi

    # 3. cli-debug.txt — the CLI's own --debug log (local host only).
    dbg="$HOME/.claude/debug/$sid.txt"
    if [[ -f "$dbg" ]]; then
      tail -200 "$dbg" > "$dir/cli-debug.txt"; included+=("cli-debug.txt")
    else
      missing+=("cli-debug.txt: no $dbg (remote sessions write it on the remote host)")
    fi

    # 4. daemon.log.txt — sid lines across every daemon-d-*.log, labelled by file.
    : > "$dir/daemon.log.txt"
    for f in "$LOG_DIR"/daemon-d-*.log; do
      [[ -f "$f" ]] || continue
      if grep -aqF "$sid" "$f"; then
        { echo "### $f"; grep -aF "$sid" "$f"; } >> "$dir/daemon.log.txt"
      fi
    done
    if [[ -s "$dir/daemon.log.txt" ]]; then included+=("daemon.log.txt"); else
      rm -f "$dir/daemon.log.txt"; missing+=("daemon.log.txt: no daemon-d-*.log mentions $sid"); fi

    # 5. turn-events.txt — the wide obs "turn" records for this sid.
    : > "$dir/turn-events.txt"
    for f in $(recent_logs); do
      grep -aF "$sid" "$f" 2>/dev/null | grep -aF '"subsystem":"obs"' | grep -aF '"message":"turn"' \
        >> "$dir/turn-events.txt" || true
    done
    if [[ -s "$dir/turn-events.txt" ]]; then included+=("turn-events.txt"); else
      rm -f "$dir/turn-events.txt"; missing+=("turn-events.txt: no obs turn events for $sid in last ${mins}min"); fi

    # 6. meta.json — same shape as the in-process bundle.
    inc_json=$(printf '%s\n' "${included[@]:-}" | jq -R . | jq -sc 'map(select(.!=""))')
    mis_json=$(printf '%s\n' "${missing[@]:-}" | jq -R . | jq -sc 'map(select(.!=""))')
    jq -n --arg sid "$sid" --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      --argjson w "$mins" --argjson inc "$inc_json" --argjson mis "$mis_json" \
      '{sessionId:$sid, capturedAt:$at, windowMins:$w, filesIncluded:$inc, notesIfMissing:$mis}' \
      > "$dir/meta.json"

    echo "── evidence bundle for $sid (window ${mins}min) ──"
    echo "  dir:     $dir"
    echo "  files:   ${included[*]:-(none)}"
    [[ ${#missing[@]} -gt 0 ]] && printf '  missing: %s\n' "${missing[@]}"
    ;;

  errors)
    need_log; n="${1:-40}"
    echo "── last $n WARN/ERR lines ──"
    grep -aE '"level":"(warn|error)"' "$JSON_LOG" | tail -"$n" | fmt
    ;;

  metrics)
    # metrics [prefix] [mins] — windowed histograms flushed by the metrics
    # registry (subsystem=obs, message=metric). Live view: GET /api/metrics.
    need_log; pfx="${1:-}"; mins="${2:-60}"
    if [[ "$mins" == "0" ]]; then since="1970-01-01T00:00:00Z"; else
      since=$(date -u -v "-${mins}M" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -d "-${mins} minutes" '+%Y-%m-%dT%H:%M:%S')
    fi
    echo "── metric windows (prefix='${pfx:-*}', last ${mins}min; UTC) ──"
    grep -aF '"message":"metric"' "$JSON_LOG" | jq -r --arg pfx "$pfx" --arg since "$since" '
      select(.time >= $since) | select(.metric | startswith($pfx)) |
      "\(.time[11:19]) \(.metric)\(if .labels then (.labels|to_entries|map("\(.key)=\(.value)")|join(",")|" {"+.+"}") else "" end) n=\(.count) avg=\(.avg) p50=\(.p50) p90=\(.p90) p99=\(.p99) max=\(.max)"'
    ;;

  ttft)
    # ttft [sid] [mins] — time-to-first-text attribution (inc-1786665503510).
    # Three evidence families, one timeline:
    #   1. obs turn wide-events: firstThinkingMs/firstTextMs/firstToolMs (server
    #      bus emit times, anchored at the turn-start FIFO write)
    #   2. per-layer first-emit lines: server "first text emit of turn",
    #      browser "first text-delta arrived" / "first text flush to blocks"
    #   3. daemon "ttft:" lines live in the DAEMON's log on the exec host —
    #      surfaced here as a reminder, fetch with: walnut-logs.sh daemon <sid>
    # Reading: firstTextMs >> firstThinkingMs/firstToolMs = model produced text
    # late (upstream). server-emit ≈ browser-arrival ≈ flush = pipeline healthy.
    need_log; sid="${1:-}"; mins="${2:-60}"
    if [[ "$mins" == "0" ]]; then since="1970-01-01T00:00:00Z"; else
      since=$(date -u -v "-${mins}M" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -d "-${mins} minutes" '+%Y-%m-%dT%H:%M:%S')
    fi
    echo "── per-turn TTFT (wide events${sid:+, sid=$sid}; last ${mins}min; UTC) ──"
    grep -aF '"message":"turn"' "$JSON_LOG" | jq -r --arg sid "$sid" --arg since "$since" '
      select(.time >= $since) | select($sid == "" or .sessionId == $sid) |
      "\(.time[11:19]) sid=\(.sessionId[0:8]) turn=\(.durationMs)ms firstThinking=\(.firstThinkingMs // "-")ms firstText=\(.firstTextMs // "-")ms firstTool=\(.firstToolMs // "-")ms delivery=\(.deliveryMs // "-")ms(\(.deliveryPath // "?"))"'
    echo ""
    echo "── per-layer first-emit / arrival lines (server emit + browser arrival/flush) ──"
    # Browser-forwarded lines carry a "[stream] " message prefix and their
    # sessionId inside the stringified `args`, not as a top-level field.
    grep -aE '"message":"(\[stream\] )?(first (thinking|text|tool) emit of turn|first text-delta arrived|first text flush to blocks( \(sync\))?)"' "$JSON_LOG" | \
      jq -r --arg sid "$sid" --arg since "$since" '
        select(.time >= $since) |
        (.sessionId // (try (.args | fromjson | .sessionId) catch null)) as $rowSid |
        select($sid == "" or $rowSid == $sid) |
        "\(.time[11:23]) [\(.subsystem)] \(.message)\(if .sinceTurnStartMs != null then " +\(.sinceTurnStartMs)ms" else "" end) sid=\(($rowSid // "?")[0:8])"'
    echo ""
    echo "(daemon-side 'ttft:' lines live on the exec host's daemon log — see: $0 daemon <sid>)"
    ;;

  grep)
    pat="${1:?usage: grep <pattern>}"; need_log
    grep -aF "$pat" "$JSON_LOG" | fmt
    ;;

  tail)
    need_log; n="${1:-40}"
    tail -n "$n" -F "$JSON_LOG" | fmt
    ;;

  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
