/**
 * A vitest test timeout, as the baseline gate reads it. vitest builds the timeout
 * error by copying the stack of an error it made when the test was defined, whose
 * message is "STACK_TRACE_ERROR", and replacing that message with its own text; the
 * copied stack keeps the placeholder (bun and node alike), so the JSON report's failure reads
 * "Error: STACK_TRACE_ERROR" and nothing else (2026-11-01: a parity test that ran 32 s
 * against the 30 s limit was read as a broken test for two CI runs).
 */
const PLACEHOLDER = /^(\s*)Error: STACK_TRACE_ERROR\s*$/m

export const TIMEOUT_WORDS = 'Error: the test timed out (vitest testTimeout; its report reads STACK_TRACE_ERROR)'

/** The failure message with vitest's timeout placeholder named for what it is. */
export function nameTestTimeout(message) {
  return typeof message === 'string' ? message.replace(PLACEHOLDER, `$1${TIMEOUT_WORDS}`) : message
}
