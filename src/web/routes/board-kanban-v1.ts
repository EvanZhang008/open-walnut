/**
 * /api/v1/tasks/:id/board kanban writes (core/boards/board-kanban.ts). `:id` is
 * the board's OWNER (the pane's owner), never a worker's own task.
 *
 *   PUT  /tasks/:id/board/lanes                 { lanes, override_user?, if_unchanged_since? } → { lanes, cards_unplaced }
 *   PUT  /tasks/:id/board/cards/:task           { lane?, summary?, waiting_on?, override_user?, if_unchanged_since? }
 *                                                → { card, lane_effective }
 *   POST /tasks/:id/board/cards/:task/move      { lane, order, rank_only? } → { card, order }
 *   POST /tasks/:id/board/cards                 { title, lane?, tags? } → 201 { task, card, warning? } (humans only:
 *                                                a session files work with task_create, which places it and brakes it)
 *   POST /tasks/:id/board/cards/:task/suggestion { action: accept | dismiss } → { card, lane_effective } (humans only)
 *   PUT  /tasks/:id/board/kanban-seen           { cards?, snapshot?, visit_end? } → { kanban_seen } (humans only)
 *
 * Same rules as board-v1.ts: replica 501, the caller from x-walnut-caller-sid,
 * a session only on a board its task belongs to. Mounted at the same prefix.
 */

import { Router } from 'express'
import { log } from '../../logging/index.js'
import {
  answerSuggestion, createBoardCardTask, fullTaskId, moveBoardCard, setBoardCard, setBoardLanes, type KanbanWriteOpts,
} from '../../core/boards/board-kanban.js'
import { setKanbanSeen } from '../../core/boards/board-kanban-seen.js'
import { body, param, prepareHumanWrite, prepareWrite, route, RouteError, writer } from './board-v1.js'

export const boardKanbanV1Router = Router()

function flag(b: Record<string, unknown>, field: string): boolean {
  const v = b[field]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new RouteError(400, 'bad_request', `\`${field}\` must be a boolean`)
  return v
}

function since(b: Record<string, unknown>): string | undefined {
  const v = b.if_unchanged_since
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new RouteError(400, 'bad_request', '`if_unchanged_since` must be the *_at time you saw ("" = none)')
  return v
}

function stringField(b: Record<string, unknown>, field: string): string | undefined {
  const v = b[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new RouteError(400, 'bad_request', `\`${field}\` must be a string ("" clears it)`)
  return v
}

boardKanbanV1Router.put('/tasks/:id/board/lanes', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  if (!Array.isArray(b.lanes)) throw new RouteError(400, 'bad_request', '`lanes` must be an array of { id?, name, kind }')
  const opts: KanbanWriteOpts = { by: writer(caller), overrideUser: flag(b, 'override_user'), ifUnchangedSince: since(b) }
  const out = await setBoardLanes(task.id, b.lanes, opts)
  log.web.info('board lanes set', { taskId: task.id, by: opts.by, lanes: out.lanes.length, unplaced: out.cards_unplaced.length })
  res.json(out)
}))

boardKanbanV1Router.put('/tasks/:id/board/cards/:task', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  const cardId = await fullTaskId(param(req.params.task))
  const opts: KanbanWriteOpts = { by: writer(caller), overrideUser: flag(b, 'override_user'), ifUnchangedSince: since(b) }
  const out = await setBoardCard(task.id, cardId, {
    lane: stringField(b, 'lane'), summary: stringField(b, 'summary'), waiting_on: stringField(b, 'waiting_on'),
  }, opts)
  res.json(out)
}))

boardKanbanV1Router.post('/tasks/:id/board/cards/:task/move', route(async (req, res) => {
  const { task, caller } = await prepareWrite(req)
  const b = body(req)
  const lane = stringField(b, 'lane')
  if (!lane) throw new RouteError(400, 'bad_request', '`lane` must be a lane id')
  if (b.order !== undefined && !Array.isArray(b.order)) throw new RouteError(400, 'bad_request', '`order` must be an array of task ids')
  const cardId = await fullTaskId(param(req.params.task))
  const out = await moveBoardCard(task.id, cardId, {
    lane, order: (b.order as string[] | undefined) ?? [], rank_only: flag(b, 'rank_only'),
  }, { by: writer(caller), overrideUser: flag(b, 'override_user') })
  res.json(out)
}))

boardKanbanV1Router.post('/tasks/:id/board/cards', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'adds a task from a lane (a session uses task_create)')
  const b = body(req)
  if (typeof b.title !== 'string') throw new RouteError(400, 'bad_request', '`title` must be a string')
  if (b.tags !== undefined && !Array.isArray(b.tags)) throw new RouteError(400, 'bad_request', '`tags` must be an array of strings')
  const out = await createBoardCardTask(task.id, {
    title: b.title, lane: stringField(b, 'lane'), tags: b.tags as string[] | undefined,
  }, { by: 'human' })
  if (out.warning) {
    log.web.warn('board card task made but not placed', { taskId: task.id, cardTaskId: out.task.id, error: out.error })
  }
  res.status(201).json({ task: out.task, card: out.card, ...(out.warning ? { warning: out.warning } : {}) })
}))

boardKanbanV1Router.post('/tasks/:id/board/cards/:task/suggestion', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'answers a suggestion')
  const b = body(req)
  if (b.action !== 'accept' && b.action !== 'dismiss') throw new RouteError(400, 'bad_request', '`action` must be accept or dismiss')
  const cardId = await fullTaskId(param(req.params.task))
  res.json(await answerSuggestion(task.id, cardId, b.action, { by: 'human' }))
}))

boardKanbanV1Router.put('/tasks/:id/board/kanban-seen', route(async (req, res) => {
  const task = await prepareHumanWrite(req, 'marks cards seen')
  const b = body(req)
  res.json(await setKanbanSeen(task.id, {
    cards: b.cards as string[] | 'all' | undefined,
    snapshot: b.snapshot as Record<string, never> | undefined,
    visit_end: b.visit_end as boolean | undefined,
  }, { by: 'human' }))
}))
