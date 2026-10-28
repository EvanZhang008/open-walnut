/**
 * /api/v1/tasks/:id/board: a task's Board (src/core/boards/).
 *
 *   GET    /tasks/:id/board[?team=1]         → { board_task_id, board_task_title, board | null, threads, marks,
 *                                                projects, checks, choices, reminders, section_seen, refs }
 *                                                + kanban: lanes, lanes_effective, lanes_template, cards, team,
 *                                                kanban_seen, board_version (?fields=kanban: only those + ids)
 *   GET    /tasks/:id/board/owner[?tab=1]    → { task_id, title, self, has_board[, own_board, open_subtasks] }
 *   GET    /tasks/:id/board/open-choice      → { choice: { owner, id, title, options, recommended? } | null }
 *                                               the unanswered choice on any Board that names this task
 *   Kanban lanes, cards, moves, suggestions and the seen baseline: board-kanban-v1.ts
 *   PUT    /tasks/:id/board                  { html, version? }      → { board }
 *   POST   /tasks/:id/board/edits            { edits, version? }     → { board }
 *   POST   /tasks/:id/board/threads/:thread  { text }                → 201 { message, delivery }
 *   DELETE /tasks/:id/board/threads/:thread/messages/:message[?override_user=true] → { message } (the removed one)
 *   PUT    /tasks/:id/board/marks/:mark      { note?, state? (legacy), override_user? } → { mark | null }
 *   PUT    /tasks/:id/board/projects/:project { title?, status?, tasks?, summary?, latest?, next?, waiting?, meta?,
 *                                                delete?, override_user? }
 *                                                → { project | null, delivery? (a human's new status) }
 *   PUT    /tasks/:id/board/checks/:check    { read, hash? }         → { check | null, hash }
 *   PUT    /tasks/:id/board/choices/:choice  { option?, text?, override_user? } → { choice | null, delivery }
 *   PUT    /tasks/:id/board/reminders/:target { at | null, note?, override_user? } → { reminder | null }
 *   PUT    /tasks/:id/board/seen/:section    { hash }                → { seen | null }
 *   DELETE /tasks/:id/board                  → 204 (the file is kept in boards/.deleted/, newest 5 per task)
 *
 * The caller comes from `x-walnut-caller-sid`: none = a human. Every write is
 * open to every caller, the user and any session alike (2026-10-27, the user:
 * "all human action can be done by agent also"); the writer is recorded
 * (board-team.ts), and a read tick, a choice answer or a section seen by an
 * agent carries `by` / `by_name`, which the Board shows. What the user did stays
 * theirs until an agent says the user asked for the change (`override_user`,
 * 409 user_wrote otherwise): their posts, answers (each part), marks and
 * reminders. An agent ticking or unticking a point the user read gets the
 * user's tick back unchanged, and an agent's seen marks (section and kanban)
 * are kept apart from the user's baseline, which only the user moves. A human's thread
 * message and a choice answer are delivered to the board task's session through
 * the one send path (core/boards/board-delivery.ts): the user's as the user, an
 * agent's as a message from that agent's task, and never to the session that
 * answered (its own board); a COMPLETE board task is never reopened by an
 * agent's answer, and an answer whose delivery did not go out is delivered again
 * when it is given again. A session's post is stored only (it IS the answer).
 * Anyone may delete any thread message, the log names who; a post the user
 * wrote takes `override_user=true` from a session (409 user_wrote otherwise).
 * A board project is
 * one area of this board (a cause, a ticket), not a Walnut project; the user
 * picks its status on the page too, that pick is delivered like a choice, and a
 * session's write that would change it is 409 status_set_by_user unless it
 * passes `override_user: true`. A team shares one board: `?team=1` and `/owner`
 * answer with the nearest ancestor that has one (else the root of the tree),
 * the default target of every board_* op.
 *
 * Replica: reads work (boards arrive with the data sync); writes answer 501,
 * because the primary is the single writer and delivery needs its sessions.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { Task } from '../../core/types.js'
import {
  BoardError,
  boardHasContent,
  removeBoard,
  deleteBoardMessage,
  editBoardHtml,
  extractTaskRefs,
  getBoard,
  postBoardMessage,
  setBoardHtml,
  setBoardMark,
  type BoardEdit,
  type BoardFile,
  type BoardMessage,
} from '../../core/boards/board-store.js'
import {
  BOARD_PROJECT_MAX_TASKS,
  BOARD_PROJECT_TEXT_FIELDS,
  boardCheckStates,
  writeBoardProject,
  setBoardCheck,
  setBoardChoice,
  setBoardReminder,
  setBoardSectionSeen,
  markChoiceDelivery,
} from '../../core/boards/board-items.js'
import {
  buildChoicePrompt,
  buildProjectStatusPrompt,
  deliverBoardText,
  threadHeading,
  buildBoardThreadPrompt,
  type BoardDelivery,
} from '../../core/boards/board-delivery.js'
import {
  boardWriter, boardWriterStamp, kanbanFields, resolveBoardCaller, resolveTeamBoardTask, teamSnapshot, type BoardCaller,
} from '../../core/boards/board-team.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export { buildBoardThreadPrompt }

export const boardV1Router = Router()

/** Refs resolved per GET; the rest are dropped (a board naming more is not a task list). */
const MAX_REFS = 500

/**
 * The board routes' own JSON parser, mounted at app level BEFORE the global one
 * (first parser wins). A 1 MiB html plus JSON escaping fits; past this limit the
 * handler below answers in the v1 error shape instead of Express's bare 413.
 */
export const BOARD_BODY_PATH = '/api/v1/tasks/:id/board'
export const boardJsonParser = express.json({ limit: '4mb' })

export function boardPayloadTooLargeHandler(err: Error, _req: Request, res: Response, next: NextFunction): void {
  if ((err as { type?: string }).type === 'entity.too.large') {
    sendError(res, 413, 'board_too_large', 'Board request body too large (board html is capped at 1 MiB)')
    return
  }
  next(err)
}

export function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return v || undefined
}

export function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join('/') : v ?? ''
}

export function body(req: Request): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

/** An optional boolean body field (`override_user`): absent = false, anything but a boolean 400. */
function bodyFlag(b: Record<string, unknown>, field: string): boolean {
  if (b[field] !== undefined && typeof b[field] !== 'boolean') throw new RouteError(400, 'bad_request', `\`${field}\` must be a boolean`)
  return b[field] === true
}

/** `override_user` on a DELETE: `?override_user=true` (or 1), or `true` in a JSON body. */
function overrideUserFlag(req: Request): boolean {
  const q = req.query.override_user
  const v = Array.isArray(q) ? q[0] : q
  if (v !== undefined) {
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0' || v === '') return false
    throw new RouteError(400, 'bad_request', '`override_user` must be true or false')
  }
  const b = body(req).override_user
  if (b !== undefined && typeof b !== 'boolean') throw new RouteError(400, 'bad_request', '`override_user` must be a boolean')
  return b === true
}

export class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message)
  }
}

/** A board task by id or unique prefix: 404 unknown, 400 ambiguous. */
export async function resolveTask(rawId: string): Promise<Task> {
  const { getTask } = await import('../../core/task-manager.js')
  try {
    return await getTask(rawId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Ambiguous ID prefix/i.test(msg)) throw new RouteError(400, 'bad_request', msg)
    throw new RouteError(404, 'not_found', msg)
  }
}

export function refuseOnReplica(): void {
  if (CLOUD_MODE) throw new RouteError(501, 'not_supported_cloud', 'Boards are written on the primary box')
}

/** Every write: replica refusal, then the task, then who is writing. */
export async function prepareWrite(req: Request): Promise<{ task: Task; caller: BoardCaller }> {
  refuseOnReplica()
  const task = await resolveTask(param(req.params.id))
  const caller = await resolveBoardCaller(header(req, 'x-walnut-caller-sid'))
  return { task, caller }
}

export const writer = boardWriter

function optionalVersion(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RouteError(400, 'bad_request', '`version` must be a non-negative integer')
  }
  return v
}

function optionalString(b: Record<string, unknown>, field: string): string | null | undefined {
  const v = b[field]
  if (v === undefined || v === null || typeof v === 'string') return v as string | null | undefined
  throw new RouteError(400, 'bad_request', `\`${field}\` must be a string`)
}

function publicBoard(b: BoardFile): Pick<BoardFile, 'html' | 'version' | 'updated_at' | 'updated_by'> {
  return { html: b.html, version: b.version, updated_at: b.updated_at, updated_by: b.updated_by }
}

type Handler = (req: Request, res: Response) => Promise<void>

/** BoardError / RouteError → their status in the v1 error shape; anything else → the error handler. */
export function route(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res)
    } catch (err) {
      if (err instanceof BoardError) {
        sendError(res, err.statusCode, err.code, err.message, err.details)
        return
      }
      if (err instanceof RouteError) {
        sendError(res, err.status, err.code, err.message, err.extra)
        return
      }
      next(err)
    }
  }
}

export interface BoardRef {
  /** The id as the html wrote it (may be a prefix): what the frame matches on. */
  ref: string
  id: string
  title: string
  phase: string
  status: string
  /** The one user status (src/core/user-status.ts): needs | working | waiting | done. */
  user?: string
}

async function resolveRefs(ids: string[]): Promise<BoardRef[]> {
  const { getTask } = await import('../../core/task-manager.js')
  const out: BoardRef[] = []
  for (const ref of ids.slice(0, MAX_REFS)) {
    // No real task id is this short, and a tiny prefix is a guess, not a ref.
    if (ref.length < 4) continue
    const task = await getTask(ref).catch(() => undefined)
    if (!task) continue
    const user = task.phase === 'COMPLETE' || task.status === 'done' ? 'done' : task.user_status?.state
    out.push({ ref, id: task.id, title: task.title, phase: task.phase, status: task.status, ...(user ? { user } : {}) })
  }
  return out
}

/** Chips the html names, then the tasks the projects hold (so `<walnut-project>` can render them). */
function boardRefIds(board: BoardFile): string[] {
  const ids = new Set(extractTaskRefs(board.html))
  for (const project of Object.values(board.projects)) for (const id of project.tasks ?? []) ids.add(id)
  return [...ids]
}

/** Direct subtasks not done, by the board's rule (a parent ref may be a short prefix of the id). */
async function openSubtaskCount(taskId: string): Promise<number> {
  const { listTasks } = await import('../../core/task-manager.js')
  let n = 0
  for (const t of await listTasks()) {
    const parent = t.parent_task_id
    if (!parent || t.id === taskId || !taskId.startsWith(parent)) continue
    if (t.phase !== 'COMPLETE' && t.status !== 'done') n++
  }
  return n
}

function wantsTeam(v: unknown): boolean {
  const s = Array.isArray(v) ? String(v[0]) : String(v ?? '')
  return s === '1' || s === 'true'
}

boardV1Router.get('/tasks/:id/board/owner', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const owner = await resolveTeamBoardTask(task.id)
  const base = { task_id: owner.taskId, title: owner.title, self: owner.self, has_board: owner.hasBoard }
  // ?tab=1 (the session header's Board tab) also asks whether the task leads: a
  // Board of its own with something in it, and its open subtasks. Only on request:
  // every board_* op resolves its default board through this route.
  if (!wantsTeam(req.query.tab)) { res.json(base); return }
  const ownBoard = owner.self && owner.hasBoard && boardHasContent(await getBoard(owner.taskId))
  res.json({ ...base, own_board: ownBoard, open_subtasks: await openSubtaskCount(task.id) })
}))

// The choice the task's status counts as waiting on the user (src/core/boards/open-choice.ts),
// so the Org page answers it where the task is listed.
boardV1Router.get('/tasks/:id/board/open-choice', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const { listTasks } = await import('../../core/task-manager.js')
  const { openChoiceFor } = await import('../../core/boards/open-choice.js')
  const ids = (await listTasks()).map((t) => t.id)
  res.json({ choice: await openChoiceFor(task.id, ids) })
}))

boardV1Router.get('/tasks/:id/board', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const owner = wantsTeam(req.query.team)
    ? await resolveTeamBoardTask(task.id)
    : { taskId: task.id, title: task.title }
  const board = await getBoard(owner.taskId)
  // Kanban (board-kanban.ts): always present, a board with no file too; fields=kanban answers only these.
  const kanban = kanbanFields(board, await teamSnapshot(owner.taskId))
  if (String(Array.isArray(req.query.fields) ? req.query.fields[0] : req.query.fields ?? '') === 'kanban') {
    res.json({ board_task_id: owner.taskId, board_task_title: owner.title, board_version: board?.version ?? 0, ...kanban })
    return
  }
  res.json({
    board_task_id: owner.taskId,
    board_task_title: owner.title,
    board: board ? publicBoard(board) : null,
    threads: board?.threads ?? {},
    marks: board?.marks ?? {},
    projects: board?.projects ?? {},
    checks: board ? boardCheckStates(board) : {},
    choices: board?.choices ?? {},
    reminders: board?.reminders ?? {},
    section_seen: board?.section_seen ?? {},
    ...(board?.section_seen_agent ? { section_seen_agent: board.section_seen_agent } : {}),
    refs: board ? await resolveRefs(boardRefIds(board)) : [],
    board_version: board?.version ?? 0,
    ...kanban,
  })
}))

boardV1Router.put('/tasks/:id/board', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (typeof b.html !== 'string') throw new RouteError(400, 'bad_request', '`html` must be a string')
  const board = await setBoardHtml(task.id, b.html, { by: writer(caller), expectVersion: optionalVersion(b.version) })
  res.json({ board: publicBoard(board) })
}))

boardV1Router.post('/tasks/:id/board/edits', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (!Array.isArray(b.edits) || b.edits.length === 0) {
    throw new RouteError(400, 'bad_request', '`edits` must be a non-empty array of { old, new }')
  }
  const edits = b.edits.map((e: unknown, index: number): BoardEdit => {
    const o = e as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || typeof o.old !== 'string' || typeof o.new !== 'string' || o.old === '') {
      throw new RouteError(400, 'bad_request', `edits[${index}] must be { old: non-empty string, new: string }`, { index })
    }
    return { old: o.old, new: o.new }
  })
  const board = await editBoardHtml(task.id, edits, { by: writer(caller), expectVersion: optionalVersion(b.version) })
  res.json({ board: publicBoard(board) })
}))

boardV1Router.post('/tasks/:id/board/threads/:thread', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const thread = param(req.params.thread)
  const b = body(req)
  if (typeof b.text !== 'string') throw new RouteError(400, 'bad_request', '`text` must be a string')
  const author = caller.kind === 'human' ? 'user' as const : caller.kind === 'task' ? `task:${caller.taskId}` as const : 'agent' as const
  const message = await postBoardMessage(task.id, thread, { author, text: b.text })
  if (caller.kind !== 'human') {
    res.status(201).json({ message, delivery: { state: 'stored' } })
    return
  }
  res.status(201).json({ message, delivery: await deliverToLeader(task, thread, message) })
}))

boardV1Router.delete('/tasks/:id/board/threads/:thread/messages/:message', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const thread = param(req.params.thread)
  const overrideUser = overrideUserFlag(req)
  const message = await deleteBoardMessage(task.id, thread, param(req.params.message), { by: writer(caller), overrideUser })
  log.web.info('board thread message deleted', {
    taskId: task.id, thread, messageId: message.id, by: writer(caller), author: message.author,
    ...(overrideUser ? { overrideUser: true } : {}),
  })
  res.json({ message })
}))

boardV1Router.put('/tasks/:id/board/marks/:mark', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  for (const field of ['state', 'note'] as const) {
    if (b[field] !== undefined && b[field] !== null && typeof b[field] !== 'string') {
      throw new RouteError(400, 'bad_request', `\`${field}\` must be a string`)
    }
  }
  const markId = param(req.params.mark)
  const overrideUser = bodyFlag(b, 'override_user')
  const mark = await setBoardMark(task.id, markId, {
    state: b.state as string | null | undefined,
    note: b.note as string | null | undefined,
  }, { writer: await boardWriterStamp(caller), overrideUser })
  if (caller.kind !== 'human') log.web.info('board mark written by an agent', { taskId: task.id, mark: markId, by: writer(caller), overrideUser })
  res.json({ mark })
}))

/** Each entry to a full task id: unknown or ambiguous → 400 bad_task naming it. */
async function resolveProjectTasks(raw: unknown): Promise<string[] | null | undefined> {
  if (raw === undefined || raw === null) return raw
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new RouteError(400, 'bad_request', '`tasks` must be an array of task ids')
  }
  if (raw.length > BOARD_PROJECT_MAX_TASKS) {
    throw new RouteError(400, 'too_many', `A project holds at most ${BOARD_PROJECT_MAX_TASKS} tasks`, { max: BOARD_PROJECT_MAX_TASKS })
  }
  const { getTask } = await import('../../core/task-manager.js')
  const out: string[] = []
  for (const ref of raw as string[]) {
    try {
      out.push((await getTask(ref.trim())).id)
    } catch (err) {
      const ambiguous = /Ambiguous ID prefix/i.test(err instanceof Error ? err.message : String(err))
      throw new RouteError(400, 'bad_task', ambiguous ? `Ambiguous task id prefix: ${ref}` : `Unknown task: ${ref}`, { task: ref })
    }
  }
  return out
}

boardV1Router.put('/tasks/:id/board/projects/:project', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  const title = optionalString(b, 'title')
  const status = optionalString(b, 'status')
  for (const field of ['delete', 'override_user'] as const) {
    if (b[field] !== undefined && typeof b[field] !== 'boolean') throw new RouteError(400, 'bad_request', `\`${field}\` must be a boolean`)
  }
  const text: Record<string, string | null> = {}
  for (const field of Object.keys(BOARD_PROJECT_TEXT_FIELDS)) {
    const v = optionalString(b, field)
    if (v !== undefined) text[field] = v
  }
  const tasks = await resolveProjectTasks(b.tasks)
  const projectId = param(req.params.project)
  const by = writer(caller)
  const out = await writeBoardProject(task.id, projectId, {
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...text,
    ...(b.delete === true ? { delete: true } : {}),
  }, { by, overrideUser: b.override_user === true })
  // The user's pick reaches the board's session like a choice answer; a session's own write is its own news.
  if (by === 'human' && out.statusChanged && out.project?.status) {
    const text = buildProjectStatusPrompt(projectId, out.project, out.previous, task.id)
    const delivery = await deliverBoardText(task.id, text, { project: projectId, status: out.project.status })
    log.web.info('board project status set by the user', {
      taskId: task.id, project: projectId, status: out.project.status, was: out.previous?.status ?? '', delivery: delivery.state,
    })
    res.json({ project: out.project, delivery })
    return
  }
  res.json({ project: out.project })
}))

boardV1Router.put('/tasks/:id/board/checks/:check', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (typeof b.read !== 'boolean') throw new RouteError(400, 'bad_request', '`read` must be a boolean')
  if (b.hash !== undefined && typeof b.hash !== 'string') throw new RouteError(400, 'bad_request', '`hash` must be a string')
  const out = await setBoardCheck(task.id, param(req.params.check), { read: b.read, hash: b.hash as string | undefined },
    { writer: await boardWriterStamp(caller) })
  res.json(out)
}))

boardV1Router.put('/tasks/:id/board/choices/:choice', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  // An option, words, or both: each one given replaces that part ("" takes it back).
  const { option, text } = b
  if (option !== undefined && typeof option !== 'string') throw new RouteError(400, 'bad_request', '`option` must be a string ("" clears)')
  if (text !== undefined && typeof text !== 'string') throw new RouteError(400, 'bad_request', '`text` must be a string ("" clears)')
  if (option === undefined && text === undefined) throw new RouteError(400, 'bad_request', 'Give `option`, `text` or both')
  const choiceId = param(req.params.choice)
  const overrideUser = bodyFlag(b, 'override_user')
  const result = await setBoardChoice(task.id, choiceId, { option: option as string | undefined, text: text as string | undefined },
    { writer: await boardWriterStamp(caller), overrideUser })
  let delivery: BoardDelivery | { state: 'skipped'; reason: 'unchanged' | 'cleared' | 'self' }
  if (!result.choice) delivery = { state: 'skipped', reason: 'cleared' }
  // The same answer again: nothing to say, unless its last delivery did not go out.
  else if (!result.changed && !result.choice.undelivered) delivery = { state: 'skipped', reason: 'unchanged' }
  // The board task's own session answering its own choice: it knows already.
  else if (caller.kind === 'task' && caller.taskId === task.id) delivery = { state: 'skipped', reason: 'self' }
  else {
    const board = await getBoard(task.id)
    const text = await buildChoicePrompt(board?.html ?? '', choiceId, result.choice)
    // The user's answer goes as the user; an agent's as a message from that agent's session (peer provenance).
    delivery = await deliverBoardText(task.id, text, { choice: choiceId, option: result.choice.option },
      caller.kind === 'human' ? undefined : { callerSid: caller.sessionId })
    result.choice = await markChoiceDelivery(task.id, choiceId, result.choice, delivery.state !== 'stored')
  }
  log.web.info('board choice answered', {
    taskId: task.id, choice: choiceId, option: result.choice?.option ?? '', textChars: result.choice?.text?.length ?? 0,
    by: writer(caller), delivery: delivery.state, ...(overrideUser ? { overrideUser: true } : {}),
  })
  res.json({ choice: result.choice, delivery })
}))

boardV1Router.put('/tasks/:id/board/reminders/:target', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (!('at' in b) || (b.at !== null && typeof b.at !== 'string')) {
    throw new RouteError(400, 'bad_time', '`at` must be an ISO-8601 time, or null to clear')
  }
  const note = optionalString(b, 'note')
  const reminder = await setBoardReminder(task.id, param(req.params.target), {
    at: b.at === '' ? null : b.at as string | null,
    note,
  }, { by: writer(caller), overrideUser: bodyFlag(b, 'override_user') })
  res.json({ reminder })
}))

boardV1Router.put('/tasks/:id/board/seen/:section', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (typeof b.hash !== 'string') throw new RouteError(400, 'bad_request', '`hash` must be a string ("" forgets)')
  const seen = await setBoardSectionSeen(task.id, param(req.params.section), { hash: b.hash }, { by: writer(caller) })
  res.json({ seen })
}))

boardV1Router.delete('/tasks/:id/board', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  // Kept as a copy (boards/.deleted/), whoever deletes it: an agent may delete any board.
  const { existed, copy } = await removeBoard(task.id, { keepCopy: true })
  if (existed) log.web.info('board deleted', { taskId: task.id, by: writer(caller), copy })
  res.status(204).end()
}))

// ── Delivery: a human's thread message reaches the board task's session ──

/** Never fails the post: the message is already stored, so a send failure is reported, not thrown. */
async function deliverToLeader(task: Task, thread: string, message: BoardMessage): Promise<BoardDelivery> {
  const board = await getBoard(task.id)
  const text = buildBoardThreadPrompt(await threadHeading(board?.html ?? '', thread, board?.projects), thread, message.text)
  return deliverBoardText(task.id, text, { thread, messageId: message.id })
}
