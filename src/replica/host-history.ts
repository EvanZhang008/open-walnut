/**
 * A session that runs on THIS host, read while the Mac is away, from its
 * stream file (docs/plan/walnut-replica-servers-impl.md, WP7) when the host's
 * daemon has no owner-scoped file reads (`replica-reads-v1`, WP6). With them,
 * the route itself answers (the self-host shim reads the CLI's own transcript,
 * exactly as the Mac does), and this file is not used. Pure: the text in, the
 * answer out.
 *
 * The read is a tail window of the stream file (`read-history {sid, tailBytes}`,
 * owner scoped in both daemon twins). Such a daemon does not say whether the
 * window cut the file, so a window is always called one: the answer is
 * `windowed`, and an older page needs the Mac (the console says older messages
 * load when the Mac is back). The window is small (1 MB): its parse is a few
 * milliseconds of the event loop (measured: about 3 ms per MB, prepare and
 * parse together), and the caller yields between the two.
 */
import { parseSessionMessages, type SessionHistoryMessage } from '../core/session-history.js'
import { transcriptFromJsonl, TRANSCRIPT_TAIL_BYTES } from '../core/sessions/transcript-from-jsonl.js'
import { historyTurnWindowLimit } from '../lib/history-turn-window.js'

/** One read of the console's history: the newest 1 MB of the stream file. */
export const HOST_HISTORY_TAIL_BYTES = 1024 * 1024
export { TRANSCRIPT_TAIL_BYTES }

/**
 * The stream file holds the person's words as Walnut's markers
 * (`subtype: 'walnut-injected'`, the CLI does not echo them), which the
 * transcript parser drops as copies of the CLI's own user lines. Here they are
 * the only copy: each message id keeps its LAST marker (a line resent to a new
 * process is marked again; the last one is the delivery that ran), as a plain
 * user line the parser keeps. Every other line is passed as it is.
 */
export function streamFileForParse(main: string): string {
  const lines = main.split('\n')
  const parsed: Array<Record<string, unknown> | null> = lines.map((l) => {
    if (!l.includes('walnut-injected')) return null
    try { return JSON.parse(l) as Record<string, unknown> } catch { return null }
  })
  const last = new Map<string, number>()
  parsed.forEach((p, i) => {
    if (p && p.type === 'user' && p.subtype === 'walnut-injected' && typeof p.walnutMessageId === 'string') last.set(p.walnutMessageId, i)
  })
  const out: string[] = []
  lines.forEach((l, i) => {
    const p = parsed[i]
    if (!p || p.type !== 'user' || p.subtype !== 'walnut-injected' || typeof p.walnutMessageId !== 'string') { out.push(l); return }
    if (last.get(p.walnutMessageId) !== i) return
    const message = p.message as { content?: unknown } | undefined
    out.push(JSON.stringify({
      type: 'user',
      uuid: `walnut-${p.walnutMessageId}`,
      message: { role: 'user', content: message?.content ?? '' },
      ...(typeof p.timestamp === 'string' ? { timestamp: p.timestamp } : {}),
    }))
  })
  return out.join('\n')
}

/** Every row of a stream file's text (streamFileForParse, then the transcript parser). */
export function hostHistoryMessages(prepared: string): SessionHistoryMessage[] {
  return parseSessionMessages(prepared)
}

export interface HostHistoryQuery { tail?: number; turns?: number }

export interface HostHistoryAnswer {
  messages: SessionHistoryMessage[]
  total: number
  /** The count the client holds after this answer, as the leader's full answer says it. */
  cursor: number
  /** A full answer, never a delta: a `since` read is answered whole, and the client rebuilds. */
  delta: false
  /** Always: the read was a tail window (older messages need the Mac). */
  windowed: true
}

/**
 * The console's `/api/sessions/:id/history` (and the phone's rich
 * `/api/v1/sessions/:id/history`) answer, from every row of the window: the
 * shape of the leader's full answer (src/web/routes/sessions.ts).
 */
export function hostHistoryAnswer(messages: SessionHistoryMessage[], q: HostHistoryQuery): HostHistoryAnswer {
  const tail = q.tail && q.tail > 0 ? q.tail : 0
  const turns = q.turns && q.turns > 0 ? historyTurnWindowLimit(messages, q.turns) : 0
  const limit = Math.max(tail, turns)
  const sliced = limit > 0 ? messages.slice(-limit) : messages
  return { messages: sliced, total: messages.length, cursor: messages.length, delta: false, windowed: true }
}

/** The phone's `/api/v1/sessions/:id/transcript` answer (the companion's slim build). */
export function hostTranscriptAnswer(sid: string, main: string): Record<string, unknown> {
  return transcriptFromJsonl(sid, main)
}
