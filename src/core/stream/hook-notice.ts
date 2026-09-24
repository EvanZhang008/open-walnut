/**
 * CLI hook lifecycle lines: silent when the hook works, one readable row when it fails.
 *
 * `claude -p --output-format stream-json --verbose` reports every SessionStart and
 * Setup hook as a `hook_started` + `hook_response` pair (fork `cli/print.ts`,
 * `ALWAYS_EMITTED_HOOK_EVENTS` in `utils/hooks/hookEvents.ts`), so a user with a
 * SessionStart hook gets the pair on every spawn and every resume. The unknown-subtype
 * catch-all used to render each one as a raw "hook_response ›" row with its JSON as
 * the detail: noise on every session, and it landed in a promo GIF.
 *
 * A hook that FAILED is different: the user's own hook broke, so whatever it was meant
 * to do (inject context, set up the environment) did not happen. That one row stays.
 *
 * Shared by the live parser (providers/claude-code-session.ts) and the history parser
 * (core/session-history.ts) so a reload shows exactly the rows the live view did.
 */

export const HOOK_LIFECYCLE_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_progress',
  'hook_response',
])

export interface HookFailureNotice {
  message: string
  detail?: string
}

const DETAIL_MAX = 500

/** The row for a failed `hook_response`, or null for anything a reader needn't see
 *  (a start, a progress tick, a success, a cancelled hook). */
export function hookFailureNotice(line: Record<string, unknown>): HookFailureNotice | null {
  if (line.subtype !== 'hook_response' || line.outcome !== 'error') return null
  const name = typeof line.hook_name === 'string' && line.hook_name
    ? line.hook_name
    : typeof line.hook_event === 'string' && line.hook_event ? line.hook_event : 'A'
  const exit = typeof line.exit_code === 'number' ? ` (exit ${line.exit_code})` : ''
  const said = [line.stderr, line.stdout, line.output]
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return {
    message: `${name} hook failed${exit}`,
    ...(said ? { detail: said.trim().slice(0, DETAIL_MAX) } : {}),
  }
}
