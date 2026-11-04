/**
 * The stand-in of a LaunchAgent whose job launchd will not start (daemon-update-tail.ts): the
 * service's own program and env (the plist's ProgramArguments and EnvironmentVariables, as
 * renderDaemonLaunchAgent writes them) run outside launchd, so the Mac is never left without
 * a daemon. 2026-11-04: in a dark wake launchd loaded the new job and the restored one and ran
 * neither, and the Mac had no daemon until a reboot and a login 1 h 45 min later.
 *
 * A script of its own in the install root, started out of the caller's session (t_detach): the
 * runner, a server's revive or an SSH session may all be gone long before launchd starts jobs.
 * Every N s it asks whether launchd starts jobs; once it does, it hands back through
 * `walnut daemon handback` (daemon-service-handback.ts): the stand-in is asked to hand over
 * like any service daemon before an update (refused while ACP turns, host_exec runs or relays
 * are open, and asked again later), then launchd's job starts and adopts the sessions. Never a
 * signal: 2026-11-04 review, a SIGTERM cut the very work the normal update path waits for. A
 * stand-in that exits on its own is started again unless another daemon serves or an update's
 * runner is at work (that update stopped it, and its own tail decides); one loop per runtime
 * dir; the loop ends when the service config is gone.
 */
import { launchdSpawnProbeLines } from './daemon-service-launchd.js'
import { DAEMON_SERVICE_LABEL } from './daemon-service-config.js'
import { DETACH_LINE, disabledLines, laterLines, lockLines, servicePreamble, UP_LINE } from './daemon-update-shell.js'

export const STANDIN_SCRIPT_NAME = 'daemon-standin.sh'
export const STANDIN_PID_NAME = 'daemon.standin'
const EOF = 'WALNUT_STANDIN_EOF'

/** A sed that undoes the plist's XML escaping (daemon-service-config.ts xmlText), &amp; last. */
export const UNXML_SED = `sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\\&/g'`

/** t_words (one "=word" per line of a plist key's value, unescaped) and t_prog (the program). Needs $tc. */
export function plistWordLines(): string[] {
  // The sed of one plist value line: "=word" (never empty), so an empty value keeps its place.
  const value = (tag: string) => `-e 's/^[[:space:]]*<${tag}>\\(.*\\)<\\/${tag}>[[:space:]]*$/=\\1/p'`
  const unxml = UNXML_SED
  return [
    // $1 the plist key, $2 the element that ends its value.
    `t_words() { sed -n "/<key>$1<\\/key>/,/<\\/$2>/p" "$tc" | sed 1d | sed -n ${value('string')} ${value('key')} | ${unxml}; }`,
    't_prog() { t_words ProgramArguments array | sed -n "1s/^=//p"; }',
  ]
}

/** The stand-in's own script (static: everything it needs comes from the plist and its arguments). */
export function standInScript(everySeconds: number): string {
  return [
    '#!/bin/sh',
    '# Walnut stand-in daemon loop (src/providers/daemon-update-standin.ts), started detached by an update tail.',
    // $1 the runtime dir; $2 the program the config named when the tail began (a second CLI for the handback).
    // $3 the runners' latest marker the tail used (tests point it elsewhere).
    'tr=$1; tsx0=${2:-}; L=${3:-"/tmp/open-walnut-update-latest-$(id -u)"}; d=',
    ...servicePreamble('user'),
    '[ "$tk" = launchd ] && [ -f "$tc" ] && [ -d "$tr" ] || exit 0',
    UP_LINE,
    ...laterLines(),
    ...lockLines(),
    ...plistWordLines(),
    ...launchdSpawnProbeLines(DAEMON_SERVICE_LABEL),
    ...disabledLines(),
    't_sgone() { [ -n "${sp:-}" ] && kill -0 "$sp" 2>/dev/null || return 0; case "$(ps -o stat= -p "$sp" 2>/dev/null)" in Z*) return 0;; esac; return 1; }',
    // As launchd starts it: the account's own few vars, then the plist's env, then its program. Not
    // a child of this loop (a subshell starts it and exits): the handback waits for the stand-in to
    // be gone while this loop waits for the handback, and a child of ours would stay a zombie.
    't_start() {',
    `  set -f; ti=$IFS; nl=$(printf '\\n_'); nl=\${nl%_}; IFS=$nl; k=; set --`,
    '  for w in $(t_words EnvironmentVariables dict); do w=${w#=}',
    '    if [ -z "$k" ]; then k=$w; continue; fi',
    '    case "$k" in [0-9]*|*[!A-Za-z0-9_]*) ;; *) set -- "$@" "$k=$w";; esac; k=',
    '  done',
    '  n=$#; for w in $(t_words ProgramArguments array); do set -- "$@" "${w#=}"; done',
    '  IFS=$ti; set +f',
    '  [ "$#" -gt "$n" ] || return 1; eval "x=\\${$((n + 1))}"; [ -x "$x" ] || return 1',
    `  (cd "$HOME" 2>/dev/null || cd /; env -i HOME="$HOME" USER="\${USER:-}" LOGNAME="\${LOGNAME:-}" SHELL="\${SHELL:-/bin/sh}" TMPDIR="\${TMPDIR:-/tmp}" "$@" </dev/null >>"$tr/daemon-standin.log" 2>&1 & echo $! > "$tr/${STANDIN_PID_NAME}.tmp")`,
    `  sp=$(cat "$tr/${STANDIN_PID_NAME}.tmp" 2>/dev/null); case "$sp" in ""|*[!0-9]*) sp=; rm -f "$tr/${STANDIN_PID_NAME}.tmp"; return 1;; esac`,
    `  mv -f "$tr/${STANDIN_PID_NAME}.tmp" "$tr/${STANDIN_PID_NAME}"; ts_at=$(date +%s); }`,
    // One CLI's handback: 0 handed back, 1 refused (a real answer: no other CLI is asked), 2 no
    // answer (no such file, or a build without the action: no JSON).
    't_hb1() { [ -n "$1" ] && [ -x "$1" ] || return 2',
    '  tho=$("$1" walnut daemon handback --yes --scope user 2>>"$tr/daemon-standin.log")',
    `  case "$tho" in *'"ok": true'*|*'"ok":true'*) return 0;; *'"ok"'*) return 1;; esac; return 2; }`,
    // The service's own CLI hands back: the config's program, the one the tail began with, then the
    // builds staged in the install root, newest first. After a rollback the first two are the
    // previous build, which may have no handback at all (2026-11-04 review: the stand-in then
    // served outside launchd until logout); the update's own build is staged there.
    't_handback() {',
    '  for x in "$(t_prog)" "$tsx0"; do t_hb1 "$x"; thr=$?; [ "$thr" = 2 ] || return "$thr"; done',
    '  ls -td "$tb"/versions/*/ 2>/dev/null | head -n 5 | { while IFS= read -r v; do t_hb1 "${v%/}/daemon"; thr=$?; [ "$thr" = 2 ] || exit "$thr"; done; exit 1; }; }',
    // One loop per runtime dir: another one already at work keeps it. Its pid is a loop's only while
    // its command line names this script (as t_later reads a runner's): a loop killed with the
    // Mac (a power loss, a SIGKILL) leaves its pid behind, and a process that has it now kept
    // every later stand-in from starting (2026-11-04 review).
    `t_isloop() { [ "$1" -gt 1 ] && kill -0 "$1" 2>/dev/null || return 1; tl_a=$(ps -ww -o args= -p "$1" 2>/dev/null)`,
    '  [ -n "$tl_a" ] || return 0; case "$tl_a" in *"$0"*) return 0;; esac; return 1; }',
    'tg="$tr/.standin-loop"',
    'if ! mkdir "$tg" 2>/dev/null; then og=$(cat "$tg/pid" 2>/dev/null); case "$og" in ""|*[!0-9]*) ;; *) t_isloop "$og" && exit 0;; esac; rm -rf "$tg"; mkdir "$tg" 2>/dev/null || exit 0; fi',
    'echo $$ > "$tg/pid"',
    "trap 'rm -rf \"$tg\"' EXIT",
    'rm -f "$tg/wanted"; tf=0; tz=0; ts_at=0',
    // Never past the user's `launchctl disable` (2026-11-04 review), at the start or at a restart.
    't_disabled && exit 0',
    't_up || t_start || exit 0',
    `while sleep ${everySeconds}; do`,
    // The service uninstalled meanwhile: nothing to stand in for any more (the running one stays).
    '  [ -f "$tc" ] && [ -d "$tr" ] || break',
    '  if t_sgone; then',
    // Gone: another daemon serves now (launchd's job after the handback), else it is started again.
    '    t_up && break',
    // One that exits within a minute again and again waits 1, 3, 7 ... up to 31 ticks before the next start.
    '    if [ -n "${sp:-}" ]; then if [ $(($(date +%s) - ts_at)) -lt 60 ]; then tf=$((tf + 1)); else tf=0; fi',
    '      tq=$tf; [ "$tq" -gt 5 ] && tq=5; tz=$(((1 << tq) - 1)); sp=; fi',
    // A tail that wants a stand-in now (t_standin found this loop at work) goes first. Else not while
    // an update's runner is at work (it stopped the stand-in, its tail decides), nor while a
    // `walnut daemon` transaction holds the install lock (an update or an uninstall from a terminal).
    '    if [ -e "$tg/wanted" ]; then rm -f "$tg/wanted"; tz=0',
    '    elif t_later || t_held; then continue',
    '    elif [ "$tz" -gt 0 ]; then tz=$((tz - 1)); continue; fi',
    '    t_disabled && break',
    '    t_start || break',
    '    continue',
    '  fi',
    // No answer is no "none": the handback asks again, and also goes ahead once launchd ran the job.
    '  t_spawns; [ "$ts_sp" = none ] && continue',
    // Handed back: the stand-in has exited (the handback waited for it), and launchd's job serves.
    '  t_handback || continue',
    '  t_up && break',
    'done',
    `rm -f "$tr/${STANDIN_PID_NAME}"`,
    '',
  ].join('\n')
}

/** t_standin: write the stand-in's script into the install root and start it out of this shell's session. Needs $tb, $tr, $tsx0, $L. */
export function standInStartLines(everySeconds: number): string[] {
  const script = standInScript(everySeconds)
  if (script.split('\n').includes(EOF)) throw new Error('the stand-in script holds its own heredoc end')
  return [
    DETACH_LINE,
    't_standin() { [ -d "$tb" ] || return 1; t_disabled && return 1; sf="$tb/' + STANDIN_SCRIPT_NAME + '"',
    `  cat > "$sf.tmp.$$" <<'${EOF}'`,
    ...script.split('\n'),
    EOF,
    '  chmod 700 "$sf.tmp.$$" && mv -f "$sf.tmp.$$" "$sf" || { rm -f "$sf.tmp.$$"; return 1; }',
    // A loop already at work (its stand-in stopped by this update) starts one at its next tick.
    '  [ -d "$tr/.standin-loop" ] && : > "$tr/.standin-loop/wanted"',
    '  t_detach "$sf" "$tr" "${tsx0:-}" "${L:-}"; }',
  ]
}
