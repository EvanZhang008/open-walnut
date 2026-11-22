/**
 * The short ways to read a task conversation (task_history `limit`, `since`, `compact`).
 * 2026-11-02: Main's daily reflection read one task's history as about 90,000 characters, over its
 * tool output ceiling, and had to grep the saved file. A reader that needs the gist asks for the
 * newest N messages, the rows after a time, or the compact form: message text kept, every tool
 * call and thinking block one line, and a count of what was left out. None of it applies unless
 * asked, so the default answer stays the route's own; an AGENT that names none of them reads
 * the newest messages in the compact form instead (agentHistory, 2026-11-21: task_history
 * answers ran to p95 24,000 and max 86,000 characters).
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
import type { OpAnswer } from './answer.js'
import { cutText } from './answer-text.js'

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

/** One line of at most `max` characters; a longer one ends with the cut mark (answer-text.ts). */
function oneLine(s: string, max: number): string {
  return cutText(s.replace(/\s+/g, ' ').trim(), max)
}

/**
 * At most `max` characters, the mark included, when that saves more than the mark costs. The
 * mark is the one every cut answer carries: a cut message quoted into a write is refused.
 */
function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max + 100) return { text: s, clipped: false }
  return { text: cutText(s, max), clipped: true }
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

/** The newest messages an agent's task_history gives when it names no window (limit, since) and no form (compact). */
export const AGENT_HISTORY_LIMIT = 20
/** What those messages may take of the answer's cap (8,000), leaving room for its other keys. */
const AGENT_HISTORY_BUDGET = 6_500
/** An older assistant reply in that default, when the messages do not fit: its gist. */
const AGENT_OLDER_REPLY_MAX = 600

const isSessionHeader = (m: Row): boolean => m.role === 'system' && m.kind === 'notification' && !m.timestamp

/**
 * Every assistant reply but the newest held to AGENT_OLDER_REPLY_MAX, cut from its whole text (row
 * `cutOlder + i` of `rows`: no `since` here, so the shaped rows are the tail of the page one for one).
 * The newest is the result a reader came for.
 */
function clipOlderReplies(rows: Row[], out: ShapeResult): ShapeResult {
  const replies = out.messages.flatMap((m, i) => (m.role === 'assistant' && !m.kind && typeof m.text === 'string' ? [i] : []))
  const newest = replies.at(-1)
  let { clipped, chars } = out
  const messages = out.messages.map((m, i) => {
    if (i === newest || !replies.includes(i)) return m
    const whole = rows[out.cutOlder + i]?.text
    const c = clip(typeof whole === 'string' ? whole : String(m.text), AGENT_OLDER_REPLY_MAX)
    if (!c.clipped || c.text.length >= String(m.text).length) return m
    if (String(m.text) === whole) clipped++
    chars += String(m.text).length - c.text.length
    return { ...m, text: c.text }
  })
  return { ...out, messages, clipped, chars }
}

/**
 * An agent's default task_history: the newest AGENT_HISTORY_LIMIT messages in the compact form,
 * older replies cut to their gist and then fewer messages when they still would not fit (the
 * oldest go first, never the newest), with how many older rows there are and the call that reads
 * the page before. A caller that named limit, since or compact gets the answer it asked for;
 * `"_full": true` skips this altogether.
 */
export function agentHistory(result: unknown, args: Record<string, unknown>): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const r = result as Row
  const rows = r.messages
  if (!Array.isArray(rows) || rows.length === 0) return result
  if (args.limit !== undefined || args.since !== undefined || args.compact !== undefined) return result
  // Already this default (a host's call relayed through a gateway that shapes it too).
  if (typeof r.shown === 'string') return result
  const all = rows as Row[]
  const chars = (list: Row[]) => list.reduce((n, m) => n + JSON.stringify(m).length + 1, 0)
  const shaped = (n: number): ShapeResult => {
    const one = shapeHistory(all, { limit: n, compact: true })
    return chars(one.messages) > AGENT_HISTORY_BUDGET ? clipOlderReplies(all, one) : one
  }
  let limit = AGENT_HISTORY_LIMIT
  let out = shaped(limit)
  while (limit > 3 && chars(out.messages) > AGENT_HISTORY_BUDGET) {
    limit = Math.max(3, Math.floor(limit * 0.7))
    out = shaped(limit)
  }
  let messages = out.messages
  // all:true holds several sessions: a cut inside one keeps its header row, which says whose rows these are.
  if (out.cutOlder > 0 && args.all === true) {
    const header = all.slice(0, out.cutOlder).reverse().find(isSessionHeader)
    if (header && messages[0] !== header) messages = [header, ...messages]
  }
  const first = messages.find((m) => typeof m.timestamp === 'string')?.timestamp as string | undefined
  const before = r.truncated === true
  const paged = (out.cutOlder > 0 || before) && first !== undefined
  // The page before names no limit or form, so it gets this same default, fitted to its own messages.
  const page = { id: r.taskId ?? args.id, ...(args.all === true ? { all: true } : {}), before: first }
  const more = [
    out.cutOlder > 0 ? `${out.cutOlder} older rows of this page` : '',
    before ? 'older pages before it' : '',
  ].filter(Boolean).join(' and ')
  // The route's own `older` is replaced by the page before what this answer shows.
  const { older: _routeOlder, ...rest } = r
  return {
    ...rest,
    messages,
    truncated: paged,
    ...(paged ? { older: { before: first, how: `walnut tools call task_history '${JSON.stringify(page)}'` } } : {}),
    left_out: { cutOlder: out.cutOlder, cutSince: 0, folded: out.folded, clipped: out.clipped, chars: out.chars, note: leftOutLine(out, paged) },
    shown: `The newest ${limit} messages, compact (an agent's default)${more ? `; not shown: ${more} (older.how reads the page before)` : ''}. `
      + 'Pass limit (up to 200), since, compact:false, or "_full": true for the whole answer.',
  }
}

/** task_history's answer policy (the op is in src/ops/work.ts). */
export const TASK_HISTORY_ANSWER: OpAnswer = {
  kind: 'content',
  whole: 'task_history {"id":"<id>","limit":200}',
  shape: ({ result, args }) => agentHistory(result, args),
}
