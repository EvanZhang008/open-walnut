/**
 * Ops for an Org node's Threads (src/core/org/threads-model.ts, routes src/web/routes/org-threads-v1.ts):
 * the user's own requests to Main, a VP or a lead, one thread per subject.
 */
import { longTextHint } from '../core/org/ask-clarity.js'
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import {
  PAGE_BUDGET, THREAD_BODY_MAX, THREAD_GET_MAX, THREAD_GET_MESSAGES, THREAD_LIST_PAGE, fitPage, nextPageCall, objOf, pageOf, pageWords, receiptBase,
  threadRead, threadReceipt, threadRow, type Page, type ThreadLike,
} from './org-answer-shapes.js'
import type { OpCall } from './core.js'
import { PROOF_IN_PLACE_RULE, WORD_TO_USER_RULE, THREAD_ONE_PLACE_RULE, THREADS_MOVE_RULE, THREADS_KNOWN_RULE, THREADS_OPEN_RULE, THREADS_OPTIONS_RULE, THREADS_PENDING_RULE, THREADS_SUMMARY_RULE } from '../core/org/thread-rules.js'
import { ASK_OPTIONS_MAX } from '../core/user-status.js'
import { THREAD_STATES } from '../core/org/threads-model.js'
import { ACK_PLACES, PLACE_WHY_MAX } from '../core/org/thread-view.js'
import { USER_KINDS, USER_KIND_ABOUT_PARAM, USER_KIND_PARAM, USER_KIND_WHY_PARAM, USER_KIND_WORDS_PARAM, DESIGN_REVIEW_PARAM } from '../core/org/user-kind.js'

const THREADS_SCOPE = 'Your Threads are the user\'s own requests to you, one thread per subject, on the Org page beside your Brief '
  + '(Main and every lead keep them; a VP is a lead), or beside your chat on a task the user turned Threads on for. Walnut files every message he sends you, and tells you in that message which '
  + 'thread it went to. You keep each thread current: a short title in the language you write to him, one line of what he wants (ask), '
  + 'its state (working: you are on it; needs: waiting on him; answered: you answered and he may close it; pending: nothing new for him), the summary (reply) and '
  + 'the tasks you handed it to. Several asks about one subject are ONE thread: put a new one under the open thread it belongs to '
  + '(merge_into). Walnut puts your chat reply under each of his messages by itself (answer). He closes a thread with Acknowledge; a '
  + 'closed one is kept a week, then deleted; a new ask about a closed subject is a new thread. ' + THREADS_MOVE_RULE + ' ' + THREADS_SUMMARY_RULE + ' ' + PROOF_IN_PLACE_RULE + ' ' + THREADS_PENDING_RULE + ' ' + THREADS_OPTIONS_RULE + ' ' + THREADS_KNOWN_RULE + ' ' + THREADS_OPEN_RULE + ' ' + THREAD_ONE_PLACE_RULE

async function ownTask(args: { task?: unknown }, call: OpCall): Promise<string> {
  const id = typeof args.task === 'string' && args.task.trim()
    ? args.task.trim()
    : ((await call('GET', '/me')) as { task?: { id?: string } } | undefined)?.task?.id
  if (!id) throw new Error('No task of your own: pass task.')
  return id
}

/** A choice he clicks (core/ask-options.ts reads it, the report's ask_options too). */
const OPTION_ARG = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/).optional().describe('A short id; default o1, o2...'),
  label: z.string().min(1).max(80).describe('What he clicks, a few words'),
  detail: z.string().max(200).optional().describe('One line of what it leads to'),
  recommended: z.boolean().optional().describe('The one you recommend: put it first'),
})
const OPTIONS_WHY = `With state needs: the choices he picks from, 2 to ${ASK_OPTIONS_MAX}, the recommended one first; his click is his answer, filed in the thread. [] takes them off. With his one-card setting on (threads_one_card) they are his buttons, and required when the summary lists choices (A:, B:, 1., 2.): Walnut refuses that write without them (409 needs_options)`

const TASK_ARG = z.string().min(1).optional().describe('Task id or unique prefix of Main, a lead or a task with Threads on; default: your own task')

interface ThreadView { id: string; title: string; state: string; closed?: { how: string } | null; messages?: unknown[]; snoozed?: { until: string }; pinned?: { by: string }; askedIn?: { task: string; title: string }; ackPlaced?: { to: string } }

/** Every thread op that hands a thread to the user (same-ask.ts). */
/** Every thread op that hands a thread to the user while its task asks him something else (thread-supersede.ts). */
const SUPERSEDES_PARAM = 'With needs, when your task still asks the user something else (another of its threads in needs, a decision letter he has not answered; 409 other_open_asks names them): the ids (th-..., lt-...) this one replaces. They leave his Needs you now: one matter is asked in one place'
const SEPARATE_REASON_PARAM = 'With needs, after a 409 other_open_asks, when those asks are other decisions that stay open: one line (10+ characters) saying why'

const SAME_ASK_REASON_PARAM = 'With needs: only after a 409 same_ask (a task in your team already asks him this; leave the ask to it and keep the thread working or pending), '
  + 'when this really is a different decision: one line (10+ characters) saying why. Never stored'

const THREAD_ID = z.string().regex(/^th-[a-f0-9]{6,32}$/)

/** How an agent reads a thread whole after a receipt (answer.ts `whole`). */
const READ_WHOLE = 'thread_get {"id":"<id>"}'

/** A write's receipt: its notes, the thread(s) it changed in a few fields each, and what changed. */
function threadWriteReceipt(result: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const r = objOf(result)
  return {
    ...receiptBase(r),
    ...(r.thread ? { thread: threadReceipt(r.thread as ThreadLike) } : {}),
    ...(r.from ? { from: threadReceipt(r.from as ThreadLike) } : {}),
    ...extra,
  }
}

/** A long value of the caller's own is named, not repeated, in a corrected call. */
function callArgs(args: Record<string, unknown>, add: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries({ ...args, ...add })) {
    if (v === undefined) continue
    out[k] = typeof v === 'string' && v.length > 120 ? `<your ${k} as before>` : v
  }
  return JSON.stringify(out)
}

const KIND_FIX = { user_kind: `<one of ${USER_KINDS.join(', ')}>`, user_kind_why: '<one line: what in this question makes it that kind>' }
const OPTIONS_FIX = { options: [{ label: '<your pick>', recommended: true }, { label: '<the other choice>' }] }

/**
 * A refusal of a thread write says the call that goes through: the caller's own arguments with
 * what was missing, or the keys the op takes. Thrown as a new error of the same kind with the same
 * fields (status, code, whether its answer was lost), so the executor reads it as before; the
 * caller's error object is left as it was.
 */
function withCorrectedCall(op: string, args: Record<string, unknown>, keys: readonly string[], err: unknown): never {
  if (!(err instanceof Error)) throw err
  const code = (err as { code?: unknown }).code
  const status = (err as { status?: unknown }).status
  const msg = err.message
  const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
  let fix = ''
  if (code === 'user_kind' && /with user_kind \(one of/.test(msg)) fix = `${op} ${callArgs(given, KIND_FIX)}`
  else if (code === 'needs_options' || (code === 'user_kind' && /Pass options|as options/.test(msg))) fix = `${op} ${callArgs(given, OPTIONS_FIX)}`
  else if (code === 'user_kind' && /has no summary/.test(msg)) fix = `${op} ${callArgs(given, { reply: '<first what he decides and what you recommend, then the key points>' })}`
  else if (code === 'not_reacted' && given.close) fix = `${op} ${callArgs(given, { user_words: '<his words asking to close it, quoted from his latest message>' })}`
  else if (code === 'same_ask') fix = `${op} ${callArgs(given, { same_ask_reason: '<one line: why this is a different decision>' })}, or leave the ask to that task and keep this thread working`
  else if (code === 'last_message' && typeof given.merge_into === 'string') fix = `thread_update {"id":"${String(given.id)}","merge_into":"${given.merge_into}"} (its only message moves with the whole thread)`
  else if (code === 'pinned_by_user') fix = `${op} ${callArgs(Object.fromEntries(Object.entries(given).filter(([k]) => !['pin', 'snooze', 'close'].includes(k))))}`
  const words = fix ? `${msg} The call that goes through: ${fix}`
    : status === 400 && !msg.includes(' takes: ') ? `${msg} ${op} takes: ${keys.join(', ')}.` : ''
  if (!words) throw err
  throw renamed(err, words)
}

/** A copy of `err` (its class, its own fields, its stack) with other words. */
function renamed(err: Error, message: string): Error {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(err) as object) as Error, err)
  Object.defineProperty(copy, 'message', { value: message, writable: true, configurable: true })
  if (err.stack) Object.defineProperty(copy, 'stack', { value: err.stack.replace(err.message, () => message), writable: true, configurable: true })
  return copy
}

/** The keys of a thread op, for a refusal that names them. */
const keysOf = (input: Record<string, unknown>): string[] => Object.keys(input)

const LIST_STATES = [...THREAD_STATES, 'open', 'closed'] as const

/** Thread_list's answer to an agent: a page of short rows (threadRow) that fits, the next page named. */
function threadListAnswer(result: unknown, args: Record<string, unknown>): unknown {
  const r = objOf(result)
  const threads = (Array.isArray(r.threads) ? r.threads : []) as ThreadLike[]
  const opts = { bodies: args.bodies === true, bodyMax: typeof args.body_max === 'number' ? args.body_max : undefined }
  // The handler paged when the call named offset or limit; the page size is its limit, else the default.
  const at = r.page ? r.page as Page : { offset: 0, total: threads.length }
  const want = typeof args.limit === 'number' ? threads : threads.slice(0, THREAD_LIST_PAGE)
  return fitPage(want.map((t) => threadRow(t, opts)), at.offset, at.total, (rows, page) => {
    const more = nextPageCall('thread_list', args, page)
    return {
      ...receiptBase(r, ['missing']),
      threads: rows,
      page,
      outcome: `${String(r.outcome ?? '')} Showing ${pageWords(page, 'threads')}.`.trim(),
      next: `${more ? `Next page: ${more}. ` : ''}Read one thread with ${READ_WHOLE} (its messages and their ids).`,
    }
  })
}

defineOp({
  name: 'thread_list',
  title: 'List Threads',
  description: `${THREADS_SCOPE} Lists the open ones (newest change first), ${THREAD_LIST_PAGE} at a time: each with its id, title, state, counts, ask, summary (reply), tasks and one line of the newest message; `
    + 'thread_get reads one with its messages. closed: true (or state "closed") lists the closed ones of the past week too (to reopen one); ids, state, offset and limit narrow it; bodies: true adds the messages. task defaults to your own task.',
  input: {
    task: TASK_ARG,
    closed: z.boolean().optional().describe('Also the closed ones of the past week'),
    state: z.enum(LIST_STATES).optional().describe('Only this state: new, working, needs, answered, pending, open (all open ones) or closed'),
    ids: z.array(THREAD_ID).min(1).max(50).optional().describe('Only these threads, open or closed'),
    offset: z.number().int().min(0).optional().describe('Skip this many (the next page)'),
    limit: z.number().int().min(1).max(100).optional().describe(`At most this many (default ${THREAD_LIST_PAGE})`),
    bodies: z.boolean().optional().describe('Each thread with its messages, each cut to body_max'),
    body_max: z.number().int().min(100).max(16000).optional().describe(`With bodies: characters of each message and answer (default ${THREAD_BODY_MAX})`),
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const ids = Array.isArray(args.ids) ? args.ids as string[] : undefined
    const state = typeof args.state === 'string' ? args.state : undefined
    // A closed thread is read only when asked for: by closed, by state closed, or by its id.
    const withClosed = args.closed === true || state === 'closed' || !!ids
    const body = await call('GET', `/tasks/${encodeURIComponent(id)}/threads${withClosed ? '' : '?open=1'}`) as { title?: string; threads: ThreadView[]; closed_count?: number }
    const open = body.threads.filter((t) => !t.closed).length
    const said = `"${body.title}" has ${open} open thread(s)${body.closed_count ? ` (${body.closed_count} closed this week)` : ''}.`
    // No new argument: the answer as it always was.
    if (!ids && !state && args.offset === undefined && args.limit === undefined) return withOutcome(body, said, 'No further action is required.')
    let threads = body.threads
    if (ids) threads = threads.filter((t) => ids.includes(t.id))
    if (state) threads = threads.filter((t) => (state === 'closed' ? !!t.closed : state === 'open' ? !t.closed : !t.closed && t.state === state))
    const missing = ids?.filter((x) => !body.threads.some((t) => t.id === x)) ?? []
    let page: Page | undefined
    if (args.offset !== undefined || args.limit !== undefined) {
      const p = pageOf(threads, { offset: args.offset, limit: args.limit }, threads.length)
      threads = p.rows
      page = p.page
    }
    const matched = page?.total ?? threads.length
    return withOutcome(
      { ...body, threads, matched, ...(page ? { page } : {}), ...(missing.length ? { missing } : {}) },
      `${said} ${matched} match${state ? ` state ${state}` : ''}${ids ? ` of the ${ids.length} id(s) asked` : ''}.`
        + (missing.length ? ` Not here: ${missing.join(', ')} (a closed thread is kept a week; a merged one is under the thread it went to).` : ''),
      'No further action is required.',
    )
  },
  answer: { kind: 'content', whole: READ_WHOLE, shape: ({ result, args }) => threadListAnswer(result, args) },
  tags: { readonly: true, remote: 'allow' },
})

/** Thread_get's answer to an agent: the thread's head and its newest messages, cut (threadRead). */
function threadGetAnswer(result: unknown, args: Record<string, unknown>): unknown {
  const r = objOf(result)
  const t = r.thread as ThreadLike | undefined
  if (!t?.id) return result
  const total = Array.isArray(t.messages) ? t.messages.length : 0
  if (typeof args.message === 'string') return threadMessageAnswer(r, t, args)
  const build = (limit: number, bodyMax: number) => {
    const view = threadRead(t, { limit, bodyMax })
    const earlier = typeof view.earlier_messages === 'number' ? view.earlier_messages : 0
    return {
      ...receiptBase(r),
      thread: view,
      next: [
        earlier ? `${earlier} earlier message(s): thread_get {"id":"${t.id}","limit":${Math.min(200, total)}}.` : '',
        `One message whole: thread_get {"id":"${t.id}","message":"<tm-id>"}; change it with thread_update {"id":"${t.id}",...}.`,
      ].filter(Boolean).join(' '),
    }
  }
  // What the call named stays; what it left to Walnut gives way until the answer fits: the
  // bodies get shorter first, then fewer of the newest messages are shown.
  const fits = (v: unknown) => JSON.stringify(v).length <= PAGE_BUDGET
  let limit = typeof args.limit === 'number' ? args.limit : THREAD_GET_MESSAGES
  const maxes = typeof args.body_max === 'number' ? [args.body_max] : [THREAD_BODY_MAX, 400, 250, 150]
  let out = build(limit, maxes[0])
  for (const max of maxes.slice(1)) { if (fits(out)) return out; out = build(limit, max) }
  while (limit > 1 && !fits(out)) { limit = limit > 10 ? Math.floor(limit * 0.8) : limit - 1; out = build(limit, maxes[maxes.length - 1]) }
  return out
}

/**
 * Thread_get with `message`: that message whole, up to THREAD_GET_MAX. His words (at most 8,000)
 * and the answer (at most 16,000) may not fit together; then his words come whole and the answer
 * is left out, with its length and the call that reads it whole (`part: "answer"`), never cut.
 */
function threadMessageAnswer(r: Record<string, unknown>, t: ThreadLike, args: Record<string, unknown>): unknown {
  const part = args.part === 'text' || args.part === 'answer' ? args.part : 'both'
  const id = String(args.message)
  const build = (p: 'both' | 'text' | 'answer', next: string) => ({
    ...receiptBase(r),
    thread: threadRead(t, { message: id, part: p }),
    next,
  })
  const plain = `Change the thread with thread_update {"id":"${t.id}",...}.`
  const out = build(part, plain)
  if (JSON.stringify(out).length <= THREAD_GET_MAX - 600 || part !== 'both') return out
  return build('text', `Its answer did not fit beside his words: thread_get {"id":"${t.id}","message":"${id}","part":"answer"} reads it whole. ${plain}`)
}

defineOp({
  name: 'thread_get',
  title: 'Read one Thread',
  description: 'One of your Threads by id, open or closed (see thread_list): its state, ask, summary (reply), tasks and its newest messages (the user\'s words and your answer, '
    + `each cut to body_max, each with its tm- id; an answer repeated under several messages is named once). message reads one message whole (part: only his words or only the answer); "_full": true the whole thread as stored. task defaults to your own task.`,
  input: {
    id: THREAD_ID.describe('The thread (th-...)'),
    limit: z.number().int().min(1).max(200).optional().describe(`The newest this many messages (default ${THREAD_GET_MESSAGES})`),
    body_max: z.number().int().min(100).max(16000).optional().describe(`Characters of each message and answer (default ${THREAD_BODY_MAX})`),
    message: z.string().regex(/^tm-[a-f0-9]{6,32}$/).optional().describe('Only this message, whole'),
    part: z.enum(['text', 'answer']).optional().describe('With message: only his words, or only the answer'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('GET', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(args.id))}`) as { task_id?: string; thread: ThreadView }
    const t = body.thread
    const messages = (t.messages ?? []) as Array<{ id: string; answer?: unknown }>
    if (typeof args.message === 'string' && !messages.some((m) => m.id === args.message)) {
      throw new Error(`No message ${args.message} in thread ${t.id}: thread_get {"id":"${t.id}"} lists its message ids.`)
    }
    const open = messages.filter((m) => !m.answer).length
    return withOutcome(
      body,
      `Thread ${t.id} "${t.title}": ${t.closed ? `closed (${t.closed.how})` : t.state}, ${messages.length} message(s)${open ? `, ${open} with no answer yet` : ''}.`,
      'No further action is required.',
    )
  },
  // Up to the ceiling so one whole message fits; a read of the newest messages fits itself to PAGE_BUDGET.
  answer: { kind: 'content', max: THREAD_GET_MAX, whole: 'thread_get {"id":"<id>","message":"<tm-id>"}', shape: ({ result, args }) => threadGetAnswer(result, args) },
  tags: { readonly: true, remote: 'allow' },
})

/** Thread_update's arguments, named here so a refusal can list them. */
const UPDATE_INPUT = {
  id: z.string().regex(/^th-[a-f0-9]{6,32}$/).describe('The thread (th-...)'),
  title: z.string().min(1).max(120).optional().describe('A few words, in the language you write to the user'),
  ask: z.string().max(400).optional().describe('One line: what he wants ("" clears it)'),
  state: z.enum(THREAD_STATES).optional().describe('working (you are on it; out of his sight until your answer), needs (waiting on him), answered (you answered; he may close it), pending (only handed off: hidden even with your answer on it). A new reply without a state sets answered'),
  user_kind: z.enum(USER_KINDS).optional().describe(USER_KIND_PARAM),
  user_kind_why: z.string().max(300).optional().describe(USER_KIND_WHY_PARAM),
  user_kind_words: z.string().max(500).optional().describe(USER_KIND_WORDS_PARAM),
  user_kind_about: z.string().max(200).optional().describe(USER_KIND_ABOUT_PARAM),
  design_review: z.string().max(500).optional().describe(DESIGN_REVIEW_PARAM),
  same_ask_reason: z.string().max(300).optional().describe(SAME_ASK_REASON_PARAM),
  ask_owner: z.string().max(128).optional().describe('The id of the task in your team whose Needs you already asks him this thread\'s decision: the thread then points at that ask (read as pending with askedIn, its conversation kept) and waits on him again by itself once that task stops asking it or asks another decision. Refused (409) when that task asks him nothing now. "" takes it off'),
  reply: z.string().max(2000).optional().describe('The summary the card shows: the latest first (the open question or what he must decide), then one or two sentences of background; Markdown ("" clears it)'),
  since_you_wrote: z.string().max(600).optional().describe('Back to needs after he wrote in the thread: one line on what you did about his message (the answer to his question, what you checked). Walnut puts it first on the card under his words, then your reply as the decision; without it the write is refused (409 returned_ask)'),
  decision: z.enum(['same', 'new']).optional().describe('Back to needs after he wrote, or new options while it waits on him, on a thread that asked before: "same" when it asks that decision again, "new" when another one. A new decision is refused here: answer him in this thread and open the new one with thread_create (supersedes naming this one)'),
  supersedes: z.array(z.string().regex(/^(th|lt)-[\w-]{4,40}$/)).max(12).optional().describe(SUPERSEDES_PARAM),
  separate_reason: z.string().max(300).optional().describe(SEPARATE_REASON_PARAM),
  options: z.array(OPTION_ARG).max(ASK_OPTIONS_MAX).optional().describe(OPTIONS_WHY),
  tasks: z.array(z.string().min(1)).max(12).optional().describe('Every task it went to (replaces the list)'),
  add_tasks: z.array(z.string().min(1)).max(12).optional().describe('Tasks to add to it'),
  known: z.string().regex(/^(tm-[a-f0-9]{6,32}|all)$/).optional().describe('He reacted to your answers through this message (tm-...), or "all": they leave the card. Refused before he reacted'),
  close: z.enum(['acked', 'dropped']).optional().describe('Close it: acked (he reacted to it as finished), dropped (he said it is no longer wanted). Refused before he reacted, unless user_words quotes him asking for it'),
  user_words: z.string().max(500).optional().describe('With close: his own words asking you to close it, or saying it is done or no longer wanted, quoted exactly from his latest message in this thread (what he typed in your chat is filed in a thread: merge it into this one first). Counts only when that message came after everything said in the thread'),
  reopen: z.boolean().optional().describe('Open a closed thread again'),
  place: z.enum(ACK_PLACES).optional().describe('On a thread he acknowledged (his card reads "AI is deciding where this goes"): where it goes now. Alone with place_why, no state or close'),
  place_why: z.string().max(PLACE_WHY_MAX).optional().describe('With place: one short line his card shows (what it waits on and until when, what still runs, or why it is over)'),
  snooze: z.string().max(40).optional().describe('Put it aside until this time: an ISO datetime, a date (that day\'s local midnight) or a duration from now ("4h", "3d"); at most a year; "" takes the snooze off'),
  pin: z.boolean().optional().describe('true pins it to the top of his view whatever its state (until he unpins or acknowledges it); false unpins it. You cannot unpin one he pinned'),
  merge_into: THREAD_ID.optional().describe('Put this thread under that open thread (same subject); alone in its call'),
  task: TASK_ARG,
}

defineOp({
  name: 'thread_update',
  title: 'Update a Thread',
  description: `${THREADS_SCOPE} Change one thread: title, ask, state, reply, tasks (replace the list) or add_tasks, known (he reacted to your answers through `
    + 'this message: they fold to context), close ("acked" when he reacted to it as finished, "dropped" when he said it is no longer wanted), reopen, '
    + 'snooze (put it aside until a time when he asked to come back to it later: it leaves his view for its Snoozed section and comes back on its date, or earlier when he writes in it, you answer it, or it moves to needs or answered; "" takes it off), '
    + 'pin (true keeps it at the top of his view whatever its state, until he unpins or acknowledges it; false unpins it; one HE pinned '
    + 'you cannot unpin, snooze or close: 409 pinned_by_user), '
    + 'or merge_into another open thread (alone in its call: its messages move there and it is gone). '
    + `A wrong merge is undone with thread_split. ${WORD_TO_USER_RULE} Answers a receipt (ids, state, message count, what changed); thread_get reads the thread. task defaults to your own task.`,
  input: UPDATE_INPUT,
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const { task: _t, id: threadId, ...patch } = args as Record<string, unknown>
    const given = Object.keys(patch).filter((k) => patch[k] !== undefined)
    // A merge removes this thread: anything else asked of it would be written and then lost.
    if (typeof patch.merge_into === 'string' && given.length > 1) {
      const rest = Object.fromEntries(given.filter((k) => k !== 'merge_into').map((k) => [k, patch[k]]))
      throw new Error(`merge_into goes alone: this thread is gone after the merge, so ${Object.keys(rest).join(', ')} would be lost. `
        + `Two calls: thread_update ${JSON.stringify({ id: threadId, merge_into: patch.merge_into })}, then thread_update ${callArgs({ id: patch.merge_into, ...rest })}.`)
    }
    let body: { thread: ThreadView; merged?: string }
    try {
      body = await call('PATCH', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(threadId))}`, patch) as { thread: ThreadView; merged?: string }
    } catch (err) { withCorrectedCall('thread_update', args as Record<string, unknown>, keysOf(UPDATE_INPUT), err) }
    const long = longTextHint(typeof patch.reply === 'string' ? patch.reply : undefined)
    return withOutcome(
      body,
      body.merged ? `Thread ${body.merged} is now under ${body.thread.id} "${body.thread.title}" (${body.thread.messages?.length ?? 0} messages).`
        : `Thread ${body.thread.id} "${body.thread.title}": ${body.thread.closed ? `closed (${body.thread.closed.how})` : body.thread.state}${body.thread.snoozed && !body.thread.closed && Date.parse(body.thread.snoozed.until) > Date.now() ? `, snoozed until ${body.thread.snoozed.until}` : ''}${body.thread.pinned && !body.thread.closed ? `, pinned${body.thread.pinned.by === 'human' ? ' by the user' : ''}` : ''}${body.thread.askedIn ? `, its decision asked in ${body.thread.askedIn.title} (${body.thread.askedIn.task})` : ''}${body.thread.ackPlaced && !body.thread.closed ? `, placed in ${body.thread.ackPlaced.to}` : ''}.`,
      long ?? 'No further action is required.',
    )
  },
  answer: {
    kind: 'receipt', whole: READ_WHOLE,
    shape: ({ result, args }) => threadWriteReceipt(result, {
      changed: Object.keys(args).filter((k) => k !== 'id' && k !== 'task' && args[k] !== undefined),
      ...(objOf(result).merged ? { merged: objOf(result).merged } : {}),
    }),
  },
  tags: { readonly: false, remote: 'allow' },
})

/** Thread_create's arguments, named here so a refusal can list them. */
const CREATE_INPUT = {
  title: z.string().min(1).max(120).describe('A few words, in the language you write to the user'),
  text: z.string().min(1).max(16000).describe('The first post: what reached you and what he needs to know or decide, Markdown'),
  reply: z.string().max(2000).optional().describe('The card\'s summary, as thread_update\'s reply: its first sentence says what he decides and what you recommend, then the key points and evidence paths. Left out, the card shows only the first line of the post, so a needs thread whose post runs longer is refused without it'),
  from: z.enum(['mail', 'task', 'letter', 'trigger', 'node']).describe('Where it came from: mail, task (a team\'s work), letter (your letter to him), trigger, node (your own finding)'),
  ref: z.string().max(120).optional().describe('What it points at: a task id, a letter id (lt-...), a mail subject'),
  state: z.enum(['needs', 'answered']).optional().describe('Default needs (it waits on him)'),
  options: z.array(OPTION_ARG).max(ASK_OPTIONS_MAX).optional().describe(OPTIONS_WHY),
  user_kind: z.enum(USER_KINDS).optional().describe(USER_KIND_PARAM),
  user_kind_why: z.string().max(300).optional().describe(USER_KIND_WHY_PARAM),
  user_kind_words: z.string().max(500).optional().describe(USER_KIND_WORDS_PARAM),
  user_kind_about: z.string().max(200).optional().describe(USER_KIND_ABOUT_PARAM),
  design_review: z.string().max(500).optional().describe(DESIGN_REVIEW_PARAM),
  same_ask_reason: z.string().max(300).optional().describe(SAME_ASK_REASON_PARAM),
  supersedes: z.array(z.string().regex(/^(th|lt)-[\w-]{4,40}$/)).max(12).optional().describe(SUPERSEDES_PARAM),
  separate_reason: z.string().max(300).optional().describe(SEPARATE_REASON_PARAM),
  tasks: z.array(z.string().min(1)).max(12).optional().describe('Tasks it is about'),
  task: TASK_ARG,
}

defineOp({
  name: 'thread_create',
  title: 'Open a Thread yourself',
  description: `${THREADS_SCOPE} Opens a thread of your own for something that reached you the user must act on or asked to follow `
    + '(a mail he must answer, a team\'s question only he can settle, news he asked to hear about): its first post is yours, shown as '
    + 'opened by you and where from, and his reply is filed under it. Never a progress feed, and never beside a letter about the same '
    + `thing: what is on a thread stays there, a decision as its needs state. ${WORD_TO_USER_RULE} task defaults to your own task.`,
  input: CREATE_INPUT,
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const { task: _t, ...open } = args as Record<string, unknown>
    let body: { thread: ThreadView }
    try {
      body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads/open`, open) as { thread: ThreadView }
    } catch (err) { withCorrectedCall('thread_create', args as Record<string, unknown>, keysOf(CREATE_INPUT), err) }
    const long = longTextHint(typeof open.reply === 'string' ? open.reply : undefined)
    return withOutcome(body, `Opened thread ${body.thread.id} "${body.thread.title}" (${body.thread.state}).`, `${long ? `${long} ` : ''}His reply to it is filed under it; keep it current with thread_update.`)
  },
  answer: { kind: 'receipt', whole: READ_WHOLE, shape: ({ result }) => threadWriteReceipt(result) },
  tags: { readonly: false, remote: 'allow' },
})

/** Thread_split's arguments, named here so a refusal can list them. */
const SPLIT_INPUT = {
  id: THREAD_ID.describe('The thread holding the message'),
  message: z.string().regex(/^tm-[a-f0-9]{6,32}$/).describe('The message to take out (thread_get shows the ids)'),
  merge_into: THREAD_ID.optional().describe('Move it straight into this open thread instead of a new one'),
  keep_open: z.boolean().optional().describe('Keep the thread it leaves open even when nothing is left open on it (by default that one closes, as acked)'),
  task: TASK_ARG,
}

/**
 * The words for a split's source, from what the server's answer states and nothing else: it
 * closed with the split only when the answer says `from_closed`; a closed source the answer does
 * not explain is just said to be closed.
 */
function splitSourceWords(from: ThreadView | undefined, closedBySplit: boolean): string {
  if (!from) return ''
  if (closedBySplit) {
    return ` ${from.id} "${from.title}" CLOSED with it (acked): every message left on it was answered and he had reacted. `
      + `Reopen it with thread_update {"id":"${from.id}","reopen":true}, or pass keep_open: true next time to keep it open.`
  }
  return ` ${from.id} "${from.title}" is ${from.closed ? `closed (${from.closed.how})` : from.state} with ${from.messages?.length ?? 0} message(s).`
}

/**
 * What a server older than merge_into and keep_open did with them: it ignores both, so its answer
 * lacks `merged_into` (a new thread was made instead) and it may close the source. Said plainly,
 * with the call that finishes what was asked; empty when the server applied what was asked.
 */
function notAppliedWords(args: Record<string, unknown>, body: { thread: ThreadView; from?: ThreadView; from_closed?: boolean; merged_into?: string }): { words: string; keys: string[] } {
  const keys: string[] = []
  const parts: string[] = []
  if (typeof args.merge_into === 'string' && !body.merged_into) {
    keys.push('merge_into')
    parts.push(`This server did not apply merge_into (it is older than that option): the message went to a NEW thread ${body.thread.id} instead of ${args.merge_into}. `
      + `Finish the move with thread_update {"id":"${body.thread.id}","merge_into":"${args.merge_into}"}.`)
  }
  if (args.keep_open === true && body.from?.closed && body.from_closed === undefined) {
    keys.push('keep_open')
    parts.push(`keep_open was not applied by this server, or ${body.from.id} was closed already: it is closed (${body.from.closed.how}). `
      + `Reopen it with thread_update {"id":"${body.from.id}","reopen":true} if it should stay open.`)
  }
  return { words: parts.join(' '), keys }
}

defineOp({
  name: 'thread_split',
  title: 'Split a Thread message out',
  description: `${THREADS_SCOPE} Takes one message (tm-...) out of a thread into a new thread of its own (a merge that was wrong), or with merge_into straight into another open thread, in one call. `
    + 'The thread it leaves closes (acked) when nothing is left open on it; keep_open: true keeps it open. Answers a receipt of both threads. task defaults to your own task.',
  input: SPLIT_INPUT,
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    let body: { thread: ThreadView; from?: ThreadView; from_closed?: boolean; merged_into?: string }
    try {
      body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(args.id))}/split`, {
        message: args.message,
        ...(typeof args.merge_into === 'string' ? { merge_into: args.merge_into } : {}),
        ...(args.keep_open === true ? { keep_open: true } : {}),
      }) as typeof body
    } catch (err) { withCorrectedCall('thread_split', args as Record<string, unknown>, keysOf(SPLIT_INPUT), err) }
    const source = splitSourceWords(body.from, body.from_closed === true)
    const ignored = notAppliedWords(args as Record<string, unknown>, body)
    if (ignored.keys.length) {
      return withOutcome({ ...body, not_applied: ignored.keys }, `The message is its own thread now: ${body.thread.id}.${source} ${ignored.words}`,
        ignored.keys.includes('merge_into') ? `thread_update {"id":"${body.thread.id}","merge_into":"${String(args.merge_into)}"}` : `Give it a title with thread_update {"id":"${body.thread.id}","title":"..."}.`)
    }
    if (body.merged_into) {
      return withOutcome(body, `Moved ${String(args.message)} into ${body.thread.id} "${body.thread.title}" (${body.thread.messages?.length ?? 0} messages, ${body.thread.state}).${source}`,
        `Update ${body.thread.id} with thread_update {"id":"${body.thread.id}",...} if its summary changed.`)
    }
    return withOutcome(body, `The message is its own thread now: ${body.thread.id}.${source}`, `Give it a title with thread_update {"id":"${body.thread.id}","title":"..."}.`)
  },
  answer: {
    kind: 'receipt', whole: READ_WHOLE,
    // Only what the server's answer states: from_closed and merged_into when it sent them.
    shape: ({ result }) => threadWriteReceipt(result, Array.isArray(objOf(result).not_applied) ? { not_applied: objOf(result).not_applied } : {}),
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'thread_file',
  title: 'File a request as a Thread',
  description: `${THREADS_SCOPE} Files words of the user's that Walnut did not (a request he made elsewhere, or before Threads existed) on a node's Threads, `
    + 'as a new thread or under thread. Quote his words; never your own. task defaults to your own task.',
  input: {
    text: z.string().min(1).max(8000).describe('The user\'s words, quoted'),
    thread: z.string().regex(/^th-[a-f0-9]{6,32}$/).optional().describe('Put it under this thread'),
    at: z.string().optional().describe('When he said it (ISO); default now'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads`, {
      text: args.text, ...(args.thread ? { thread: args.thread } : {}), ...(args.at ? { at: args.at } : {}),
    }) as { thread: ThreadView; created: boolean }
    return withOutcome(body, body.created ? `Filed as a new thread ${body.thread.id}.` : `Filed under ${body.thread.id} "${body.thread.title}".`,
      body.created ? `Give it a short title with thread_update {"id":"${body.thread.id}","title":"..."}.` : 'No further action is required.')
  },
  answer: {
    kind: 'receipt', whole: READ_WHOLE,
    shape: ({ result }) => threadWriteReceipt(result, { ...(typeof objOf(objOf(result).message).id === 'string' ? { message_id: objOf(objOf(result).message).id } : {}) }),
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'thread_move',
  title: 'Move a Thread to another node',
  description: `${THREADS_SCOPE} Moves one open thread to another node's Threads (another VP, Main, or the node whose team a task is in), `
    + 'with everything on it: his messages, the answers, its state, pin and tasks; it reads "Moved here from" there, and it closes on yours as moved, '
    + 'pointing at it. Use it when one of his asks belongs to another node (he said so, or the work is theirs); handing the work on with '
    + 'task_send, org_send, task_start or task_create naming `thread` does the same in one step. task defaults to your own task.',
  input: {
    id: z.string().regex(/^th-[a-f0-9]{6,32}$/).describe('The thread (th-...)'),
    to: z.string().min(1).describe('Where it goes: a node\'s task id, a task (its team\'s node takes it), a project name or the name the user gave a VP'),
    why: z.string().max(400).optional().describe('One line both nodes read: why it moves'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(args.id))}/move`, {
      to: args.to, ...(args.why ? { why: args.why } : {}),
    }) as { thread: ThreadView; moved_to: { task: string; title: string } }
    return withOutcome(body, `Thread ${body.thread.id} "${body.thread.title}" moved to ${body.moved_to.title} (${body.moved_to.task}); it is closed on the Threads it left.`,
      `${body.moved_to.title} keeps it now and was told; you no longer follow it.`)
  },
  answer: { kind: 'receipt', shape: ({ result }) => threadWriteReceipt(result, { ...(objOf(result).moved_to ? { moved_to: objOf(result).moved_to } : {}) }) },
  tags: { readonly: false, remote: 'allow' },
})
