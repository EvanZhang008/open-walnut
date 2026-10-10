/**
 * The phone's transcript shape (SessionTranscript: the main lane's user turns,
 * assistant text and tool rows, newest TRANSCRIPT_TAIL_ROWS) from the tail of a
 * session's stream file. Two readers: the cloud companion, over the bridge
 * (web/routes/session-stream-v1.ts), and a host server answering alone, over
 * its daemon link (host-server/alone-api.ts). Pure: no I/O.
 */

import { toolDetail, toolResultPreview, toolResultText } from '../tool-summary.js'
import { clipTranscriptText } from './transcript-clip.js'
import { toDisplayedUserText } from './reference-cards.js'

export const TRANSCRIPT_TAIL_ROWS = 200
// Tail-only read: ~200 rendered rows fit comfortably in the last 512KB even
// with tool-result noise. A whale session's full 10MB+ jsonl as one frame is
// exactly the proxy-killing payload class (inc-…925).
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024

export function transcriptFromJsonl(sessionId: string, main: string): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = []
  for (const line of main.split('\n')) {
    if (!line.trim()) continue
    try { lines.push(JSON.parse(line)) } catch { continue }
  }

  // Pre-scan tool_result carrier lines so tool rows can attach output previews
  // and say when the call failed.
  const resultsById = new Map<string, string>()
  const errorIds = new Set<string>()
  for (const parsed of lines) {
    if (parsed.type !== 'user') continue
    const content = (parsed.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const text = toolResultText(b.content)
        if (text) resultsById.set(b.tool_use_id, text)
        if (b.is_error === true) errorIds.add(b.tool_use_id)
      }
    }
  }

  // One message id gives one row. A line whose process died before running it
  // is marked again when it is resent; the last marker is the delivery that ran.
  const lastMarker = new Map<string, number>()
  lines.forEach((parsed, i) => {
    if (parsed.subtype === 'walnut-injected' && typeof parsed.walnutMessageId === 'string') lastMarker.set(parsed.walnutMessageId, i)
  })

  const messages: Array<{ role: string; text: string; timestamp: string; kind?: 'tool' | 'thinking'; detail?: string; resultPreview?: string; agent?: string; isError?: true }> = []
  for (const [i, parsed] of lines.entries()) {
    if (parsed.parent_tool_use_id) continue // subagent lane
    if (typeof parsed.walnutMessageId === 'string' && parsed.subtype === 'walnut-injected'
        && lastMarker.get(parsed.walnutMessageId) !== i) continue
    // CLI-injected user lines (skill dumps, compaction summaries): the same skip
    // as buildSessionTranscript's `m.injected` filter on the primary box.
    // walnut-injected markers are exempt: they ARE the user's words.
    if (parsed.subtype !== 'walnut-injected'
        && (parsed.isMeta === true || parsed.isSynthetic === true
          || parsed.isCompactSummary === true || parsed.isVisibleInTranscriptOnly === true)) continue
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
    const type = parsed.type as string
    const content = (parsed.message as { content?: unknown } | undefined)?.content

    if (type === 'user') {
      // Real user turns + walnut-injected markers (both ARE the user's words);
      // tool_result carrier lines have array content with tool_result blocks.
      // Drop ONLY the CLI's interrupt markers. The old blanket startsWith('[')
      // filter also swallowed "[Images attached, use the Read tool ...]" turns
      // (every phone/web image send), so a cloud fresh=1 read showed a
      // transcript with the user's image messages missing while the primary
      // path (buildSessionTranscript) kept them. Keep parity with primary:
      // everything the human's turn carries survives.
      if (typeof content === 'string') {
        const text = content.trim()
        if (text && !isInterruptMarker(text)) messages.push({ role: 'user', text: clipUserText(text), timestamp })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string }
          const text = b.type === 'text' ? b.text?.trim() : undefined
          if (text && !isInterruptMarker(text)) {
            messages.push({ role: 'user', text: clipUserText(text), timestamp })
          }
        }
      }
    } else if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }
        if (b.type === 'text' && b.text?.trim()) {
          messages.push({ role: 'assistant', text: clip(b.text.trim()), timestamp })
        } else if (b.type === 'tool_use') {
          const detail = toolDetail(b.name ?? '', b.input)
          const result = typeof b.id === 'string' ? resultsById.get(b.id) : undefined
          // Subagent attribution (additive), parity with the primary path
          // (session-projection.ts buildSessionTranscript): Task/Agent rows
          // carry the subagent's name/subagent_type as `agent`.
          let agent: string | undefined
          if ((b.name === 'Task' || b.name === 'Agent') && b.input) {
            const input = b.input as Record<string, unknown>
            agent = (typeof input.name === 'string' && input.name ? input.name : undefined)
              ?? (typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : undefined)
          }
          messages.push({
            role: 'assistant', text: b.name ?? 'tool', timestamp, kind: 'tool',
            ...(detail ? { detail } : {}),
            ...(result ? { resultPreview: toolResultPreview(result) } : {}),
            ...(agent ? { agent } : {}),
            ...(typeof b.id === 'string' && errorIds.has(b.id) ? { isError: true as const } : {}),
          })
        }
      }
    }
  }

  const truncated = messages.length > TRANSCRIPT_TAIL_ROWS
  return {
    version: 1,
    sessionId,
    exportedAt: new Date().toISOString(),
    truncated,
    messages: truncated ? messages.slice(-TRANSCRIPT_TAIL_ROWS) : messages,
  }
}

/** The same HTML-safe cut as the primary path, at the LIVE budget its rich read
 *  uses: both readers answer only a phone reading right now (nothing they build
 *  is pushed), so a long reply must not arrive whole on one route and cut at 4K
 *  on the other (core/sessions/transcript-clip.ts). */
function clip(text: string): string {
  return clipTranscriptText(text, 'live')
}

/** A USER row, minus the machine text the send path appended (output-mode
 *  wrapper, reference-card block) and the CLI echoed into its JSONL. The
 *  primary path strips it at the history projection
 *  choke point (core/session-history.ts); this route is a SECOND parser of the
 *  same JSONL, so without the same call the phone shows the machine instruction
 *  as part of what the human typed, on every message, since the reminder rides
 *  every send while rich holds. Strip BEFORE clipping so the budget is spent on
 *  the human's words. */
function clipUserText(text: string): string {
  return clipTranscriptText(toDisplayedUserText(text), 'live')
}

/** The CLI's abort echo ("[Request interrupted by user( for tool use)]"):
 *  plumbing, not the human's words. The only bracket-prefixed user line the
 *  slim tail hides (matches the web console's SessionMessage handling). */
function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user( for tool use)?\]$/.test(text)
}
