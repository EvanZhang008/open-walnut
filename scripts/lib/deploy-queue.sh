# The deploy queue of scripts/deploy-committed.sh: at most one production restart
# per gap, and each deploy ships the newest commit of then.
#
# 2026-11-03: 27 production restarts in one day, two of them 7 minutes apart while
# the link to a remote host was already failing; every restart costs every open
# window seconds of timeouts and pushes a new daemon to every host. A deploy inside
# the old 120 s cooldown exited 0 saying the server was current while the caller's
# commit was not live, and two at once failed outright.
#
# Now a caller files a request (its commit) and waits; ONE runner, detached from
# every caller so a caller's timeout never cuts a deploy, does the deploys:
#   - nothing goes out sooner than WALNUT_DEPLOY_MIN_GAP_SECS (600) after the last
#     restart (this queue's own record, dev-prod.sh's success stamp, the served
#     build's time, whichever is latest) or 125 s after a deploy attempt;
#   - then it deploys the checkout's HEAD of that moment, which carries every
#     waiting commit on it (a commit HEAD does not carry goes alone, in turn,
#     unless that would take production back: a commit a rebase replaced);
#   - it runs detached from every caller, with none of a caller's WALNUT_DEVPROD_*
#     knobs (a rehearsal's own excepted);
#   - every caller whose commit it carried hears "deployed X, which contains your
#     commit", or its failure with the log; a commit production already serves is
#     answered at once, as before.
# WALNUT_DEPLOY_NO_WAIT=1 files the request and returns; WALNUT_DEPLOY_WAIT_SECS
# (2400) caps a caller's wait (the runner goes on). WALNUT_DEVPROD_FORCE=1 and a dry
# run skip the queue. A rehearsal keeps its queue in its own state dir.
# State (WALNUT_DEPLOY_QUEUE_DIR, else ~/.local/state/open-walnut/deploy-queue):
#   requests/<id>  a waiting commit     results/<id>  ok|failed|refused <target> <log> <code>
#   runner.lock/   the runner's pid     current       the deploy running now
#   next-at        when it may go       last-restart  its last deploy that served
#   logs/          one log per deploy   runner.log    the runner's own lines
# Ratchet: tests/scripts/deploy-queue.test.ts. Needs SERVE_ROOT, JS_RUN and DQ_SCRIPT.

DQ_GAP="${WALNUT_DEPLOY_MIN_GAP_SECS:-600}"
[[ "$DQ_GAP" =~ ^[0-9]+$ ]] || DQ_GAP=600
DQ_ATTEMPT_GAP=125
# A busy Mac stretches the gap (2026-11-09: four deploys an hour, each a full build of the web app
# and five compiled files, took this Mac's load to 200 to 400 with an iOS build and a test run, and
# messages to sessions waited on the server's queue lock): once the gap is over, a deploy waits
# while the Mac's 1-minute load stays over WALNUT_DEPLOY_BUSY_LOAD per CPU (4), until
# WALNUT_DEPLOY_BUSY_GAP_SECS (1200) after the last restart; then it goes whatever the load, so
# the commits waiting go out together in one build.
DQ_BUSY_GAP="${WALNUT_DEPLOY_BUSY_GAP_SECS:-1200}"
[[ "$DQ_BUSY_GAP" =~ ^[0-9]+$ ]] || DQ_BUSY_GAP=1200
DQ_BUSY_LOAD="${WALNUT_DEPLOY_BUSY_LOAD:-4}"
[[ "$DQ_BUSY_LOAD" =~ ^[0-9]+(\.[0-9]+)?$ ]] || DQ_BUSY_LOAD=4
# The 1-minute load when it is over the busy line, else nothing. WALNUT_DEPLOY_LOAD_TEST stands in
# for the machine's load in tests.
dq_busy_load() {
  local l c
  l="${WALNUT_DEPLOY_LOAD_TEST:-}"
  [[ -n "$l" ]] || l="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
  [[ -n "$l" ]] || l="$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
  c="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1)"
  awk -v l="$l" -v c="$c" -v m="$DQ_BUSY_LOAD" 'BEGIN { if (c < 1) c = 1; if (l != "" && l / c > m) print l }'
}

dq_rehearsal() {
  [[ "${WALNUT_DEVPROD_REHEARSAL:-0}" == "1" && "${WALNUT_DEVPROD_REHEARSAL_DIR:-}" == /* && -d "${WALNUT_DEVPROD_REHEARSAL_DIR:-}" ]]
}

dq_dir() {
  if [[ -n "${WALNUT_DEPLOY_QUEUE_DIR:-}" ]]; then printf '%s' "$WALNUT_DEPLOY_QUEUE_DIR"
  elif dq_rehearsal; then printf '%s' "${WALNUT_DEVPROD_REHEARSAL_DIR%/}/rehearsal-state/deploy-queue"
  else printf '%s' "${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/deploy-queue"
  fi
}

# Where dev-prod.sh keeps its stamps (its default_tmpdir, or a rehearsal's state dir).
dq_devprod_tmp() {
  if dq_rehearsal; then printf '%s' "${WALNUT_DEVPROD_REHEARSAL_DIR%/}/rehearsal-state"; return; fi
  if [[ -n "${TMPDIR:-}" ]]; then printf '%s' "${TMPDIR%/}"; return; fi
  local d=""
  if [[ "$(uname -s)" == "Darwin" ]]; then d="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"; fi
  d="${d%/}"
  if [[ -n "$d" && -d "$d" ]]; then printf '%s' "$d"; else printf '/tmp'; fi
}

dq_config_url() {
  if dq_rehearsal && [[ -z "${WALNUT_DEPLOY_CONFIG_URL:-}" ]]; then
    printf 'http://127.0.0.1:%s/api/config' "${WALNUT_DEVPROD_PORT:-0}"
  else
    printf '%s' "${WALNUT_DEPLOY_CONFIG_URL:-http://127.0.0.1:3456/api/config}"
  fi
}

# "<full sha> <built-at epoch>" of the clean build production serves, or nothing.
dq_served() {
  local json line sha
  json="$(curl -s -m 3 "$(dq_config_url)" 2>/dev/null || true)"
  line="$("${JS_RUN[@]}" "$json" <<'JS' 2>/dev/null || true
try {
  const b = JSON.parse(process.argv[2] || '{}').build || {}
  if (b.dirty === false && /^[0-9a-f]{7,40}$/.test(b.commit || '')) {
    const at = Date.parse(b.builtAt || '')
    console.log(b.commit + ' ' + (Number.isFinite(at) ? Math.floor(at / 1000) : 0))
  }
} catch {}
JS
)"
  [[ -n "$line" ]] || return 0
  sha="$(git -C "$SERVE_ROOT" rev-parse --verify --quiet "${line%% *}^{commit}" 2>/dev/null || true)"
  [[ -n "$sha" ]] && printf '%s %s' "$sha" "${line##* }"
  return 0
}


dq_num() { local v; v="$(cat "$1" 2>/dev/null || true)"; [[ "$v" =~ ^[0-9]+$ ]] && printf '%s' "$v" || printf '0'; }
dq_clock() { date -r "$1" '+%H:%M:%S' 2>/dev/null || date -d "@$1" '+%H:%M:%S' 2>/dev/null || printf '%s' "$1"; }

# The runner holding the lock, alive and still this script (a reused pid is not), or nothing.
dq_runner_pid() {
  local q="$1" pid
  pid="$(cat "$q/runner.lock/pid" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
    *deploy-committed*) printf '%s' "$pid" ;;
  esac
  return 0
}

# Writes a file whole (a reader never sees it half written): a temp name, then mv.
dq_put() {
  local f="$1" t; shift
  t="$(dirname "$f")/.tmp.$$.$RANDOM"
  printf '%s\n' "$*" > "$t" && mv -f "$t" "$f"
}

dq_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf '0'; }

# Whether `target` (arg 1) carries commit `sha` (arg 2): it contains it, or every
# change of it under another id (a rebase moved it, git cherry).
dq_covers() {
  [[ -n "${1:-}" && -n "${2:-}" ]] || return 1
  git -C "$SERVE_ROOT" merge-base --is-ancestor "$2" "$1" 2>/dev/null && return 0
  local out
  out="$(git -C "$SERVE_ROOT" cherry "$1" "$2" 2>/dev/null)" || return 1
  [[ -n "$out" ]] && ! grep -q '^+' <<<"$out"
}

# The runner lock: this process holds it (0) or not (1). A lock no live runner
# holds is taken over only once it is 10 s old: its maker may not have written its pid yet.
dq_lock() {
  local q="$1"
  if mkdir "$q/runner.lock" 2>/dev/null; then dq_put "$q/runner.lock/pid" "$$"; return 0; fi
  [[ -n "$(dq_runner_pid "$q")" ]] && return 1
  (( $(date +%s) - $(dq_mtime "$q/runner.lock") >= 10 )) || return 1
  rm -f "$q/runner.lock/pid"
  rmdir "$q/runner.lock" 2>/dev/null || return 1
  mkdir "$q/runner.lock" 2>/dev/null || return 1
  dq_put "$q/runner.lock/pid" "$$"
}
dq_unlock() {
  local q="$1"
  [[ "$(cat "$q/runner.lock/pid" 2>/dev/null || true)" == "$$" ]] || return 0
  rm -f "$q/current" "$q/next-at" "$q/runner.lock/pid"
  rmdir "$q/runner.lock" 2>/dev/null || true
}

# The knobs a caller may set for its own deploy; the queue's runner never takes them
# from whoever happened to start it (a rehearsal's own settings excepted).
dq_caller_knobs() {
  env | sed -n 's/^\(WALNUT_DEVPROD_[A-Z0-9_]*\)=.*/\1/p' \
    | grep -vE '^WALNUT_DEVPROD_(REHEARSAL|REHEARSAL_DIR|PORT|REHEARSAL_FAIL_[A-Z_]*|FORCE|DRY_RUN)$' || true
}

dq_start_runner() {
  local q="$1" name
  [[ -n "$(dq_runner_pid "$q")" ]] && return 0
  local drop=()
  for name in $(dq_caller_knobs); do drop+=(-u "$name"); done
  # Forked twice: its parent exits at once, so the runner belongs to init, never to
  # the caller. Claude Code ends a timed-out command by killing its whole tree (by
  # parent pid), which would otherwise take the runner and its deploy with it.
  env ${drop[@]+"${drop[@]}"} WALNUT_DEPLOY_RUNNER_LOOP=1 nohup perl -e \
    'use POSIX qw(setsid); my $p = fork; die "fork: $!" unless defined $p; exit 0 if $p; setsid(); exec @ARGV or die "exec: $!"' \
    bash "$DQ_SCRIPT" >> "$q/runner.log" 2>&1 < /dev/null &
  wait $! 2>/dev/null || true
}

dq_log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# ── The runner ───────────────────────────────────────────────────────────────
dq_runner() {
  local q; q="$(dq_dir)"
  mkdir -p "$q/requests" "$q/results" "$q/logs"
  cd "$SERVE_ROOT"
  dq_lock "$q" || return 0
  trap 'dq_unlock "'"$q"'"' EXIT
  dq_log "runner $$ started (gap ${DQ_GAP}s)"
  local served served_sha built id sha pending last now at wait head target log code before refused
  while :; do
    served="$(dq_served)"; served_sha="${served%% *}"; built="${served##* }"
    # Requests production already carries are answered.
    pending=""
    for id in $(ls "$q/requests" 2>/dev/null | sort); do
      sha="$(cat "$q/requests/$id" 2>/dev/null || true)"
      [[ -n "$sha" ]] || { rm -f "$q/requests/$id"; continue; }
      if dq_covers "$served_sha" "$sha"; then
        dq_put "$q/results/$id" "ok $served_sha - 0"; rm -f "$q/requests/$id"
      else
        pending="$pending $id"
      fi
    done
    if [[ -z "$pending" ]]; then
      # Nothing waits. A request filed while it was ending is taken up again.
      dq_unlock "$q"
      if [[ -n "$(ls "$q/requests" 2>/dev/null)" ]] && dq_lock "$q"; then continue; fi
      break
    fi
    # The gap since the last restart, and since the last attempt (dev-prod.sh's cooldown).
    last="$(dq_num "$q/last-restart")"
    at="$(dq_num "$(dq_devprod_tmp)/open-walnut-dev-prod.last-success")"; (( at > last )) && last=$at
    [[ "$built" =~ ^[0-9]+$ ]] && (( built > last )) && last=$built
    at="$(dq_num "$(dq_devprod_tmp)/open-walnut-dev-prod.last-attempt")"
    now="$(date +%s)"
    wait=$(( last + DQ_GAP - now ))
    (( at + DQ_ATTEMPT_GAP - now > wait )) && wait=$(( at + DQ_ATTEMPT_GAP - now ))
    if [[ "${WALNUT_DEPLOY_NO_GAP:-0}" != "1" ]] && (( wait > 0 )); then
      dq_put "$q/next-at" "$(( now + wait ))"
      sleep $(( wait < 10 ? wait : 10 ))
      continue
    fi
    if [[ "${WALNUT_DEPLOY_NO_GAP:-0}" != "1" ]] && (( last + DQ_BUSY_GAP > now )); then
      busy="$(dq_busy_load)"
      if [[ -n "$busy" ]]; then
        [[ -n "${busy_said:-}" ]] || dq_log "the Mac is busy (load $busy, over $DQ_BUSY_LOAD per CPU): the deploy waits for it to ease, until $(dq_clock "$(( last + DQ_BUSY_GAP ))") at the latest"
        busy_said=1
        dq_put "$q/next-at" "$(( last + DQ_BUSY_GAP ))"; dq_put "$q/busy" "$busy"
        wait=$(( last + DQ_BUSY_GAP - now ))
        sleep $(( wait < 10 ? wait : 10 ))
        continue
      fi
    fi
    busy_said=; rm -f "$q/busy"
    rm -f "$q/next-at"
    # The newest commit of now. A waiting commit it does not carry goes alone, in
    # turn, unless that would take production back past the build it serves (a
    # commit a rebase replaced: its change is in HEAD under another id, or not).
    head="$(git -C "$SERVE_ROOT" rev-parse HEAD)"
    target="$head"; refused=0
    for id in $pending; do
      sha="$(cat "$q/requests/$id" 2>/dev/null || true)"
      [[ -n "$sha" ]] || continue
      dq_covers "$head" "$sha" && continue
      if [[ -n "$served_sha" ]] && ! git -C "$SERVE_ROOT" merge-base --is-ancestor "$served_sha" "$sha" 2>/dev/null; then
        dq_put "$q/results/$id" "refused $sha $served_sha 0"; rm -f "$q/requests/$id"; refused=1
        continue
      fi
      target="$sha"; break
    done
    (( refused == 0 )) || continue
    log="$q/logs/$(date +%Y%m%dT%H%M%S)-${target:0:12}.log"
    dq_put "$q/current" "$target $(date +%s) $log"
    dq_log "deploying ${target:0:12} for$pending (log $log)"
    before="$served_sha"
    code=0
    WALNUT_DEPLOY_RUNNER=1 bash "$DQ_SCRIPT" "$target" > "$log" 2>&1 < /dev/null || code=$?
    rm -f "$q/current"
    if (( code == 0 )) && grep -q '^Deploy skipped: last deploy' "$log"; then
      # dev-prod.sh's own cooldown answered (a deploy outside this queue): nothing went out, ask again.
      dq_log "deploy of ${target:0:12} met dev-prod.sh's cooldown; trying again"
      continue
    fi
    served="$(dq_served)"; served_sha="${served%% *}"
    # A clean exit with production answering another build is no deploy of it.
    if (( code == 0 )) && [[ -n "$served_sha" ]] && ! dq_covers "$served_sha" "$target"; then
      echo "The deploy exited 0, but production serves ${served_sha:0:12}, which does not include ${target:0:12}." >> "$log"
      code=70
    fi
    if (( code == 0 )); then
      [[ "$served_sha" != "$before" ]] && dq_put "$q/last-restart" "$(date +%s)"
      dq_log "deployed ${target:0:12} (production serves ${served_sha:0:12})"
    else
      dq_log "deploy of ${target:0:12} failed (exit $code)"
    fi
    for id in $pending; do
      sha="$(cat "$q/requests/$id" 2>/dev/null || true)"
      [[ -n "$sha" ]] && dq_covers "$target" "$sha" || continue
      if (( code == 0 )); then dq_put "$q/results/$id" "ok $target $log 0"
      else dq_put "$q/results/$id" "failed $target $log $code"; fi
      rm -f "$q/requests/$id"
    done
    # Old deploy logs and answers nobody read.
    ls -t "$q/logs" 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$q/logs/$f"; done
    find "$q/results" -type f -mmin +1440 -exec rm -f {} + 2>/dev/null || true
  done
  dq_log "runner $$ done: nothing waits"
}

# ── A caller ─────────────────────────────────────────────────────────────────
# Prints the answer filed for request `id` (arg 2) and returns its exit code:
# 0 live, 1 failed or refused; 2 when there is none yet.
dq_answer() {
  local q="$1" id="$2" sha="$3" kind target log code
  [[ -f "$q/results/$id" ]] || return 2
  read -r kind target log code < "$q/results/$id" || true
  rm -f "$q/results/$id"
  case "$kind" in
    ok)
      if [[ "$target" == "$sha" ]]; then echo "Deployed ${sha:0:12}: production serves it now."
      else echo "Deployed: production serves ${target:0:12}, which includes your commit ${sha:0:12}."; fi
      if [[ "$log" != "-" && -f "$log" ]]; then
        echo "Deploy log: $log"
        # A part of the deploy that failed while the server went live (dev-prod.sh).
        grep -h '^Deploy incomplete: ' "$log" >&2 || true
      fi
      return 0 ;;
    refused)
      echo "Not deployed: your commit ${sha:0:12} is not on the checkout's HEAD (a rebase replaced it, or it is on another branch), and production serves ${log:0:12}, which deploying it alone would take back. Deploy the commit that carries it now (usually HEAD)." >&2
      return 1 ;;
    *)
      echo "Deploy failed: the deploy of ${target:0:12}, which includes your commit ${sha:0:12}, exited $code; nothing of it is live. Log: $log" >&2
      tail -n 30 "$log" >&2 2>/dev/null || true
      return 1 ;;
  esac
}

# Files SHA, makes sure a runner runs, and waits for the answer. Exit code: 0 live,
# 1 its deploy failed or was refused, 3 still waiting at the cap (the runner goes on).
dq_request() {
  local sha="$1" q id served served_sha said="" line now deadline target log next rc knobs
  q="$(dq_dir)"
  mkdir -p "$q/requests" "$q/results" "$q/logs"
  knobs="$(dq_caller_knobs | tr '\n' ' ')"
  if [[ -n "$knobs" ]]; then
    echo "Note: a queued deploy runs with the queue's settings, so ${knobs}does not apply to it; WALNUT_DEVPROD_FORCE=1 deploys now with it." >&2
  fi
  id="$(date +%s)-$$-$RANDOM"
  dq_put "$q/requests/$id" "$sha"
  dq_start_runner "$q"
  if [[ "${WALNUT_DEPLOY_NO_WAIT:-0}" == "1" ]]; then
    echo "Deploy queued: ${sha:0:12} goes out with the next deploy (at most one restart per $(( DQ_GAP / 60 )) min); not waiting. State: $q"
    return 0
  fi
  # The default wait covers a busy Mac's longer gap too (a commit that comes just after a deploy
  # started waits for that build, the busy gap and its own build).
  now="$(date +%s)"; deadline=$(( now + ${WALNUT_DEPLOY_WAIT_SECS:-$(( 2400 + DQ_BUSY_GAP ))} ))
  while :; do
    rc=0; dq_answer "$q" "$id" "$sha" || rc=$?
    (( rc == 2 )) || return "$rc"
    if [[ ! -f "$q/requests/$id" ]]; then
      # Answered between the two looks, or never: read once more before saying so.
      rc=0; dq_answer "$q" "$id" "$sha" || rc=$?
      (( rc == 2 )) || return "$rc"
      served="$(dq_served)"; served_sha="${served%% *}"
      if dq_covers "$served_sha" "$sha"; then echo "Deployed: production serves ${served_sha:0:12}, which includes your commit ${sha:0:12}."; return 0; fi
      echo "Deploy request for ${sha:0:12} was removed without an answer (state $q); run the deploy again." >&2
      return 1
    fi
    # No runner (it ended, a reboot, a kill): another one takes the queue over.
    [[ -n "$(dq_runner_pid "$q")" ]] || dq_start_runner "$q"
    line=""
    if [[ -f "$q/current" ]]; then
      read -r target _ log < "$q/current" || true
      if dq_covers "${target:-}" "$sha"; then
        line="Deploying ${target:0:12}, which includes your commit ${sha:0:12} (log $log)."
      else
        line="Deploying ${target:0:12}; your commit ${sha:0:12} goes with the next one."
      fi
    elif [[ -f "$q/next-at" && -f "$q/busy" ]]; then
      next="$(dq_num "$q/next-at")"
      line="Deploy queued: this Mac is busy (load $(cat "$q/busy" 2>/dev/null)); the next deploy goes once it eases, at $(dq_clock "$next") at the latest, with the newest commit then, which includes ${sha:0:12}."
    elif [[ -f "$q/next-at" ]]; then
      next="$(dq_num "$q/next-at")"
      line="Deploy queued: production restarted recently, and restarts at most once per $(( DQ_GAP / 60 )) min; the next deploy goes at $(dq_clock "$next") with the newest commit then, which includes ${sha:0:12}."
    fi
    if [[ -n "$line" && "$line" != "$said" ]]; then echo "$line"; said="$line"; fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      echo "Still waiting after ${WALNUT_DEPLOY_WAIT_SECS:-$(( 2400 + DQ_BUSY_GAP ))}s; the queue goes on without this call (state $q). Run the deploy again to wait for it." >&2
      return 3
    fi
    sleep 3
  done
}
