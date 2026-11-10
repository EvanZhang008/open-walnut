/**
 * An Org node's Threads: the user's own requests to Main, a VP or a lead, one thread per subject
 * (core/org/threads-model.ts). Walnut files each message he sends there (core/org/thread-capture.ts);
 * the node and the user both change them here, the same way (2026-10-27, the user: "all human
 * action can be done by agent also").
 *
 *   GET   /api/v1/tasks/:id/threads[?open=1|closed=1][&limit=N][&answer_max=N]
 *                                                        { task_id, threads, closed_count, shown_count }  (open first; each message with
 *                                                          the node's answer, read from its chat in the background; each thread's
 *                                                          `shown` is his view's rule over all of them; 503 primary_only on the companion)
 *   GET   /api/v1/tasks/:id/threads/:thread                { task_id, thread }  (one thread whole, its `shown` as above)
 *   POST  /api/v1/tasks/:id/threads                        { text, images?, thread? } -> file one of his messages
 *   PATCH /api/v1/tasks/:id/threads/:thread                { title?, ask?, state?, user_kind?, user_kind_why?, same_ask_reason?, reply?, tasks?, add_tasks?, known?, close?, user_words?, reopen?, snooze?, pin?, merge_into? }
 *   POST  /api/v1/tasks/:id/threads/open                   { title, text, from, ref?, state?, user_kind?, user_kind_why?, same_ask_reason?, tasks? } -> the node opens one itself
 *   POST  /api/v1/tasks/:id/threads/:thread/split          { message } -> that message becomes its own thread
 *   POST  /api/v1/tasks/:id/threads/:thread/move           { to, why? } -> it goes to another node's Threads with its work
 *                                                          (core/org/thread-follow.ts): `to` a node, a task in its team, a project or a VP's name
 *   PUT   /api/v1/tasks/:id/threads/:thread/follow-ups/:messageId -> the message with that id, relayed
 *                                                          by the companion, is his Follow up in this thread
 *
 * The caller comes from `x-walnut-caller-sid`: none = the user. Writes answer 501 on the companion.
 * The session that wrote a summary or a first post is the caller's own, read from its session
 * record (core/org/thread-caller.ts); a `sid`, `host` or `by` in the body is never read.
 */
import { Router, type Request, type Response } from 'express'
import type { Task } from '../../core/types.js'
import { log } from '../../logging/index.js'
import { resolveThreadCaller, type ThreadCaller } from '../../core/org/thread-caller.js'
import { ThreadError, THREAD_ID_RE, THREAD_MESSAGE_ID_RE, sortedThreads, type OrgThread, type ThreadPatch, type ThreadSource, type ThreadState, type ThreadWriter } from '../../core/org/threads-model.js'
import { fileThreadMessage, mergeThread, openNodeThread, patchThread, readThreads, splitThread } from '../../core/org/threads-store.js'
import { resolveThreadAnswers } from '../../core/org/thread-answers.js'
import { cardView, sharedAnswers, shownToHim, threadCounts } from '../../core/org/thread-view.js'
import { isCompanion } from '../../core/server-role.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const orgThreadsV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof ThreadError) return sendError(res, err.status, err.code, err.message)
      if (sendLinkFailure(req, res, err)) return
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

async function nodeTask(req: Request): Promise<Task> {
  const task = await resolveTask(param(req.params.id))
  if (task.org_role !== 'main' && task.org_role !== 'lead') {
    throw new RouteError(409, 'not_org_node', 'Only Main and the leads (a VP is a lead) keep Threads.')
  }
  return task
}

/** The writer and its verified session, from the header alone. */
async function callerOf(req: Request): Promise<ThreadCaller> {
  return resolveThreadCaller(header(req, 'x-walnut-caller-sid'))
}

async function writerOf(req: Request): Promise<ThreadWriter> {
  return (await callerOf(req)).by
}

function threadIdOf(req: Request): string {
  const id = param(req.params.thread)
  if (!THREAD_ID_RE.test(id)) throw new RouteError(400, 'bad_request', `Not a thread id: ${id}`)
  return id
}

function str(b: Record<string, unknown>, k: string): string | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new RouteError(400, 'bad_request', `${k} must be a string`)
  return v
}

function ids(b: Record<string, unknown>, k: string): string[] | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RouteError(400, 'bad_request', `${k} must be a list of task ids`)
  return v as string[]
}

const flag = (v: unknown) => v === '1' || v === 'true'
const positive = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

orgThreadsV1Router.get('/tasks/:id/threads', route(async (req, res) => {
  const task = await nodeTask(req)
  // Only the primary keeps Threads. A companion asked for them (the Mac out of reach, or its answer
  // too large to carry back) has none to give, and an empty list read as "no open threads" on the
  // phone while its header counted four (2026-11-06): it says it cannot answer instead.
  if (isCompanion()) throw new RouteError(503, 'primary_only', "Threads are kept on the primary; this server could not get them from it just now.")
  const file = await readThreads(task.id)
  const all = sortedThreads(file.threads)
  // `shown`: his view shows it, judged over ALL the node's threads (an answer shared with a closed
  // thread counts), the rule `user_status.threads` counts by, so a client's list and its count agree.
  const shared = sharedAnswers(all)
  const now = Date.now()
  const open = flag(req.query.open)
  const closedOnly = !open && flag(req.query.closed)
  let threads = all.filter((t) => (open ? !t.closed : closedOnly ? !!t.closed : true))
  const limit = positive(req.query.limit)
  if (limit !== undefined) threads = threads.slice(0, limit)
  // `answer_max`: each answer he already reacted to cut to that many characters (`clipped`), so a
  // phone's read fits what the companion carries back from the Mac; an answer his card shows (not
  // reacted to yet) stays whole, and `GET .../threads/:thread` gives one thread whole.
  const answerMax = positive(req.query.answer_max)
  const out = threads.map((t) => ({
    ...markShared(answerMax === undefined ? t : clipAnswers(t, shared, answerMax), shared),
    shown: shownToHim(t, shared, now),
  }))
  // Answers still missing are read from the node's chat meanwhile; a kept one says so (org-threads:changed).
  void resolveThreadAnswers(task.id)
  res.json({
    task_id: task.id, title: task.title, threads: out,
    closed_count: file.threads.filter((t) => !!t.closed).length,
    shown_count: threadCounts(all, now).shown,
  })
}))

/**
 * An answer's text cut to about `max` characters for a list read: by code point (a cut inside an
 * emoji's surrogate pair is JSON a phone cannot decode, and the whole read failed), backed off out
 * of a tag or a code fence it would split, and to a space when one is near.
 */
export function clipAnswerText(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  let head = points.slice(0, max).join('')
  const open = head.lastIndexOf('<')
  if (open >= 0 && open > head.lastIndexOf('>')) head = head.slice(0, open)
  if ((head.match(/```/g) ?? []).length % 2 === 1) head = head.slice(0, head.lastIndexOf('```'))
  const space = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'))
  if (space > head.length / 2) head = head.slice(0, space)
  return `${head.trimEnd()}\u2026`
}

function clipAnswers(t: OrgThread, shared: ReadonlySet<string>, max: number): OrgThread {
  const onCard = new Set(cardView(t, shared).unread.flatMap((x) => x.messages.map((m) => m.id)))
  return {
    ...t,
    messages: t.messages.map((m) => (m.answer && !onCard.has(m.id) && Array.from(m.answer.text).length > max
      ? { ...m, answer: { ...m.answer, text: clipAnswerText(m.answer.text, max), clipped: true as const } }
      : m)),
  }
}

/** Each message whose answer is one reply shared with another thread says so (`shared`), judged
 *  over all of them: a client that reads part of the list, or cut answers, cannot tell by itself. */
function markShared(t: OrgThread, shared: ReadonlySet<string>): OrgThread {
  if (!t.messages.some((m) => shared.has(m.id))) return t
  return { ...t, messages: t.messages.map((m) => (shared.has(m.id) ? { ...m, shared: true as const } : m)) }
}

/** One thread whole: what a phone opens a thread's Conversation with after a cut list read. */
orgThreadsV1Router.get('/tasks/:id/threads/:thread', route(async (req, res) => {
  const task = await nodeTask(req)
  if (isCompanion()) throw new RouteError(503, 'primary_only', "Threads are kept on the primary; this server could not get them from it just now.")
  const id = threadIdOf(req)
  const all = (await readThreads(task.id)).threads
  const thread = all.find((t) => t.id === id)
  if (!thread) throw new RouteError(404, 'no_thread', `No thread ${id} on this node.`)
  const shared = sharedAnswers(all)
  res.json({ task_id: task.id, thread: { ...markShared(thread, shared), shown: shownToHim(thread, shared, Date.now()) } })
}))

orgThreadsV1Router.post('/tasks/:id/threads', route(async (req, res) => {
  const task = await nodeTask(req)
  const b = body(req)
  const text = str(b, 'text') ?? ''
  const images = Array.isArray(b.images) ? (b.images as unknown[]).filter((x): x is string => typeof x === 'string') : []
  if (!text.trim() && !images.length) throw new RouteError(400, 'bad_request', 'text (the user\'s words) is required')
  const thread = str(b, 'thread')
  if (thread && !THREAD_ID_RE.test(thread)) throw new RouteError(400, 'bad_request', `Not a thread id: ${thread}`)
  const at = str(b, 'at')
  const atIso = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString()
  const out = await fileThreadMessage(task.id, {
    text, images, via: 'import', at: atIso, ...(thread ? { threadId: thread } : {}),
  })
  log.task.info('org thread message filed', { taskId: task.id, threadId: out.thread.id, created: out.created, by: await writerOf(req) })
  res.status(out.created ? 201 : 200).json({ task_id: task.id, thread: out.thread, message: out.message, created: out.created, duplicate: out.duplicate })
}))

/**
 * A Follow up on its way through the companion: the message with this id is his reply in this
 * thread (core/org/thread-follow-up-intent.ts). The companion forwards this to the Mac; its own
 * relay of the words cannot carry the thread.
 */
orgThreadsV1Router.put('/tasks/:id/threads/:thread/follow-ups/:messageId', route(async (req, res) => {
  if (isCompanion()) throw new RouteError(503, 'primary_only', "Threads are kept on the primary; this server could not reach it just now.")
  const task = await nodeTask(req)
  const id = threadIdOf(req)
  const messageId = param(req.params.messageId)
  if (!/^qm-[A-Za-z0-9-]{1,64}$/.test(messageId)) throw new RouteError(400, 'bad_request', `Not a message id: ${messageId}`)
  if (!(await readThreads(task.id)).threads.some((t) => t.id === id)) throw new RouteError(404, 'no_thread', `No thread ${id} on this node.`)
  const { noteFollowUpIntent } = await import('../../core/org/thread-follow-up-intent.js')
  noteFollowUpIntent(task.id, id, messageId)
  log.task.info('org thread follow-up announced', { taskId: task.id, threadId: id, messageId })
  res.json({ task_id: task.id, thread_id: id, message_id: messageId })
}))

orgThreadsV1Router.post('/tasks/:id/threads/open', route(async (req, res) => {
  const task = await nodeTask(req)
  const b = body(req)
  const { by, source } = await callerOf(req)
  const thread = await openNodeThread(task.id, {
    title: str(b, 'title') ?? '', text: str(b, 'text') ?? '', from: (str(b, 'from') ?? 'node') as ThreadSource,
    ...(str(b, 'ref') ? { ref: str(b, 'ref') } : {}),
    ...(str(b, 'state') ? { state: str(b, 'state') as ThreadState } : {}),
    ...(ids(b, 'tasks') ? { tasks: ids(b, 'tasks') } : {}),
    ...(str(b, 'user_kind') ? { user_kind: str(b, 'user_kind') } : {}),
    ...(str(b, 'user_kind_why') ? { user_kind_why: str(b, 'user_kind_why') } : {}),
    ...(str(b, 'same_ask_reason') ? { same_ask_reason: str(b, 'same_ask_reason') } : {}),
  }, by, source)
  log.task.info('org thread opened by the node', { taskId: task.id, threadId: thread.id, by, from: thread.opener?.from })
  res.status(201).json({ task_id: task.id, thread })
}))

orgThreadsV1Router.patch('/tasks/:id/threads/:thread', route(async (req, res) => {
  const task = await nodeTask(req)
  const id = threadIdOf(req)
  const b = body(req)
  const { by, source } = await callerOf(req)
  const mergeInto = str(b, 'merge_into')
  const patch: ThreadPatch = {}
  for (const k of ['title', 'ask', 'reply', 'state', 'close', 'known', 'snooze', 'user_kind', 'user_kind_why', 'same_ask_reason', 'user_words'] as const) {
    const v = str(b, k)
    if (v !== undefined) (patch as Record<string, unknown>)[k] = v
  }
  const tasks = ids(b, 'tasks')
  const addTasks = ids(b, 'add_tasks')
  if (tasks) patch.tasks = tasks
  if (addTasks) patch.add_tasks = addTasks
  if (b.reopen === true) patch.reopen = true
  if (typeof b.pin === 'boolean') patch.pin = b.pin
  else if (b.pin !== undefined) throw new RouteError(400, 'bad_request', 'pin must be true or false.')
  // A merge removes this thread: anything else asked of it would be written and then lost.
  if (mergeInto && Object.keys(patch).length) {
    throw new RouteError(400, 'bad_request', 'merge_into goes alone: change the target thread with its own update.')
  }
  let thread
  if (Object.keys(patch).length) thread = await patchThread(task.id, id, patch, by, source)
  if (mergeInto) {
    if (!THREAD_ID_RE.test(mergeInto)) throw new RouteError(400, 'bad_request', `Not a thread id: ${mergeInto}`)
    thread = await mergeThread(task.id, id, mergeInto, by)
  }
  if (!thread) throw new RouteError(400, 'bad_request', 'Nothing to change: pass title, ask, state, reply, tasks, add_tasks, known, close, reopen, snooze, pin or merge_into.')
  log.task.info('org thread updated', { taskId: task.id, threadId: id, by, fields: Object.keys(patch), mergeInto })
  res.json({ task_id: task.id, thread, ...(mergeInto ? { merged: id } : {}) })
}))

orgThreadsV1Router.post('/tasks/:id/threads/:thread/split', route(async (req, res) => {
  const task = await nodeTask(req)
  const id = threadIdOf(req)
  const message = str(body(req), 'message') ?? ''
  if (!THREAD_MESSAGE_ID_RE.test(message)) throw new RouteError(400, 'bad_request', 'message (a tm- id of this thread) is required')
  const by = await writerOf(req)
  const out = await splitThread(task.id, id, message, by)
  log.task.info('org thread split', { taskId: task.id, threadId: id, newThreadId: out.thread.id, by })
  res.status(201).json({ task_id: task.id, thread: out.thread, from: out.from })
}))

orgThreadsV1Router.post('/tasks/:id/threads/:thread/move', route(async (req, res) => {
  const task = await nodeTask(req)
  const id = threadIdOf(req)
  const b = body(req)
  const to = (str(b, 'to') ?? '').trim()
  if (!to) throw new RouteError(400, 'bad_request', 'to (the node, a task in its team, a project or a VP\'s name) is required')
  const by = await writerOf(req)
  const { moveThreadTo } = await import('../../core/org/thread-follow.js')
  const out = await moveThreadTo({ from: task, threadId: id, to, by, ...(str(b, 'why') ? { why: str(b, 'why') } : {}) })
  res.json({ task_id: task.id, thread: out.thread, moved_to: out.to })
}))
