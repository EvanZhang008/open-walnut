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
 */
import { isHistorySentRow, isHistoryUserTurn } from '../../lib/history-turn-window.js'

export type TranscriptSentBy = 'person' | 'agent' | 'cli'

export function transcriptSentBy(row: { role: string; text: string; injected?: boolean }): TranscriptSentBy {
  if (isHistoryUserTurn(row)) return 'person'
  return isHistorySentRow(row) ? 'agent' : 'cli'
}
