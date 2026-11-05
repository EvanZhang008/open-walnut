/**
 * host_exec `keep`: a call starts where this task's last keep call on the same host ended, its
 * working directory and its exported variables (new, changed and unset ones), with no process left
 * up between calls. Shell functions, aliases, unexported variables, options and traps do not carry.
 *
 * The server shapes the line, like strict (host-exec-strict.ts), so every daemon already deployed
 * runs it. bash only: under another shell the wrapper does nothing and the line runs as without keep.
 * Written for bash 3.2 (macOS /bin/bash: no associative arrays, no `${x@Q}`, no `declare -n`), 4 and 5.
 *
 * The state is a bash file on the host, `$WALNUT_TASK_DIR/host-exec/keep.sh` (one per task per host),
 * written 0600 through a temp file and `mv` (two keep calls of one task at once: the last to end
 * wins). It is the whole delta from a fresh shell: the inner bash's exported environment is read
 * BEFORE the file is sourced (the baseline), and at the end every exported variable whose
 * `declare -px` text is not one of the baseline's lines is written, and every baseline name no longer
 * exported becomes `unset`. Values never reach the output, the server or the answer.
 *
 * Saved by an EXIT trap: on a normal end, `exit N`, and SIGTERM (host_exec_stop and a deadline send
 * it first; bash runs its EXIT trap then). Not saved when the line sets its own EXIT trap (it replaces
 * Walnut's), `exec`s, is killed by SIGKILL, or runs in the background (it ends much later, and would
 * write an old state over a newer one). Restore runs before strict's prefix: no set -e, no ERR trap.
 */
import type { ExecParams } from './host-exec.js'
import { HostExecError } from './host-exec-target.js'
import { strictLine } from './host-exec-strict.js'

/** Where the state lives, under the task's directory on the host. */
export const KEEP_FILE = 'host-exec/keep.sh'

/** Names never carried: the shell's own, the run's own, Walnut's, bash's. */
const SKIP = '""|PWD|OLDPWD|SHLVL|_|WALNUT_HOST_EXEC_JOB|WALNUT_TASK_DIR|walnut_*|BASH_*'
/** The next name of `$walnut_r`, a newline-ended list (no `read`: IFS and here-strings stay out of it). */
const NEXT = 'walnut_n=${walnut_r%%"$walnut_nl"*}; walnut_r=${walnut_r#*"$walnut_nl"}'

/**
 * The EXIT trap. Its first word marks it as Walnut's (OWN_COMMAND_RE, host-exec-strict.ts). Before
 * anything else: no xtrace or verbose (a value in a trace line), no -e or -u (a failure here would
 * change the run's exit code), no strict ERR trap (it would name a step of Walnut's), no
 * nocasematch (the baseline test compares exact text). Every write goes to the temp file only.
 */
const SAVE = [
  'walnut_ks=1',
  '{ builtin set +xv; } 2>/dev/null',
  '{ builtin set +eu; builtin trap - ERR; builtin shopt -u nocasematch; builtin umask 077',
  'walnut_ke=$(builtin compgen -e); walnut_kt="$walnut_kf.$$.$RANDOM"',
  '[ -d "${walnut_kf%/*}" ] || command -p mkdir -p "${walnut_kf%/*}" || command mkdir -p "${walnut_kf%/*}"',
  '{ builtin printf "%s\\n" "# Walnut host_exec keep: this task state on this host, read by its next keep call"',
  'walnut_kd=$PWD; builtin declare -p walnut_kd',
  // Exported now and not as it was in the baseline (the whole declare text, as a whole line set there); never a readonly one.
  `walnut_r="$walnut_ke$walnut_nl"; while [ -n "$walnut_r" ]; do ${NEXT}; case $walnut_n in ${SKIP}) continue;; esac`
    + '; walnut_d=$(builtin declare -px "$walnut_n") || continue; walnut_f=${walnut_d#"declare -"}; case ${walnut_f%%" "*} in *r*) continue;; esac'
    + '; case "$walnut_nl$walnut_kb$walnut_nl" in *"$walnut_nl$walnut_d$walnut_nl"*) continue;; esac; builtin printf "%s\\n" "$walnut_d"; done',
  // Exported in the baseline and not now.
  `walnut_r="$walnut_kn$walnut_nl"; while [ -n "$walnut_r" ]; do ${NEXT}; case $walnut_n in ${SKIP}) continue;; esac`
    + '; case "$walnut_nl$walnut_ke$walnut_nl" in *"$walnut_nl$walnut_n$walnut_nl"*) continue;; esac; builtin printf "unset -v %s\\n" "$walnut_n"; done',
  // The last line: a file cut short has none, and is never read.
  'builtin printf "%s\\n" walnut_kz=1; } >| "$walnut_kt" && { command -p mv -f "$walnut_kt" "$walnut_kf" || command mv -f "$walnut_kt" "$walnut_kf"; } || { command -p rm -f "$walnut_kt" || command rm -f "$walnut_kt"; }',
  '} >/dev/null 2>&1',
].join('; ')
if (SAVE.includes("'")) throw new Error('host-exec-keep: the EXIT trap must hold no single quote')

/** Into the kept directory, unless the call named its cwd; a note on stderr (fd 3) when it cannot. */
const CD = 'if [ -n "$walnut_kd" ]; then if [ ! -d "$walnut_kd" ]; then builtin printf \'walnut: the kept directory %s is gone; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3'
  + '; elif ! builtin cd -- "$walnut_kd"; then builtin printf \'walnut: the kept directory %s cannot be entered; this run starts in %s\\n\' "$walnut_kd" "$PWD" >&3; fi; fi'

/**
 * The restore: the baseline first, then the state file, sourced only when a trial in a subshell got
 * to its last line (a file cut short or broken is ignored, with a note). Run with stderr closed off
 * (a trace line from an inherited xtrace would hold values); fd 3 is the run's stderr, for the notes.
 */
function restore(cwdNamed: boolean): string {
  return [
    "walnut_nl=$'\\n'; walnut_kf=\"$WALNUT_TASK_DIR/" + KEEP_FILE + '"; walnut_kd=; walnut_kz='
      + '; walnut_kn=$(builtin compgen -e); walnut_kb=$(builtin declare -px)',
    'if [ -f "$walnut_kf" ]; then if (. "$walnut_kf" && [ "$walnut_kz" = 1 ]) >/dev/null 2>&1; then . "$walnut_kf" >/dev/null'
      + "; else builtin printf 'walnut: the kept state in %s cannot be read; this run starts without it\\n' \"$walnut_kf\" >&3; fi; fi",
    ...(cwdNamed ? [] : [CD]),
  ].join('; ')
}

/** The text that goes before the line: one physical line, so bash counts the caller's lines as written. */
export function keepPrefix(o: { cwdNamed: boolean; save: boolean }): string {
  return `if [ -n "\${BASH_VERSION:-}" ]; then { ${restore(o.cwdNamed)}; } 3>&2 2>/dev/null${o.save ? `; trap '${SAVE}' EXIT` : ''}; fi`
}

/**
 * The line a call runs, shaped by strict and keep; null when neither applies (the line goes as it is).
 * With both, keep's restore comes first, and its EXIT trap stands in for strict's own `trap : EXIT`
 * (it stops bash 3.2 and 4 from exec'ing the last command just the same); a background run sets no
 * EXIT trap of keep's, so strict keeps its own.
 */
export function shapedLine(params: Pick<ExecParams, 'command' | 'strict' | 'keep' | 'background' | 'cwd'>, jobId: string): string | null {
  const command = typeof params.command === 'string' && params.command.trim() !== '' ? params.command : null
  if (command === null) return null
  const strict = params.strict === true
  if (params.keep !== true) return strict ? strictLine(command, jobId) : null
  const save = params.background !== true
  const body = strict ? strictLine(command, jobId, { exitTrap: !save }) : command
  return `${keepPrefix({ cwdNamed: typeof params.cwd === 'string' && params.cwd.trim() !== '', save })}; ${body}`
}

/** A wrong `keep` is refused before anything runs: a boolean, and only with a shell line. */
export function checkKeep(keep: unknown, hasCommand: boolean): void {
  if (keep === undefined) return
  if (typeof keep !== 'boolean') throw new HostExecError('keep is true or false. Nothing ran.', 400, 'bad_request')
  if (keep && !hasCommand) {
    throw new HostExecError('keep keeps a shell\'s state, and argv runs one program with no shell: give the line as command. Nothing ran.', 400, 'bad_request')
  }
}

/**
 * A host with no task directory for this task refuses the line (task_dir_unset: keep's wrapper reads
 * WALNUT_TASK_DIR), whatever the caller wrote: said as keep's need, not as the caller's own line's.
 */
export function keepRefusal(err: unknown, host: string): unknown {
  if (!(err instanceof HostExecError) || err.code !== 'task_dir_unset') return err
  const tooLong = /too long/.test(err.message)
  err.message = tooLong
    ? `keep:true makes this line too long for the older Walnut daemon on ${host} to run with WALNUT_TASK_DIR, where keep keeps its state; nothing ran. Run it without keep, or shorten it (the daemon updates on its next connect).`
    : `keep:true keeps this task's shell state in its task directory on ${host}, and that host has no task directory for this task (WALNUT_TASK_DIR is unset there); nothing ran. Run it without keep.`
  return err
}
