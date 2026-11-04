/**
 * The probation of a service update that came to serve (daemon-update-tail.ts): for
 * PROBATION_SECONDS after the tail's verdict, a script of its own in the install root watches the
 * daemon. Gone (no daemon twice in a row) or started again twice (another pid each time: KeepAlive,
 * systemd's Restart=, the cron supervisor bringing a crashing build back; one restart may be the
 * user's own) counts as the new build's failure: the config
 * from before the update is put back the way the tail does it, and the build is written down in
 * the install root (update-probation.failed), where the next runner of that build refuses it for
 * a day (daemon-net-update-io.ts) and the server holds it (judgeServiceUpdate: probationFailed).
 *
 * 2026-11-04 review 5: a build that crashed at its first session spawn, on a 60 s timer or in
 * the fold prewarm passed the CLI's 30 s and the tail's 15 s, and was restarted in a loop for
 * good, with nothing to go back to.
 *
 * The copies it puts back are the snapshot's own in the install root (`update-before/`, written
 * beside the update's dir by updateSnapshotLines), so neither a reboot nor the server removing
 * the update's dir takes them. It stands down, with no verdict, when the copies are no longer its
 * update's (a later update took a snapshot), the service config is gone, is the one from before
 * again or is another one than it watched, or a `walnut daemon` transaction holds the install
 * lock (the user's own step decides). A probation passed removes the copies, under the lock.
 *
 * No later update starts while it runs: the launcher and the runner (daemon-net-update-io.ts),
 * this machine's update (local-daemon-service.ts) and the SSH path (daemon-connection.ts) read it
 * as busy (t_probing, probingCheckScript) and ask again after its end; so they do from the moment
 * the tail starts it (its start mark), however long the detach takes. While a later runner is at
 * work anyway (one of an older build), nothing is judged, and only what that runner changes ends
 * the watch. 2026-11-05 review 6: any later runner stood it down for good, one refused at once
 * included, and a build that then crash looped had no way back.
 *
 * A failure found is written down first. Its put-back then holds the lock until the config it put
 * back is loaded, and only then leaves the rest to a later update that started meanwhile
 * (2026-11-04 review 6: one launched inside the bootout wait stood it down between the bootout
 * and the load, read the service as stopped, and the host was left with no job loaded).
 */
import { DETACH_LINE, servicePreamble } from './daemon-update-shell.js'

/** How long a new service daemon is watched after its update's tail found it serving. */
export const PROBATION_SECONDS = 15 * 60
/** How often the probation looks. */
export const PROBATION_EVERY_SECONDS = 5
/** The snapshot's copies in the install root. */
export const SNAPSHOT_DIR = 'update-before'
export const PROBATION_SCRIPT_NAME = 'daemon-probation.sh'
/** The build that did not stay serving, when, and why (three lines), in the install root. */
export const PROBATION_FAILED_NAME = 'update-probation.failed'
/** How long the runner refuses a build written down there (the server's own hold is as long). */
export const PROBATION_REFUSE_SECONDS = 24 * 60 * 60
/**
 * How long past its own end (before.until) a probation's process still counts as at work: its last
 * looks, then a put-back's lock wait, bootout, wait, stay and stand-in fit well inside. One alive
 * later than that is hung (a launchctl that never answers) or a pid another process got, and
 * holding every later update for it would hold them for good (2026-11-05 review 6b).
 */
export const PROBATION_GRACE_SECONDS = 10 * 60
/**
 * The tail's mark that it started a probation (its epoch s, then the cksum of the config it judged),
 * in "$tsb", until the probation writes its pid. A detach under load takes seconds (20 s seen at
 * load 140): before this mark, a launch in that gap found no probation at work, its snapshot took
 * the copies, and the late probation stood down, leaving the new build unwatched (2026-11-05
 * review 7). Where the detach's own process is the probation (setsid, perl) the tail writes its pid
 * at once; the mark covers the other ways, and one that never comes stops counting after
 * PROBATION_STARTING_SECONDS.
 */
export const PROBATION_STARTING_NAME = 'probation.starting'
export const PROBATION_STARTING_SECONDS = 60
const EOF = 'WALNUT_PROBATION_EOF'

/**
 * t_failed WORDS: the build of the copies in "$tsb" (before.build; $tv_b once read) did not stay serving here.
 * t_probing: a probation of the copies in "$tsb" is at work (its pid alive as this script), and not
 * past its end by more than PROBATION_GRACE_SECONDS (with no end written, its pid file not older
 * than a probation and that grace); or the tail started one less than PROBATION_STARTING_SECONDS
 * ago and it has not written its pid yet. The revive's rule: it takes up copies whose probation a
 * reboot ended.
 * t_busy: what a later update waits for: a probation at work, or copies whose probation has time
 * left (before.until ahead, by at most PROBATION_SECONDS: a clock stepped back is not believed),
 * whether or not a probation still runs. 2026-11-05 review 8: a reboot ended the probation, the
 * service brought the new build back, and the next update's snapshot took the only copy of the
 * build before it.
 */
export function probationRecordLines(): string[] {
  return [
    `t_failed() { tf_b=\${tv_b-$(cat "$tsb/before.build" 2>/dev/null)}; [ -n "$tf_b" ] || return 0`,
    `  printf '%s\\n%s\\n%s\\n' "$tf_b" "$(date +%s)" "$1" > "$tb/${PROBATION_FAILED_NAME}.tmp" && mv -f "$tb/${PROBATION_FAILED_NAME}.tmp" "$tb/${PROBATION_FAILED_NAME}"; }`,
    // $tp_t: the end it counts to (the probation's, or the start's wait).
    't_probing() { tp_p=$(cat "$tsb/probation.pid" 2>/dev/null); tp_t=$(cat "$tsb/before.until" 2>/dev/null); t_probe_pid && return 0',
    `  tp_s=$(head -n 1 "$tsb/${PROBATION_STARTING_NAME}" 2>/dev/null); case "$tp_s" in ""|*[!0-9]*) return 1;; esac; tp_n=$(date +%s); tp_t=$((tp_s + ${PROBATION_STARTING_SECONDS}))`,
    `  [ "$tp_n" -le "$tp_t" ] && [ "$tp_n" -ge $((tp_s - ${PROBATION_STARTING_SECONDS})) ]; }`,
    't_probe_pid() { case "$tp_p" in ""|*[!0-9]*) return 1;; esac; [ "$tp_p" -gt 1 ] && kill -0 "$tp_p" 2>/dev/null || return 1',
    `  tp_u=$(cat "$tsb/before.until" 2>/dev/null); case "$tp_u" in ""|*[!0-9]*) [ -n "$(find "$tsb/probation.pid" -mmin -${Math.ceil((PROBATION_SECONDS + PROBATION_GRACE_SECONDS) / 60)} 2>/dev/null)" ] || return 1;; *) [ "$(date +%s)" -le $((tp_u + ${PROBATION_GRACE_SECONDS})) ] || return 1;; esac`,
    `  if [ -r "/proc/$tp_p/cmdline" ]; then tp_a=$(tr '\\000' ' ' < "/proc/$tp_p/cmdline" 2>/dev/null); else tp_a=$(ps -ww -o args= -p "$tp_p" 2>/dev/null); fi`,
    `  [ -z "$tp_a" ] && return 0; case "$tp_a" in *${PROBATION_SCRIPT_NAME}*) return 0;; esac; return 1; }`,
    't_busy() { t_probing && return 0; tp_k=$(cat "$tsb/before.until" 2>/dev/null); case "$tp_k" in ""|*[!0-9]*) return 1;; esac; tp_n=$(date +%s)',
    `  [ "$tp_k" -gt "$tp_n" ] && [ "$tp_k" -le $((tp_n + ${PROBATION_SECONDS})) ] && tp_t=$tp_k; }`,
  ]
}

/**
 * The probation's own script. `fns`: the tail's functions (daemon-update-tail.ts tailFunctionLines),
 * so a failure is put back exactly as the tail puts one back.
 */
export function probationScript(fns: string[], o: { waitSeconds: number; staySeconds: number }): string {
  return [
    '#!/bin/sh',
    '# Walnut daemon update probation (src/providers/daemon-update-probation.ts), started detached by an update tail.',
    // $1 the runtime dir; $2 how long; $3 how often; $4 the update's dir (the copies name it); $5 the
    // runners' latest marker; $6 the tail that started it (its hold of the install lock is no one else's).
    'tr=$1; tv_s=$2; tv_e=$3; tv_d=$4; L=${5:-"/tmp/open-walnut-update-latest-$(id -u)"}; tv_pp=${6:-}; d=$tv_d',
    ...fns,
    ...probationRecordLines(),
    `tsb="$tb/${SNAPSHOT_DIR}"; ts_b=$tsb`,
    't_ours() { [ -f "$tc" ] && [ "$(cat "$tsb/before.dir" 2>/dev/null)" = "$tv_d" ]; }',
    // The copies dropped, under the lock: a later snapshot writes there (2026-11-04 review 6).
    "t_drop() { trap 't_unlock' EXIT; t_lock; t_ours && rm -rf \"$tsb\"; t_unlock; trap - EXIT; }",
    't_ours || exit 0',
    // The build judged, read now: by the time a verdict is written the copies may be a later update's.
    'tv_b=$(cat "$tsb/before.build" 2>/dev/null)',
    // The config it watches, the one the tail judged (its start mark's second line): one changed by
    // anything else, during the detach included, is not this update's service any more. Read before
    // its pid says it is at work, so nothing written after that goes unseen.
    `tv_c=$(sed -n 2p "$tsb/${PROBATION_STARTING_NAME}" 2>/dev/null); [ -n "$tv_c" ] || tv_c=$(cksum < "$tc" 2>/dev/null)`,
    `echo $$ > "$tsb/probation.pid" && rm -f "$tsb/${PROBATION_STARTING_NAME}"`,
    'tl=0; tx=0; tn=0; ty=0; tt=; tw=; tg_on=; tsx0=; tp0=; tm=0; tvr=0; tvf=',
    // On the wall clock (a Mac that slept through it still looks once after the wake), to the end
    // the tail wrote down; a miss at the end gets its second look.
    'tv_0=$(date +%s); tv_u=$(cat "$tsb/before.until" 2>/dev/null); case "$tv_u" in ""|*[!0-9]*) tv_u=$((tv_0 + tv_s));; esac',
    't_up && tp0=$p',
    'while [ "$(date +%s)" -lt "$tv_u" ] || [ "$tm" -gt 0 ]; do',
    '  sleep "$tv_e"; i=$(( $(date +%s) - tv_0 ))',
    '  t_ours || exit 0',
    // A later runner at work (one of an older build: this one's refuse while a probation runs):
    // nothing judged meanwhile. What it changes ends the watch (its snapshot takes the copies, or the
    // config is another); one that changed nothing leaves it watching.
    '  t_later && continue',
    // The config from before is the service again (put back by something else): nothing of this
    // update is watched any more (2026-11-04 review 6: its daemon's restart was the update's failure).
    '  cmp -s "$tsb/before.cfg" "$tc" && { t_drop; exit 0; }',
    // A `walnut daemon` transaction (an install, a stop, an uninstall by the user): theirs to
    // decide. Once it let go, the copies are dropped.
    '  if t_held && [ "$tk_h" != "$tv_pp" ]; then t_drop; exit 0; fi',
    // Another config than the one it watched (written by something that held no lock): the same.
    '  [ "$(cksum < "$tc" 2>/dev/null)" = "$tv_c" ] || { t_drop; exit 0; }',
    '  if t_up; then',
    '    [ -n "$tp0" ] || tp0=$p',
    '    tm=0; [ "$p" = "$tp0" ] && continue',
    '    tp0=$p; tvr=$((tvr + 1)); [ "$tvr" -lt 2 ] && continue',
    '    tvf="the new daemon stopped and was started again $tvr times within $i s of its probation"; break',
    '  fi',
    '  tm=$((tm + 1)); [ "$tm" -lt 2 ] && continue',
    '  tvf="no daemon answered $i s into the new daemon\'s probation"; break',
    'done',
    'if [ -z "$tvf" ]; then t_drop; exit 0; fi',
    // The verdict first: a later update that takes over during the put-back leaves it standing.
    't_failed "$tvf"',
    "trap 't_unlock' EXIT; trap 't_unlock; exit 129' HUP INT TERM",
    't_lock',
    't_ours || exit 0',
    '[ "$tk" = launchd ] && tsx0=$(t_prog)',
    'tq=$tvf',
    // A later update (tx=1) takes over only once the config put back is loaded (t_serve's t_handed).
    'if t_back; then',
    `  if t_serve ${o.waitSeconds} && t_stay ${o.staySeconds}; then tt=restored; ts="$tq, so the previous service config was put back, and its daemon answers"`,
    // The config put back is loaded: the copies are done with, and the later update's snapshot
    // (which waits while they have time left) takes the service from here.
    '  elif [ "$tx" = 1 ]; then t_ours && rm -rf "$tsb"; exit 0',
    '  else tt=down; ts="$tq, and no daemon answered after the previous service config was put back"; fi',
    'elif [ "$tx" = 1 ]; then exit 0',
    // The config from before came back meanwhile: the update's build is not the service any more.
    'elif [ "$tw" = same ]; then t_ours && rm -rf "$tsb"; exit 0',
    'else tt=down; ts="$tq, and there was no earlier service config to put back"; fi',
    // launchd never ends here without a daemon either (the tail's stand-in).
    `if [ "$tt" = down ] && [ "$tk" = launchd ] && ! t_disabled && t_standin && t_upwait ${o.waitSeconds}; then tt=standin; ts="$ts, so the service's daemon runs outside launchd until launchd's job can start"; fi`,
    't_failed "$ts"',
    // Still this update's: a put-back past the lock's wait may have let a later snapshot write there.
    't_ours && rm -rf "$tsb"',
    '',
  ].join('\n')
}

/**
 * t_probation: the copies in "$tsb" are kept, dated to the probation's end, and its script is
 * written into the install root and started out of this shell's session. Needs $tb, $tr, $L, $d.
 */
export function probationStartLines(fns: string[], o: { probationSeconds: number; everySeconds: number; waitSeconds: number; staySeconds: number }): string[] {
  const script = probationScript(fns, o)
  if (script.split('\n').includes(EOF)) throw new Error('the probation script holds its own heredoc end')
  return [
    DETACH_LINE,
    `t_probation() { [ -d "$tsb" ] || return 1; pf="$tb/${PROBATION_SCRIPT_NAME}"`,
    `  echo $(( $(date +%s) + ${o.probationSeconds} )) > "$tsb/before.until" || return 1`,
    `  cat > "$pf.tmp.$$" <<'${EOF}'`,
    ...script.split('\n'),
    EOF,
    '  chmod 700 "$pf.tmp.$$" && mv -f "$pf.tmp.$$" "$pf" || { rm -f "$pf.tmp.$$"; return 1; }',
    // At work (t_probing) before the runner writes update.done, however long the detach takes: a
    // launch in between would find neither the runner nor the probation, and its snapshot would end the watch.
    `  { date +%s; cksum < "$tc" 2>/dev/null; } > "$tsb/${PROBATION_STARTING_NAME}" || :`,
    '  rm -f "$tsb/probation.pid"',
    `  t_detach "$pf" "$tr" ${o.probationSeconds} ${o.everySeconds} "\${tv_d:-$d}" "\${L:-}" $$`,
    // Its pid at once where the detached process is the probation itself (setsid and perl exec it in
    // place; under this lock, so no later snapshot is between): at work for t_probing however long
    // its start takes (2026-11-05 review 8: a 75 s detach outlived the mark). Never over the pid the
    // probation wrote itself (noclobber).
    '  [ -n "${td_p:-}" ] && (set -C; echo "$td_p" > "$tsb/probation.pid") 2>/dev/null; return 0; }',
  ]
}

/** What probingCheckScript prints while a probation is at work: `<word> until=<its end> now=<the host's clock>`, epoch s. */
export const PROBING_WORD = 'walnut-probation-at-work'

/**
 * A service update must not start while a probation runs or its copies have time left (it would
 * take them, the only way back from a build that fails late): prints PROBING_WORD with the end it
 * waits for (t_busy). Plain sh; `scope` names the service (the install root is the same).
 */
export function probingCheckScript(scope: 'user' | 'cron'): string {
  return [
    ...servicePreamble(scope),
    ...probationRecordLines(),
    `tsb="$tb/${SNAPSHOT_DIR}"`,
    `if t_busy; then echo "${PROBING_WORD} until=$tp_t now=$(date +%s)"; fi`,
    ':',
  ].join('\n')
}

/** How long the probation probingCheckScript found has left, in s on the host's clock (0: at its end or not known); null: none at work. */
export function parseProbing(said: string): number | null {
  const m = new RegExp(`^${PROBING_WORD} until=(\\d*) now=(\\d+)$`, 'm').exec(said)
  if (!m) return null
  const left = m[1] ? Number(m[1]) - Number(m[2]) : 0
  return Math.max(0, Math.min(left, PROBATION_SECONDS))
}
