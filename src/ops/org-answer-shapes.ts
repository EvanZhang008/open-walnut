/**
 * org-answer-shapes.ts: the compact answers an agent reads from the Org ops (threads, the inbox,
 * boards, topics, the org): a receipt for each write and a page of short rows for each list.
 * answer.ts holds every answer to its cap; these give the cap something small to hold, so it
 * never has to cut blindly.
 *
 * 2026-11-21: in seven days thread_update answered the whole thread it had just changed (159
 * answers over 10,000 characters, max 27,446, shown by the harness as a FAILED call), and
 * thread_list answered every open thread with every message (p95 14.6K, max 50K), so a VP saved
 * it to a file and read it with jq. Pure, no I/O: the ops' shapes and the tests call these.
 */
import type { OrgThread, ThreadMessage } from '../core/org/threads-model.js'
import { briefSectionsBlock } from '../core/sessions/brief-structure.js'
import { ANSWER_CEILING_CHARS, CONTENT_MAX_CHARS, cutMark, type OpAnswer } from './answer.js'
// Note for the coordinator: src/ops/answer-text.ts (the shared short/cut helpers) did not exist when
// this was written, so `cut` below builds on cutMark directly; move it onto answer-text.ts once it lands.

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const objOf = (v: unknown): Obj => (isObj(v) ? v : {})

/**
 * `text` cut to `max` characters by code point (a cut surrogate pair is JSON a client cannot read),
 * ending with cutMark: a write refuses text that carries it (answer.ts cutTextRefusal), so a cut
 * read is never stored back as if it were whole.
 */
export function cut(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : ''
  if (s.length <= max) return s
  const points = Array.from(s)
  if (points.length <= max) return s
  return `${points.slice(0, max).join('').trimEnd()}… ${cutMark(points.length - max)}`
}

/** `text` on one line, cut to `max`: a row's short preview. */
export const line = (text: unknown, max: number): string => cut(typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '', max)

/** Top-level keys whose text says what happened or what to do next: a receipt always keeps them. */
const NOTE_KEYS = ['outcome', 'next', 'walnut_note', 'instruction', 'ref', 'hint', 'error', 'code']

/**
 * The note keys of a result (outcome, next, walnut_note...) and its short top-level values
 * (an id, a count, a flag, a title), never a nested object: what every receipt starts from.
 */
export function receiptBase(result: unknown, keep: readonly string[] = []): Obj {
  const r = objOf(result)
  const out: Obj = {}
  for (const [k, v] of Object.entries(r)) {
    if (NOTE_KEYS.includes(k) || keep.includes(k)) { out[k] = v; continue }
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 200) out[k] = v
  }
  return out
}

/** Only `keys` of `value` that are set: a small copy of an object a write answered whole. */
export function pick(value: unknown, keys: readonly string[]): Obj {
  const v = objOf(value)
  const out: Obj = {}
  for (const k of keys) if (v[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = v[k]
  return out
}

export interface Page { offset: number; shown: number; total: number; next_offset?: number }

/** A page of `rows`: `offset` and `limit` from the call, `limit` defaulting to `def`. */
export function pageOf<T>(rows: readonly T[], args: { offset?: unknown; limit?: unknown }, def: number): { rows: T[]; page: Page } {
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : def
  const shown = rows.slice(offset, offset + limit)
  const next = offset + shown.length
  return { rows: shown, page: { offset, shown: shown.length, total: rows.length, ...(next < rows.length ? { next_offset: next } : {}) } }
}

/** Room a page leaves under its answer's cap for the note answer.ts would add. */
const PAGE_ROOM = 800
/** The most of one page an answer held to `max` holds (answer.ts gives a shape its cap): room left for its note. */
export const pageBudget = (max: number): number => Math.max(1_000, max - PAGE_ROOM)
/** The most of one page under answer.ts's default content cap. */
export const PAGE_BUDGET = pageBudget(CONTENT_MAX_CHARS)

/**
 * `render` over the first of `rows`, fewer until the answer fits `budget`. A page says where the
 * next one starts, so it is never cut blindly: answer.ts would drop rows from its end and the next
 * page would skip them.
 */
export function fitPage<T>(rows: readonly T[], offset: number, total: number, render: (rows: T[], page: Page) => Obj, budget = PAGE_BUDGET): Obj {
  let n = rows.length
  for (;;) {
    const shown = rows.slice(0, n)
    const end = offset + shown.length
    const out = render(shown, { offset, shown: shown.length, total, ...(end < total ? { next_offset: end } : {}) })
    if (n <= 1 || JSON.stringify(out).length <= budget) return out
    n = n > 10 ? Math.floor(n * 0.9) : n - 1
  }
}

/** The call that reads the next page, as the tool takes it, or '' on the last page. */
export function nextPageCall(op: string, args: Obj, page: Page): string {
  if (page.next_offset === undefined) return ''
  const given = Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && k !== 'offset'))
  return `${op} ${JSON.stringify({ ...given, offset: page.next_offset })}`
}

/** "rows 1-20 of 57" for an outcome line. */
export const pageWords = (page: Page, noun: string): string =>
  page.total === 0 ? `no ${noun}` : page.shown === page.total ? `${page.total} ${noun}` : `${noun} ${page.offset + 1}-${page.offset + page.shown} of ${page.total}`

// ── Threads ─────────────────────────────────────────────────────────────────

/** A thread as a read returns it: the stored one plus what the route projects (shown, owner...). */
export type ThreadLike = Partial<OrgThread> & { id: string; owner?: unknown; shown?: boolean; askedIn?: { task?: string; title?: string } }

/** Thread_list's page when the call names no limit (fewer when its rows run long: fitPage). */
export const THREAD_LIST_PAGE = 20
/** Thread_get's newest messages when the call names no limit. */
export const THREAD_GET_MESSAGES = 10
/** Each message's words and answer in thread_get when the call names no body_max. */
export const THREAD_BODY_MAX = 600

const future = (iso: unknown): boolean => typeof iso === 'string' && Date.parse(iso) > Date.now()

/** The few fields that say where a thread stands: every thread write's receipt, and a list row's head. */
export function threadReceipt(t: ThreadLike | undefined): Obj | undefined {
  if (!t?.id) return undefined
  const messages = Array.isArray(t.messages) ? t.messages : []
  return {
    id: t.id,
    ...(t.title ? { title: line(t.title, 120) } : {}),
    state: t.closed ? 'closed' : t.state,
    ...(t.closed ? { closed: t.closed.how } : {}),
    messages: messages.length,
    ...(t.pinned && !t.closed ? { pinned: t.pinned.by === 'human' ? 'by the user' : 'by you' } : {}),
    ...(t.snoozed && !t.closed && future(t.snoozed.until) ? { snoozed_until: t.snoozed.until } : {}),
    ...(t.askedIn?.task ? { asked_in: t.askedIn.task } : {}),
    ...(t.ackPlaced && !t.closed ? { placed: t.ackPlaced.to } : {}),
    ...(t.movedTo ? { moved_to: t.movedTo.task } : {}),
  }
}

/** One row of thread_list: where it stands and one line of the newest message, never the bodies. */
export function threadRow(t: ThreadLike, opts: { bodies?: boolean; bodyMax?: number } = {}): Obj {
  const messages = Array.isArray(t.messages) ? t.messages : []
  const last = messages[messages.length - 1]
  const tasks = Array.isArray(t.tasks) ? t.tasks : []
  const bodyMax = opts.bodyMax ?? THREAD_BODY_MAX
  const head = threadReceipt(t)
  return {
    ...head,
    ...(head?.title ? { title: line(t.title, 80) } : {}),
    ...(t.ask ? { ask: line(t.ask, 100) } : {}),
    unanswered: messages.filter((m) => !m.answer).length,
    ...(t.updatedAt ? { updated_at: t.updatedAt } : {}),
    ...(last ? { last: line(last.text, 100) } : {}),
    ...(t.reply ? { reply: line(t.reply, 140) } : {}),
    ...(tasks.length ? { tasks: tasks.length } : {}),
    ...(t.opener ? { opened_by_you: t.opener.from } : {}),
    ...(t.owner ? { owner: t.owner } : {}),
    ...(t.shown !== undefined ? { shown: t.shown } : {}),
    ...(opts.bodies ? { messages_shown: messages.map((m, i) => messageView(m, messages, i, bodyMax)) } : {}),
  }
}

/**
 * One message for a read: his words and the node's answer, each cut to `max`. An answer that is
 * the same text as an earlier message's (one reply under several of his messages) names that
 * message instead of being copied again.
 */
function messageView(m: ThreadMessage, all: readonly ThreadMessage[], i: number, max: number, dedupe = true): Obj {
  const earlier = m.answer && dedupe ? all.slice(0, i).find((x) => x.answer && x.answer.text === m.answer!.text) : undefined
  const text = typeof m.text === 'string' ? m.text : ''
  const answer = m.answer
    ? earlier ? { same_as: earlier.id, at: m.answer.at }
      : { text: cut(m.answer.text, max), at: m.answer.at, ...(m.answer.text.length > max ? { chars: m.answer.text.length } : {}) }
    : undefined
  return {
    id: m.id, at: m.at, ...(m.via && m.via !== 'chat' ? { via: m.via } : {}),
    text: cut(text, max), ...(text.length > max ? { chars: text.length } : {}),
    ...(m.images?.length ? { images: m.images.length } : {}),
    ...(answer ? { answer } : {}),
    ...(m.readAt ? { read: true } : {}),
  }
}

/** Thread_get's answer: the thread's head and its newest messages, or one message whole. */
/** Thread_get's most: one whole message (his words up to THREAD_MESSAGE_MAX, 8,000) with its whole answer (THREAD_ANSWER_MAX, 16,000). */
export const THREAD_GET_MAX = ANSWER_CEILING_CHARS

/** Which of one message thread_get shows whole: both, his words only, or the answer only. */
export type MessagePart = 'both' | 'text' | 'answer'

export function threadRead(t: ThreadLike, opts: { limit?: number; bodyMax?: number; message?: string; part?: MessagePart } = {}): Obj {
  const messages = Array.isArray(t.messages) ? t.messages : []
  const one = opts.message ? messages.findIndex((m) => m.id === opts.message) : -1
  if (one >= 0) {
    // One message asked for: whole, never `same_as`, beside only where the thread stands.
    const m = messages[one]
    const view = messageView(m, messages, one, Number.MAX_SAFE_INTEGER, false)
    const part = opts.part ?? 'both'
    if (part === 'text') delete view.answer
    if (part === 'answer') { delete view.text; delete view.images }
    if (part === 'text' && m.answer) view.answer_chars = m.answer.text.length
    return { ...threadReceipt(t), position: one + 1, messages_shown: [view] }
  }
  const max = opts.bodyMax ?? THREAD_BODY_MAX
  const limit = opts.limit ?? THREAD_GET_MESSAGES
  const from = Math.max(0, messages.length - limit)
  const shown = messages.slice(from)
  const tasks = Array.isArray(t.tasks) ? t.tasks : []
  return {
    ...threadReceipt(t),
    ...(t.ask ? { ask: t.ask } : {}),
    ...(t.reply ? { reply: t.reply } : {}),
    ...(t.replyAt ? { reply_at: t.replyAt } : {}),
    ...(t.options?.length ? { options: t.options.map((o) => pick(o, ['id', 'label', 'recommended'])) } : {}),
    ...(tasks.length ? { tasks } : {}),
    ...(t.known ? { known_through: t.known.through } : {}),
    ...(t.follows ? { follows: t.follows } : {}),
    ...(t.movedFrom ? { moved_from: t.movedFrom.task } : {}),
    ...(t.opener ? { opener: { from: t.opener.from, ...(t.opener.ref ? { ref: t.opener.ref } : {}), at: t.opener.at, text: cut(t.opener.text, max) } } : {}),
    ...(t.owner ? { owner: t.owner } : {}),
    ...(t.createdAt ? { created_at: t.createdAt } : {}),
    ...(t.updatedAt ? { updated_at: t.updatedAt } : {}),
    // The newest, each cut, with how many came before.
    messages_shown: shown.map((m, k) => messageView(m, messages, from + k, max)),
    ...(from > 0 ? { earlier_messages: from } : {}),
  }
}

// ── The Brief, and what is open (brief_read, brief_write: ops/tasks.ts; open_items: ops/work.ts) ──

/** Lines of each Brief section an agent's brief_read shows when the call names no section. */
export const BRIEF_SECTION_LINES = 10
/** Moves of `fresh` a brief_read shows. */
const BRIEF_MOVES_SHOWN = 15

/** The most one brief_read answers an agent: a whole letter (up to 16,000 characters) with room around it. */
export const BRIEF_READ_MAX = ANSWER_CEILING_CHARS

/**
 * Brief_read's answer to an agent. The full read carried Walnut's live lists twice (`sections`,
 * and again inside `rules`) and every list whole (p95 25,745 characters, max 30.6K). Here the
 * letter stays whole (an edit quotes it), and what gives way to fit is everything else, in this
 * order: the rules lose their copy of the lists; each list keeps its first lines unless `section`
 * names it; the rules are cut; the lists shrink to their counts. Only a letter that cannot fit
 * even alone is cut, marked, with the call that reads it whole. A compact read (`compact: true`)
 * and an off Brief are already short and pass as they are.
 */
export function briefReadAnswer(result: unknown, args: Record<string, unknown>, max = BRIEF_READ_MAX): unknown {
  const r = objOf(result)
  if (r.off || r.compact) return result
  const want = typeof args.section === 'string' ? args.section : undefined
  const sections = isObj(r.sections) ? r.sections as Record<string, string[]> : null
  const brief = objOf(r.brief)
  const fresh = objOf(r.fresh)
  let rules = typeof r.rules === 'string' ? r.rules : undefined
  if (rules && sections) {
    const block = briefSectionsBlock(sections as Parameters<typeof briefSectionsBlock>[0])
    if (block && rules.includes(block)) rules = rules.replace(block, '(Walnut\'s live lists: under `sections`.)')
  }
  const build = (lines: number, rulesMax: number, moves: number, letterMax?: number): Obj => {
    const more: Record<string, number> = {}
    const shown = sections ? Object.fromEntries(Object.entries(sections).map(([k, rows]) => {
      const list = Array.isArray(rows) ? rows : []
      if (want === k || list.length <= lines) return [k, list]
      more[k] = list.length - lines
      return [k, list.slice(0, lines)]
    })) : sections
    const few = (v: unknown) => (Array.isArray(v) ? v.slice(0, moves) : v)
    const cutLists = Object.keys(more)
    const text = typeof brief.text === 'string' ? brief.text : ''
    const letterCut = letterMax !== undefined && text.length > letterMax
    const nexts = [
      String(r.next ?? ''),
      cutLists.length ? `A whole list: brief_read {"section":"${cutLists[0]}"} (one of ${cutLists.join(', ')}).` : '',
      letterCut ? 'The letter is longer than one answer holds: brief_read {"_full":true} reads it whole; edit it with brief_write edits, never by writing this cut text back.' : '',
    ].filter(Boolean)
    return {
      ...receiptBase(r),
      brief: r.brief ? { text: letterCut ? cut(text, letterMax!) : text, at: brief.at, ...(Array.isArray(brief.text_sources) ? { text_sources: brief.text_sources.length } : {}) } : null,
      ...(r.fresh ? { fresh: { ...fresh, ...(fresh.moved ? { moved: few(fresh.moved) } : {}), ...(fresh.finished ? { finished: few(fresh.finished) } : {}), ...(fresh.newAsks ? { newAsks: few(fresh.newAsks) } : {}) } } : {}),
      sections: shown,
      ...(cutLists.length ? { sections_more: more } : {}),
      ...(r.health ? { health: pick(r.health, ['line']) } : {}),
      ...(rules !== undefined ? { rules: cut(rules, rulesMax) } : {}),
      ...(nexts.length ? { next: nexts.join(' ') } : {}),
    }
  }
  // Room for the note answer.ts adds if anything were still over.
  const budget = max - 600
  const fits = (v: Obj) => JSON.stringify(v).length <= budget
  for (const [lines, rulesMax, moves] of [[BRIEF_SECTION_LINES, 1e9, BRIEF_MOVES_SHOWN], [BRIEF_SECTION_LINES, 3_000, BRIEF_MOVES_SHOWN], [5, 1_500, 10], [2, 600, 5], [0, 300, 3]] as const) {
    const out = build(lines, rulesMax, moves)
    if (fits(out)) return out
  }
  // The letter alone is over: cut it to what is left, marked, with the call that reads it whole.
  const bare = build(0, 300, 3, 0)
  return build(0, 300, 3, Math.max(1_000, budget - JSON.stringify(bare).length - 200))
}

/** Brief_write's receipt: the size, the limit and the lines to fix, never the letter it stored. */
export function briefWriteAnswer(result: unknown): unknown {
  const r = objOf(result)
  const issues = Array.isArray(r.issues) ? r.issues : []
  return {
    ...receiptBase(r),
    ...(r.brief ? { brief: pick(r.brief, ['at']) } : {}),
    ...(issues.length ? { issues: issues.slice(0, 20), ...(issues.length > 20 ? { issues_more: issues.length - 20 } : {}) } : {}),
  }
}

/** Rows of each open_items list an agent reads. */
const OPEN_LIST_ROWS = 15

/**
 * Open_items' answer to an agent (p95 24.7K): each list keeps its first rows, counted under
 * `<list>_more`. A hook's answer (compact, stop) is the hook's own output and passes as it is;
 * so does `full: true`, the restatement read whole on purpose.
 */
export function openItemsAnswer(result: unknown, args: Record<string, unknown>): unknown {
  if (args.hook !== undefined || args.full === true) return result
  const r = objOf(result)
  const out: Obj = {}
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v) && v.length > OPEN_LIST_ROWS) { out[k] = v.slice(0, OPEN_LIST_ROWS); out[`${k}_more`] = v.length - OPEN_LIST_ROWS }
    else out[k] = v
  }
  return out
}

/**
 * The answer policies for ops kept in other files, ready to set as their `answer`:
 * brief_read and brief_write (ops/tasks.ts), open_items (ops/work.ts).
 */
export const BRIEF_READ_ANSWER: OpAnswer = { kind: 'content', max: BRIEF_READ_MAX, whole: 'brief_read {"_full":true}', shape: ({ result, args, max }) => briefReadAnswer(result, args, max) }
export const BRIEF_WRITE_ANSWER: OpAnswer = { kind: 'receipt', whole: 'brief_read {"_full":true}', shape: ({ result }) => briefWriteAnswer(result) }
export const OPEN_ITEMS_ANSWER: OpAnswer = { kind: 'content', shape: ({ result, args }) => openItemsAnswer(result, args) }
