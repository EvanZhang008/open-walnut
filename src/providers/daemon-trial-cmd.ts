/**
 * An SSH host with no service: its staged daemon is tried before its old daemon is stopped
 * (daemon-connection.ts shouldUpgradeDaemon), and the old daemon's files are kept to go back
 * to. 2026-11-04 review: this path stopped the old daemon for the staged build with no check
 * that the build could start, so one that did not left the host with no daemon at all.
 *
 *   keep     the daemon files in the dir (daemon.cjs, its sidecars and ACP files, the binary)
 *            are copied aside before the new ones are staged over them, stamped with the build
 *            that runs (.version), into a dir that survives a reboot (daemon-previous-key.ts:
 *            ${XDG_STATE_HOME:-~/.local/state}/open-walnut/daemon-previous/<key of the dir>).
 *            2026-11-04 review 4: in <dir>/previous, /tmp by default, a reboot inside the build's
 *            day off lost them, and the next connect deployed the refused build again. Only for a
 *            production daemon dir: an isolated one (a replica check's) keeps them in
 *            <dir>/previous, gone with it, and so does a home that cannot take the copy (a quota,
 *            a full disk), which used to hold every update off for good (review 5). The restore
 *            takes the copy stamped last of the two, so an older build's <dir>/previous is still
 *            read. A copy of that build is kept as it is:
 *            after an attempt that stopped short (an upload that failed, a hold after it) the
 *            disk may hold the new build, which must never become the one to go back to
 *            (2026-11-04 review); every such abort also puts the kept files back.
 *   trial    the staged build starts as a daemon in a throwaway dir with nothing of the
 *            account's env (the isolation of daemon-boot-proof.ts: HOME, the daemon, state,
 *            streams and journal dirs, XDG, TMPDIR), must write its port file within W s and
 *            still run A s later. It is then stopped (the pid of this script's own background
 *            job, nothing else) and the dir removed. Prints walnut-trial-ok, or
 *            walnut-trial-failed and why. It also ends by itself a little after that window
 *            (WALNUT_DAEMON_LIFETIME_SECONDS), so an SSH session that died mid-trial leaves no
 *            daemon behind, and proof dirs such a trial left are swept first.
 *   restore  the kept files are renamed back into place: after a failed trial (the disk then
 *            holds what runs again), and when the staged build does not start after the stop.
 */
import { PREVIOUS_DIR, previousKeyOf } from './daemon-previous-key.js'

export const TRIAL_OK = 'walnut-trial-ok'
export const TRIAL_FAILED = 'walnut-trial-failed'
export const PREVIOUS_KEPT = 'walnut-previous-kept'
export const PREVIOUS_RESTORED = 'walnut-previous-restored'
/** The restore found no copy to put back (none kept, or only one of the build held). */
export const PREVIOUS_NONE = 'walnut-previous-none'
export const TRIAL_WAIT_SECONDS = 60
export const TRIAL_ALIVE_SECONDS = 3
/** The binary names a daemon dir holds (daemon-start-cmd.ts starts them). */
const BINARY_NAMES = ['daemon-linux-x64', 'daemon-linux-arm64']

export interface DaemonTrialOpts {
  runtime: 'bun' | 'binary' | 'node'
  /** bun's path ('bun'), the daemon binary's ('binary'). */
  execPath?: string
  dir: string
  /** The node PATH discovery ('node'), as the start runs it. */
  preamble?: string
  waitSeconds?: number
  aliveSeconds?: number
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The daemon's program words, as buildDaemonStartCmd runs them. */
function program(o: DaemonTrialOpts): string {
  const script = shq(`${o.dir}/daemon.cjs`)
  if (o.runtime === 'node') return `node ${script}`
  if (!o.execPath) throw new Error(`runtime '${o.runtime}' requires execPath`)
  return o.runtime === 'bun' ? `${shq(o.execPath)} ${script}` : shq(o.execPath)
}

export function buildDaemonTrialCmd(o: DaemonTrialOpts): string {
  const wait = o.waitSeconds ?? TRIAL_WAIT_SECONDS
  const alive = o.aliveSeconds ?? TRIAL_ALIVE_SECONDS
  const env = [
    'HOME="$t/h"', 'PATH="$PATH"', 'LANG="${LANG:-C}"', 'TMPDIR="$t/tmp"', 'USER="${USER:-}"', 'LOGNAME="${LOGNAME:-}"',
    'WALNUT_DAEMON_DIR="$t/d"', 'WALNUT_DAEMON_STATE_DIR="$t/s"', 'WALNUT_STREAMS_DIR="$t/st"', 'WALNUT_LEGACY_STREAMS_DIR="$t/ls"',
    'WALNUT_SPAWN_JOURNAL="$t/sj.jsonl"', 'WALNUT_JOURNAL_DIR="$t/j"', 'WALNUT_TASK_DIR_ROOT="$t/t"',
    'XDG_STATE_HOME="$t/h/.local/state"', 'XDG_CONFIG_HOME="$t/h/.config"', 'XDG_CACHE_HOME="$t/h/.cache"', 'XDG_DATA_HOME="$t/h/.local/share"',
    `WALNUT_DAEMON_LIFETIME_SECONDS=${wait + alive + 30}`,
    'WALNUT_RUNTIME_DIR="$trd"',
  ].join(' ')
  return [
    o.runtime === 'node' && o.preamble ? o.preamble : ':',
    // The compiled walnut file in the daemon slot unpacks its runtime tree first: where the
    // account's daemon keeps it, read with the real HOME, never under the trial's (2026-11-04
    // review 4: the whole runtime went into the throwaway HOME on every update).
    'case "${WALNUT_RUNTIME_DIR:-}" in /*) trd=$WALNUT_RUNTIME_DIR;; *) case "${OPEN_WALNUT_HOME:-}" in /*) trd="$OPEN_WALNUT_HOME/local/runtime";; *) trd="$HOME/.open-walnut/local/runtime";; esac;; esac',
    // A proof dir of this account older than 15 min whose daemon is gone: its prover died.
    'for o in /tmp/walnut-proof.*; do [ -d "$o" ] && [ -O "$o" ] && [ ! -L "$o" ] || continue',
    '  [ -n "$(find "$o" -maxdepth 0 -mmin +15 2>/dev/null)" ] || continue',
    '  op=$(cat "$o/d/daemon.pid" 2>/dev/null); case "$op" in ""|*[!0-9]*) ;; *) kill -0 "$op" 2>/dev/null && continue;; esac',
    '  rm -rf "$o"',
    'done',
    `t=$(umask 077; mktemp -d /tmp/walnut-proof.XXXXXXXXXX 2>/dev/null) || { echo "${TRIAL_FAILED} no throwaway dir could be made in /tmp"; exit 0; }`,
    'mkdir -p "$t/h" "$t/tmp"',
    // The subshell execs env, which execs the daemon: $! is the daemon itself.
    `(cd "$t/h" && exec env -i ${env} ${program(o)} --start) </dev/null >"$t/out.log" 2>&1 &`,
    'p=$!',
    // A zombie still answers kill -0. Its state: /proc/<pid>/stat (the word after the last ")"),
    // else ps. 2026-11-04 review: on busybox (ps has no -p) a build that listened and exited read
    // as alive, so it passed.
    't_gone() { kill -0 "$p" 2>/dev/null || return 0',
    '  if [ -r "/proc/$p/stat" ]; then tg_s=$(cat "/proc/$p/stat" 2>/dev/null) || return 0; tg_s=${tg_s##*) }; case "$tg_s" in Z*|X*) return 0;; esac; return 1; fi',
    '  case "$(ps -o stat= -p "$p" 2>/dev/null)" in Z*) return 0;; esac; return 1; }',
    'r=; i=0',
    'while :; do',
    // The port file first: one that listened and then exited is told apart from one that never listened.
    '  [ -s "$t/d/daemon.port" ] && break',
    '  if t_gone; then wait "$p" 2>/dev/null; r="it exited with $? before it listened"; break; fi',
    `  [ "$i" -ge ${wait} ] && { r="it did not listen within ${wait} s"; break; }`,
    '  sleep 1; i=$((i + 1))',
    'done',
    `if [ -z "$r" ]; then sleep ${alive}; t_gone && r="it listened, then exited"; fi`,
    // Only this script's own job, and only while it has not exited.
    't_gone || { kill "$p" 2>/dev/null; j=0; while ! t_gone && [ "$j" -lt 10 ]; do sleep 1; j=$((j + 1)); done; t_gone || kill -9 "$p" 2>/dev/null; }',
    'said=$(tail -n 3 "$t/out.log" 2>/dev/null | tr "\\n" " " | cut -c1-300)',
    'rm -rf "$t"',
    `if [ -z "$r" ]; then echo ${TRIAL_OK}; else echo "${TRIAL_FAILED} $r: $said"; fi`,
  ].join('\n')
}

/** null: the build served. Else why not (no answer at all counts as a failure: the old daemon keeps serving). */
export function parseDaemonTrial(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trim())
  if (lines.includes(TRIAL_OK)) return null
  const failed = lines.find((l) => l.startsWith(TRIAL_FAILED))
  if (failed) return failed.slice(TRIAL_FAILED.length).trim() || 'it did not serve'
  return `the trial gave no answer${output.trim() ? `: ${output.trim().slice(-200)}` : ''}`
}

/**
 * Sets kr (the root of the kept copies, a dir that survives a reboot), k (this daemon dir's) and
 * ko (beside the daemon's files: an older build's, an isolated dir's, a fallback). As
 * previousKeepDir reads it on this machine. Not `durable` (no production dir): kr is empty and k
 * is ko.
 */
function keepDirLines(dir: string, durable: boolean): string[] {
  const ko = `ko=${shq(`${dir}/${PREVIOUS_DIR}`)}`
  if (!durable) return [`${ko}; kr=; k=$ko`]
  return [
    'case "${WALNUT_DAEMON_PREVIOUS_ROOT:-}" in /*) kr=$WALNUT_DAEMON_PREVIOUS_ROOT;; *) case "${XDG_STATE_HOME:-}" in /*) kr="$XDG_STATE_HOME/open-walnut/daemon-previous";; *) kr="$HOME/.local/state/open-walnut/daemon-previous";; esac;; esac',
    `k="$kr/${previousKeyOf(dir)}"; ${ko}`,
  ]
}

export const PREVIOUS_NOT_RUNNING = 'walnut-previous-not-running'

/**
 * Copy the daemon files there now into the kept dir, whole or not at all, stamped with
 * `running` (the build the daemon answers with). A kept copy already stamped with it stays (one
 * an older build kept in <dir>/previous is moved over as it is); files on disk whose program does
 * not carry that build (its version is a literal in daemon.cjs and in the binary) are not kept.
 */
export function buildKeepPreviousCmd(dir: string, running: string, runtime: 'binary' | 'script', durable = true): string {
  const d = shq(dir)
  if (!/^[A-Za-z0-9._-]+$/.test(running)) throw new Error('the running build must be a plain version word')
  const programs = runtime === 'binary' ? BINARY_NAMES.map((n) => `"$d/${n}"`).join(' ') : '"$d/daemon.cjs"'
  return [
    `d=${d}; v=${shq(running)}`,
    ...keepDirLines(dir, durable),
    `[ -d "$k" ] && [ "$(cat "$k/.version" 2>/dev/null)" = "$v" ] && { echo ${PREVIOUS_KEPT}; exit 0; }`,
    `if [ "$k" != "$ko" ] && [ -d "$ko" ] && [ "$(cat "$ko/.version" 2>/dev/null)" = "$v" ]; then src=$ko; else`,
    `  w=; for f in ${programs}; do [ -f "$f" ] && grep -qF "$v" "$f" 2>/dev/null && w=1; done`,
    `  [ -n "$w" ] || { echo ${PREVIOUS_NOT_RUNNING}; exit 0; }`,
    '  src=$d',
    'fi',
    // The copy into $1, whole or not at all.
    't_keep() { rm -rf "$1.tmp" && mkdir -m 700 "$1.tmp" || return 1',
    `  for f in "$src"/*.cjs "$src"/*.mjs ${BINARY_NAMES.map((n) => `"$src/${n}"`).join(' ')}; do`,
    '    [ -f "$f" ] || continue',
    '    cp -p "$f" "$1.tmp/" || { rm -rf "$1.tmp"; return 1; }',
    '  done',
    '  printf \'%s\\n\' "$v" > "$1.tmp/.version" || { rm -rf "$1.tmp"; return 1; }',
    '  rm -rf "$1" && mv "$1.tmp" "$1"; }',
    `if [ -n "$kr" ] && (umask 077; mkdir -p "$kr") 2>/dev/null && t_keep "$k"; then echo ${PREVIOUS_KEPT}; exit 0; fi`,
    // The home could not take it (a quota, a full disk): beside the daemon's files, which a reboot
    // may clear, and never an older copy left in the kept dir read before it.
    '[ "$k" = "$ko" ] || rm -rf "$k"',
    `[ "$src" = "$ko" ] && { echo ${PREVIOUS_KEPT}; exit 0; }`,
    `t_keep "$ko" && echo ${PREVIOUS_KEPT}`,
  ].join('\n')
}

/**
 * Copy the kept files back into place (a running process keeps the file it runs), into a daemon
 * dir a reboot removed too. `notBuild`: a kept copy stamped with that build is not put back (the
 * one held back there is never the way back).
 */
export function buildRestorePreviousCmd(dir: string, notBuild?: string, durable = true): string {
  if (notBuild !== undefined && !/^[A-Za-z0-9._-]+$/.test(notBuild)) throw new Error('the held build must be a plain version word')
  return [
    `d=${shq(dir)}`,
    ...keepDirLines(dir, durable),
    // The copy stamped last: the other may be an older build's (a fallback beside the files, a downgrade).
    'if [ "$k" != "$ko" ] && [ -d "$ko" ] && { [ ! -d "$k" ] || [ "$ko/.version" -nt "$k/.version" ]; }; then k=$ko; fi',
    `[ -d "$k" ] || { echo ${PREVIOUS_NONE}; exit 0; }`,
    ...(notBuild ? [`[ "$(cat "$k/.version" 2>/dev/null)" = ${shq(notBuild)} ] && { echo ${PREVIOUS_NONE}; exit 0; }`] : []),
    '(umask 077; mkdir -p "$d") || exit 0',
    // Every file copied beside its place first, then all renamed in: a copy that fails (a full disk)
    // changes nothing, never a mix of two builds' files (2026-11-04 review 5: one by one, it did).
    'tr_ok=1; for f in "$k"/*; do [ -f "$f" ] || continue; cp -p "$f" "$d/.${f##*/}.walnut-prev" || { tr_ok=; break; }; done',
    'if [ -z "$tr_ok" ]; then for f in "$k"/*; do rm -f "$d/.${f##*/}.walnut-prev"; done; exit 0; fi',
    'for f in "$k"/*; do [ -f "$f" ] || continue; mv -f "$d/.${f##*/}.walnut-prev" "$d/${f##*/}" || exit 0; done',
    `echo ${PREVIOUS_RESTORED}`,
  ].join('\n')
}

/** A line run on the host (DaemonConnection.sshExec). */
export type HostExec = (command: string, timeoutMs?: number) => Promise<string>

/** How long the trial may take over SSH: its wait, its alive check, the stop, and the link. */
const TRIAL_EXEC_MS = (TRIAL_WAIT_SECONDS + TRIAL_ALIVE_SECONDS + 40) * 1000

/** The staged build's trial on the host: null when it served, else why not. A link that fails is a failure. */
export async function trialStagedDaemon(exec: HostExec, o: DaemonTrialOpts): Promise<string | null> {
  const once = async () => parseDaemonTrial(await exec(buildDaemonTrialCmd(o), TRIAL_EXEC_MS).catch((error: unknown) => {
    return `${TRIAL_FAILED} the trial could not run (${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200)})`
  }))
  const first = await once()
  // The instance lock's port is a hash of the throwaway dir: one taken by something else is that dir's bad luck.
  return first && /\block\b/i.test(first) ? once() : first
}

/** Keep the running build's files to go back to (false: nothing kept, there is none to go back to). */
/**
 * kept: previous/ holds the running build. not-running: there is nothing of it to keep (its
 * files on disk carry another build, or a legacy daemon answers no version). failed: no copy
 * and no answer why (the command failed or timed out): the caller does not stop the daemon
 * (2026-11-04 review: the stop did not depend on a copy having been kept).
 */
export type KeptPrevious = 'kept' | 'not-running' | 'failed'

/** `durable`: a production daemon dir, whose copy goes where a reboot leaves it (else beside its files). */
export async function keepPreviousDaemon(exec: HostExec, dir: string, running: string, runtime: 'binary' | 'script', durable = true): Promise<KeptPrevious> {
  if (!running) return 'not-running'
  if (!/^[A-Za-z0-9._-]+$/.test(running)) return 'failed'
  const said = (await exec(buildKeepPreviousCmd(dir, running, runtime, durable), 120_000).catch(() => '')).split('\n').map((l) => l.trim())
  return said.includes(PREVIOUS_KEPT) ? 'kept' : said.includes(PREVIOUS_NOT_RUNNING) ? 'not-running' : 'failed'
}

export const CARRIES_BUILD = 'walnut-files-carry-build'

/**
 * Whether the daemon files in `dir` carry `build` (its version is a literal in daemon.cjs and in
 * the binary): a start "of the one that ran before" from files that are the held build's would
 * start the held build, unwatched. No answer is false.
 */
export async function filesCarryBuild(exec: HostExec, dir: string, build: string, runtime: 'binary' | 'script'): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]+$/.test(build)) return false
  const d = shq(dir)
  const programs = runtime === 'binary' ? BINARY_NAMES.map((n) => `${d}/${n}`).join(' ') : `${d}/daemon.cjs`
  const cmd = `for f in ${programs}; do [ -f "$f" ] && grep -qF ${shq(build)} "$f" 2>/dev/null && { echo ${CARRIES_BUILD}; break; }; done; :`
  return (await exec(cmd, 30_000).catch(() => '')).split('\n').some((l) => l.trim() === CARRIES_BUILD)
}

export async function restorePreviousDaemon(exec: HostExec, dir: string, notBuild?: string, durable = true): Promise<boolean> {
  return (await restorePreviousOutcome(exec, dir, notBuild, durable)) === 'restored'
}

/** The restore, and why not: no copy there to put back ('none'), or putting it back failed (a full disk, a link that dropped). */
export async function restorePreviousOutcome(exec: HostExec, dir: string, notBuild?: string, durable = true): Promise<'restored' | 'none' | 'failed'> {
  const said = await exec(buildRestorePreviousCmd(dir, notBuild, durable), 120_000).catch(() => '')
  return said.includes(PREVIOUS_RESTORED) ? 'restored' : said.includes(PREVIOUS_NONE) ? 'none' : 'failed'
}
