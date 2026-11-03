/**
 * What a host_exec job runs (host-exec-core.ts): the line from a request, the shell that runs it,
 * and the whole lines of a window into its output (lineSpan).
 *
 * Which shell (host-exec-v2): the user's login shell starts first (`-l`), so
 * its profile sets PATH and the environment the way the user's sessions get
 * them, and then execs bash (sh on a host with none) to run the line. The
 * agents that send a line write bash, and zsh, the macOS login shell, reads it
 * differently without a word: `log` is a zsh builtin (`log show` says "too
 * many arguments"), a word starting with `=` is a command lookup (`echo ===`
 * fails "== not found"), an unmatched glob or a `?` in a URL stops the line
 * (2026-11-03, a session on a user's Mac). A bash login shell runs the line
 * itself.
 *
 * `argv` runs a program with no shell parsing at all: each argument is quoted
 * for the shell, which only finds the program on the user's PATH (`exec`).
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import fs from 'node:fs'
import path from 'node:path'

const COMMAND_MAX_CHARS = 64 * 1024
const ARGV_MAX = 256
const ARG_MAX_CHARS = 8 * 1024

export type ExecError = { ok: false; code: 'bad_request' | 'cwd_missing' | 'spawn_failed' | 'unknown_job' | 'task_dir_unset' | 'job_exists' | 'may_prompt'; error: string }

/**
 * The whole lines of a window into a job's output: a window that starts inside a line
 * drops that partial line, and one that may end inside a line (the job still writes,
 * or more follows) stops at the last newline. The server hides credential-looking
 * lines one line at a time, so a token cut in two at a window's edge would pass as
 * two harmless halves. A window with no newline at all is kept whole.
 */
export function lineSpan(buf: Buffer, startsMid: boolean, mayEndMid: boolean): { start: number; end: number } {
  let start = 0
  if (startsMid) {
    const nl = buf.indexOf(0x0a)
    if (nl !== -1 && nl + 1 < buf.length) start = nl + 1
    else if (nl === -1) while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start++
  }
  let end = buf.length
  if (mayEndMid && end > start && buf[end - 1] !== 0x0a) {
    const nl = buf.lastIndexOf(0x0a)
    if (nl >= start) end = nl + 1
    else {
      // One long line with no newline yet: at least never end inside a character.
      let i = end - 1
      while (i > start && end - i < 4 && (buf[i] & 0xc0) === 0x80) i--
      const lead = buf[i]
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (end - i < need) end = i
    }
  }
  return { start, end }
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

export function bad(error: string, code: ExecError['code'] = 'bad_request'): ExecError {
  return { ok: false, code, error }
}

/** The shell line a request runs, or an error. */
export function commandLine(req: { command?: unknown; argv?: unknown }): string | ExecError {
  const hasCommand = typeof req.command === 'string' && req.command.trim() !== ''
  const hasArgv = Array.isArray(req.argv) && req.argv.length > 0
  if (hasCommand === hasArgv) return bad('give exactly one of command (a shell line) or argv (a program and its arguments)')
  if (hasCommand) {
    const c = req.command as string
    if (c.length > COMMAND_MAX_CHARS || c.includes('\0')) return bad(`command must be under ${COMMAND_MAX_CHARS} characters, with no NUL`)
    return c
  }
  const argv = req.argv as unknown[]
  if (argv.length > ARGV_MAX || !argv.every((a) => typeof a === 'string' && a.length <= ARG_MAX_CHARS && !a.includes('\0'))) {
    return bad(`argv must be at most ${ARGV_MAX} strings of at most ${ARG_MAX_CHARS} characters, with no NUL`)
  }
  if (!(argv[0] as string)) return bad('argv[0] (the program) is empty')
  return 'exec ' + (argv as string[]).map(shellQuote).join(' ')
}

function runsAsProgram(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/**
 * Where bash is looked for, in order (the same on every run): a Homebrew or MacPorts bash first,
 * since a Mac's /bin/bash is 3.2 (no `declare -A`, no `${x,,}`, no `mapfile`), then the system one.
 * host-exec-legacy.ts LEGACY_RUNNER tries the same list.
 */
export const BASH_CANDIDATES = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/opt/local/bin/bash', '/bin/bash', '/usr/bin/bash']

/** This host's bash: the first of BASH_CANDIDATES there, else the first on PATH; null for none. */
export function findBash(envPath: string | undefined, isProgram: (file: string) => boolean = runsAsProgram): string | null {
  const onPath = (envPath ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'bash'))
  return [...BASH_CANDIDATES, ...onPath].find(isProgram) ?? null
}

/** Login shells whose quoting is not POSIX (fish reads `\\` inside single quotes, csh refuses a newline in them). */
const NON_POSIX_LOGIN = new Set(['fish', 'csh', 'tcsh'])
/** Where the line waits for bash under such a login shell (unset before the line runs). */
export const LINE_ENV = 'WALNUT_HOST_EXEC_LINE'

/**
 * How a line runs: the login shell with `-l` sets up the environment, then execs
 * bash (sh when there is none) on the line, which reaches it as one quoted word.
 * A bash login shell runs the line itself. Under fish or csh the line never passes
 * through their quoting: it rides the environment, and bash reads it from there.
 */
export function shellPlan(loginShell: string, bash: string | null, line: string): { args: string[]; shell: string; loginShell: string; env?: Record<string, string> } {
  const login = loginShell || '/bin/sh'
  const inner = bash || '/bin/sh'
  const loginName = path.basename(login)
  if (loginName === 'bash' || login === inner) return { args: ['-l', '-c', line], shell: loginName, loginShell: loginName }
  if (NON_POSIX_LOGIN.has(loginName)) {
    const hop = `exec ${shellQuote(inner)} -c '__walnut_line=$${LINE_ENV}; unset ${LINE_ENV}; eval "$__walnut_line"'`
    // csh and tcsh take -l only as their one flag.
    const args = loginName === 'fish' ? ['-l', '-c', hop] : ['-c', hop]
    return { args, shell: path.basename(inner), loginShell: loginName, env: { [LINE_ENV]: line } }
  }
  return { args: ['-l', '-c', `exec ${shellQuote(inner)} -c ${shellQuote(line)}`], shell: path.basename(inner), loginShell: loginName }
}
