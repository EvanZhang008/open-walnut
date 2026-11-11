/**
 * The last word of every daemon update Walnut runs on a host (over SSH, daemon-service-update.ts;
 * in the host network's detached runner, daemon-net-update-io.ts): whatever `walnut daemon
 * update` answered, a daemon serves when it is over. In plain sh, so neither build's CLI is
 * needed: the new one may be the thing that does not start, the old one may predate this.
 *
 *   before   the service config and the ownership record (daemon-service-files.ts) are
 *            copied into the update's own dir, before the first try, with whether the
 *            service ran then (a service the user stopped is left stopped), and again into
 *            the install root (update-before/), which a reboot does not clear.
 *   after    wait up to 90 s for a daemon (its pid alive, its port file there), loading the
 *            job (launchd), starting the unit (systemd) or the supervisor (cron) whenever
 *            it is not, and kickstarting a launchd job that is loaded and idle; none: put
 *            both copies back (together, so the next `walnut daemon` still knows the
 *            config as its own), reload the service, and wait again. A later update at work
 *            on the host (the runner's latest marker, $L, naming a live runner) ends the
 *            check: its own tail decides, and nothing of this one is put back over it.
 *   launchd  still no daemon (launchd starts no jobs, or will not load or start ours): the
 *            service's own program runs outside launchd until launchd's job can take over
 *            (daemon-update-standin.ts).
 *   probation  a daemon that served and stayed, when the update changed the service config, is
 *            watched for 15 minutes more by a script of its own (daemon-update-probation.ts);
 *            one that dies or restarts then is put back the same way, from the install root's
 *            copies.
 *   lock     the snapshot and the tail hold the service install lock (daemon-update-shell.ts).
 *   record   `update.tail`: `outcome=<word>` and one sentence, read by the server once
 *            the link is back (daemon-net-update.ts).
 *
 * 2026-11-04: a host network Mac's update stopped its old daemon, the new job never got
 * loaded, and the runner only wrote update.done; nothing on the host checked that a daemon
 * ran afterwards, and the server could only poll files over the link that had just died.
 * Nothing here runs when the service config is not on disk: there is no service to keep.
 */
import { DAEMON_BOOT_PID_NAME, DAEMON_BOOT_STOP_NAME } from './daemon-service-boot-script.js'
import { DAEMON_SERVICE_LABEL, DAEMON_SERVICE_UNIT_NAME } from './daemon-service-config.js'
import { JOB_GONE_BY_MS, launchdSpawnProbeLines } from './daemon-service-launchd.js'
import { disabledLines, LAUNCHD_DISABLED_WORDS, laterLines, loadedLines, lockLines, servicePreamble, UP_LINE } from './daemon-update-shell.js'
import { plistWordLines, standInStartLines, UNXML_SED } from './daemon-update-standin.js'
import { PROBATION_EVERY_SECONDS, PROBATION_SECONDS, probationRecordLines, probationStartLines, SNAPSHOT_DIR } from './daemon-update-probation.js'
import { RUNTIME_KEEP_MS } from './daemon-core.js'

export type UpdateTailOutcome = 'serving' | 'loaded' | 'restored' | 'standin' | 'down' | 'no-service' | 'stopped' | 'superseded'
export interface UpdateTail { outcome: UpdateTailOutcome; words: string }

export interface UpdateTailOptions {
  scope: 'user' | 'cron'
  /** How long a daemon has to answer, after the update and again after the put-back. */
  waitSeconds?: number
  /** How long the daemon that answered after the update must stay (the same pid) before it counts; 0: one answer counts (a revive). */
  staySeconds?: number
  /** How long a put-back waits for the job it booted out, and its process, to be gone (launchd: its ExitTimeOut). */
  goneSeconds?: number
  /** How often a stand-in asks whether launchd starts jobs again (daemon-update-standin.ts). */
  standInCheckSeconds?: number
  /** How long the snapshot and the tail wait for the service install lock (daemon-update-shell.ts). */
  lockWaitSeconds?: number
  /** How long each spawn probe of the tail waits for launchd to run its job; two in a row must see none. */
  probeSeconds?: number
  /** How long the new daemon is watched after a serving verdict (daemon-update-probation.ts); 0: not at all. */
  probationSeconds?: number
  /** How often the probation looks. */
  probationEverySeconds?: number
}

export const TAIL_WAIT_SECONDS = 90
/**
 * The daemon that answered after the update must keep its pid this long (t_stay). 2026-11-04
 * review: the first answer counted, so a build that listened and exited (launchd or systemd
 * restarting it in a loop) was left as the service. The CLI's own check waited 30 s before it
 * answered (daemon-service-cli.ts daemonStays); this one sees what came after, and the
 * probation (daemon-update-probation.ts) the 15 minutes after that.
 */
export const TAIL_STAY_SECONDS = 15
/**
 * A booted-out job may take launchd's ExitTimeOut to go (its daemon finishes what is in flight
 * first). 2026-11-04 review 5: the put-back waited 25 s, then took the daemon it had just booted
 * out for the restored one, and no job was loaded once that one exited.
 */
const GONE_SECONDS = Math.ceil(JOB_GONE_BY_MS / 1000)
/** One spawn probe's wait (launchctl under load answers far slower than an idle Mac). */
const PROBE_SECONDS = 15
export const TAIL_FILE = 'update.tail'
/** A snapshot this old in the install root is no update's way back any more (a revive drops it). */
export const SNAPSHOT_MAX_SECONDS = 7 * 24 * 60 * 60

const LOCK_TRAP = "trap 't_unlock' EXIT; trap 't_unlock; exit 129' HUP INT TERM"
const LOCK_UNTRAP = 'trap - EXIT HUP INT TERM'

/**
 * Copies the config and its ownership record into "$d" (whole or not at all), and whether the
 * service ran, before the update's first try; with which update and build ($tvb) they are, and a
 * copy of them all in the install root, where a reboot or a power loss leaves it (2026-11-04
 * review 5: they lived in /tmp only, so a power loss mid-update left the new config with no way
 * back, and the revive could only load it again). None at all (tv_busy set) while the last
 * update's probation is at work or its copies have time left (t_busy, looked at under the lock).
 */
export function updateSnapshotLines(o: UpdateTailOptions): string[] {
  return [
    ...servicePreamble(o.scope),
    ...loadedLines(),
    ...laterLines(),
    ...lockLines(o.lockWaitSeconds),
    ...probationRecordLines(),
    // Nothing when the last update's probation is at work, or its copies have time left (tv_busy,
    // set by the caller's own look too): they are the only way back from a build that fails late.
    'if [ -z "${tv_busy:-}" ]; then',
    // Under the lock: never the middle of another `walnut daemon` transaction; let go of on any exit.
    LOCK_TRAP,
    't_lock',
    // Every probation starts under this lock (t_probation), so this look is exact (2026-11-05 review
    // 8: the runner's own look, before the lock, could miss one starting).
    `tsb="$tb/${SNAPSHOT_DIR}"; t_busy && tv_busy=1`,
    'if [ -z "$tv_busy" ]; then',
    // A partial copy (a full /tmp) must never be put back: copy aside, then rename.
    '[ -f "$tc" ] && { cp -p "$tc" "$d/before.cfg.tmp" 2>/dev/null && mv -f "$d/before.cfg.tmp" "$d/before.cfg" || rm -f "$d/before.cfg.tmp"; }',
    '[ -f "$to" ] && { cp -p "$to" "$d/before.owners.tmp" 2>/dev/null && mv -f "$d/before.owners.tmp" "$d/before.owners" || rm -f "$d/before.owners.tmp"; }',
    'if [ -f "$tc" ]; then if t_loaded; then echo running; else echo stopped; fi > "$d/before.state"; fi',
    `[ -f "$tc" ] && { printf '%s\\n' "$d" > "$d/before.dir"; date +%s > "$d/before.at"; printf '%s\\n' "\${tvb:-}" > "$d/before.build"; }`,
    `if [ -d "$tb" ] && [ -s "$d/before.cfg" ]; then rm -rf "$tsb.tmp"`,
    '  if (umask 077; mkdir "$tsb.tmp") 2>/dev/null && cp -p "$d"/before.* "$tsb.tmp/" 2>/dev/null; then rm -rf "$tsb"; mv "$tsb.tmp" "$tsb" 2>/dev/null || rm -rf "$tsb.tmp"; else rm -rf "$tsb.tmp"; fi',
    'fi',
    'fi',
    't_unlock',
    LOCK_UNTRAP,
    'fi',
  ]
}

/** Undoes daemon-service-config.ts systemdQuoted's escaping of an Environment= value (`%%`, `\\`, `\"`), as readServiceEnv does. */
const SYSTEMD_UNQUOTE_SED = String.raw`sed -e 's/%%/%/g' -e 's/\\\([\\"]\)/\1/g'`
/** Undoes the boot script's sh single quoting (`'\''`, daemon-service-boot-script.ts shq). */
const CRON_UNQUOTE_SED = String.raw`sed -e "s/'\\\\''/'/g"`

/**
 * t_dir: the daemon dir the config pins (the plist's string after the key, the unit's Environment=,
 * the script's export), with the config's own escaping undone the way readDaemonServiceDir does.
 * 2026-11-05 review 6: it was read as written, so a dir under a HOME holding ' & " (launchd), '
 * (cron) or " \ % (systemd) named no dir, and a daemon that served was taken for none: put back.
 */
export function dirLines(): string[] {
  return [
    't_dir() { case $tk in',
    `  launchd) sed -n '/<key>WALNUT_DAEMON_DIR<\\/key>/{n;s/^[[:space:]]*<string>\\(.*\\)<\\/string>[[:space:]]*$/\\1/p;}' "$tc" | ${UNXML_SED};;`,
    `  systemd) sed -n 's/^Environment="WALNUT_DAEMON_DIR=\\(.*\\)"$/\\1/p' "$tc" | ${SYSTEMD_UNQUOTE_SED};;`,
    `  cron) sed -n "s/^export WALNUT_DAEMON_DIR='\\(.*\\)'\\$/\\1/p" "$tc" | ${CRON_UNQUOTE_SED};;`,
    'esac; }',
  ]
}

/**
 * The tail's functions, without its flow (the probation runs the same ones): the service, the
 * waits, the loads, the spawn checks, the put-back. Sets nothing until called.
 */
export function tailFunctionLines(o: UpdateTailOptions): string[] {
  const gone = o.goneSeconds ?? GONE_SECONDS
  const probe = o.probeSeconds ?? PROBE_SECONDS
  const job = `"gui/$tu/${DAEMON_SERVICE_LABEL}"`
  const unit = DAEMON_SERVICE_UNIT_NAME
  return [
    ...servicePreamble(o.scope),
    // The daemon dir the config pins: the plist's string after the key, the unit's Environment=, the script's export.
    ...dirLines(),
    UP_LINE,
    ...loadedLines(),
    ...laterLines(),
    ...lockLines(o.lockWaitSeconds),
    ...disabledLines(),
    ...launchdSpawnProbeLines(DAEMON_SERVICE_LABEL),
    ...plistWordLines(),
    ...standInStartLines(o.standInCheckSeconds ?? 30),
    't_start() { case $tk in',
    `  launchd) launchctl bootstrap "gui/$tu" "$tc" >/dev/null 2>&1;;`,
    `  systemd) systemctl --user daemon-reload >/dev/null 2>&1; systemctl --user reset-failed ${unit} >/dev/null 2>&1; systemctl --user start ${unit} >/dev/null 2>&1;;`,
    // cron's own environment, as the manager starts it: the script exports what the daemon needs,
    // and the runner's (the daemon's) WALNUT_BOOT_* counters must not reach the new supervisor.
    `  cron) [ -e "$tb/${DAEMON_BOOT_STOP_NAME}" ] && return 1; ts0=; command -v setsid >/dev/null 2>&1 && ts0=setsid`,
    '    $ts0 env -i HOME="$HOME" PATH=/usr/bin:/bin LANG="${LANG:-C}" /bin/sh "$tc" </dev/null >/dev/null 2>&1 &;;',
    'esac; }',
    `t_idle() { ! launchctl print ${job} 2>/dev/null | grep -q 'state = running'; }`,
    // launchd started our job at least once since it was loaded (runs = N): it starts jobs, and a job
    // that is idle again is a daemon that exited (the build's failure), never a dark wake.
    `t_ran() { launchctl print ${job} 2>/dev/null | grep -Eq '^[[:space:]]*runs[[:space:]]*=[[:space:]]*[1-9]'; }`,
    // launchd starts no jobs: only when it never ran ours and two probes in a row saw their own job
    // not run within ${probe} s each. 2026-11-04 review 5: one 5 s probe that a busy launchd did not
    // answer in time cancelled the put-back, and a stand-in ran the broken new build.
    `t_nospawn() { t_ran && return 1; ts_w=${probe * 10}; t_spawns; [ "$ts_sp" = none ] || return 1; t_ran && return 1; t_spawns; [ "$ts_sp" = none ] || return 1; ! t_ran; }`,
    // After a put-back (tg_on) a daemon counts only when it is none of the processes that served
    // before it, and (launchd) its job is loaded: the one booted out may still be finishing.
    't_fresh() { [ -n "${tg_on:-}" ] || return 0; for x in ${tg_x:-} ${tg_j:-}; do [ "$p" = "$x" ] && return 1; done; [ "$tk" != launchd ] || t_loaded; }',
    // Wait $1 s for a daemon; every 5 s a service that is not running is started (tl=1: it had
    // to be), and a launchd job loaded with nothing running (KeepAlive restarts only a failed
    // exit) is kickstarted. One still idle 5 s after that, or at the end, while launchd starts no
    // jobs at all (t_nospawn): tn=1.
    // After a put-back (tg_on), a later update takes over only once the config put back is loaded
    // (tg_ld: started from it, or reloaded). 2026-11-04 review 6: one launched inside the bootout
    // wait stood the put-back down with no job loaded, its snapshot read the service as stopped,
    // and the host was left with no daemon.
    't_handed() { [ -z "${tg_on:-}" ] && return 0; [ -n "${tg_ld:-}" ] && t_loaded; }',
    't_serve() { i=0; while :; do t_up && t_fresh && return 0; t_later && t_handed && { tx=1; return 1; }; [ "$i" -ge "$1" ] && break',
    '  if [ $((i % 5)) -eq 0 ]; then if ! t_loaded; then tl=1; t_start && [ -n "${tg_on:-}" ] && tg_ld=1',
    '    elif [ "$tk" = launchd ] && [ "$i" -ge 10 ] && t_idle; then tl=1',
    '      if [ "$i" -ge 15 ]; then t_nospawn && { tn=1; return 1; }; fi',
    `      launchctl kickstart ${job} >/dev/null 2>&1; fi; fi`,
    '  sleep 1; i=$((i + 1)); done',
    '  if [ "$tk" = launchd ] && t_loaded && t_idle && t_nospawn; then tn=1; fi; return 1; }',
    't_upwait() { i=0; while ! t_up; do [ "$i" -ge "$1" ] && return 1; sleep 1; i=$((i + 1)); done; }',
    // The daemon t_up found keeps its pid $1 s (ty=1: it did not), or a later update took over (tx=1).
    't_stay() { ty_p=$p; i=0; while [ "$i" -lt "$1" ]; do sleep 1; i=$((i + 1)); t_later && { tx=1; return 1; }',
    '  if ! t_up || [ "$p" != "$ty_p" ]; then ty=1; return 1; fi; done; return 0; }',
    // The parent of pid $1 is $2 (ps, else /proc's stat, whose second field after the name is the parent).
    't_childof() { tc_w=$2; case "$tc_w" in ""|*[!0-9]*) return 1;; esac; tc_pp=$(ps -o ppid= -p "$1" 2>/dev/null | tr -d \' \')',
    '  if [ -z "$tc_pp" ] && [ -r "/proc/$1/stat" ]; then tc_s=$(cat "/proc/$1/stat" 2>/dev/null); tc_s=${tc_s##*) }; set -- $tc_s; tc_pp=${2:-}; fi',
    '  [ -n "$tc_pp" ] && [ "$tc_pp" = "$tc_w" ]; }',
    // The job booted out is gone from launchd, and so is every process that served before the put-back.
    `t_jobgone() { launchctl print ${job} >/dev/null 2>&1 && return 1; for x in \${tg_x:-} \${tg_j:-}; do kill -0 "$x" 2>/dev/null && return 1; done; return 0; }`,
    // Put the copies in "$ts_b" back when the config is not the one from before, then reload what
    // reads it. tw says why nothing was put back: none (no config before), nocopy (one, and the
    // snapshot could not copy it), same (the config is the one from before), copy (putting it back
    // failed). tg_x / tg_j: the daemon that served, and its job's process, which never count as
    // the one put back (t_fresh).
    't_back() { if t_later; then tx=1; return 1; fi',
    '  [ -s "$ts_b/before.cfg" ] || { if [ -s "$ts_b/before.state" ]; then tw=nocopy; else tw=none; fi; return 1; }',
    '  cmp -s "$ts_b/before.cfg" "$tc" && { tw=same; return 1; }',
    '  tg_x=; tg_j=; t_up && tg_x=$p',
    '  tf="$(dirname "$tc")/.walnut-tail.$$"; cp -p "$ts_b/before.cfg" "$tf" && mv -f "$tf" "$tc" || { rm -f "$tf"; tw=copy; return 1; }',
    '  if [ -s "$ts_b/before.owners" ]; then tf="$tb/.walnut-tail.$$"; cp -p "$ts_b/before.owners" "$tf" && mv -f "$tf" "$to"; fi',
    '  tg_on=1; tg_ld=',
    '  case $tk in',
    `    launchd) tg_j=$(launchctl print ${job} 2>/dev/null | sed -n 's/^[[:space:]]*pid[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)`,
    `      launchctl bootout ${job} >/dev/null 2>&1; i=0; while [ "$i" -lt ${gone} ] && ! t_jobgone; do sleep 1; i=$((i + 1)); done;;`,
    `    systemd) systemctl --user daemon-reload >/dev/null 2>&1; systemctl --user reset-failed ${unit} >/dev/null 2>&1; systemctl --user restart ${unit} >/dev/null 2>&1; tg_ld=1;;`,
    // cron: the supervisor reads its script again at each restart of the daemon, so the daemon it
    // runs now (its own child, never a pid that merely reads so; one that serves, or one that never
    // got to answer) is asked to exit (2026-11-04 review 5: nothing reloaded, and the daemon the
    // update left kept running from the new script).
    `    cron) tg_s=$(cat "$tb/${DAEMON_BOOT_PID_NAME}" 2>/dev/null); tg_c=\${tg_x:-$(cat "$tr/daemon.pid" 2>/dev/null)}`,
    `      if [ -n "$tg_c" ] && t_childof "$tg_c" "$tg_s"; then tg_x=$tg_c; kill -TERM "$tg_c" 2>/dev/null; i=0; while [ "$i" -lt ${gone} ] && kill -0 "$tg_c" 2>/dev/null; do sleep 1; i=$((i + 1)); done; fi; tg_ld=1;;`,
    '  esac; return 0; }',
    ...probationRecordLines(),
  ]
}

/** After the update: the check, the loads, the put-back, the stand-in, the probation; sets tt (the outcome) and writes "$d/update.tail". */
export function updateTailLines(o: UpdateTailOptions): string[] {
  const wait = o.waitSeconds ?? TAIL_WAIT_SECONDS
  const stay = o.staySeconds ?? TAIL_STAY_SECONDS
  const probation = o.probationSeconds ?? PROBATION_SECONDS
  const fns = tailFunctionLines(o)
  const darkWake = "launchd starts no jobs in this login session now (a dark wake, or a login not finished), so the service's daemon runs outside launchd until it does, and launchd's job takes over then"
  const darkWakeBack = "launchd starts no jobs in this login session now (a dark wake, or a login not finished), so the new daemon never ran: the previous service config was put back, and its daemon runs outside launchd until launchd starts jobs, and launchd's job takes over then"
  const superseded = 'tt=superseded; ts="a later update on the host took over during the check, and its own check decides"'
  return [
    ...fns,
    // Its put-back is judged as the tail's own (a revive's stay of 0 is the tail's 15 s there too).
    ...probationStartLines(fns, { probationSeconds: probation, everySeconds: o.probationEverySeconds ?? PROBATION_EVERY_SECONDS, waitSeconds: wait, staySeconds: o.staySeconds || TAIL_STAY_SECONDS }),
    // tv_stay: the stay asked for (a revive with an update's copies to judge asks for one too).
    `tl=0; tx=0; tn=0; ty=0; ty1=0; tt=; tw=; tw_b=; tsx0=; tg_on=; tg_ld=; tv_stay=\${tv_stay:-${stay}}; tq="no daemon answered within ${wait} s"`,
    // The copies: this update's dir, or the install root's a revive found ($ts_b set before this).
    ': "${ts_b:=$d}"',
    'if [ ! -f "$tc" ]; then tt=no-service; ts="no service config is installed there, so there was no service to keep running"',
    'elif [ "$(cat "$ts_b/before.state" 2>/dev/null)" = stopped ]; then tt=stopped; ts="the service was not running before the update, so it was left as it was"',
    'else',
    `  ${LOCK_TRAP}`,
    '  t_lock',
    '  tr=$(t_dir | head -n 1); [ -n "$tr" ] || tr=/tmp/open-walnut',
    '  [ "$tk" = launchd ] && tsx0=$(t_prog)',
    // tv_sp: the daemon judged serving, the one the probation counts restarts from.
    `  tv_sp=; if t_serve ${wait} && t_stay "$tv_stay"; then tok=1; tv_sp=$p; else tok=0; fi`,
    '  [ "$ty" = 1 ] && tq="the new daemon answered and then did not stay serving for $tv_stay s"',
    '  if [ "$tok" = 1 ]; then',
    '    if [ "$tl" = 1 ]; then tt=loaded; ts="the service was not running after the update, so it was started again, and a daemon answers"',
    '    else tt=serving; ts="a daemon answers"; fi',
    `  elif [ "$tx" = 1 ]; then ${superseded}`,
    // launchd starts no jobs, so the new build never ran: the config from before goes back when its
    // program is there, loaded for when launchd starts jobs, and the stand-in below runs the build
    // that served before (2026-11-04 review 5: it ran the new one, which may be the broken one).
    '  elif [ "$tn" = 1 ]; then',
    '    tw_p=$(tc="$ts_b/before.cfg"; [ -s "$tc" ] && t_prog 2>/dev/null)',
    '    if [ -n "$tw_p" ] && [ -x "$tw_p" ] && t_back; then tw_b=1; tsx0=$tw_p; t_loaded || t_start; fi',
    '  elif t_back; then',
    '    ty1=$ty; ty=0',
    '    if t_serve ' + String(wait) + ' && t_stay "$tv_stay"; then tt=restored; ts="$tq, so the previous service config was put back, and its daemon answers"',
    `    elif [ "$tx" = 1 ]; then ${superseded}`,
    '    elif [ "$tn" != 1 ]; then tt=down',
    '      if [ "$ty" = 1 ]; then ts="$tq, and the daemon from before the update answered after its config was put back, then did not stay serving for $tv_stay s either"',
    '      elif [ "$ty1" = 1 ]; then ts="$tq, and no daemon answered after the previous service config was put back"',
    '      else ts="$tq, nor after the previous service config was put back"; fi',
    '    fi',
    `  elif [ "$tx" = 1 ]; then ${superseded}`,
    '  else tt=down',
    '    case "$tw" in',
    `      same) ts="$tq, and the service config was already the one from before the update, so there was nothing to put back";;`,
    `      copy) ts="$tq, and the previous service config could not be put back";;`,
    `      nocopy) ts="$tq, and the service config from before the update could not be copied before it, so there was nothing to put back";;`,
    `      *) ts="$tq, and there was no earlier service config to go back to";;`,
    '    esac',
    '  fi',
    // launchd never ends here without a daemon: starting no jobs (tn=1), or a job it will not load or start (down).
    '  if [ "$tk" = launchd ] && { { [ "$tn" = 1 ] && [ -z "$tt" ]; } || [ "$tt" = down ]; }; then',
    '    tw0=$tt; tsw=$ts',
    '    if [ -z "$tw0" ]; then tt=down; ts="launchd starts no jobs in this login session now, and its job was left loaded for when it does"',
    '      [ -n "$tw_b" ] && ts="launchd starts no jobs in this login session now, so the new daemon never ran: the previous service config was put back, and its job was left loaded for when launchd starts jobs"; fi',
    // The user turned the job off: no daemon outside launchd either, and the record says why.
    `    if t_disabled; then ts="$ts; ${LAUNCHD_DISABLED_WORDS}"`,
    '    elif t_standin; then',
    `      if t_upwait ${wait}; then tt=standin`,
    `        if [ -n "$tw0" ]; then ts="$tsw, so the service's daemon runs outside launchd until launchd's job can start, and that job takes over then"; elif [ -n "$tw_b" ]; then ts="${darkWakeBack}"; else ts="${darkWake}"; fi`,
    `      elif [ -z "$tw0" ]; then ts="launchd starts no jobs in this login session now, and the daemon started outside it did not answer within ${wait} s"`,
    `      else ts="$tsw, and the daemon started outside launchd did not answer within ${wait} s either"; fi`,
    '    fi',
    '  fi',
    // The copies in the install root: kept for the probation once a daemon serves the update's
    // config, else done with (2026-11-04 review 6: one that installed nothing, the old build still
    // serving, had the old build watched for the new one, and wrote the new one down for its
    // death). A put-back writes the build down as failed, for the next runner of it (a revive's too).
    `  tsb="$tb/${SNAPSHOT_DIR}"`,
    '  if [ -d "$tsb" ] && [ "$(cat "$tsb/before.dir" 2>/dev/null)" = "${tv_d:-$d}" ]; then',
    '    [ "$tt" = restored ] && t_failed "$ts"',
    `    if { [ "$tt" = serving ] || [ "$tt" = loaded ]; } && [ ${probation} -gt 0 ] && ! cmp -s "$tsb/before.cfg" "$tc" && t_probation; then :; else rm -rf "$tsb"; fi`,
    '  fi',
    '  t_unlock',
    `  ${LOCK_UNTRAP}`,
    'fi',
    // No service (it was removed), or one the user had stopped: the copies are done with too (under
    // the lock, as everything that writes there holds it).
    `if { [ "$tt" = no-service ] || [ "$tt" = stopped ]; } && [ -d "$tb/${SNAPSHOT_DIR}" ]; then ${LOCK_TRAP}; t_lock`,
    `  [ "$(cat "$tb/${SNAPSHOT_DIR}/before.dir" 2>/dev/null)" = "\${tv_d:-$d}" ] && rm -rf "$tb/${SNAPSHOT_DIR}"; t_unlock; ${LOCK_UNTRAP}; fi`,
    `printf 'outcome=%s\\n%s\\n' "$tt" "$ts" > "$d/${TAIL_FILE}.tmp" && mv -f "$d/${TAIL_FILE}.tmp" "$d/${TAIL_FILE}"`,
  ]
}

const dirLine = (directory: string): string => {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(directory)) throw new Error('the update record dir must be a plain absolute path')
  return `d='${directory}'`
}

/** The snapshot as one command (the SSH path, where the update runs in the foreground). */
export function updateSnapshotScript(directory: string, o: UpdateTailOptions): string {
  return [dirLine(directory), ...updateSnapshotLines(o)].join('\n')
}

/** What a revive printed when an update's runner was at work: it did nothing, that runner's tail decides. */
export const REVIVE_UPDATING = 'walnut-revive=updating'
const NO_ROOT = 'the service config is there, but not the service install dir, so Walnut left it alone'

/**
 * The revive (this machine's LocalDaemon, an SSH host's connect): a service whose config is
 * on disk while no daemon answers is loaded or started the tail's way, under the install
 * lock. Never while an update's runner or a probation is at work (it prints REVIVE_UPDATING),
 * never with no install root (that dir is the installer's to make). It prints the record.
 * `latest`: the runner's marker (tests point it elsewhere).
 *
 * An update's copies left in the install root (a power loss or a reboot cut it short, or ended
 * its probation's watch before its end) are its way back: the config on disk must stay serving,
 * else they are put back, and the build is written down as failed (2026-11-04 review 5: the
 * revive could only load the config again, a build that crash-looped on real data included).
 * With none, or once the probation's end passed, the daemon counts on its first answer.
 */
export function reviveScript(o: UpdateTailOptions & { latest?: string }): string {
  if (o.latest && !/^\/[A-Za-z0-9._/-]+$/.test(o.latest)) throw new Error('the latest marker must be a plain absolute path')
  return [
    `L=${o.latest ? `'${o.latest}'` : '"/tmp/open-walnut-update-latest-$(id -u)"'}`,
    `d=$(umask 077; mktemp -d /tmp/open-walnut-update.XXXXXXXXXX 2>/dev/null) || { printf 'outcome=down\\nno dir for the check could be made in /tmp\\n'; exit 0; }`,
    ...servicePreamble(o.scope),
    ...laterLines(),
    `if t_later; then rm -rf "$d"; echo ${REVIVE_UPDATING}; exit 0; fi`,
    `if [ -f "$tc" ] && [ ! -d "$tb" ]; then rm -rf "$d"; printf 'outcome=down\\n%s\\n' '${NO_ROOT}'; exit 0; fi`,
    // Turned off by the user: not loaded, not started, not stood in for (outcome stopped: left as it was).
    ...disabledLines(),
    `if [ -f "$tc" ] && t_disabled; then rm -rf "$d"; printf 'outcome=stopped\\n%s\\n' '${LAUNCHD_DISABLED_WORDS}'; exit 0; fi`,
    ...probationRecordLines(),
    ...lockLines(o.lockWaitSeconds),
    ...dirLines(),
    `tsb="$tb/${SNAPSHOT_DIR}"`,
    `if t_probing; then rm -rf "$d"; echo ${REVIVE_UPDATING}; exit 0; fi`,
    'tv_d=; tv_stay=0',
    // Copies of a service that ran before its update (one the user had stopped is no way back to a
    // daemon), while its probation has time left; ones with no probation yet (a power loss in the
    // middle of the update) for SNAPSHOT_MAX_SECONDS. 2026-11-04 review 6: a probation a reboot
    // cut short left them for 7 days, and a slow start days later put back a config from then.
    // Others are dropped under the lock, as everything that writes there (a later snapshot) holds it.
    // With no probation yet, a daemon that kept the runtime dir's pid file fresh (a daemon touches it
    // hourly, RUNTIME_KEEP_MS) past the update and a probation's length served through them
    // (review 7: a good build that served for days then had a slow start, and the copies went back).
    `if [ -s "$tsb/before.cfg" ]; then tv_a=$(cat "$tsb/before.at" 2>/dev/null); case "$tv_a" in ""|*[!0-9]*) tv_a=0;; esac`,
    '  tv_u=$(cat "$tsb/before.until" 2>/dev/null); case "$tv_u" in ""|*[!0-9]*) tv_u=;; esac',
    '  tv_r=$(t_dir | head -n 1); tv_m=$(t_mtime "${tv_r:-/tmp/open-walnut}/daemon.pid"); case "$tv_m" in ""|*[!0-9]*) tv_m=0;; esac',
    `  [ -z "$tv_u" ] && [ "$tv_m" -gt $((tv_a + ${PROBATION_SECONDS + RUNTIME_KEEP_MS / 1000})) ] && tv_u=0`,
    `  if [ $(( $(date +%s) - tv_a )) -lt ${SNAPSHOT_MAX_SECONDS} ] && [ "$(cat "$tsb/before.state" 2>/dev/null)" = running ] && { [ -z "$tv_u" ] || [ "$(date +%s)" -lt "$tv_u" ]; }; then tv_d=$(cat "$tsb/before.dir" 2>/dev/null); ts_b=$tsb; tv_stay=${o.staySeconds ?? TAIL_STAY_SECONDS}`,
    `  else tv_o=$(cat "$tsb/before.dir" 2>/dev/null); ${LOCK_TRAP}; t_lock; [ "$(cat "$tsb/before.dir" 2>/dev/null)" = "$tv_o" ] && rm -rf "$tsb"; t_unlock; ${LOCK_UNTRAP}; fi`,
    'fi',
    ...updateTailLines({ ...o, staySeconds: 0 }),
    `cat "$d/${TAIL_FILE}"; rm -rf "$d"`,
  ].join('\n')
}

/** The tail as one command; it prints the record it wrote. */
export function updateTailScript(directory: string, o: UpdateTailOptions): string {
  return [dirLine(directory), ...updateTailLines(o), `cat "$d/${TAIL_FILE}"`].join('\n')
}

const OUTCOMES: ReadonlySet<string> = new Set(['serving', 'loaded', 'restored', 'standin', 'down', 'no-service', 'stopped', 'superseded'])

/** The record `update.tail` holds (or what the tail printed), or null when there is none. */
export function parseUpdateTail(text: string | null | undefined): UpdateTail | null {
  if (!text) return null
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /^outcome=/.test(line.trim()))
  if (at < 0) return null
  const outcome = lines[at].trim().slice('outcome='.length)
  if (!OUTCOMES.has(outcome)) return null
  return { outcome: outcome as UpdateTailOutcome, words: (lines[at + 1] ?? '').trim() }
}

/** The tail had to step in, or could not: the daemon the update meant to leave was not running. */
export function tailSteppedIn(tail: UpdateTail | null): boolean {
  return !!tail && (tail.outcome === 'loaded' || tail.outcome === 'restored' || tail.outcome === 'standin' || tail.outcome === 'down')
}
