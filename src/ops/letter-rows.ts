/**
 * A letter as an agent reads it from the inbox ops (human-inbox.ts): the list's row, its short form,
 * and one letter whole, with its document and thread as readable text.
 *
 * Outside text (core/human-inbox/letter-outside.ts says which letters carry it) reaches the agent inside
 * the one JSON frame of core/outside-content.ts, under `outside`: the subject, the preview, the options'
 * words and the document of such a letter, and every turn not a person's in it; a mail item's words go
 * under `items_content`. Ids, state, times and option ids stay beside the frame, so an agent still
 * marks, answers and links the letter. A JSON frame and not a text block: the answer cap (answer.ts)
 * shortens strings, and a cut string inside the frame leaves the frame whole, where a cut text block
 * would lose its closing tag. `framed` is false for a person or a plugin's own code (agentReadsFramed):
 * they read every letter as it was.
 */
import { frameOutsideData, isFramedOutside, outsideDataOf } from '../core/outside-content.js'
import { LETTER_ITEMS_SOURCE, letterOutsideSource, turnOutsideSource } from '../core/human-inbox/letter-outside.js'
import { line, objOf, pick } from './org-answer-shapes.js'

/** At most this much of a letter's document reaches the agent; the rest is named, not pasted. */
const BODY_CHARS = 20_000
const TURN_CHARS = 4_000
/** The newest turns a read returns; the count of the earlier ones rides beside them. */
const THREAD_TURNS = 20
/** The biggest deferred body a read fetches to make text of. */
export const DEFERRED_READ_BYTES = 10 * 1024 * 1024

/** The named entities mail html uses most; the rest of the decoding is numeric. */
const ENTITIES: Record<string, string> = {
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
  middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', zwnj: '', zwj: '', shy: '',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Markup an html turn's plain `text` may hold too (a plugin's reply with html and no text). */
const LOOKS_HTML = /<\/?[a-z][^>]*>/i

/** A document as readable text: an html body loses its markup, styles, scripts and inline media. */
function readable(body: string, format: unknown): string {
  if (format !== 'html') return body
  const text = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(style|script|head|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '\n')
    // A tag, quoted attribute values and all: a `>` inside a value does not end it.
    .replace(/<\/?[a-z!?](?:[^>"']|"[^"]*"|'[^']*')*>/gi, ' ')
  return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
}

function capped(text: string, max: number): { text: string; truncated?: true; chars?: number } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true, chars: text.length } : { text }
}

export type LetterRow = Record<string, unknown> & {
  id: string; createdAt?: number; sender?: { taskId?: string; taskTitle?: string; sessionTitle?: string; project?: string; host?: string; pluginId?: string }
  taskRefs?: string[]; thread?: Array<Record<string, unknown>>; read?: boolean; createdByOp?: string; origin?: { kind?: string }
  body?: string; bodyFormat?: string; bodyDeferred?: boolean; bodyBytes?: number
}

/** The options of a letter whose words are outside: their ids beside the frame, their words in it. */
function actionIds(actions: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(actions) ? actions.map((a) => pick(objOf(a), ['id', 'recommended'])) : undefined
}

/**
 * A letter's email items (always a mail's display data, item-schema.ts): what an agent acts on (item and
 * action ids, the mail's account and message ids, whether it was read) plain, their words framed.
 */
function itemsOf(items: unknown, framed: boolean): { items?: unknown[]; items_content?: Record<string, unknown> } {
  if (!Array.isArray(items) || !items.length) return {}
  if (!framed) return { items }
  const refs = items.map((one) => {
    const i = objOf(one)
    return {
      ...pick(i, ['id', 'source', 'readObservation']),
      ...(Array.isArray(i.actions) ? { actions: i.actions.map((a) => pick(objOf(a), ['id', 'kind', 'intent'])) } : {}),
    }
  })
  const words = items.map((one) => {
    const i = objOf(one)
    const labelled = Array.isArray(i.actions) ? i.actions.map((a) => pick(objOf(a), ['id', 'label', 'question'])).filter((a) => a.label || a.question) : []
    return { ...pick(i, ['id', 'subject', 'summary', 'display']), ...(labelled.length ? { actions: labelled } : {}) }
  })
  return { items: refs, items_content: frameOutsideData({ source: LETTER_ITEMS_SOURCE }, words) }
}

/** The label of the option a letter was answered with, when it has one. */
function answeredLabel(answered: unknown): string | undefined {
  const label = objOf(answered).label
  return typeof label === 'string' && label ? label : undefined
}

/** A list row: the envelope the user's inbox shows, no documents; `framed` for an agent's read (agentReadsFramed). */
export function envelope(l: LetterRow, framed: boolean) {
  const source = framed ? letterOutsideSource(l) : undefined
  return {
    id: l.id, ...(source ? {} : { subject: l.subject }), type: l.type, ...(source ? {} : { preview: l.textPreview }),
    from: l.sender ? { taskId: l.sender.taskId, task: l.sender.taskTitle, session: l.sender.sessionTitle, project: l.sender.project, plugin: l.sender.pluginId } : undefined,
    at: typeof l.createdAt === 'number' ? new Date(l.createdAt).toISOString() : undefined,
    read: l.read, pinned: l.pinned, archived: l.archived,
    ...(l.actions ? { actions: source ? actionIds(l.actions) : l.actions } : {}),
    // The chosen option's label is the letter's words too: its id, time and who stay beside the frame.
    ...(l.answered ? { answered: source && typeof l.answered === 'object' ? pick(objOf(l.answered), ['actionId', 'at', 'by']) : l.answered } : {}),
    ...(l.settled ? { settled: l.settled } : {}),
    ...(l.taskRefs?.length ? { taskRefs: l.taskRefs } : {}),
    turns: Array.isArray(l.thread) ? l.thread.length : 0,
    ...(source ? {
      outside: frameOutsideData({ source }, {
        subject: l.subject, ...(l.textPreview ? { preview: l.textPreview } : {}),
        ...(Array.isArray(l.actions) ? { actions: l.actions.map((a) => pick(objOf(a), ['id', 'label', 'description'])) } : {}),
        ...(answeredLabel(l.answered) ? { answered: { label: answeredLabel(l.answered) } } : {}),
      }),
    } : {}),
  }
}

/**
 * A list row an agent reads: the envelope in short (one line each), no options' text. A row whose words
 * are outside keeps them framed, shortened inside the frame; `withNote: false` leaves the frame's
 * reading note to the page, which carries it once for every row.
 */
export function compactEnvelope(row: unknown, withNote = true) {
  const e = objOf(row)
  const from = objOf(e.from)
  const actions = Array.isArray(e.actions) ? e.actions.length : 0
  // The row's own frame, read back to shorten it and framed again: never left out of a frame.
  const framed = isFramedOutside(e.outside)
  const source = objOf(objOf(e.outside).external_content).source
  const words = objOf(outsideDataOf(e.outside))
  const answered = objOf(words.answered)
  const outside = framed
    ? frameOutsideData({ source: typeof source === 'string' && source ? source : 'letter' }, {
      subject: line(words.subject, 120), ...(words.preview ? { preview: line(words.preview, 120) } : {}),
      ...(typeof answered.label === 'string' ? { answered: { label: line(answered.label, 120) } } : {}),
    })
    : undefined
  if (outside && !withNote) delete outside.note
  return {
    id: e.id, ...(outside ? {} : { subject: line(e.subject, 120) }), type: e.type,
    ...(from.task || from.taskId || from.plugin ? { from: from.task ? `${line(from.task, 60)}${from.taskId ? ` (${String(from.taskId)})` : ''}` : from.plugin ?? from.taskId } : {}),
    at: e.at, read: e.read,
    ...(e.pinned ? { pinned: true } : {}), ...(e.archived ? { archived: true } : {}),
    ...(actions ? { actions } : {}),
    ...(e.answered ? { answered: typeof e.answered === 'object' ? pick(e.answered, ['actionId', 'label', 'at', 'by']) : true } : {}),
    ...(e.settled ? { settled: true } : {}),
    turns: e.turns,
    ...(!outside && e.preview ? { preview: line(e.preview, 120) } : {}),
    ...(outside ? { outside } : {}),
  }
}

/** One letter whole: its envelope, its document as readable text (`raw`, when read), items and thread. */
export function readLetter(l: LetterRow, raw: string | undefined, framed: boolean): { letter: Record<string, unknown>; source?: string } {
  const doc = raw !== undefined ? capped(readable(raw, l.bodyFormat), BODY_CHARS)
    : l.bodyDeferred ? { text: '', deferred: true as const, bytes: l.bodyBytes } : null
  const source = framed ? letterOutsideSource(l) : undefined
  const turns = l.thread ?? []
  const shown = turns.slice(-THREAD_TURNS)
  const thread = shown.map((t) => {
    const text = typeof t.text === 'string' ? t.text : ''
    const words = {
      // A rich turn's plain line can be its html (a plugin's reply with no text); a person's words never are.
      ...capped(readable(text, t.from === 'agent' && t.bodyFormat === 'html' && LOOKS_HTML.test(text) ? 'html' : 'text'), TURN_CHARS),
      ...(typeof t.body === 'string' ? { body: capped(readable(t.body, t.bodyFormat), TURN_CHARS) } : t.bodyDeferred ? { body: { text: '', deferred: true } } : {}),
    }
    const turnSource = framed ? turnOutsideSource(t as { from?: unknown; sender?: Record<string, string> }, source) : undefined
    return {
      from: t.from, at: typeof t.at === 'number' ? new Date(t.at).toISOString() : t.at,
      ...(t.by ? { by: t.by } : {}),
      ...(turnSource ? { outside: frameOutsideData({ source: turnSource }, words) } : words),
      ...itemsOf(t.items, framed),
    }
  })
  const { outside: envelopeWords, ...head } = envelope(l, framed)
  const letter = {
    ...head,
    format: l.bodyFormat,
    ...(source
      ? { outside: frameOutsideData({ source }, { ...objOf(outsideDataOf(envelopeWords)), ...(doc ? { document: doc } : {}) }) }
      : doc ? { document: doc } : {}),
    ...itemsOf(l.items, framed),
    thread,
    ...(turns.length > shown.length ? { earlierTurns: turns.length - shown.length } : {}),
  }
  return { letter, ...(source ? { source } : {}) }
}
