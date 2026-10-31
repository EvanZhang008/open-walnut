/**
 * Human-inbox ops — how an agent writes to the ONE human who reads its letters.
 *
 * The default is NOT to send (2026-10-05, the user: "only the most important
 * information"; notifications go to the inbox only when the user asked).
 *
 * Send a letter, reply in an existing letter's thread; and read the inbox the way
 * the user does (list, one letter by id, read / pin / archive), since whatever a
 * person can do in Walnut an agent can do too (2026-10-27: Main could not read a
 * letter it wanted to pass on). The envelope (which session, task, project, host)
 * is stamped server-side from the caller's session id, so the descriptions below
 * spend their words on the thing the model actually has to get right: writing a
 * letter worth reading. A task may answer a letter in the user's place, recorded as
 * its answer; a plugin's letter (an approval of a step outside Walnut) refuses it.
 *
 * WHERE THE REFUSALS LIVE. Nothing here validates: this module only DECLARES the
 * op, and `bind` is executed by src/ops/executor.ts as an HTTP call from the
 * CALLER's own process, so a check in this file would run inside the session's CLI
 * and be advisory. Every rule is enforced where the op is SERVED —
 * `sendLetterAsCaller` (core/human-inbox/letter-ops.ts) and the store behind it —
 * which is the one path both the HTTP route and the cloud replica's relay share.
 * That is also where the per-run letter budget lives
 * (core/human-inbox/triage-quota.ts); the refusal's text tells the model what to
 * do instead, and the clause below is what stops that refusal being a surprise.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineOp } from './registry.js'
import { inboxItemsSchema } from '../core/human-inbox/item-schema.js'
import { MESSAGE_TEXT_HINT } from '../core/team-charter.js'
import { withOutcome } from './outcome.js'

const LETTER_TYPE = z.enum(['completion', 'action_required', 'review', 'info'])

const ACTION = z.object({
  id: z.string().min(1).describe('Stable id you receive back when the human picks this option'),
  label: z.string().min(1).describe('Button text, e.g. "Option A: cache the result"'),
  description: z.string().optional().describe('One line of trade-off shown under the button'),
})

defineOp({
  name: 'human_inbox_send',
  title: 'Send the human a letter',
  description:
    'Send your user a letter they read in Walnut (web or phone) and can reply to. The inbox is only for '
    + 'what needs them, and every letter buzzes their phone: send one when you are blocked on their '
    + 'decision, when something must have their review, or when they asked for it (a digest or report they '
    + 'set up, "tell me when X"). Never for a notification they did not ask for: progress, a finished step, '
    + 'a parked task, an FYI. Your task and its session already show those. When unsure, do not send. '
    + 'A task answering another task\'s request (Main, a lead) sends its result in its reply to that task, '
    + 'which tells the user; a report letter (info, completion, review) about that work is refused (409, '
    + 'the request named) unless the user themself asked this task for a letter or report (user_asked:true). '
    + 'A letter from or about a snoozed task (start date still to come) is refused (409 task_snoozed) unless '
    + 'snooze_reason says why it cannot wait for that date. '
    + 'Writing standard: one phone screen, background in 1-2 sentences, then the point; '
    + 'self-contained (never "see the session"); link long artifacts by path instead of pasting them. '
    + 'Body is markdown (usual choice) or self-contained html with inline styles, exactly one of the two. '
    + 'type=action_required means you need a decision and REQUIRES `actions`, at least one: the human '
    + 'taps one option and that choice is delivered back into this session. Without them the letter is '
    + 'a dead end, so it is rejected — if the human only needs to read this, send review or info '
    + 'instead. A few agents have a per-run letter budget (Inbox Triage: one summary plus three '
    + 'action_required); going over it is refused with the next move spelled out. Never write who you are; the '
    + 'sender (session, task, host) is stamped for you. Returns the letter id, which you need to reply.',
  input: {
    subject: z.string().min(1).describe('One line the human reads first, like an email subject'),
    type: LETTER_TYPE.describe(
      'completion | action_required | review | info. action_required also requires `actions`'),
    markdown: z.string().optional().describe(`Letter body as markdown (exactly one of markdown | html). ${MESSAGE_TEXT_HINT}`),
    html: z.string().optional().describe(
      'Letter body as self-contained HTML, no scripts (inline styles only). The one body that may '
      + 'carry inline media as data: URIs — a chart image, an audio digest as '
      + '<audio controls src="data:audio/mpeg;base64,...">, or a clip as '
      + '<video controls src="data:video/mp4;base64,...">. Up to 100MB (hours of audio, or a '
      + 'screen recording); remote URLs are blocked. A payload this big cannot ride argv — write '
      + 'the whole JSON to a file and pass it as '
      + '`walnut tools call human_inbox_send @/path/payload.json` (the file is transferred in '
      + 'batches for you, so size is not your problem).'),
    text: z.string().optional().describe('Short plain-text preview for the envelope row and the phone push'),
    actions: z.array(ACTION).min(1).optional().describe(
      'The options rendered as buttons. REQUIRED (at least one) when type=action_required, and '
      + 'rejected on any other type: a decision letter with no options is one the human cannot answer'),
    items: inboxItemsSchema.optional().describe('Independent email items. Supply exact account/message, safe display data and typed actions for every email in a summary. Fixed intents only; no tool, args, label or target on op actions. These do not answer the whole letter.'),
    task_refs: z.array(z.string()).optional().describe('Task ids this letter is about; rendered as clickable pills'),
    pin: z.boolean().optional().describe('Pin it to the top of the inbox (digests, standing reports)'),
    user_asked: z.boolean().optional().describe(
      'The user themself asked this task for this letter or report. Only then does a report letter go out '
      + 'while this task answers another task\'s request'),
    snooze_reason: z.string().optional().describe(
      'Required when this task, or one in task_refs, is snoozed (its start date is still to come): one line '
      + 'the user reads saying why this cannot wait for that date. It leads the letter'),
  },
  bind: { method: 'POST', path: '/human-inbox' },
  mapResult: ({ body }) => ({
    letterId: (body as { id?: unknown } | undefined)?.id,
    ...((body as { addedToThread?: unknown } | undefined)?.addedToThread === true ? { addedToThread: true } : {}),
    instruction:
      ((body as { addedToThread?: unknown } | undefined)?.addedToThread === true
        ? 'The user is away from your chat, so this update joined your letter of this absence (one thread, one buzz). '
        : 'The letter is in the human\'s inbox. ')
      + 'If they answer, their reply arrives as a message in '
      + 'this session; continue the thread with human_inbox_reply and that letterId.',
  }),
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'human_inbox_reply',
  title: 'Reply in a letter thread',
  description:
    'Append your answer to a letter you already sent, once the human has replied or clicked an '
    + 'option. Same standard as the letter itself: answer the question first, keep it to a few '
    + 'sentences, link anything long. This flips the letter back to unread and notifies them, so '
    + 'reply here rather than only in the session, otherwise your answer never leaves this host.',
  input: {
    letter: z.string().min(1).describe('Letter id from human_inbox_send (lt-...)'),
    text: z.string().min(1).describe('Your reply as plain text (always required: it is the thread line)'),
    markdown: z.string().optional().describe('Optional richer body rendered under the reply'),
    html: z.string().optional().describe('Optional self-contained HTML body, no scripts'),
    items: inboxItemsSchema.optional().describe('New independent email items for this reply only. Item and action ids must be unique across the whole letter and thread.'),
  },
  bind: { method: 'POST', path: '/human-inbox/:letter/reply' },
  tags: { readonly: false, remote: 'allow' },
})

// ─── Reading the inbox, as the user does ─────────────────────────────────────

/** At most this much of a letter's document reaches the agent; the rest is named, not pasted. */
const BODY_CHARS = 20_000
const TURN_CHARS = 4_000
/** The newest turns a read returns; the count of the earlier ones rides beside them. */
const THREAD_TURNS = 20
/** The biggest deferred body a read fetches to make text of. */
const DEFERRED_READ_BYTES = 10 * 1024 * 1024

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

type LetterRow = Record<string, unknown> & {
  id: string; createdAt?: number; sender?: { taskId?: string; taskTitle?: string; sessionTitle?: string; project?: string; host?: string; pluginId?: string }
  taskRefs?: string[]; thread?: unknown[]; read?: boolean
}

/** A list row: the envelope the user's inbox shows, no documents. */
function envelope(l: LetterRow) {
  return {
    id: l.id, subject: l.subject, type: l.type, preview: l.textPreview,
    from: l.sender ? { taskId: l.sender.taskId, task: l.sender.taskTitle, session: l.sender.sessionTitle, project: l.sender.project, plugin: l.sender.pluginId } : undefined,
    at: typeof l.createdAt === 'number' ? new Date(l.createdAt).toISOString() : undefined,
    read: l.read, pinned: l.pinned, archived: l.archived,
    ...(l.actions ? { actions: l.actions } : {}), ...(l.answered ? { answered: l.answered } : {}),
    ...(l.settled ? { settled: l.settled } : {}),
    ...(l.taskRefs?.length ? { taskRefs: l.taskRefs } : {}),
    turns: Array.isArray(l.thread) ? l.thread.length : 0,
  }
}

defineOp({
  name: 'human_inbox_list',
  title: 'List the letters in the user\'s inbox',
  description:
    'The letters in your user\'s inbox, newest first, as the inbox lists them (subject, type, sender, '
    + 'read, pinned, answered; no documents). `task_id` keeps the letters that task sent or that name it. '
    + 'Read one with human_inbox_get.',
  input: {
    task_id: z.string().optional().describe('Only letters this task sent, or that name it in their task pills'),
    archived: z.boolean().optional().describe('The archive instead of the inbox'),
    unread: z.boolean().optional().describe('Only letters the user has not read'),
    limit: z.number().int().min(1).max(200).optional().describe('At most this many (default 30)'),
  },
  handler: async ({ task_id, archived, unread, limit }, call) => {
    const body = await call('GET', `/human-inbox${archived ? '?archived=1' : ''}`) as { letters?: LetterRow[]; unreadCount?: number }
    const all = Array.isArray(body?.letters) ? body.letters : []
    const task = typeof task_id === 'string' ? task_id.trim() : ''
    const kept = all
      .filter((l) => !task || l.sender?.taskId === task || (l.taskRefs ?? []).includes(task))
      .filter((l) => !unread || !l.read)
    const letters = kept.slice(0, typeof limit === 'number' ? limit : 30).map(envelope)
    return withOutcome(
      { letters, total: kept.length, unreadCount: body?.unreadCount ?? 0 },
      letters.length ? `${kept.length} letter${kept.length === 1 ? '' : 's'}${kept.length > letters.length ? `, the newest ${letters.length} shown` : ''}.` : 'No letters match.',
      'Read one with human_inbox_get; mark it with human_inbox_mark.',
    )
  },
  routes: [{ method: 'GET', path: '/human-inbox' }],
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'human_inbox_get',
  title: 'Read one letter in the user\'s inbox',
  description:
    'One letter by id (lt-...), as the user reads it: the envelope, its options and the user\'s answer, '
    + 'the document as readable text (an html letter loses its markup; a long one is cut, with its length), '
    + 'and the thread. Reading it here does not mark it read for the user.',
  input: {
    id: z.string().min(1).describe('Letter id (lt-...)'),
  },
  handler: async ({ id }, call) => {
    const path = `/human-inbox/${encodeURIComponent(String(id))}`
    const body = await call('GET', path) as { letter?: LetterRow & { body?: string; bodyFormat?: string; bodyDeferred?: boolean; bodyBytes?: number; thread?: Array<Record<string, unknown>> } }
    const l = body?.letter
    if (!l) throw new Error(`Letter not found: ${id}`)
    // A body over the inline cap (a digest with media) is read whole from its own route, up to
    // DEFERRED_READ_BYTES: its media goes with the markup, and the text left is what the user reads.
    let raw = typeof l.body === 'string' ? l.body : undefined
    if (raw === undefined && l.bodyDeferred && (l.bodyBytes ?? 0) <= DEFERRED_READ_BYTES) {
      const fetched = await call('GET', `${path}/body`).catch(() => undefined)
      if (typeof fetched === 'string') raw = fetched
    }
    const doc = raw !== undefined ? capped(readable(raw, l.bodyFormat), BODY_CHARS)
      : l.bodyDeferred ? { text: '', deferred: true as const, bytes: l.bodyBytes } : null
    const turns = (l.thread ?? []) as Array<Record<string, unknown>>
    const shown = turns.slice(-THREAD_TURNS)
    const thread = shown.map((t) => {
      const text = typeof t.text === 'string' ? t.text : ''
      return {
        from: t.from, at: typeof t.at === 'number' ? new Date(t.at).toISOString() : t.at,
        ...(t.by ? { by: t.by } : {}),
        // A rich turn's plain line can be its html (a plugin's reply with no text); a person's words never are.
        ...capped(readable(text, t.from === 'agent' && t.bodyFormat === 'html' && LOOKS_HTML.test(text) ? 'html' : 'text'), TURN_CHARS),
        ...(typeof t.body === 'string' ? { body: capped(readable(t.body, t.bodyFormat), TURN_CHARS) } : t.bodyDeferred ? { body: { text: '', deferred: true } } : {}),
        ...(t.items ? { items: t.items } : {}),
      }
    })
    const letter = {
      ...envelope(l),
      format: l.bodyFormat,
      ...(doc ? { document: doc } : {}),
      ...(l.items ? { items: l.items } : {}),
      thread,
      ...(turns.length > shown.length ? { earlierTurns: turns.length - shown.length } : {}),
    }
    return withOutcome({ letter }, `Letter ${l.id}: "${String(l.subject ?? '')}".`, 'Mark it with human_inbox_mark; answer it for the user with human_inbox_answer; reply in a letter you sent with human_inbox_reply.')
  },
  routes: [{ method: 'GET', path: '/human-inbox/:id' }, { method: 'GET', path: '/human-inbox/:id/body' }],
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'human_inbox_mark',
  title: 'Mark a letter read, pinned or archived',
  description:
    'Sets a letter\'s read, pinned or archived flag, as the user does in the inbox (any of the three, '
    + 'true or false). Archive only what the user no longer needs to see: a letter you sent that is '
    + 'settled, or one the user asked you to clear; an unread decision letter stays for the user. '
    + '`settled` closes a decision letter nobody needs to answer any more (the thing it asked was done '
    + 'outside Walnut, the blocker cleared, the question is moot): it leaves the inbox with your one-line '
    + 'reason, which the user reads. Settle your own decision letter the moment its ask is moot.',
  input: {
    id: z.string().min(1).describe('Letter id (lt-...)'),
    read: z.boolean().optional().describe('Read (true) or unread (false)'),
    pinned: z.boolean().optional().describe('Pinned to the top (true) or not (false)'),
    archived: z.boolean().optional().describe('Archived (true) or back in the inbox (false)'),
    settled: z.string().min(3).max(200).optional().describe(
      'Settle an unanswered decision letter: one line saying why nobody needs to answer it now (e.g. "The agreement was accepted; build 140 uploaded")'),
  },
  handler: async ({ id, read, pinned, archived, settled }, call) => {
    const sets = ([['read', read], ['pin', pinned], ['archive', archived]] as const).filter(([, v]) => typeof v === 'boolean')
    const reason = typeof settled === 'string' ? settled.trim() : ''
    if (!sets.length && !reason) throw new Error('Name at least one of read, pinned, archived, settled.')
    let letter: unknown
    if (reason) {
      const body = await call('POST', `/human-inbox/${encodeURIComponent(String(id))}/settle`, { reason }) as { letter?: LetterRow }
      letter = body?.letter ? envelope(body.letter) : letter
    }
    for (const [what, v] of sets) {
      const key = what === 'read' ? 'read' : what === 'pin' ? 'pinned' : 'archived'
      const body = await call('POST', `/human-inbox/${encodeURIComponent(String(id))}/${what}`, { [key]: v }) as { letter?: LetterRow }
      letter = body?.letter ? envelope(body.letter) : letter
    }
    return withOutcome({ letter }, `Letter ${id} updated.`, 'human_inbox_list shows the inbox as the user sees it.')
  },
  routes: [
    { method: 'POST', path: '/human-inbox/:id/read' },
    { method: 'POST', path: '/human-inbox/:id/pin' },
    { method: 'POST', path: '/human-inbox/:id/archive' },
    { method: 'POST', path: '/human-inbox/:id/settle' },
  ],
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'human_inbox_answer',
  title: 'Answer a letter in the user\'s place',
  description:
    'Answers a letter in your user\'s inbox for them, as they would there: pick one of its options '
    + '(`action_id`, with an optional `note`) or write a reply (`text`). Only when your user asked you to, '
    + 'or the answer is plainly theirs already (they said it to you), and always with `user_words`: exactly what '
    + 'they said, quoted in their language, naming the option or the step you answer with. The letter, its sender '
    + 'and the inbox record that your task answered on those words, not the user, and the letter stays unread for '
    + 'them. An answer that approves a step that is hard to undo or leaves Walnut (rewriting git history, '
    + 'unpublishing a release, deleting, publishing or sending outward, spending, credentials or permissions) is '
    + 'refused (human-approval-required) unless `user_words` ask for that step by name; naming the option ("all as '
    + 'recommended", "yes", "A") is not enough, and one vague line such as "clear everything" approves none of them: '
    + 'ask the user about that step by name. A '
    + 'plugin\'s letter (an approval of a step outside Walnut, such as a mail send) is the user\'s alone: refused '
    + 'too; tell the user what you would answer.',
  input: {
    id: z.string().min(1).describe('Letter id (lt-...)'),
    action_id: z.string().optional().describe('The option to pick (its id, from human_inbox_get actions)'),
    note: z.string().optional().describe('With action_id: a note beside the choice'),
    text: z.string().optional().describe('Without action_id: a reply in the thread, in the user\'s place'),
    user_words: z.string().optional().describe(
      'REQUIRED: the user\'s own words this answer rests on, quoted exactly (their language), naming each step that is hard to undo or leaves Walnut'),
  },
  handler: async ({ id, action_id, note, text, user_words }, call) => {
    const path = `/human-inbox/${encodeURIComponent(String(id))}`
    const pick = typeof action_id === 'string' ? action_id.trim() : ''
    const words = typeof text === 'string' ? text.trim() : ''
    if (!pick && !words) throw new Error('Name action_id (an option) or text (a reply).')
    // Checked where the op is served (core/human-inbox/answer-approval.ts); passed through as given.
    const quoted = typeof user_words === 'string' ? { userWords: user_words } : {}
    const out = pick
      ? await call('POST', `${path}/answer`, { actionId: pick, ...(typeof note === 'string' && note.trim() ? { freeText: note.trim() } : {}), ...quoted })
      // The same words to the same letter are the same reply: a retry is never a second turn.
      : await call('POST', `${path}/human-reply`, { text: words, clientId: `op-${createHash('sha256').update(`${id}\n${words}`).digest('hex').slice(0, 32)}`, ...quoted })
    const r = out as { letter?: LetterRow; delivery?: { status?: string; reason?: string } }
    const status = r?.delivery?.status
    return withOutcome(
      { ...(r?.letter ? { letter: envelope(r.letter) } : {}), ...(r?.delivery ? { delivery: r.delivery } : {}) },
      `Letter ${id} answered for the user${status ? `; to its sender: ${status}${r.delivery?.reason ? ` (${r.delivery.reason})` : ''}` : ''}.`,
      'Tell the user what you answered when they asked you to.',
    )
  },
  routes: [
    { method: 'POST', path: '/human-inbox/:id/answer' },
    { method: 'POST', path: '/human-inbox/:id/human-reply' },
  ],
  tags: { readonly: false, remote: 'allow' },
})
