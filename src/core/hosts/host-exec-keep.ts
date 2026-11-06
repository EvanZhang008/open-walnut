/**
 * host_exec `keep`: a call starts where this task's last keep call on the same host ended, its
 * working directory and its exported variables (new, changed and unset ones), with no process left
 * up between calls. Shell functions, aliases, unexported variables, options and traps do not carry.
 *
 * The server shapes the line, like strict (host-exec-strict.ts), so every daemon already deployed
 * runs it. bash only: under another shell the wrapper does nothing and the line runs as without keep.
 * Written for bash 3.2 (macOS /bin/bash: no associative arrays, no `${x@Q}`, no `declare -n`), 4 and 5.
 *
 * The state lives on the host in `$WALNUT_TASK_DIR/host-exec/` (per task per host), 0600, as one
 * snapshot per save: `keep.d/<gen>.sh`, a bash file written once and never changed (the directory
 * and the whole delta from a fresh shell: the inner bash's exported environment is read BEFORE the
 * state is sourced, the baseline, and at the end every exported variable whose `declare -px` text
 * is not one of the baseline's lines is written, and every baseline name no longer exported becomes
 * `unset`), then `keep.current`, put in place by one `mv`: two lines, the generation and the
 * directory. Two keep calls of one task at once: the last to move the pointer wins, and the pointer
 * always names one run's directory and variables. Values never reach the output, the server or the
 * answer. Before a keep call this server reads keep.current (keptState, one read) and gives the
 * daemon the directory as the run's cwd (so its own checks, the macOS permission guard, the Command
 * Line Tools check, every wait_for file, see the directory the line starts in) and the line the
 * generation to source, the one that directory came from. A host that cannot hand the pointer over
 * gets the shell reading it and entering the directory itself (`shellCd`), after those checks, and
 * the answer says so. Once a foreground run ended the server reads keep.current again: the answer says
 * the state carries only when it names this run's snapshot (its generation ends with the run's seal).
 *
 * Saved by an EXIT trap: on a normal end, `exit N`, and SIGTERM (host_exec_stop and a deadline send
 * it first; bash runs its EXIT trap then). Not saved when the line sets its own EXIT trap (it replaces
 * Walnut's), `exec`s, is killed by SIGKILL, leaves a DEBUG trap that fails under extdebug, or runs in
 * the background (it ends much later, and would write an old state over a newer one). Restore runs
 * before strict's prefix: no set -e, no ERR trap.
 *
 * What the line can do to its shell is the threat model: the save never adds output, changes the exit
 * code or signal, or shows a value, whatever the line turned on (tracing, aliases, functions over
 * builtins, readonly names). The limits are named where they are (TRAP_FIRST_LINE).
 */
import path from 'node:path'
import type { ExecParams } from './host-exec.js'
import { HostExecError } from './host-exec-target.js'
import { sealFor, strictLine } from './host-exec-strict.js'
import { taskDirPath } from '../../lib/task-dir.js'

/** The pointer: the newest snapshot's generation and directory, under the task's directory on the host. */
export const KEEP_POINTER = 'host-exec/keep.current'
/** The snapshots, one file per generation, beside it. */
export const KEEP_GENS = 'host-exec/keep.d'
/** A generation's name: its time, then the saving run's seal (letters, digits, - only). */
export const GEN_RE = /^[A-Za-z0-9-]{1,64}$/
/** The longest kept directory read (a path: PATH_MAX is 4096 on Linux, 1024 on macOS). */
const KEEP_CWD_MAX = 4_096
/**
 * A save leaves, besides its own, the newest older generations and any younger than this: a call that
 * read the pointer just before may still be about to source the one it named.
 */
export const GENS_KEPT = 4
export const GEN_FRESH_S = 600

/** The sentence the answer shows for a save that did not complete (keep's mark, rewritten). */
const NOT_SAVED = 'walnut: keep could not save this run\'s state'
const NOT_SAVED_TAIL = 'the next keep call starts from the last saved one'
/** The mark the run prints, on a line of its own: the run's seal (strict's, only this server knows it) and why, no value. */
const markHead = (seal: string) => `walnut keep ${seal}: could not save`
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/** Names never carried: the shell's own, the run's own, Walnut's, bash's, the save's posix switch. */
const SKIP = '""|PWD|OLDPWD|SHLVL|_|POSIXLY_CORRECT|WALNUT_HOST_EXEC_JOB|WALNUT_TASK_DIR|walnut_*|BASH_*'
/** The next name of `$walnut_r`, a newline-ended list (no `read`: IFS and here-strings stay out of it). */
const NEXT = 'walnut_n=${walnut_r%%"$walnut_nl"*}; walnut_r=${walnut_r#*"$walnut_nl"}'
/**
 * A loop over the names in `$list`, one per line, that ends in bounded time whatever a DEBUG trap
 * under extdebug skips (bash counts a skipped command as a success): `until` stops at a skipped
 * test, and a turn goes on only after the count ran, at most as many turns as `$list` has characters.
 */
export const each = (list: string, body: string) => `walnut_r=$${list}$walnut_nl; walnut_j=0; until [[ -z $walnut_r ]] || (( (walnut_j += 1) > \${#${list}} )); do ${NEXT}; ${body}; done`
/** Every name the save assigns: one the line made readonly stops it before it starts. */
export const KEEP_SAVE_NAMES = [
  'walnut_nl', 'walnut_w', 'walnut_ke', 'walnut_kd', 'walnut_kq', 'walnut_s', 'walnut_r', 'walnut_n', 'walnut_d', 'walnut_f',
  'walnut_t', 'walnut_g', 'walnut_a', 'walnut_i', 'walnut_c', 'walnut_p', 'walnut_x', 'walnut_j', 'walnut_m',
]
/** The functions the first line removes: a function over builtin or exec would run in Walnut's place (the rest as the review asked). */
export const KEEP_UNSET_FUNCTIONS = ['builtin', 'command', 'exec', 'shopt', 'printf', 'declare', 'compgen', 'umask', 'pwd', 'cd']
const say = (seal: string, why: string) => `\\builtin printf "\\n${markHead(seal)} (%s)\\n" ${why} >&4`
const NULL_FDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((fd) => `${fd}${fd === 0 ? '<' : '>'}/dev/null`).join(' ')

/**
 * The EXIT trap's first line, run before anything else and parsed alone: bash reads the trap's next
 * line only after it ran. One group with fds 0 to 9 on /dev/null (a trace there, BASH_XTRACEFD of 0
 * to 9 included, goes nowhere; one of 10 or more is not covered), in which nothing is looked up as a
 * function: the assignment turns on posix mode (an assignment runs no command), where `:`, trap, set,
 * unset and exit are special builtins, found before any function; it removes the line's DEBUG and ERR
 * traps, tracing, verbose, -e and -u, and the functions over builtins (the shell is ending: they cost
 * the line nothing), then leaves posix mode. A readonly function among them is not removed: the save is
 * skipped and says so with trap -p, a special builtin (keepMarkWhy reads that form too), and exits,
 * which keeps the run's exit code and signal. Then, with no function in the way, no alias expansion
 * (after leaving posix mode, which itself turns it off in a shell that is not interactive on 3.2, 4.2
 * and 5.2; switched off last so that does not rest on it). Backslash-quoted words are never alias-expanded.
 * Not covered (measured 2026-11-05 on 3.2, 4.2 and 5.2): an alias named `{`; a readonly
 * POSIXLY_CORRECT (bash 3.2 and 4.2, and any bash in posix mode, end the trap at the assignment:
 * nothing saved, nothing said, the exit code kept; bash 5 outside posix mode goes on there, where a
 * function over set, trap or unset would run in place of the builtin). Under set -v this one line is
 * echoed; it holds no value.
 *
 * A DEBUG trap that fails under extdebug makes bash skip every command, this line's included, and
 * count each as a success (3.2 and 4.2 skip the trap's own commands, not those of a subshell it
 * starts; 5 skips both). So the rest of the trap runs only when the gate after this line ran
 * (GATE): a skipped `false` succeeds, and nothing more runs. The line's DEBUG trap still runs before
 * each of the few commands up to the gate, with its output on /dev/null.
 */
export function trapFirstLine(seal: string): string {
  return `{ POSIXLY_CORRECT=y || \\:; \\trap - ERR DEBUG; \\set +xveu; \\unset -f ${KEEP_UNSET_FUNCTIONS.join(' ')} && \\set +o posix`
    + ` && { \\builtin unset -v POSIXLY_CORRECT; \\builtin shopt -u expand_aliases; }; } ${NULL_FDS}`
    + ` || { \\trap -- $'\\n${markHead(seal)} (the line made a function the save needs readonly)' RETURN; { \\trap -p RETURN; } >&2; \\exit; }`
}

/** The rest of the trap runs only when this `false` ran: a DEBUG trap that skips it makes it succeed. */
const GATE = `{ \\builtin false; } ${NULL_FDS} || {`

/**
 * The EXIT trap. After its first line and the gate: no allexport (it would hand the state to mv's
 * environment), no noglob (the old generations are found by a glob), no nocasematch (the baseline test
 * compares exact text). The save runs in a subshell, so nothing in it (a readonly name, a failed write)
 * changes the run's exit code or signal; its own errors go nowhere, and one that stops it prints keep's
 * mark, on a line of its own with the run's seal and no value (`say`, on fd 4: the run's stderr). The
 * shell waits for it with its stderr on /dev/null: that wait reaps a job a signal ended, and bash would
 * print "Terminated" for it, a line the run without keep never has. The state text is made whole first;
 * then nothing is exported, so date, mkdir, mv and rm start with an empty environment (`command -p`:
 * the default PATH) whatever size the line's exports had, and GLOBIGNORE is unset (the line's is in the
 * text) for the old generations' glob. Names the save uses lose any attribute the line gave them
 * (integer, case, array, nameref) first. Every loop ends in bounded time (`each`, and a `for`).
 *
 * The snapshot's generation ends with the run's seal: the server, reading the pointer once the run
 * ended, knows whether it names this run's snapshot (keepAnswer), whatever the run could print.
 */
function trapText(seal: string): string {
  const names = KEEP_SAVE_NAMES.join(' ')
  return [
    trapFirstLine(seal),
    GATE,
    // Bare exec: through builtin or command its redirections end with it. fd 4 is closed first, so with
    // no stderr it is not left a file of the line's; outside posix mode a failed exec does not end the trap.
    '\\exec 4>&-; \\exec 4>&2; { \\builtin set +af; \\builtin shopt -u nocasematch nullglob failglob',
    '(',
    // Its names without what the line made of them (an unset of a readonly one fails, and goes on).
    `{ \\builtin unset -n ${names}; \\builtin unset -v ${names}; } 2>/dev/null`,
    // Read from what it prints, never its status: bash 3.2 ends a subshell on the error, inside an EXIT trap with the run's status.
    `case $({ ${KEEP_SAVE_NAMES.map((n) => `${n}=`).join(' ')} && \\builtin printf ok; } 2>/dev/null) in (ok) ;; (*) ${say(seal, '"the line made a walnut_ variable readonly"')}; \\builtin exit;; esac`,
    '{ \\builtin umask 077; walnut_nl=$\'\\n\'; walnut_w=; walnut_ke=$(\\builtin compgen -e); walnut_kd=${PWD:-$(\\builtin pwd)}; walnut_kq=$walnut_kh/keep.d',
    'walnut_s=$(\\builtin printf "%s\\n" "# Walnut host_exec keep: one saved state of this task on this host, read by a later keep call"; \\builtin declare -p walnut_kd',
    // Exported now and not as it was in the baseline (the whole declare text, as a whole line set there); never a readonly one.
    // Every case pattern opens with `(`: bash 3.2 and 4 end a `$( … )` at a pattern's lone `)`.
    each('walnut_ke', `case $walnut_n in (${SKIP}) \\builtin continue;; esac`
      + '; walnut_d=$(\\builtin declare -px "$walnut_n") || \\builtin continue; walnut_f=${walnut_d#"declare -"}; case ${walnut_f%%" "*} in (*r*) \\builtin continue;; esac'
      + '; case "$walnut_nl$walnut_kb$walnut_nl" in (*"$walnut_nl$walnut_d$walnut_nl"*) \\builtin continue;; esac; \\builtin printf "%s\\n" "$walnut_d"'),
    // Exported in the baseline and not now.
    each('walnut_kn', `case $walnut_n in (${SKIP}) \\builtin continue;; esac`
      + '; case "$walnut_nl$walnut_ke$walnut_nl" in (*"$walnut_nl$walnut_n$walnut_nl"*) \\builtin continue;; esac; \\builtin printf "unset -v %s\\n" "$walnut_n"') + ')',
    // The text is whole: nothing exported from here (a value over the kernel's limit for one stops any program).
    each('walnut_ke', '\\builtin export -n "$walnut_n"'),
    `walnut_m=$(\\builtin compgen -A function); ${each('walnut_m', '\\builtin export -fn "$walnut_n"')}; \\builtin unset -v GLOBIGNORE`,
    // This snapshot's generation: its time first, so the names sort oldest first (a host whose time cannot be read removes none), then the seal.
    `walnut_t=$(\\builtin command -p date +%s); case $walnut_t in (""|*[!0-9]*) walnut_t=0;; esac; walnut_g=$walnut_t-${seal}`,
    'if [[ $walnut_kh != /*/host-exec ]]; then walnut_w="the line changed a walnut_ variable"',
    'elif ! { [[ -d $walnut_kq ]] || \\builtin command -p mkdir -p -- "$walnut_kq"; }; then walnut_w="its folder in the task directory cannot be made"',
    // The snapshot's last line: a file cut short has none, and is never read. The pointer: the generation, then the directory as it is.
    'elif ! { \\builtin printf "%s\\nwalnut_kz=1\\n" "$walnut_s" >| "$walnut_kq/$walnut_g.sh" && \\builtin printf "%s\\n%s" "$walnut_g" "$walnut_kd" >| "$walnut_kh/keep.current.$walnut_g"; }; then walnut_w="it cannot be written in the task directory"',
    'elif ! \\builtin command -p mv -f -- "$walnut_kh/keep.current.$walnut_g" "$walnut_kh/keep.current"; then walnut_w="it cannot be put in place in the task directory"',
    'fi; [[ -z $walnut_w ]] || \\builtin command -p rm -f -- "$walnut_kq/$walnut_g.sh" "$walnut_kh/keep.current.$walnut_g"',
    // The old generations, oldest first: this one stays, and the newest others (walnut_i after it, this
    // one among them while walnut_c is 1), and any one younger than the window.
    '[[ -n $walnut_w ]] || { walnut_a=("$walnut_kq"/[0-9]*-*.sh); walnut_i=${#walnut_a[@]}; walnut_c=1; walnut_x=()',
    'for walnut_p in "${walnut_a[@]}"; do walnut_i=$((walnut_i - 1)); [[ $walnut_p == "$walnut_kq/$walnut_g.sh" ]] && { walnut_c=0; \\builtin continue; }',
    `(( walnut_i - walnut_c < ${GENS_KEPT} )) && \\builtin continue; walnut_n=\${walnut_p##*/}; walnut_n=\${walnut_n%%-*}; case $walnut_n in (""|*[!0-9]*) \\builtin continue;; esac`,
    `(( walnut_t == 0 || walnut_t - 10#$walnut_n < ${GEN_FRESH_S} )) || walnut_x[\${#walnut_x[@]}]=$walnut_p; done`,
    '(( ${#walnut_x[@]} == 0 )) || \\builtin command -p rm -f -- "${walnut_x[@]}"; }; } 2>/dev/null',
    `[[ -z $walnut_w ]] || ${say(seal, '"$walnut_w"')}`,
    ') >/dev/null; } 2>/dev/null; }',
  ].join('\n')
}

/**
 * `text` as one bash word that holds it exactly, its newlines too, on one physical line. A quote is
 * `\047`, never `\'`: another sh reads the word as `$` and a single-quoted string, which it parses
 * (and never runs) only while nothing in it ends the quotes.
 */
const ansiC = (text: string) => `$'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\047').replace(/\n/g, '\\n')}'`

/** The pointer's generation, read by the shell (a host that cannot hand it over): its first line, kept only when it is a name. */
const READ_POINTER = 'if [ -f "$walnut_kh/keep.current" ]; then walnut_kg=$(< "$walnut_kh/keep.current"); walnut_kg=${walnut_kg%%"$walnut_nl"*}'
  + '; case $walnut_kg in (*[!A-Za-z0-9-]*) walnut_kg=;; esac; fi'

/** Into the kept directory in the shell (a host that cannot hand it over); a note on stderr (fd 3) when it cannot. */
const CD = 'if [ -n "$walnut_kd" ]; then if [ ! -d "$walnut_kd" ]; then builtin printf \'walnut: the kept directory %s is gone; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3'
  + '; elif ! builtin cd -- "$walnut_kd"; then builtin printf \'walnut: the kept directory %s cannot be entered; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3; fi; fi'

/**
 * The restore: the baseline first, then the generation's snapshot, sourced only when a trial in a
 * subshell got to its last line (one cut short, broken or gone is ignored, with a note). Run with
 * stderr closed off (a trace line from an inherited xtrace would hold values); fd 3 is the run's
 * stderr, for the notes. `gen`: the generation the server read with the directory (null: none kept),
 * or 'shell': the shell reads the pointer itself.
 */
function restore(gen: string | null | 'shell', enter: boolean): string {
  return [
    `walnut_nl=$'\\n'; walnut_kh="$WALNUT_TASK_DIR/host-exec"; walnut_kg=${gen === 'shell' || gen === null ? '' : gen}; walnut_kf=; walnut_kd=; walnut_kz=`
      + '; walnut_kn=$(builtin compgen -e); walnut_kb=$(builtin declare -px)',
    ...(gen === 'shell' ? [READ_POINTER] : []),
    'if [ -n "$walnut_kg" ]; then walnut_kf="$walnut_kh/keep.d/$walnut_kg.sh"; if (. "$walnut_kf" && [ "$walnut_kz" = 1 ]) >/dev/null 2>&1; then . "$walnut_kf" >/dev/null'
      + "; else builtin printf 'walnut: the kept state in %s cannot be read; this run starts without it\\n' \"$walnut_kf\" >&3; fi; fi",
    ...(enter ? [CD] : []),
  ].join('; ')
}

/** The text that goes before the line: one physical line, so bash counts the caller's lines as written. */
export function keepPrefix(o: { gen: string | null | 'shell'; enter: boolean; save: boolean; seal: string }): string {
  return `if [ -n "\${BASH_VERSION:-}" ]; then { ${restore(o.gen, o.enter)}${o.save ? `; trap ${ansiC(trapText(o.seal))} EXIT` : ''}; } 3>&2 2>/dev/null; fi`
}

/**
 * The line a call runs, shaped by strict and keep; null when neither applies (the line goes as it is).
 * With both, keep's restore comes first, and its EXIT trap stands in for strict's own `trap : EXIT`
 * (it stops bash 3.2 and 4 from exec'ing the last command just the same); a background run sets no
 * EXIT trap of keep's, so strict keeps its own. `gen`: the generation the server read (keptState);
 * `shellCd`: the host could not hand the pointer over, so the shell reads it, and enters the kept
 * directory itself when no cwd is named.
 */
export function shapedLine(params: Pick<ExecParams, 'command' | 'strict' | 'keep' | 'background' | 'cwd'>, jobId: string, o: { gen?: string | null; shellCd?: boolean } = {}): string | null {
  const command = typeof params.command === 'string' && params.command.trim() !== '' ? params.command : null
  if (command === null) return null
  const strict = params.strict === true
  if (params.keep !== true) return strict ? strictLine(command, jobId) : null
  const gen = o.shellCd === true ? 'shell' : o.gen ?? null
  if (gen !== null && gen !== 'shell' && !GEN_RE.test(gen)) throw new Error(`shapedLine: not a generation: ${gen}`)
  const save = params.background !== true
  const body = strict ? strictLine(command, jobId, { exitTrap: !save }) : command
  const prefix = keepPrefix({ gen, enter: o.shellCd === true && !named(params.cwd), save, seal: sealFor(jobId, true)! })
  return `${prefix}; ${body}`
}

export const named = (cwd: unknown): cwd is string => typeof cwd === 'string' && cwd.trim() !== ''

/** A wrong `keep` is refused before anything runs: a boolean, and only with a shell line. */
export function checkKeep(keep: unknown, hasCommand: boolean): void {
  if (keep === undefined) return
  if (typeof keep !== 'boolean') throw new HostExecError('keep is true or false. Nothing ran.', 400, 'bad_request')
  if (keep && !hasCommand) {
    throw new HostExecError('keep keeps a shell\'s state, and argv runs one program with no shell: give the line as command. Nothing ran.', 400, 'bad_request')
  }
}

/** A kept directory as the host holds it, or null (empty, too long, not UTF-8 as written, not absolute). */
export function keptDirOf(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > KEEP_CWD_MAX) return null
  const dir = bytes.toString('utf8')
  return Buffer.from(dir, 'utf8').equals(bytes) && dir.startsWith('/') && !dir.includes('\0') ? dir : null
}

/** keep.current as the host holds it: the generation and the directory, or null (not two such lines). */
export function pointerOf(bytes: Buffer): { gen: string; dir: string } | null {
  const nl = bytes.indexOf(0x0a)
  if (nl <= 0) return null
  const gen = bytes.subarray(0, nl).toString('latin1')
  const dir = keptDirOf(bytes.subarray(nl + 1))
  return GEN_RE.test(gen) && dir ? { gen, dir } : null
}

/** What a keep call starts from: a snapshot (both null: none kept), or the shell reads the pointer itself. */
export type Kept = { gen: string | null; dir: string | null } | { shellCd: true }

/**
 * The snapshot this task's last keep call on the host saved, read there before the run: ONE
 * fs.readRange of keep.current (a required daemon command since long before host_exec; `read` bounds
 * its time). No file is no snapshot. A host that cannot hand it over (no fs.readRange, no task
 * directory root told, a read it refuses: a follower's scope, a file it may not read) gets the shell
 * reading it. A read that fails on the way (`read` throws) ends the call: nothing ran yet.
 */
export async function keptState(conn: { hasCapability: (c: string) => boolean; taskDirRoot?: string | null }, taskId: string, read: (params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<Kept> {
  const dir = typeof conn.taskDirRoot === 'string' && conn.taskDirRoot.startsWith('/') ? taskDirPath(conn.taskDirRoot, taskId) : null
  if (!dir || !conn.hasCapability('fs.readRange')) return { shellCd: true }
  const reply = await read({ path: path.posix.join(dir, KEEP_POINTER), start: 0, length: 64 + 1 + KEEP_CWD_MAX + 1 })
  if (reply.ok !== true) return /\((?:ENOENT|ENOTDIR|ENOTFILE)\)/.test(String(reply.error ?? '')) ? { gen: null, dir: null } : { shellCd: true }
  const data = typeof reply.data === 'string' ? Buffer.from(reply.data, 'base64') : Buffer.alloc(0)
  const p = typeof reply.fileSize === 'number' && reply.fileSize !== data.length ? null : pointerOf(data)
  return p ?? { gen: null, dir: null }
}

/**
 * The kept directory as the daemon is given it: the daemon trims a cwd (it is a user's text there),
 * so one that ends in white space goes as `<dir>/.`, which trimming leaves whole and which resolves
 * to the directory itself.
 */
export const daemonCwd = (dir: string): string => (dir !== dir.trimEnd() ? `${dir}/.` : dir)

/** keep's mark in a run's output, in either form (say's line, the first line's trap -p): `why` is the group. */
const markRe = (seal: string) => new RegExp(`(?:trap -- ')?\\n${esc(markHead(seal))} \\(([^)\\n]{1,120})\\)(?:' RETURN)?(?=\\n|$)\\n?`, 'g')

/** Why this run's save did not complete, from keep's mark with its seal (the last one), or null. */
export function keepMarkWhy(output: string, jobId: string): string | null {
  const seal = sealFor(jobId)
  if (!seal || !output.includes(markHead(seal))) return null
  let why: string | null = null
  for (const m of output.matchAll(markRe(seal))) why = m[1]!
  return why
}

/** The output without keep's mark (strict's step is read from the line's own output). */
export function withoutKeepMark(output: string, jobId: string): string {
  const seal = sealFor(jobId)
  return seal && output.includes(markHead(seal)) ? output.replace(markRe(seal), '') : output
}

/**
 * The output with keep's mark said as a sentence on a line of its own: its leading newline only where
 * the text before it does not already end a line. A line the run printed that looks like it, with no
 * seal or another, stays as it is.
 */
export function withKeepMarkSaid(output: string, jobId: string): string {
  const seal = sealFor(jobId)
  if (!seal || !output.includes(markHead(seal))) return output
  return output.replace(markRe(seal), (_m, why: string, at: number) => `${at === 0 || output[at - 1] === '\n' ? '' : '\n'}${NOT_SAVED} (${why}); ${NOT_SAVED_TAIL}\n`)
}

/** Whether a generation is the one this run's save named (it ends with the run's seal: host-exec-keep.ts trapText). */
export function savedBy(gen: string | null, jobId: string): boolean {
  const seal = sealFor(jobId)
  return !!seal && !!gen && gen.endsWith(`-${seal}`)
}

/** Why a run's end does not carry, or is not known to, when its output says nothing (keepAnswer). */
export const KEEP_NOT_RUN = 'its save did not run to its end'
export const KEEP_SAVED_OVER = 'a keep call that ran at the same time saved after it'
export const KEEP_UNREAD = 'Walnut could not read the kept state on the host after the run'

/**
 * What keep did, for the answer: `saves` (false for a background run); for a foreground run that ended,
 * `saved`, read from the pointer once it ended (`after`): true when it names this run's snapshot, false
 * (with `why`: keep's mark in the output says it, else the pointer did not move from `before` or moved
 * to another run's), null when it could not be read (`why` too); `gone` (a kept directory the host no
 * longer has: the run started in the fresh cwd), `notEntered` (one the shell could not start in:
 * nothing ran), `shellCd` (the shell read the pointer and entered the directory itself, after the
 * host's checks). A run still going has no `saved`: it saves when it ends.
 */
export function keepAnswer(o: { background: boolean; out: Record<string, unknown>; output: string; jobId: string; keptDir: string | null; shellCd: boolean; gone?: string; before?: Kept | null; after?: Kept | null }): Record<string, unknown> {
  const ended = o.out.running !== true
  const mark = !o.background && ended ? keepMarkWhy(o.output, o.jobId) : null
  const keptDir = o.gone ? null : o.keptDir
  // A shell that never started (the host could not enter the directory) ends with neither a code nor a signal.
  const notEntered = keptDir && ended && o.out.exitCode === null && o.out.signal === null && o.out.timedOut !== true && !o.out.blocked ? keptDir : null
  const now = o.after && 'gen' in o.after ? o.after.gen : undefined
  const was = o.before && 'gen' in o.before ? o.before.gen : null
  const saved = o.background || !ended || notEntered ? undefined : mark ? false : now === undefined ? null : savedBy(now, o.jobId)
  const why = mark ?? (saved === null ? KEEP_UNREAD : saved === false ? (now !== null && now !== was ? KEEP_SAVED_OVER : KEEP_NOT_RUN) : null)
  return {
    saves: !o.background,
    ...(saved !== undefined ? { saved } : {}),
    ...(saved !== undefined && saved !== true && why ? { why } : {}),
    ...(o.gone ? { gone: o.gone } : {}),
    ...(notEntered ? { notEntered } : {}),
    ...(o.shellCd ? { shellCd: true } : {}),
  }
}

/**
 * A refusal, said as keep's: a host with no task directory for this task refuses the line
 * (task_dir_unset: keep's wrapper reads WALNUT_TASK_DIR), whatever the caller wrote; a dialog risk
 * from the kept directory names it, and how to start elsewhere. A kept directory macOS guards is
 * itself the risk: the server's guard reads it as a `cd` there (host-exec.ts), the host's as the
 * wrapper's `trap` word resolved there; either is said as where the call would start.
 */
export function keepRefusal(err: unknown, host: string, keptDir?: string | null): unknown {
  if (!(err instanceof HostExecError)) return err
  if (err.code === 'may_prompt' && keptDir) {
    const own = /^`(?:cd|trap)` would (?:read|walk through) (.+?), which macOS guards/.exec(err.message)
    err.message = own && (own[1] === keptDir || own[1] === daemonCwd(keptDir))
      ? `This keep call would start in ${keptDir}, where this task's last keep call on ${host} ended, and macOS guards that place: a command run there can show a permission dialog on that Mac's screen and wait there for someone. Nothing ran. Give cwd to start somewhere else, or ask the user first and call again with allow_prompts: true.`
      : `${err.message} This keep call starts in ${keptDir}, where this task's last keep call on ${host} ended: give cwd to start somewhere else.`
    err.data = { ...err.data, keptDir }
    return err
  }
  if (err.code !== 'task_dir_unset') return err
  const tooLong = /too long/.test(err.message)
  err.message = tooLong
    ? `keep:true makes this line too long for the older Walnut daemon on ${host} to run with WALNUT_TASK_DIR, where keep keeps its state; nothing ran. Run it without keep, or shorten it (the daemon updates on its next connect).`
    : `keep:true keeps this task's shell state in its task directory on ${host}, and that host has no task directory for this task (WALNUT_TASK_DIR is unset there); nothing ran. Run it without keep.`
  return err
}
