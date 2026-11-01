/**
 * An Org node's Threads: the user's own requests to Main, a VP or a lead, one thread per subject
 * (core/org/threads-model.ts). Walnut files each message he sends there (core/org/thread-capture.ts);
 * the node and the user both change them here, the same way (2026-10-27, the user: "all human
 * action can be done by agent also").
 *
 *   GET   /api/v1/tasks/:id/threads[?open=1]               { task_id, threads, closed_count }  (open first; each message with
 *                                                          the node's answer, read from its chat in the background)
 *   POST  /api/v1/tasks/:id/threads                        { text, images?, thread? } -> file one of his messages
 *   PATCH /api/v1/tasks/:id/threads/:thread                { title?, ask?, state?, reply?, tasks?, add_tasks?, known?, close?, reopen?, merge_into? }
 *   POST  /api/v1/tasks/:id/threads/open                   { title, text, from, ref?, state?, tasks? } -> the node opens one itself
 *   POST  /api/v1/tasks/:id/threads/:thread/split          { message } -> that message becomes its own thread
 *
 * The caller comes from `x-walnut-caller-sid`: none = the user. Writes answer 501 on the companion.
 */
import { Router, type Request, type Response } from 'express'
import type { Task } from '../../core/types.js'
import { log } from '../../logging/index.js'
import { resolveBoardCaller, boardWriter } from '../../core/boards/board-team.js'
import { ThreadError, THREAD_ID_RE, THREAD_MESSAGE_ID_RE, sortedThreads, type ThreadPatch, type ThreadSource, type ThreadState, type ThreadWriter } from '../../core/org/threads-model.js'
import { fileThreadMessage, mergeThread, openNodeThread, patchThread, readThreads, splitThread } from '../../core/org/threads-store.js'
import { resolveThreadAnswers } from '../../core/org/thread-answers.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const orgThreadsV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof ThreadError) return sendError(res, err.status, err.code, err.message)
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

async function writerOf(req: Request): Promise<ThreadWriter> {
  return boardWriter(await resolveBoardCaller(header(req, 'x-walnut-caller-sid'))) as ThreadWriter
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

orgThreadsV1Router.get('/tasks/:id/threads', route(async (req, res) => {
  const task = await nodeTask(req)
  const file = await readThreads(task.id)
  const open = req.query.open === '1' || req.query.open === 'true'
  const threads = sortedThreads(file.threads).filter((t) => !open || !t.closed)
  // Answers still missing are read from the node's chat meanwhile; a kept one says so (org-threads:changed).
  void resolveThreadAnswers(task.id)
  res.json({ task_id: task.id, title: task.title, threads, closed_count: file.threads.filter((t) => !!t.closed).length })
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

orgThreadsV1Router.post('/tasks/:id/threads/open', route(async (req, res) => {
  const task = await nodeTask(req)
  const b = body(req)
  const by = await writerOf(req)
  const thread = await openNodeThread(task.id, {
    title: str(b, 'title') ?? '', text: str(b, 'text') ?? '', from: (str(b, 'from') ?? 'node') as ThreadSource,
    ...(str(b, 'ref') ? { ref: str(b, 'ref') } : {}),
    ...(str(b, 'state') ? { state: str(b, 'state') as ThreadState } : {}),
    ...(ids(b, 'tasks') ? { tasks: ids(b, 'tasks') } : {}),
  }, by)
  log.task.info('org thread opened by the node', { taskId: task.id, threadId: thread.id, by, from: thread.opener?.from })
  res.status(201).json({ task_id: task.id, thread })
}))

orgThreadsV1Router.patch('/tasks/:id/threads/:thread', route(async (req, res) => {
  const task = await nodeTask(req)
  const id = threadIdOf(req)
  const b = body(req)
  const by = await writerOf(req)
  const mergeInto = str(b, 'merge_into')
  const patch: ThreadPatch = {}
  for (const k of ['title', 'ask', 'reply', 'state', 'close', 'known'] as const) {
    const v = str(b, k)
    if (v !== undefined) (patch as Record<string, unknown>)[k] = v
  }
  const tasks = ids(b, 'tasks')
  const addTasks = ids(b, 'add_tasks')
  if (tasks) patch.tasks = tasks
  if (addTasks) patch.add_tasks = addTasks
  if (b.reopen === true) patch.reopen = true
  // A merge removes this thread: anything else asked of it would be written and then lost.
  if (mergeInto && Object.keys(patch).length) {
    throw new RouteError(400, 'bad_request', 'merge_into goes alone: change the target thread with its own update.')
  }
  let thread
  if (Object.keys(patch).length) thread = await patchThread(task.id, id, patch, by)
  if (mergeInto) {
    if (!THREAD_ID_RE.test(mergeInto)) throw new RouteError(400, 'bad_request', `Not a thread id: ${mergeInto}`)
    thread = await mergeThread(task.id, id, mergeInto, by)
  }
  if (!thread) throw new RouteError(400, 'bad_request', 'Nothing to change: pass title, ask, state, reply, tasks, add_tasks, known, close, reopen or merge_into.')
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
