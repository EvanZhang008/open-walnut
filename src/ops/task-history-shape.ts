/**
 * The short ways to read a task conversation (task_history `limit`, `since`, `compact`).
 * 2026-11-02: Main's daily reflection read one task's history as about 90,000 characters, over its
 * tool output ceiling, and had to grep the saved file. A reader that needs the gist asks for the
 * newest N messages, the rows after a time, or the compact form: message text kept, every tool
 * call and thinking block one line, and a count of what was left out. None of it applies unless
 * asked, so the default answer stays the route's own.
 */

export interface HistoryShape {
  /** The newest N messages a reader sees as text (with the tool and thinking rows between them). */
  limit?: number
  /** Only rows strictly after this ISO time. */
  since?: string
  /** Tool calls and thinking folded to one line each; long non-person text clipped. */
  compact?: boolean
}

import { parseSessionEnvelopes, type SessionEnvelope } from '../lib/history-session-envelope.js'

type Row = Record<string, unknown>

/** One folded line (a tool call, a row of another kind). */
export const COMPACT_LINE_MAX = 160
/** A thinking block's folded line: its gist, the reply below carries the conclusion. */
export const THINKING_LINE_MAX = 100
/** A Walnut status notice (a subtask parked, a trigger fired) folded to one line. */
export const NOTICE_LINE_MAX = 240
/** An assistant reply in the compact form. */
export const COMPACT_REPLY_MAX = 2000
/** A user-role row Walnut or another agent wrote (a notice, a peer note) in the compact form. */
export const COMPACT_NOTICE_MAX = 1200

/** A row a reader sees as text: the human's or an agent's message, the assistant's prose. */
export function isTextRow(r: Row): boolean {
  return (r.role === 'user' || r.role === 'assistant') && !r.kind && typeof r.text === 'string' && r.text.trim() !== ''
}

const time = (r: Row): number => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN)

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Clip only when it saves more than its own marker costs. */
function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max + 100) return { text: s, clipped: false }
  return { text: `${s.slice(0, max)}… [+${s.length - max} chars; read without compact for all of it]`, clipped: true }
}

/**
 * A Walnut envelope (a notice, a peer note, a reply) as one bracketed head and its body: the
 * opening tag's session ids and routing attributes are most of a short notice's characters.
 */
function envelopeLine(e: SessionEnvelope): string {
  const who = e.peer.title ? ` "${e.peer.title}"` : e.peer.taskId ? ` ${e.peer.taskId}` : ''
  const head = [e.requestId, e.title ?? e.statusLine].filter(Boolean).join(': ')
  const body = e.body && e.body !== e.statusLine ? ` ${e.body.trim()}` : ''
  const line = `[${e.kind}${who}${head ? ` ${head}` : ''}]${body}`
  // A status notice (a subtask parked, a trigger fired) is Walnut's, not another session's words.
  return e.kind === 'reply' || e.kind === 'peer-note' ? line : oneLine(line, NOTICE_LINE_MAX)
}

function noticeText(text: string): string {
  const segs = parseSessionEnvelopes(text)
  return segs ? segs.map((g) => (g.kind === 'text' ? g.text : envelopeLine(g.envelope))).join('\n\n') : text
}

/** The person's own words are never clipped: a row they sent, or an older row with no sender stamp. */
const fromPerson = (r: Row) => r.role === 'user' && (r.sentBy === undefined || r.sentBy === 'person')

function compactRow(r: Row): { row: Row; folded?: 'tool' | 'thinking'; clipped: boolean } {
  const base: Row = { role: r.role, ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}) }
  const text = typeof r.text === 'string' ? r.text : ''
  if (r.kind === 'tool') {
    const detail = typeof r.detail === 'string' && r.detail ? `: ${r.detail}` : ''
    return { row: { ...base, kind: 'tool', text: oneLine(`${text}${detail}`, COMPACT_LINE_MAX), ...(r.isError ? { isError: true } : {}), ...(r.sentTo ? { sentTo: r.sentTo } : {}) }, folded: 'tool', clipped: false }
  }
  if (r.kind === 'thinking') return { row: { ...base, kind: 'thinking', text: oneLine(text, THINKING_LINE_MAX) }, folded: 'thinking', clipped: false }
  if (r.kind) return { row: { ...base, kind: r.kind, text: oneLine(text, COMPACT_LINE_MAX) }, clipped: text.length > COMPACT_LINE_MAX }
  const keep: Row = { ...base }
  for (const k of ['sentBy', 'sentTo', 'personText'] as const) if (r[k] !== undefined) keep[k] = r[k]
  // A row that also carries notices (or another session's mail) holds the person's part in
  // personText, kept whole; the rest of its text is the envelopes, compacted like any other.
  // The person's part can sit on both sides of an envelope, so the rest is the envelopes alone.
  if (typeof r.personText === 'string' && r.personText) {
    const segs = parseSessionEnvelopes(text)
    const envelopes = segs?.flatMap((g) => (g.kind === 'envelope' ? [envelopeLine(g.envelope)] : [])).join('\n\n')
    const rest = clip(envelopes ?? text.replace(r.personText, '').trim(), COMPACT_NOTICE_MAX)
    return { row: { ...keep, text: rest.text }, clipped: rest.clipped }
  }
  if (fromPerson(r)) return { row: { ...keep, text }, clipped: false }
  const c = r.role === 'user' ? clip(noticeText(text), COMPACT_NOTICE_MAX) : clip(text, COMPACT_REPLY_MAX)
  return { row: { ...keep, text: c.text }, clipped: c.clipped }
}

export interface ShapeResult {
  messages: Row[]
  /** Rows older than the answer that `limit` cut (older.before reads them). */
  cutOlder: number
  /** Rows at or before `since`. */
  cutSince: number
  folded: { tool: number; thinking: number }
  clipped: number
  /** Characters of the JSON rows the shaping left out. */
  chars: number
}

/** Apply `since`, then `limit`, then `compact` to one conversation's rows. */
export function shapeHistory(rows: Row[], shape: HistoryShape): ShapeResult {
  let kept = rows
  let cutSince = 0
  if (shape.since) {
    const after = Date.parse(shape.since)
    kept = kept.filter((r) => !(time(r) <= after))
    cutSince = rows.length - kept.length
  }
  let cutOlder = 0
  if (shape.limit !== undefined) {
    let seen = 0
    let start = kept.length
    while (start > 0 && seen < shape.limit) if (isTextRow(kept[--start])) seen++
    if (seen < shape.limit) start = 0
    // Rows of one history message share its timestamp, and the next page's `before` excludes all
    // of them, so the cut never splits such a run: what it left out stays readable.
    const at = kept[start]?.timestamp
    while (start > 0 && at !== undefined && kept[start - 1].timestamp === at) start--
    cutOlder = start
    kept = kept.slice(start)
  }
  const folded = { tool: 0, thinking: 0 }
  let clipped = 0
  const size = (list: Row[]) => list.reduce((n, r) => n + JSON.stringify(r).length, 0)
  const whole = size(rows)
  if (shape.compact) {
    kept = kept.map((r) => {
      const c = compactRow(r)
      if (c.folded) folded[c.folded]++
      if (c.clipped) clipped++
      return c.row
    })
  }
  const chars = whole - size(kept)
  return { messages: kept, cutOlder, cutSince, folded, clipped, chars }
}

/** The one-line total of what a shaped answer left out (`paged`: the answer carries `older`). */
export function leftOutLine(r: Pick<ShapeResult, 'cutOlder' | 'cutSince' | 'folded' | 'clipped' | 'chars'>, paged = true): string {
  const parts: string[] = []
  if (r.folded.tool || r.folded.thinking) parts.push(`${r.folded.tool} tool calls and ${r.folded.thinking} thinking blocks folded to one line each`)
  if (r.clipped) parts.push(`${r.clipped} long messages clipped (the person's own words never are)`)
  if (r.cutOlder) parts.push(`${r.cutOlder} older rows past the limit${paged ? ' (older.before reads them)' : ''}`)
  if (r.cutSince) parts.push(`${r.cutSince} rows at or before since`)
  return parts.length ? `${parts.join('; ')}: ${r.chars.toLocaleString('en-US')} characters left out.` : 'Nothing left out.'
}
