/**
 * A refusal that says what it is: an error carrying a 4xx `status` (or 501: this box does not do
 * that by design) and a `code` of its own.
 *
 * Something a caller did that Walnut will not do (an argument, a rule of a plugin, a state that
 * refuses the call) is the caller's to fix, and every door answers it under that code. An error
 * with neither is a fault: the HTTP routes answer it 500 `internal`, an op's client reads
 * `internal`, and real use counts it as a thrown error, the server's own. 2026-11-26: a task
 * update whose description broke a sync plugin's content rule was thrown as a plain error class
 * and read `internal` that way, one day after four thread_update refusals did.
 *
 * Every door reads this one definition: the app's error handler and each router's funnel
 * (web/middleware/coded-refusal-answer.ts), and the op executor for a handler's throw, a plugin's
 * handler included (ops/executor.ts). A new error class is one or the other on purpose:
 * tests/core/coded-refusal-classes.test.ts lists the classes that carry no code.
 */

/** A code as Walnut writes them: lower case words joined by underscores (never ENOENT or ERR_BAD_REQUEST). */
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/** What an HTTP client's error carries of the answer it got. */
const OTHER_SERVICE = ['headers', 'response', 'request'] as const

export interface CodedRefusal {
  status: number
  code: string
  message: string
}

/** What `err` says it is when it is a refusal with its own status and code, else null. */
export function codedRefusalOf(err: unknown): CodedRefusal | null {
  if (!(err instanceof Error)) return null
  // Another service's answer passed along (an HTTP client's error keeps the response it got) is
  // that service refusing Walnut, never Walnut refusing its caller.
  if (OTHER_SERVICE.some((key) => key in err)) return null
  const { status, code } = err as { status?: unknown; code?: unknown }
  if (typeof status !== 'number' || !Number.isInteger(status) || ((status < 400 || status > 499) && status !== 501)) return null
  if (typeof code !== 'string' || code.length > 60 || !CODE.test(code)) return null
  return { status, code, message: err.message }
}

/** An argument the caller got wrong, by its status: counted as a bad argument, never a refusal of state. */
export const isBadArgumentStatus = (status: number): boolean => status === 400 || status === 422

/** An error that refuses under `code`, for a caller with no error class of its own (a plugin's handler). */
export function refusal(code: string, message: string, status = 400): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code })
}
