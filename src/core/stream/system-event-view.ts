/**
 * What a stream-json `system` line with no handler of its own shows the reader.
 *
 * The live parser (providers/claude-code-session.ts) handles the subtypes it knows
 * (compaction, retries, background tasks, hooks, ...). Everything else used to reach a
 * catch-all that rendered the subtype NAME plus its JSON: `vcs_state_changed
 * {"kind":"push","cwd":"/home/sample/.claude"}` between two step rows, splitting what
 * should have been one row (2026-10-26, the user: "the vcs changes should be combined
 * also"). CLI 2.1.284 reports some thirty subtypes Walnut has no handler for, so the
 * same leak was waiting for each of them.
 *
 * The rule now: a line shows only as words the CLI wrote for a person (`content`,
 * `message` or `text`), never as a name and a payload. A line with no words is logged,
 * which is where its diagnostic value belongs. A few lines carry their meaning in
 * fields rather than words (a refusal, a failed plugin install); those get a fixed
 * sentence here. The history parser keeps its own allowlist (core/session-history.ts)
 * for the transcript's line shapes, which are not the stream's.
 */

/**
 * Bookkeeping the CLI reports to every client but which means nothing to a reader.
 * Logged at debug and never rendered. Every entry must also read as bookkeeping to
 * the reconciler (isPostTurnBookkeeping in core/session-reconcile.ts): pinned by
 * tests/providers/silent-system-subtypes.test.ts. The cost of showing one is not a
 * wasted row: a card interrupts the model's text where it lands, so a
 * `commands_changed` line arriving mid-tag split one sentence into an empty pill plus
 * a leaked attribute (inc-1788209680147).
 */
export const SILENT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'commands_changed',          // slash-command list reloaded (fires on any .claude/commands edit)
  'control_request_progress',  // progress ticks for control reads Walnut itself issued
  'vcs_state_changed',         // a commit/push/merge/rebase happened; the git step that did it is already a row
])

/**
 * Lines whose words repeat something already on screen, so they would show the same
 * fact twice. `permission_denied`: the tool call's own result carries the refusal.
 * `code_change_published`: a pull request the step before it opened, whose output
 * already holds the link (the same emitter as `vcs_state_changed`). The two summary
 * subtypes are status cards for the CLI's remote-control layer; they are logged where
 * they arrive and never belong in the chat.
 */
const SHOWN_ELSEWHERE_SUBTYPES: ReadonlySet<string> = new Set([
  'permission_denied',
  'code_change_published',
  'post_turn_summary',
  'task_summary',
])

export type SystemEventView =
  | { show: true; variant: 'info' | 'error'; message: string; detail?: string }
  | { show: false; why: 'bookkeeping' | 'shown-elsewhere' | 'no-words' }

const HEADLINE_MAX = 200
const DETAIL_MAX = 2000

/** The words a line carries for a person, if any. */
function wordsOf(sys: Record<string, unknown>): string | undefined {
  return str(sys.content) ?? str(sys.message) ?? str(sys.text)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Lines whose meaning is in their fields: one fixed sentence, the reason as detail. */
function sentenceFor(subtype: string, sys: Record<string, unknown>): SystemEventView | undefined {
  if (subtype === 'model_refusal_no_fallback' && !wordsOf(sys)) {
    // The CLI writes `content: ""` and puts the reason in the explanation (stdout
    // uses snake_case, the transcript camelCase). The turn stops here, so the
    // reader must learn why.
    const why = str(sys.api_refusal_explanation) ?? str(sys.apiRefusalExplanation)
    return { show: true, variant: 'error', message: 'The model declined this request.', ...(why ? { detail: why.slice(0, DETAIL_MAX) } : {}) }
  }
  // A Stop hook that held the turn (Walnut's unanswered-request reminder, or the user's own):
  // the CLI's words are "Stop hook error occurred · ctrl+o to see", a key for its own screen;
  // the hook's words follow as the turn's next input row.
  if (subtype === 'notification' && sys.key === 'stop-hook-error') {
    return { show: true, variant: 'info', message: 'A Stop hook held the turn; its note follows.' }
  }
  if (subtype === 'plugin_install') {
    const error = str(sys.error)
    if (!error && sys.status !== 'failed') return { show: false, why: 'no-words' }
    const name = str(sys.name)
    return { show: true, variant: 'error', message: name ? `Plugin ${name} failed to install` : 'A plugin failed to install', ...(error ? { detail: error.slice(0, DETAIL_MAX) } : {}) }
  }
  return undefined
}

export function systemEventView(sys: Record<string, unknown>): SystemEventView {
  const subtype = String(sys.subtype ?? '')
  if (SILENT_SYSTEM_SUBTYPES.has(subtype)) return { show: false, why: 'bookkeeping' }
  if (SHOWN_ELSEWHERE_SUBTYPES.has(subtype)) return { show: false, why: 'shown-elsewhere' }
  const fixed = sentenceFor(subtype, sys)
  if (fixed) return fixed
  const message = wordsOf(sys)
  if (!message) return { show: false, why: 'no-words' }
  const tone = sys.level ?? sys.color
  const variant = tone === 'error' ? 'error' : 'info'
  // A row's headline is one short line; longer words (a local command's output)
  // keep their full text behind the row's expander.
  const first = message.split('\n', 1)[0]
  if (first.length <= HEADLINE_MAX && first === message) return { show: true, variant, message }
  const headline = first.length <= HEADLINE_MAX ? first : `${first.slice(0, HEADLINE_MAX - 1)}\u2026`
  return { show: true, variant, message: headline, detail: message.slice(0, DETAIL_MAX) }
}
