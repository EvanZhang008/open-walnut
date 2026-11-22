/**
 * The phone's transcript shape (SessionTranscript: the main lane's user turns,
 * assistant text and tool rows, newest TRANSCRIPT_TAIL_ROWS) from the tail of a
 * session's stream file. Two readers: the cloud companion, over the bridge
 * (web/routes/session-stream-v1.ts), and a host server answering alone, over
 * its daemon link (host-server/alone-api.ts). Pure: no I/O.
 */

import { toolDetail, toolResultPreview, toolResultText } from '../tool-summary.js'
import { clipTranscriptText } from './transcript-clip.js'
import { projectUserText } from './reference-cards.js'
import { transcriptSentBy, personTextOf, type TranscriptSentBy } from './transcript-sent-by.js'
import { nonHumanOrigin, opensTurnLine } from '../../lib/history-session-envelope.js'
import { InjectedLines, type InjectedCarrier } from './transcript-injected.js'
import { hookContextText, walnutAddedOf, type WalnutAddedItem } from '../../lib/walnut-added.js'
import { settingChangeNotice, walnutCommandNotice } from './walnut-commands.js'
import { cliErrorRowText } from './cli-error-reply.js'
import { queuedCommandText, transformInjectedUserText } from '../history-parse.js'
import { drainedSendIsAgent, joinedRun, mergedSendUuidsOf } from '../drained-sends.js'

export const TRANSCRIPT_TAIL_ROWS = 200
// Tail-only read: ~200 rendered rows fit comfortably in the last 512KB even
// with tool-result noise. A whale session's full 10MB+ jsonl as one frame is
// exactly the proxy-killing payload class (inc-…925).
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024

type TranscriptRow = InjectedCarrier & {
  role: string; text: string; timestamp: string; kind?: 'tool' | 'thinking'; detail?: string; resultPreview?: string
  agent?: string; isError?: true; sentBy?: TranscriptSentBy; personText?: string; added?: WalnutAddedItem[]; textWithoutContext?: string
  cliError?: true
  /** The queue row id (`qm-…`) a walnut-injected line delivered (the primary's projection says the same). */
  walnutMessageId?: string
  /** The first row of a turn the CLI began on a hidden line (the primary's projection says the same). */
  opensTurn?: true
}

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

  const messages: TranscriptRow[] = []
  // The lines the CLI put in itself ride the row before them (transcript-injected.ts).
  const injected = new InjectedLines('live')
  // A background agent's notification the CLI began a turn on: hidden, so the next row the
  // turn writes says the turn opens there (history-parse.ts `opensTurn`).
  let hiddenTurnStart = -1
  const stampTurnStart = () => {
    if (hiddenTurnStart < 0 || messages.length <= hiddenTurnStart) return
    messages[hiddenTurnStart].opensTurn = true
    hiddenTurnStart = -1
  }
  // The texts queued so far and not yet run, in queue order: a line Claude Code drained from
  // several of them is split back into one row per send (drained-sends.ts), as the primary does.
  const queued: string[] = []
  for (const [i, parsed] of lines.entries()) {
    stampTurnStart()
    if (parsed.type === 'queue-operation') {
      const text = typeof parsed.content === 'string' ? parsed.content : ''
      if (parsed.operation === 'enqueue' && text) queued.push(text)
      if (parsed.operation === 'remove' && text) takeQueued(queued, text)
      continue
    }
    if (parsed.parent_tool_use_id) continue // subagent lane
    if (typeof parsed.walnutMessageId === 'string' && parsed.subtype === 'walnut-injected'
        && lastMarker.get(parsed.walnutMessageId) !== i) continue
    // A hook's added context, written as an attachment line (the primary's
    // history parser reads it the same way, session-history.ts).
    const attachment = parsed.attachment as { type?: string; content?: unknown; hookEvent?: unknown; prompt?: unknown } | undefined
    // A queued send the CLI took mid-turn ran on its own: it is queued no more.
    if (parsed.type === 'attachment' && attachment?.type === 'queued_command') {
      const prompt = queuedCommandText(attachment.prompt)
      if (prompt) takeQueued(queued, prompt)
    }
    if (parsed.type === 'attachment' && attachment?.type === 'hook_additional_context') {
      const text = hookContextText(attachment.content, attachment.hookEvent)
      if (text) injected.take(text, messages)
      continue
    }
    // Claude Code's own error reply ("Prompt is too long"): the row the primary's projection gives
    // it, the turn's last words marked `cliError`, so the phone draws its error line, never a reply.
    if (parsed.type === 'assistant') {
      const cliError = cliErrorRowText(parsed as Parameters<typeof cliErrorRowText>[0])
      if (cliError) {
        const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
        messages.push({ role: 'assistant', text: clip(cliError), timestamp: ts, cliError: true })
        continue
      }
    }
    // CLI-injected user lines (a skill's text, a compaction summary): as on the
    // primary box, they ride the row before them, and one that is only a Walnut
    // message is drawn as that message. walnut-injected markers are exempt: they
    // ARE the user's words.
    if (parsed.subtype !== 'walnut-injected'
        && (parsed.isMeta === true || parsed.isSynthetic === true
          || parsed.isCompactSummary === true || parsed.isVisibleInTranscriptOnly === true)) {
      if (parsed.type !== 'user') continue
      const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
      const body = (parsed.message as { content?: unknown } | undefined)?.content
      const texts = typeof body === 'string' ? [body]
        : Array.isArray(body) ? body.flatMap((b) => {
          const block = b as { type?: string; text?: string }
          return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        }) : []
      for (const text of texts) {
        if (injected.take(text, messages) === 'message') messages.push(userRow(text.trim(), ts, nonHumanOrigin(parsed.origin)))
      }
      continue
    }
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
        // A command Walnut sent itself is its notice, never the person's message; the phone draws
        // no notice rows, as the primary's projection leaves its system rows out (sessions/walnut-commands.ts).
        if (walnutCommandNotice(text) || settingChangeNotice(text)) continue
        // The CLI's own plumbing (a local command's caveat and output, a task notification) is
        // nobody's message, as the primary's parser hides it; a command line reads as typed.
        const injected = transformInjectedUserText(text)
        if (injected === null) {
          if (opensTurnLine(parsed)) hiddenTurnStart = messages.length
          continue
        }
        const shown = injected !== undefined && text.startsWith('<command-') ? injected : text
        // A walnut-injected marker names one delivery; it is never a drained line, nor a take.
        const marker = parsed.subtype === 'walnut-injected'
        const others = mergedSendUuidsOf(parsed)
        // A CLI older than `mergedSendUuids` names nothing: any run of two or more still queued.
        const run = marker ? undefined : joinedRun(queued, text, others ? others.length + 1 : undefined)
        if (run) {
          // A line drained from several sends: each send is its own row with its own author.
          for (const words of queued.splice(run[0], run[1] - run[0] + 1)) {
            const send = words.trim()
            if (send && !isInterruptMarker(send)) messages.push(userRow(send, timestamp, drainedSendIsAgent(parsed.origin, send)))
          }
        } else {
          if (!marker) takeQueued(queued, text)
          if (shown && !isInterruptMarker(shown)) messages.push(withMessageId(userRow(shown, timestamp, nonHumanOrigin(parsed.origin)), parsed))
        }
      } else if (Array.isArray(content)) {
        // A line of blocks drained from several sends carries one text block per send; the line's
        // one origin is its last send's, so each send is judged by its own words.
        const drained = !!mergedSendUuidsOf(parsed)
        for (const block of content) {
          const b = block as { type?: string; text?: string }
          const text = b.type === 'text' ? b.text?.trim() : undefined
          const agent = drained ? drainedSendIsAgent(parsed.origin, text ?? '') : nonHumanOrigin(parsed.origin)
          if (text && !isInterruptMarker(text)) messages.push(withMessageId(userRow(text, timestamp, agent), parsed))
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

  stampTurnStart()
  injected.finish(messages)
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
 *  the human's words, and name the sender from the whole text (an envelope cut
 *  short reads as prose), by the primary's rule (transcript-sent-by.ts). */
/** A walnut-injected line names the queue row it delivered: the phone replaces that row's card by id. */
function withMessageId(row: TranscriptRow, parsed: Record<string, unknown>): TranscriptRow {
  const id = parsed.subtype === 'walnut-injected' ? parsed.walnutMessageId : undefined
  return typeof id === 'string' && id ? { ...row, walnutMessageId: id } : row
}

function userRow(text: string, timestamp: string, agentOrigin = false): TranscriptRow {
  const { text: shown } = projectUserText(text, timestamp)
  // What Walnut added besides its notes in front, as the primary's projection says it.
  const { items, textWithoutContext } = walnutAddedOf(shown)
  const sentBy = transcriptSentBy({ role: 'user', text: shown, agentOrigin })
  const personText = sentBy === 'person' ? personTextOf(shown) : undefined
  return {
    role: 'user', text: clipTranscriptText(shown, 'live'), timestamp, sentBy,
    ...(personText !== undefined ? { personText: clipTranscriptText(personText, 'live') } : {}),
    ...(items.length ? { added: items.map((i) => ({ ...i, text: clipTranscriptText(i.text, 'live') })) } : {}),
    ...(textWithoutContext !== undefined ? { textWithoutContext: clipTranscriptText(textWithoutContext.trim(), 'live') } : {}),
  }
}

/** A queued text that ran on its own (or was taken back) is queued no more. */
function takeQueued(queued: string[], text: string): void {
  const t = text.trim()
  const at = queued.findIndex((q) => q.trim() === t)
  if (at >= 0) queued.splice(at, 1)
}

/** The CLI's abort echo ("[Request interrupted by user( for tool use)]"):
 *  plumbing, not the human's words. The only bracket-prefixed user line the
 *  slim tail hides (matches the web console's SessionMessage handling). */
function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user( for tool use)?\]$/.test(text)
}
