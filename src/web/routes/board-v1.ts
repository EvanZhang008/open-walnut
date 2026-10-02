/**
 * /api/v1/tasks/:id/board: a task's Board (src/core/boards/).
 *
 *   GET    /tasks/:id/board[?team=1]         → { board_task_id, board_task_title, board | null, threads, marks,
 *                                                projects, checks, choices, reminders, section_seen, refs }
 *   GET    /tasks/:id/board/owner            → { task_id, title, self, has_board } (the team's shared board)
 *   PUT    /tasks/:id/board                  { html, version? }      → { board }
 *   POST   /tasks/:id/board/edits            { edits, version? }     → { board }
 *   POST   /tasks/:id/board/threads/:thread  { text }                → 201 { message, delivery }
 *   DELETE /tasks/:id/board/threads/:thread/messages/:message       → { message } (the removed one)
 *   PUT    /tasks/:id/board/marks/:mark      { state?, note? }       → { mark | null }
 *   PUT    /tasks/:id/board/projects/:project { title?, status?, tasks?, delete? } → { project | null }
 *   PUT    /tasks/:id/board/checks/:check    { read, hash? }         → { check | null, hash } (humans only)
 *   PUT    /tasks/:id/board/choices/:choice  { option }              → { choice | null, delivery } (humans only)
 *   PUT    /tasks/:id/board/reminders/:target { at | null, note? }   → { reminder | null }
 *   PUT    /tasks/:id/board/seen/:section    { hash }                → { seen | null } (humans only)
 *   DELETE /tasks/:id/board                  → 204 (humans only)
 *
 * The caller comes from `x-walnut-caller-sid`: none = a human; a session may
 * write only a board its task belongs to (board-team.ts). A human's thread
 * message and a human's choice are delivered to the board task's session through
 * the one send path (core/boards/board-delivery.ts); a session's post is stored
 * only (it IS the answer). A human may delete any thread message, a session only
 * its own (403 not_author). Read ticks, choices and sections seen are the
 * user's word, so a session gets 403 human_only. A board project is one area
 * of this board (a cause, a ticket), not a Walnut project. A team shares one
 * board: `?team=1` and `/owner` answer with the nearest ancestor that has one
 * (else the root of the tree).
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
  deleteBoard,
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
  boardCheckStates,
  setBoardProject,
  setBoardCheck,
  setBoardChoice,
  setBoardReminder,
  setBoardSectionSeen,
} from '../../core/boards/board-items.js'
import {
  buildChoicePrompt,
  deliverBoardText,
  threadHeading,
  buildBoardThreadPrompt,
  type BoardDelivery,
} from '../../core/boards/board-delivery.js'
import { callerMayWriteBoard, resolveTeamBoardTask, type BoardCaller } from '../../core/boards/board-team.js'
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

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return v || undefined
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join('/') : v ?? ''
}

function body(req: Request): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message)
  }
}

/** A board task by id or unique prefix: 404 unknown, 400 ambiguous. */
async function resolveTask(rawId: string): Promise<Task> {
  const { getTask } = await import('../../core/task-manager.js')
  try {
    return await getTask(rawId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Ambiguous ID prefix/i.test(msg)) throw new RouteError(400, 'bad_request', msg)
    throw new RouteError(404, 'not_found', msg)
  }
}

function refuseOnReplica(): void {
  if (CLOUD_MODE) throw new RouteError(501, 'not_supported_cloud', 'Boards are written on the primary box')
}

/** Every write: replica refusal, then the task, then the team check. */
async function prepareWrite(req: Request): Promise<{ task: Task; caller: BoardCaller }> {
  refuseOnReplica()
  const task = await resolveTask(param(req.params.id))
  const caller = await callerMayWriteBoard(task.id, header(req, 'x-walnut-caller-sid'))
  return { task, caller }
}

/** A write only the user may make (a read tick, a choice): any caller sid is a session. */
async function prepareHumanWrite(req: Request, what: string): Promise<Task> {
  refuseOnReplica()
  if (header(req, 'x-walnut-caller-sid')) throw new BoardError('human_only', 403, undefined, `Only the user ${what}`)
  return resolveTask(param(req.params.id))
}

const writer = (caller: BoardCaller) => (caller.kind === 'human' ? 'human' as const : `task:${caller.taskId}` as const)

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
function route(fn: Handler) {
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
}

async function resolveRefs(ids: string[]): Promise<BoardRef[]> {
  const { getTask } = await import('../../core/task-manager.js')
  const out: BoardRef[] = []
  for (const ref of ids.slice(0, MAX_REFS)) {
    // No real task id is this short, and a tiny prefix is a guess, not a ref.
    if (ref.length < 4) continue
    const task = await getTask(ref).catch(() => undefined)
    if (task) out.push({ ref, id: task.id, title: task.title, phase: task.phase, status: task.status })
  }
  return out
}

/** Chips the html names, then the tasks the projects hold (so `<walnut-project>` can render them). */
function boardRefIds(board: BoardFile): string[] {
  const ids = new Set(extractTaskRefs(board.html))
  for (const project of Object.values(board.projects)) for (const id of project.tasks ?? []) ids.add(id)
  return [...ids]
}

function wantsTeam(v: unknown): boolean {
  const s = Array.isArray(v) ? String(v[0]) : String(v ?? '')
  return s === '1' || s === 'true'
}

boardV1Router.get('/tasks/:id/board/owner', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const owner = await resolveTeamBoardTask(task.id)
  res.json({ task_id: owner.taskId, title: owner.title, self: owner.self, has_board: owner.hasBoard })
}))

boardV1Router.get('/tasks/:id/board', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const owner = wantsTeam(req.query.team)
    ? await resolveTeamBoardTask(task.id)
    : { taskId: task.id, title: task.title }
  const board = await getBoard(owner.taskId)
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
    refs: board ? await resolveRefs(boardRefIds(board)) : [],
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
  const author = caller.kind === 'human' ? 'user' as const : `task:${caller.taskId}` as const
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
  const message = await deleteBoardMessage(task.id, thread, param(req.params.message), { by: writer(caller) })
  log.web.info('board thread message deleted', {
    taskId: task.id, thread, messageId: message.id, by: writer(caller), author: message.author,
  })
  res.json({ message })
}))

boardV1Router.put('/tasks/:id/board/marks/:mark', route(async (req, res) => {
  const { task } = await prepareWrite(req)
  const b = body(req)
  for (const field of ['state', 'note'] as const) {
    if (b[field] !== undefined && b[field] !== null && typeof b[field] !== 'string') {
      throw new RouteError(400, 'bad_request', `\`${field}\` must be a string`)
    }
  }
  const mark = await setBoardMark(task.id, param(req.params.mark), {
    state: b.state as string | null | undefined,
    note: b.note as string | null | undefined,
  })
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
  if (b.delete !== undefined && typeof b.delete !== 'boolean') throw new RouteError(400, 'bad_request', '`delete` must be a boolean')
  const tasks = await resolveProjectTasks(b.tasks)
  const project = await setBoardProject(task.id, param(req.params.project), {
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(b.delete === true ? { delete: true } : {}),
  }, { by: writer(caller) })
  res.json({ project })
}))

boardV1Router.put('/tasks/:id/board/checks/:check', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'ticks a point read')
  const b = body(req)
  if (typeof b.read !== 'boolean') throw new RouteError(400, 'bad_request', '`read` must be a boolean')
  if (b.hash !== undefined && typeof b.hash !== 'string') throw new RouteError(400, 'bad_request', '`hash` must be a string')
  const out = await setBoardCheck(task.id, param(req.params.check), { read: b.read, hash: b.hash as string | undefined })
  res.json(out)
}))

boardV1Router.put('/tasks/:id/board/choices/:choice', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'answers a choice')
  const b = body(req)
  if (typeof b.option !== 'string') throw new RouteError(400, 'bad_request', '`option` must be a string ("" clears)')
  const choiceId = param(req.params.choice)
  const result = await setBoardChoice(task.id, choiceId, { option: b.option })
  let delivery: BoardDelivery | { state: 'skipped'; reason: 'unchanged' | 'cleared' }
  if (!result.choice) delivery = { state: 'skipped', reason: 'cleared' }
  else if (!result.changed) delivery = { state: 'skipped', reason: 'unchanged' }
  else {
    const board = await getBoard(task.id)
    const text = await buildChoicePrompt(board?.html ?? '', choiceId, result.choice)
    delivery = await deliverBoardText(task.id, text, { choice: choiceId, option: result.choice.option })
  }
  log.web.info('board choice answered', { taskId: task.id, choice: choiceId, option: result.choice?.option ?? '', delivery: delivery.state })
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
  }, { by: writer(caller) })
  res.json({ reminder })
}))

boardV1Router.put('/tasks/:id/board/seen/:section', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'marks a section seen')
  const b = body(req)
  if (typeof b.hash !== 'string') throw new RouteError(400, 'bad_request', '`hash` must be a string ("" forgets)')
  const seen = await setBoardSectionSeen(task.id, param(req.params.section), { hash: b.hash })
  res.json({ seen })
}))

boardV1Router.delete('/tasks/:id/board', route(async (req, res) => {
  refuseOnReplica()
  if (header(req, 'x-walnut-caller-sid')) throw new BoardError('human_only', 403, undefined, 'Only a human may delete a board')
  const task = await resolveTask(param(req.params.id))
  await deleteBoard(task.id)
  res.status(204).end()
}))

// ── Delivery: a human's thread message reaches the board task's session ──

/** Never fails the post: the message is already stored, so a send failure is reported, not thrown. */
async function deliverToLeader(task: Task, thread: string, message: BoardMessage): Promise<BoardDelivery> {
  const board = await getBoard(task.id)
  const text = buildBoardThreadPrompt(await threadHeading(board?.html ?? '', thread), thread, message.text)
  return deliverBoardText(task.id, text, { thread, messageId: message.id })
}
