import fs from 'node:fs'

export interface ToolCallErrorBody {
  code: string
  message: string
  detail?: unknown
}

export interface ToolCallFailure {
  ok: false
  error: ToolCallErrorBody
}

/** One failure; `notes` are extra lines joined into the message after it. */
export function toolCallFailure(
  code: string,
  message: string,
  notes: readonly string[] = [],
  detail?: unknown,
): ToolCallFailure {
  const lines = [message, ...notes].map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '')
  return {
    ok: false,
    error: { code, message: lines.join('\n'), ...(detail !== undefined ? { detail } : {}) },
  }
}

export interface ToolCallStreams {
  stdout: string
  stderr: string
}

/**
 * Whether this process's stderr is thrown away (`2>/dev/null`, or closed). A failure written there
 * would reach nobody: the caller then reads an empty stdout and takes it for a broken answer
 * (2026-11-22: a lead's `walnut tools call task_history ... 2>/dev/null > f` read an empty file
 * after its limit was refused). Such a failure goes to stdout instead, as with --json.
 */
export function stderrDiscarded(stat: (fd: number) => { dev: number; ino: number; rdev?: number } = fs.fstatSync,
  nullStat: () => { dev: number; ino: number; rdev?: number } | null = devNullStat): boolean {
  let err: { dev: number; ino: number; rdev?: number }
  try { err = stat(2) } catch { return true }
  const dn = nullStat()
  return !!dn && err.dev === dn.dev && err.ino === dn.ino
}

function devNullStat(): { dev: number; ino: number } | null {
  try { return fs.statSync(process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null') } catch { return null }
}

/** Where a call's failure goes: stdout with --json, or when stderr is thrown away. */
export function failureOnStdout(json: boolean): boolean {
  return json || stderrDiscarded()
}

/** Each stream's text. `partial` goes to stdout by default, into `error.detail` with --json. */
export function renderToolCallFailure(
  failure: ToolCallFailure,
  opts: { json: boolean; partial?: unknown },
): ToolCallStreams {
  const { json, partial } = opts
  if (json) {
    const error = failure.error.detail === undefined && partial !== undefined
      ? { ...failure.error, detail: partial }
      : failure.error
    return { stdout: JSON.stringify({ ok: false, error }) + '\n', stderr: '' }
  }
  const stdout = partial === undefined ? '' : JSON.stringify(partial, null, 2) + '\n'
  const error = partial !== undefined && failure.error.detail === partial
    ? { code: failure.error.code, message: failure.error.message }
    : failure.error
  return { stdout, stderr: JSON.stringify({ ok: false, error }) + '\n' }
}

/** The code of an op failure that has a message only, read from the opening src/ops/executor.ts writes. */
export function opFailureCode(message: string, fallback = 'op_failed'): string {
  if (message.startsWith('Invalid arguments for ')) return 'invalid_arguments'
  if (/^unknown op: /i.test(message)) return 'unknown_op'
  const api = /^Walnut API error \(([^)]+)\)/.exec(message)
  if (api) return /^\d+$/.test(api[1]) ? `http_${api[1]}` : api[1]
  if (message.startsWith('Walnut server not running')) return 'hub_unreachable'
  if (message.startsWith('Walnut request timed out')) return 'hub_timeout'
  if (message.startsWith('Walnut request failed')) return 'request_failed'
  return fallback
}

/** A gateway code, with its catch-alls (`internal`, `bad_request`) named as the hub CLI names them. */
export function gatewayFailureCode(code: string, message: string): string {
  return code === 'internal' || code === 'bad_request' ? opFailureCode(message, code) : code
}

export function splitToolsJsonFlag(args: readonly string[]): { args: string[]; json: boolean } {
  let json = false
  let i = 0
  while (args[i] === '--json') { json = true; i++ }
  const sub = args[i]
  if (sub !== 'call') return { args: args.slice(i), json }
  i++
  while (args[i] === '--json') { json = true; i++ }
  const name = args[i]
  if (name === undefined) return { args: ['call'], json }
  const tail = args.slice(i + 1)
  let t = 0
  while (tail[t] === '--json') { json = true; t++ }
  const rest = tail.slice(t)
  // Flag form: every word is the flag parser's.
  if (rest[0]?.startsWith('--')) return { args: ['call', name, ...rest], json }
  // JSON form: one argument, and a --json word anywhere after it.
  const kept: string[] = []
  rest.forEach((a, k) => {
    if (k > 0 && a === '--json') json = true
    else kept.push(a)
  })
  return { args: ['call', name, ...kept], json }
}
