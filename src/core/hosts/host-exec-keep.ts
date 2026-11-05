/**
 * host_exec `keep`: a call starts where this task's last keep call on the same host ended, its
 * working directory and its exported variables (new, changed and unset ones), with no process left
 * up between calls. Shell functions, aliases, unexported variables, options and traps do not carry.
 *
 * The server shapes the line, like strict (host-exec-strict.ts), so every daemon already deployed
 * runs it. bash only: under another shell the wrapper does nothing and the line runs as without keep.
 * Written for bash 3.2 (macOS /bin/bash: no associative arrays, no `${x@Q}`, no `declare -n`), 4 and 5.
 *
 * The state is two files on the host, in `$WALNUT_TASK_DIR/host-exec/` (one pair per task per host),
 * each written 0600 through a temp file and `mv` (two keep calls of one task at once: the last to end
 * wins). `keep.sh` is a bash file, the whole delta from a fresh shell: the inner bash's exported
 * environment is read BEFORE the file is sourced (the baseline), and at the end every exported
 * variable whose `declare -px` text is not one of the baseline's lines is written, and every baseline
 * name no longer exported becomes `unset`. Values never reach the output, the server or the answer.
 * `keep.cwd` is the directory alone, a path: this server reads it before a keep call that names no
 * cwd (keptCwd) and gives it to the daemon as the run's cwd, so the daemon's own checks (the macOS
 * permission guard, the Command Line Tools check, every wait_for file) see the directory the line
 * starts in. A host that cannot hand it over gets the shell entering it itself (`shellCd`), after
 * those checks, and the answer says so.
 *
 * Saved by an EXIT trap: on a normal end, `exit N`, and SIGTERM (host_exec_stop and a deadline send
 * it first; bash runs its EXIT trap then). Not saved when the line sets its own EXIT trap (it replaces
 * Walnut's), `exec`s, is killed by SIGKILL, or runs in the background (it ends much later, and would
 * write an old state over a newer one). Restore runs before strict's prefix: no set -e, no ERR trap.
 */
import path from 'node:path'
import type { ExecParams } from './host-exec.js'
import { HostExecError } from './host-exec-target.js'
import { strictLine } from './host-exec-strict.js'
import { taskDirPath } from '../../lib/task-dir.js'

/** Where the state lives, under the task's directory on the host. */
export const KEEP_FILE = 'host-exec/keep.sh'
/** The kept directory alone, beside it: a path, never a value. */
export const KEEP_CWD_FILE = 'host-exec/keep.cwd'
/** The longest keep.cwd read (a path: PATH_MAX is 4096 on Linux, 1024 on macOS). */
const KEEP_CWD_MAX = 4_096

/** The line a save that could not complete prints on the run's stderr: no value in it, read back by notSavedWhy. */
const NOT_SAVED = 'walnut: keep could not save this run\'s state'
const NOT_SAVED_TAIL = 'the next keep call starts from the last saved one'

/** Names never carried: the shell's own, the run's own, Walnut's, bash's. */
const SKIP = '""|PWD|OLDPWD|SHLVL|_|WALNUT_HOST_EXEC_JOB|WALNUT_TASK_DIR|walnut_*|BASH_*'
/** The next name of `$walnut_r`, a newline-ended list (no `read`: IFS and here-strings stay out of it). */
const NEXT = 'walnut_n=${walnut_r%%"$walnut_nl"*}; walnut_r=${walnut_r#*"$walnut_nl"}'
/** Every name the save assigns: one the line made readonly stops it before it starts. */
export const KEEP_SAVE_NAMES = ['walnut_nl', 'walnut_kt', 'walnut_kc', 'walnut_ke', 'walnut_kd', 'walnut_s', 'walnut_r', 'walnut_n', 'walnut_d', 'walnut_f', 'walnut_w']
const say = (why: string) => `\\builtin printf "${NOT_SAVED} (%s); ${NOT_SAVED_TAIL}\\n" ${why} >&4`

/**
 * The EXIT trap's first line, run before anything else and parsed alone: bash reads the trap's next
 * line only after it ran. No xtrace or verbose, with whatever they would print going nowhere (stderr,
 * and a BASH_XTRACEFD of 3 to 9; one of 10 or more is not covered: a trace line holds values), and no
 * alias expansion. Backslash-quoted words are never alias-expanded (an alias named `{` or `}` is not
 * covered); under set -v this one line is echoed, it holds no value.
 */
export const TRAP_FIRST_LINE = '{ \\builtin set +xv; } 2>/dev/null 3>/dev/null 4>/dev/null 5>/dev/null 6>/dev/null 7>/dev/null 8>/dev/null 9>/dev/null; \\builtin shopt -u expand_aliases'

/**
 * The EXIT trap. After its first line: no -e, -u, -a or posix (a failure here would change the run's
 * exit code; allexport would hand the state to mv's environment), no strict ERR trap (it would name
 * a step of Walnut's), no nocasematch (the baseline test compares exact text). The save runs in a
 * subshell, so nothing in it (a readonly name, a failed write) changes the run's exit code or signal;
 * its own errors go nowhere, and one that stops it says so in one line with no value (`say`, on fd 4:
 * the run's stderr). The shell waits for it with its stderr on /dev/null: that wait reaps a job a
 * signal ended, and bash would print "Terminated" for it, a line the run without keep never has. The
 * state text is made whole first; then nothing is exported, so mkdir, mv and rm start with an empty
 * environment (`command -p`: the default PATH) whatever size the line's exports had.
 */
const TRAP = [
  TRAP_FIRST_LINE,
  '\\builtin set +eua +o posix; \\builtin trap - ERR DEBUG; \\builtin shopt -u nocasematch',
  // Bare exec: through builtin or command its redirections end with it (a readonly function named exec
  // is not covered). fd 4 is closed first, so with no stderr it is not left a file of the line's; no
  // posix mode, so a failed exec does not end the trap.
  '{ \\builtin unset -f exec; } 2>/dev/null; \\exec 4>&-; \\exec 4>&2; {',
  '(',
  // Read from what it prints, never its status: bash 3.2 ends a subshell on the error, inside an EXIT trap with the run's status.
  `case $({ ${KEEP_SAVE_NAMES.map((n) => `${n}=`).join(' ')} && \\builtin printf ok; } 2>/dev/null) in (ok) ;; (*) ${say('"the line made a walnut_ variable readonly"')}; \\builtin exit;; esac`,
  '{ \\builtin umask 077; walnut_nl=$\'\\n\'; walnut_w=; walnut_ke=$(\\builtin compgen -e); walnut_kt=$walnut_kf.$$.$RANDOM; walnut_kc=${walnut_kf%/*}/keep.cwd; walnut_kd=${PWD:-$(\\builtin pwd)}',
  'walnut_s=$(\\builtin printf "%s\\n" "# Walnut host_exec keep: this task\'s state on this host, read by its next keep call"; \\builtin declare -p walnut_kd',
  // Exported now and not as it was in the baseline (the whole declare text, as a whole line set there); never a readonly one.
  // Every case pattern opens with `(`: bash 3.2 and 4 end a `$( … )` at a pattern's lone `)`.
  `walnut_r=$walnut_ke$walnut_nl; while [[ -n $walnut_r ]]; do ${NEXT}; case $walnut_n in (${SKIP}) continue;; esac`
    + '; walnut_d=$(\\builtin declare -px "$walnut_n") || continue; walnut_f=${walnut_d#"declare -"}; case ${walnut_f%%" "*} in (*r*) continue;; esac'
    + '; case "$walnut_nl$walnut_kb$walnut_nl" in (*"$walnut_nl$walnut_d$walnut_nl"*) continue;; esac; \\builtin printf "%s\\n" "$walnut_d"; done',
  // Exported in the baseline and not now.
  `walnut_r=$walnut_kn$walnut_nl; while [[ -n $walnut_r ]]; do ${NEXT}; case $walnut_n in (${SKIP}) continue;; esac`
    + '; case "$walnut_nl$walnut_ke$walnut_nl" in (*"$walnut_nl$walnut_n$walnut_nl"*) continue;; esac; \\builtin printf "unset -v %s\\n" "$walnut_n"; done)',
  // The text is whole: nothing exported from here (a value over the kernel's limit for one stops any program).
  `walnut_r=$walnut_ke$walnut_nl; while [[ -n $walnut_r ]]; do ${NEXT}; \\builtin export -n "$walnut_n"; done`,
  `walnut_r=$(\\builtin compgen -A function)$walnut_nl; while [[ -n $walnut_r ]]; do ${NEXT}; \\builtin export -fn "$walnut_n"; done`,
  'if [[ $walnut_kf != /*/host-exec/keep.sh ]]; then walnut_w="the line changed a walnut_ variable"',
  'elif ! { [[ -d ${walnut_kf%/*} ]] || \\builtin command -p mkdir -p -- "${walnut_kf%/*}"; }; then walnut_w="its folder in the task directory cannot be made"',
  // The last line of keep.sh: a file cut short has none, and is never read.
  'elif ! { \\builtin printf "%s\\nwalnut_kz=1\\n" "$walnut_s" >| "$walnut_kt" && \\builtin printf "%s" "$walnut_kd" >| "$walnut_kt.d"; }; then walnut_w="it cannot be written in the task directory"',
  'elif ! { \\builtin command -p mv -f -- "$walnut_kt" "$walnut_kf" && \\builtin command -p mv -f -- "$walnut_kt.d" "$walnut_kc"; }; then walnut_w="it cannot be put in place in the task directory"',
  'fi; [[ -z $walnut_w ]] || \\builtin command -p rm -f -- "$walnut_kt" "$walnut_kt.d"; } 2>/dev/null',
  `[[ -z $walnut_w ]] || ${say('"$walnut_w"')}`,
  ') >/dev/null; } 2>/dev/null',
].join('\n')

/**
 * `text` as one bash word that holds it exactly, its newlines too, on one physical line. A quote is
 * `\047`, never `\'`: another sh reads the word as `$` and a single-quoted string, which it parses
 * (and never runs) only while nothing in it ends the quotes.
 */
const ansiC = (text: string) => `$'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\047').replace(/\n/g, '\\n')}'`

/** Into the kept directory in the shell (a host that cannot hand it over); a note on stderr (fd 3) when it cannot. */
const CD = 'if [ -n "$walnut_kd" ]; then if [ ! -d "$walnut_kd" ]; then builtin printf \'walnut: the kept directory %s is gone; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3'
  + '; elif ! builtin cd -- "$walnut_kd"; then builtin printf \'walnut: the kept directory %s cannot be entered; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3; fi; fi'

/**
 * The restore: the baseline first, then the state file, sourced only when a trial in a subshell got
 * to its last line (a file cut short or broken is ignored, with a note). Run with stderr closed off
 * (a trace line from an inherited xtrace would hold values); fd 3 is the run's stderr, for the notes.
 */
function restore(shellCd: boolean): string {
  return [
    "walnut_nl=$'\\n'; walnut_kf=\"$WALNUT_TASK_DIR/" + KEEP_FILE + '"; walnut_kd=; walnut_kz='
      + '; walnut_kn=$(builtin compgen -e); walnut_kb=$(builtin declare -px)',
    'if [ -f "$walnut_kf" ]; then if (. "$walnut_kf" && [ "$walnut_kz" = 1 ]) >/dev/null 2>&1; then . "$walnut_kf" >/dev/null'
      + "; else builtin printf 'walnut: the kept state in %s cannot be read; this run starts without it\\n' \"$walnut_kf\" >&3; fi; fi",
    ...(shellCd ? [CD] : []),
  ].join('; ')
}

/** The text that goes before the line: one physical line, so bash counts the caller's lines as written. */
export function keepPrefix(o: { shellCd: boolean; save: boolean }): string {
  return `if [ -n "\${BASH_VERSION:-}" ]; then { ${restore(o.shellCd)}${o.save ? `; trap ${ansiC(TRAP)} EXIT` : ''}; } 3>&2 2>/dev/null; fi`
}

/**
 * The line a call runs, shaped by strict and keep; null when neither applies (the line goes as it is).
 * With both, keep's restore comes first, and its EXIT trap stands in for strict's own `trap : EXIT`
 * (it stops bash 3.2 and 4 from exec'ing the last command just the same); a background run sets no
 * EXIT trap of keep's, so strict keeps its own. `shellCd`: the shell enters the kept directory itself
 * (a host that could not hand it over, and no cwd named); otherwise the run's cwd is the kept one.
 */
export function shapedLine(params: Pick<ExecParams, 'command' | 'strict' | 'keep' | 'background' | 'cwd'>, jobId: string, o: { shellCd?: boolean } = {}): string | null {
  const command = typeof params.command === 'string' && params.command.trim() !== '' ? params.command : null
  if (command === null) return null
  const strict = params.strict === true
  if (params.keep !== true) return strict ? strictLine(command, jobId) : null
  const save = params.background !== true
  const body = strict ? strictLine(command, jobId, { exitTrap: !save }) : command
  return `${keepPrefix({ shellCd: o.shellCd === true && !named(params.cwd), save })}; ${body}`
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

/** keep.cwd as the host holds it: the kept directory, or null (empty, too long, not UTF-8 as written, not absolute). */
export function keptDirOf(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > KEEP_CWD_MAX) return null
  const dir = bytes.toString('utf8')
  return Buffer.from(dir, 'utf8').equals(bytes) && dir.startsWith('/') && !dir.includes('\0') ? dir : null
}

/** Where a keep call with no cwd starts: the kept directory (null: none kept), or the shell enters it itself. */
export type KeptCwd = { dir: string | null } | { shellCd: true }

/**
 * The directory this task's last keep call on the host ended in, read there before the run: ONE
 * fs.readRange of keep.cwd (a required daemon command since long before host_exec; `read` bounds
 * its time). No file is no kept directory. A host that cannot hand it over (no fs.readRange, no task
 * directory root told, a read it refuses: a follower's scope, a file it may not read) gets the shell
 * entering it itself. A read that fails on the way (`read` throws) ends the call: nothing ran yet.
 */
export async function keptCwd(conn: { hasCapability: (c: string) => boolean; taskDirRoot?: string | null }, taskId: string, read: (params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<KeptCwd> {
  const dir = typeof conn.taskDirRoot === 'string' && conn.taskDirRoot.startsWith('/') ? taskDirPath(conn.taskDirRoot, taskId) : null
  if (!dir || !conn.hasCapability('fs.readRange')) return { shellCd: true }
  const reply = await read({ path: path.posix.join(dir, KEEP_CWD_FILE), start: 0, length: KEEP_CWD_MAX + 1 })
  if (reply.ok !== true) return /\((?:ENOENT|ENOTDIR|ENOTFILE)\)/.test(String(reply.error ?? '')) ? { dir: null } : { shellCd: true }
  const data = typeof reply.data === 'string' ? Buffer.from(reply.data, 'base64') : Buffer.alloc(0)
  return { dir: typeof reply.fileSize === 'number' && reply.fileSize !== data.length ? null : keptDirOf(data) }
}

/** Why the run's save did not complete, from its own line on stderr (the last one), or null. */
export function notSavedWhy(output: string): string | null {
  const re = new RegExp(`(?:^|\\n)${NOT_SAVED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(([^)\\n]{1,120})\\); ${NOT_SAVED_TAIL}(?=\\n|$)`, 'g')
  let why: string | null = null
  for (const m of output.matchAll(re)) why = m[1]!
  return why
}

/**
 * What keep did, for the answer: `saves` (false for a background run), `saved: false` with `why` when
 * the run's output says the save did not complete, `gone` (a kept directory the host no longer has:
 * the run started in the fresh cwd), `notEntered` (one the shell could not start in: nothing ran),
 * `shellCd` (the shell entered it itself, after the host's checks).
 */
export function keepAnswer(o: { background: boolean; out: Record<string, unknown>; kept: KeptCwd | null; gone?: string }): Record<string, unknown> {
  const ended = o.out.running !== true
  const why = !o.background && ended && typeof o.out.output === 'string' ? notSavedWhy(o.out.output) : null
  const keptDir = o.kept && 'dir' in o.kept && !o.gone ? o.kept.dir : null
  // A shell that never started (the host could not enter the directory) ends with neither a code nor a signal.
  const notEntered = keptDir && ended && o.out.exitCode === null && o.out.signal === null && o.out.timedOut !== true && !o.out.blocked ? keptDir : null
  return {
    saves: !o.background,
    ...(why ? { saved: false, why } : {}),
    ...(o.gone ? { gone: o.gone } : {}),
    ...(notEntered ? { notEntered } : {}),
    ...(o.kept && 'shellCd' in o.kept ? { shellCd: true } : {}),
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
    err.message = own && own[1] === keptDir
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
