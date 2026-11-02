/**
 * Who put a user row into a session, for the phone's transcript rows
 * (`sentBy`, additive on GET /api/v1/sessions/:id/transcript).
 *
 * The web console decides it from the stored row (lib/history-turn-window.ts):
 * a person's own message starts a turn the reader must see; a delivery from
 * another task or from Walnut (a peer note, a reply, a notification, a trigger)
 * starts one the timeline may fold or hide; a line the CLI wrote itself (the
 * interrupt marker, a skill dump) starts nothing. The phone has no envelope
 * parser and reads clipped text, so the server names it once, here, from the
 * whole text, and every transcript builder (the primary's projection, the
 * companion's and a host server's JSONL reader) answers with the same word.
 *
 * `person` is the one word agents trust as the user's own (the team charter: a `sentBy: "person"`
 * row is the user's go-ahead), so it must hold only for text a person typed. The send path keeps
 * that true by framing everything else in a Walnut envelope (sessions/send-frame.ts), and the
 * daemon's own corrective lines carry the automated marker below. Rows written before 2026-11-02
 * predate the framing: an agent's unframed text from then still reads `person`.
 */
import { isHistorySentRow, isHistoryUserTurn } from '../../lib/history-turn-window.js'
import { typedUserText } from '../../lib/history-injected-banner.js'
import { parseSessionEnvelopes } from '../../lib/history-session-envelope.js'

export type TranscriptSentBy = 'person' | 'agent' | 'cli'

/**
 * The daemon writes two lines into a session itself (the scheduler-policy correction and the turn
 * auto-retry nudge), each opening with this marker. A person could type it too; the failure is then
 * the safe one, a person's row read as an agent's.
 */
const AUTOMATED_LINE = /^\[Walnut [^\]\n]{1,80} automated message, not from the user\]/

export function transcriptSentBy(row: { role: string; text: string; injected?: boolean; agentOrigin?: boolean }): TranscriptSentBy {
  // The CLI's own `origin` (or another session's mail tag) says a person did not type it: that
  // holds whatever the text looks like, so a tag nobody listed yet is still not a person.
  if (row.agentOrigin && isHistorySentRow(row)) return 'agent'
  if (isHistoryUserTurn(row)) return AUTOMATED_LINE.test(row.text.trimStart()) ? 'agent' : 'person'
  return isHistorySentRow(row) ? 'agent' : 'cli'
}

/**
 * A row can hold a Walnut notice or another session's message AND words a person typed (the CLI
 * joins what is pending into one line). The row reads `person` for the typed part; this is that
 * part alone, so nobody takes the envelope's words for the user's. Undefined when the row has no
 * envelope (its whole text is the person's) or no typed words.
 */
export function personTextOf(text: string): string | undefined {
  const segments = parseSessionEnvelopes(typedUserText(text).trim())
  if (!segments) return undefined
  const own = segments.flatMap((s) => (s.kind === 'text' ? [s.text] : [])).join('\n\n').trim()
  return own || undefined
}
