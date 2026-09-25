/**
 * How the daemon connect path runs a command on a remote host: always through
 * POSIX `sh`, never through the user's login shell, and only the text between
 * two markers counts as the answer.
 *
 * `ssh host CMD` hands CMD to the login shell (`$SHELL -c CMD`). A csh or fish
 * login shell rejects POSIX syntax (`$(...)`, `2>&1`, `||`), and an rc file that
 * prints a banner on stdout corrupts every answer Walnut parses as JSON or as a
 * port number. Two rules fix both:
 *   - the remote command is the literal `sh -s`, which any shell can run, and
 *     the script travels on stdin, so nothing but sh ever parses it;
 *   - the script prints __WALNUT_BEGIN__ and __WALNUT_END__ around its own
 *     output, so whatever an rc file prints before or after is dropped.
 * A zero exit without the markers means the script never ran as written (a
 * ForceCommand, a login shell that is not a shell): that is `shell_noise`.
 *
 * The user's login shell is still used on purpose in exactly one place, the
 * PATH capture for the node runtime (userShellPathScript), so a zsh user's
 * ~/.zshrc is read by zsh and never by sh.
 */

import { spawn } from 'node:child_process'

export const REMOTE_BEGIN_MARKER = '__WALNUT_BEGIN__'
export const REMOTE_END_MARKER = '__WALNUT_END__'
/** The whole remote command line the login shell ever sees for a scripted call. */
export const REMOTE_SH_COMMAND = 'sh -s'

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const NOISE_PREVIEW_CHARS = 200

/** POSIX single quote: safe against spaces, $, backticks, semicolons. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The stdin text for `sh -s`. The script runs in a subshell with stdin from
 * /dev/null: sh must parse the whole `( ... )` before running any of it, so a
 * command inside that reads stdin can never swallow the rest of the script, and
 * an `exit` inside still reaches the END marker.
 */
export function wrapRemoteScript(script: string): string {
  return [
    `echo ${REMOTE_BEGIN_MARKER}`,
    '(',
    script,
    ') </dev/null',
    'walnut_rc=$?',
    'echo',
    `echo ${REMOTE_END_MARKER}`,
    'exit $walnut_rc',
    '',
  ].join('\n')
}

export type MarkedOutput = { found: true; body: string } | { found: false }

/** The text between the first BEGIN line and the last END line after it. */
export function extractMarkedOutput(stdout: string): MarkedOutput {
  const lines = stdout.split('\n')
  const begin = lines.findIndex((l) => l.replace(/\r$/, '') === REMOTE_BEGIN_MARKER)
  if (begin < 0) return { found: false }
  let end = -1
  for (let i = lines.length - 1; i > begin; i--) {
    if (lines[i].replace(/\r$/, '') === REMOTE_END_MARKER) { end = i; break }
  }
  if (end < 0) return { found: false }
  const body = lines.slice(begin + 1, end)
  // The wrapper's own `echo` before END adds one empty line.
  if (body.length > 0 && body[body.length - 1] === '') body.pop()
  return { found: true, body: body.join('\n') }
}

/** ssh exited 0 but the reply carried no markers: the remote shell did not run the script. */
export class RemoteShellNoiseError extends Error {
  readonly preview: string
  constructor(host: string, output: string) {
    const preview = output.replace(/\s+/g, ' ').trim().slice(0, NOISE_PREVIEW_CHARS)
    super(`shell_noise: the login shell on ${host} answered without Walnut's output markers `
      + `(it did not run \`${REMOTE_SH_COMMAND}\` as written). It printed: ${preview || '(nothing)'}`)
    this.name = 'RemoteShellNoiseError'
    this.preview = preview
  }
}

/** A remote command that exited non-zero. `code` 255 is ssh's own failure (auth, network, host key). */
export class RemoteCommandError extends Error {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  constructor(message: string, fields: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) {
    super(message)
    this.name = 'RemoteCommandError'
    this.code = fields.code
    this.stdout = fields.stdout
    this.stderr = fields.stderr
    this.timedOut = fields.timedOut
  }
}

/** True when the failure is the link itself, not the command: every later command would fail the same way. */
export function isSshTransportFailure(err: unknown): boolean {
  if (err instanceof RemoteShellNoiseError) return true
  return err instanceof RemoteCommandError && err.code === 255 && !err.timedOut
}

interface RawRun { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: Error }

function runSsh(args: string[], input: string, timeoutMs: number): Promise<RawRun> {
  return new Promise((resolve) => {
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (run: RawRun) => { if (!settled) { settled = true; clearTimeout(timer); resolve(run) } }
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM') }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString() })
    proc.stdin.on('error', () => { /* ssh died before reading the script: the exit code says why */ })
    proc.on('error', (err) => finish({ stdout, stderr, code: null, timedOut, spawnError: err }))
    proc.on('close', (code) => finish({ stdout, stderr, code, timedOut }))
    proc.stdin.end(input)
  })
}

/**
 * Run `script` on the host behind `sshArgs` (the ssh options plus the target,
 * no remote command) and return the marked output, trimmed. Rejects with
 * RemoteCommandError on a non-zero exit or timeout (stderr in the message, the
 * way execFile reports it), and RemoteShellNoiseError when a zero exit came
 * back without the markers.
 */
export async function runRemoteSh(sshArgs: string[], script: string, timeoutMs: number): Promise<string> {
  const host = sshArgs[sshArgs.length - 1] ?? 'host'
  const run = await runSsh([...sshArgs, REMOTE_SH_COMMAND], wrapRemoteScript(script), timeoutMs)
  if (run.spawnError) throw run.spawnError
  const stderr = run.stderr.trim()
  // First line in execFile's shape ("Command failed: <cmd>"), so the summary and
  // the classifier skip it the way they skip an echoed command; the diagnosis
  // (ssh's own stderr) follows on its own lines.
  const head = `Command failed: ssh ${host} ${REMOTE_SH_COMMAND}`
  if (run.timedOut) {
    throw new RemoteCommandError(
      `${head}\nRemote command timed out after ${timeoutMs}ms${stderr ? `\n${stderr}` : ''}`,
      { code: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: true },
    )
  }
  if (run.code !== 0) {
    throw new RemoteCommandError(
      `${head}\n${stderr || `remote command exited with code ${run.code}`}`,
      { code: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: false },
    )
  }
  const marked = extractMarkedOutput(run.stdout)
  if (!marked.found) throw new RemoteShellNoiseError(host, run.stdout || run.stderr)
  return marked.body.trim()
}

/**
 * The remote command for an ssh whose STDIN carries data (an upload): `sh -c`
 * around one line, so the login shell only ever sees a quoted word. csh cannot
 * hold a newline inside quotes and fish reads backslashes there, hence the
 * refusal rather than a quoting trick.
 */
export function shDataCommand(line: string): string {
  if (/[\n\\!]/.test(line)) {
    throw new Error('shDataCommand: the command must be one line without backslashes or "!"')
  }
  return `sh -c ${shq(line)}`
}

/**
 * An upload command whose verification output is marked: `cat > path`, then the
 * markers around `verify`. Pair with extractMarkedOutput on the reply.
 */
export function markedUploadCommand(remotePath: string, verify?: string): string {
  const write = `cat > ${shq(remotePath)}`
  if (!verify) return shDataCommand(write)
  return shDataCommand(`${write} && echo ${REMOTE_BEGIN_MARKER} && ${verify} && echo ${REMOTE_END_MARKER}`)
}

/**
 * Shell lines (for a `sh -s` script) that give it the PATH the user's own shell
 * builds with `preamble`: the preamble runs in $SHELL when that is a POSIX-family
 * shell, which is what it was written for (it sources ~/.zshrc under zsh), and
 * only the resulting PATH comes back. csh, fish or a shell that fails falls back
 * to running the preamble in sh itself.
 */
export function userShellPathScript(preamble: string): string {
  const inner = `${preamble}; printf '\\n__WALNUT_PATH__=%s\\n' "$PATH"`
  return [
    'walnut_user_path=',
    'case "${SHELL##*/}" in',
    '  bash|zsh|sh|dash|ksh|mksh|yash)',
    `    walnut_user_path=$("$SHELL" -c ${shq(inner)} </dev/null 2>/dev/null | sed -n 's/^__WALNUT_PATH__=//p' | tail -n 1) ;;`,
    'esac',
    'if [ -n "$walnut_user_path" ]; then PATH=$walnut_user_path; export PATH; else',
    preamble || 'true',
    'fi',
  ].join('\n')
}
