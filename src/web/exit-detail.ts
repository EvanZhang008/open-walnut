/**
 * What a dying server records about the error that killed it.
 *
 * The exit log used to keep `err.message` alone. On 2026-10-24 the server died
 * of an uncaught `read ECONNRESET` (a socket's 'error' event that nothing
 * listened for), and the record named no socket, no stack and no errno, so the
 * owner could not be found. The stack (Node's printed form) names the emitter's
 * class and where the event was raised; `code` / `syscall` / `errno` say what the
 * OS refused. Neither names the code that opened the socket: that needs the
 * class, the frames and the log lines before it, read together.
 *
 * Redacted like every other raw error text that reaches a log line or a card.
 */
import { redactSensitiveText } from '../logging/redact.js'

/** The longest stack kept: a deep async chain says nothing new past this. */
export const EXIT_STACK_MAX_CHARS = 4_000

export interface ExitDetail {
  detail?: unknown
  code?: string
  syscall?: string
  errno?: number
  stack?: string
}

/**
 * The stack as Node prints it for an 'error' event nobody listened for: the
 * plain stack of a socket read is one frame (`at TCP.onStreamRead`), and only
 * Node's enhanced form adds "Emitted 'error' event on <Class> instance at: …",
 * which names the emitter's class (Socket, TLSSocket, a library's WebSocket)
 * and any library frame that emitted it. Node keeps it behind a symbol on the
 * error; another runtime has none, and the plain stack stands.
 */
function printedStack(e: Error): string | undefined {
  for (const sym of Object.getOwnPropertySymbols(e)) {
    if (sym.description !== 'kEnhanceStackBeforeInspector') continue
    const enhance = (e as unknown as Record<symbol, unknown>)[sym]
    if (typeof enhance !== 'function') continue
    try {
      const out = (enhance as () => unknown)()
      if (typeof out === 'string' && out) return out
    } catch { /* fall back to the plain stack */ }
  }
  return e.stack
}

/** A raw text redacted; a value that is not a string is printed first. */
function redacted(v: unknown): string {
  return redactSensitiveText(typeof v === 'string' ? v : String(v))
}

function describe(err: unknown): ExitDetail {
  if (!(err instanceof Error)) {
    if (err === undefined) return {}
    return { detail: typeof err === 'string' ? redacted(err) : err }
  }
  const e = err as NodeJS.ErrnoException
  const stack = printedStack(e)
  return {
    detail: redacted(e.message),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(typeof e.syscall === 'string' ? { syscall: e.syscall } : {}),
    ...(typeof e.errno === 'number' ? { errno: e.errno } : {}),
    ...(stack ? { stack: redacted(stack).slice(0, EXIT_STACK_MAX_CHARS) } : {}),
  }
}

/**
 * Never throws: it runs inside the uncaughtException handler, where a second
 * throw ends the process with code 7 before the exit record is written (an
 * error whose message or stack getter throws, say).
 */
export function exitDetail(err: unknown): ExitDetail {
  try {
    return describe(err)
  } catch {
    try { return { detail: redacted(err) } } catch { return { detail: '[unprintable error]' } }
  }
}
