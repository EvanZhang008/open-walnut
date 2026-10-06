/**
 * The kanban's server facts (src/core/boards/board-kanban-watch.ts) on the real
 * bus with real tasks: every row of the 4.2 table (lane_auto is sticky and
 * forward only; NEED_ACTION, idle and turn ends never move a card),
 * handed_back_at only from the worker's OWN session, worker_summary_at on a
 * summary change, output_at only when a turn ends with a changed summary, and
 * nothing at all for an owner with no board file or a task below a direct child.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-board-kanban-watch'))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { addTask, linkSessionSlot, updateSummary, updateTask } from '../../src/core/task-manager.js'
import { getBoard, hasBoard, setBoardHtml } from '../../src/core/boards/board-store.js'
import { _kanbanWatchIdle, startBoardKanbanWatch, stopBoardKanbanWatch } from '../../src/core/boards/board-kanban-watch.js'

/** A task made the way the routes make one: addTask, then TASK_CREATED (addTask itself emits nothing). */
async function task(title: string, parent?: string, tags?: string[]): Promise<string> {
  const { task: t } = await addTask({ title, project: 'acme', ...(parent ? { parent_task_id: parent } : {}), ...(tags ? { tags } : {}) })
  bus.emit(EventNames.TASK_CREATED, { task: t }, ['web-ui'], { source: 'test' })
  return t.id
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
  await _kanbanWatchIdle()
}

async function card(owner: string, id: string) {
  return (await getBoard(owner))?.cards[id] ?? {}
}

function status(sessionId: string, taskId: string, processStatus: string): void {
  const s = { sessionId, taskId, process_status: processStatus }
  bus.emit(EventNames.SESSION_STATUS_CHANGED, { ...s, status: s }, ['web-ui'], { source: 'test' })
}

function turnEnd(sessionId: string, taskId: string): void {
  bus.emit(EventNames.SESSION_RESULT, { sessionId, taskId, result: 'done' }, ['web-ui'], { source: 'test' })
}

let cardEvents: Array<Record<string, unknown>> = []
let owner: string

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  startBoardKanbanWatch()
  bus.subscribe('test-kanban-watch-spy', (e: BusEvent) => {
    const d = e.data as Record<string, unknown>
    if (d.kind === 'card') cardEvents.push(d)
  }, { global: true, interest: [EventNames.BOARD_CHANGED] })
  owner = await task('Payments resolver group', undefined, ['ticket:V1000000200'])
  await setBoardHtml(owner, '<h1>Team page</h1>', { by: 'human' })
})

afterAll(async () => {
  stopBoardKanbanWatch()
  bus.unsubscribe('test-kanban-watch-spy')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { cardEvents = [] })

describe('lane_auto (4.2 table)', () => {
  it('walks todo, active, wait, active, done, active, and never moves on NEED_ACTION, idle or a turn end (C56)', async () => {
    const id = await task('V1000000201 refund stuck', owner, ['ticket:V1000000201'])
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('new')
    const sid = 'aaaaaaaa-0000-0000-0000-000000000201'
    await linkSessionSlot(id, sid, 'exec')
    status(sid, id, 'running')
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('investigating')
    await updateTask(id, { phase: 'IN_PROGRESS' })
    await settle()
    cardEvents = []
    const before = await card(owner, id)
    await updateTask(id, { phase: 'NEED_ACTION' })
    status(sid, id, 'idle')
    turnEnd(sid, id)
    await settle()
    expect(await card(owner, id)).toEqual(before)
    expect(cardEvents).toEqual([])
    status(sid, id, 'running') // the next turn: still investigating, no write
    await settle()
    expect((await card(owner, id)).lane_auto).toEqual(before.lane_auto)
    expect(cardEvents).toEqual([])
    await updateTask(id, { phase: 'WAITING' })
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('waiting-others')
    // Only a real actor ends a wait (an internal write may only complete a WAITING task).
    await updateTask(id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('investigating')
    await updateTask(id, { phase: 'COMPLETE' })
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('resolved')
    status(sid, id, 'idle')
    status(sid, id, 'running') // a stray run of a done card does not pull it back
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('resolved')
    await updateTask(id, { phase: 'IN_PROGRESS' }, { source: 'api' }) // a reopen
    await settle()
    expect((await card(owner, id)).lane_auto?.lane).toBe('investigating')
  })
})

describe('handed_back_at, worker_summary_at and output_at', () => {
  it('handed_back_at only when the worker\'s own session sets NEED_ACTION', async () => {
    const id = await task('V1000000202 ledger drift', owner)
    const own = 'aaaaaaaa-0000-0000-0000-000000000202'
    const leaderSid = 'aaaaaaaa-0000-0000-0000-000000000299'
    await linkSessionSlot(id, own, 'exec')
    await updateTask(id, { phase: 'IN_PROGRESS' })
    await updateTask(id, { phase: 'NEED_ACTION' }) // a turn end: no actor
    await settle()
    expect((await card(owner, id)).handed_back_at).toBeUndefined()
    await updateTask(id, { phase: 'IN_PROGRESS' })
    await updateTask(id, { phase: 'NEED_ACTION' }, { actorSid: leaderSid })
    await settle()
    expect((await card(owner, id)).handed_back_at).toBeUndefined()
    await updateTask(id, { phase: 'IN_PROGRESS' })
    await updateTask(id, { phase: 'NEED_ACTION' }, { actorSid: own })
    await settle()
    const c = await card(owner, id)
    expect(c.handed_back_at).toMatch(/^\d{4}-/)
    expect(c.lane_auto?.lane).toBe('investigating')
  })

  it('worker_summary_at on a summary change; output_at only when a turn ends with a changed summary', async () => {
    const id = await task('V1000000203 webhook retries', owner)
    const sid = 'aaaaaaaa-0000-0000-0000-000000000203'
    await linkSessionSlot(id, sid, 'exec')
    status(sid, id, 'running')
    await settle()
    turnEnd(sid, id) // nothing changed during this turn
    await settle()
    expect((await card(owner, id)).output_at).toBeUndefined()
    expect((await card(owner, id)).worker_summary_at).toBeUndefined()
    status(sid, id, 'idle')
    status(sid, id, 'running')
    await settle()
    await updateSummary(id, 'Retries pile up after the partner timeout; a backoff fix is in review.')
    await settle()
    const mid = await card(owner, id)
    expect(mid.worker_summary_at).toMatch(/^\d{4}-/)
    expect(mid.output_at).toBeUndefined()
    turnEnd(sid, id)
    await settle()
    const after = await card(owner, id)
    expect(after.output_at).toMatch(/^\d{4}-/)
    expect(after.worker_summary_at).toBe(mid.worker_summary_at)
    await updateTask(id, { title: 'V1000000203 webhook retries again' })
    await settle()
    expect((await card(owner, id)).worker_summary_at).toBe(mid.worker_summary_at)
  })

  it('an owner with no board file gets no file and no writes; a grandchild is not a card of the grandparent', async () => {
    const bare = await task('Leader without a board')
    const kid = await task('Kid of a bare leader', bare)
    await updateTask(kid, { phase: 'IN_PROGRESS' })
    await settle()
    expect(await hasBoard(bare)).toBe(false)
    const child = await task('Direct child', owner)
    const grandchild = await task('Grandchild', child)
    await updateTask(grandchild, { phase: 'IN_PROGRESS' })
    await settle()
    expect((await getBoard(owner))!.cards[grandchild]).toBeUndefined()
    expect(await hasBoard(child)).toBe(false)
  })

  it('C57: a hand back reaches a top-level leader with no board file yet (it gets one); a nested leader under a board never gets its own', async () => {
    const bare = await task('Payments resolver group, no page yet')
    const kid = await task('V1000000203 wallet top up error', bare)
    const own = 'aaaaaaaa-0000-0000-0000-000000000203'
    await linkSessionSlot(kid, own, 'exec')
    await updateTask(kid, { phase: 'IN_PROGRESS' })
    await updateTask(kid, { phase: 'NEED_ACTION' }) // a turn end: still no file
    await settle()
    expect(await hasBoard(bare)).toBe(false)
    await updateTask(kid, { phase: 'IN_PROGRESS' })
    await updateTask(kid, { phase: 'NEED_ACTION' }, { actorSid: own })
    await settle()
    expect(await hasBoard(bare)).toBe(true)
    expect((await card(bare, kid)).handed_back_at).toMatch(/^\d{4}-/)
    expect((await getBoard(bare))!.html).toBe('')
    expect(cardEvents.some((e) => e.taskId === bare && e.task === kid)).toBe(true)
    // A leader nested under `owner` (which has a board): its worker's hand back creates nothing.
    const mid = await task('Nested leader', owner)
    const deep = await task('V1000000204 nested worker', mid)
    const deepSid = 'aaaaaaaa-0000-0000-0000-000000000204'
    await linkSessionSlot(deep, deepSid, 'exec')
    await updateTask(deep, { phase: 'IN_PROGRESS' })
    await updateTask(deep, { phase: 'NEED_ACTION' }, { actorSid: deepSid })
    await settle()
    expect(await hasBoard(mid)).toBe(false)
  })

  it('never bumps the html version', async () => {
    expect((await getBoard(owner))!.version).toBe(1)
    expect((await getBoard(owner))!.html).toBe('<h1>Team page</h1>')
  })
})
