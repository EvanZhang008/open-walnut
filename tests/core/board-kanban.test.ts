/**
 * Kanban writes of a Board (src/core/boards/board-kanban.ts) against real
 * files and real tasks in an isolated home: the board file a first lane or
 * card write creates (C27), template materialization, the user vs session
 * rule with the recorded suggestion (C11), reorder without taking the lane
 * (C68), the one done lane (C78), lane deletion, limits, and the cleanup of
 * cards whose task left the team.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-board-kanban'))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, type BusEvent } from '../../src/core/event-bus.js'
import { addTask, deleteTask, updateTask } from '../../src/core/task-manager.js'
import { BoardError, _boardFilePath, getBoard, setBoardHtml } from '../../src/core/boards/board-store.js'
import { resolveTeamBoardTask } from '../../src/core/boards/board-team.js'
import {
  answerSuggestion, createBoardCardTask, moveBoardCard, setBoardCard, setBoardLanes,
} from '../../src/core/boards/board-kanban.js'

const HUMAN = 'human' as const

async function task(title: string, parent?: string, tags?: string[]): Promise<string> {
  const { task: t } = await addTask({ title, project: 'acme', ...(parent ? { parent_task_id: parent } : {}), ...(tags ? { tags } : {}) })
  return t.id
}

async function boardError(fn: () => Promise<unknown>): Promise<BoardError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof BoardError) return err
    throw err
  }
  throw new Error('expected a BoardError')
}

let events: BusEvent[] = []

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bus.subscribe('test-board-kanban-spy', (e) => { events.push(e) }, { global: true, interest: ['board:'] })
})

afterAll(async () => {
  bus.unsubscribe('test-board-kanban-spy')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { events = [] })

describe('the first kanban write (C27)', () => {
  it('creates the board file with an empty page at version 0, and the team still resolves to the owner', async () => {
    const owner = await task('Payments resolver group')
    const worker = await task('V1000000101 refund stuck', owner, ['ticket:V1000000101'])
    expect(await getBoard(owner)).toBeNull()
    const out = await setBoardCard(owner, worker, { summary: 'Refund job stuck on one shard' }, { by: HUMAN })
    const board = await getBoard(owner)
    expect(board).toMatchObject({ html: '', version: 0, task_id: owner })
    await expect(fs.stat(_boardFilePath(owner))).resolves.toBeTruthy()
    expect(board!.cards[worker]).toMatchObject({ summary: 'Refund job stuck on one shard', summary_by: 'human' })
    expect(out.lane_effective).toBe('new')
    const resolved = await resolveTeamBoardTask(worker)
    expect(resolved).toMatchObject({ taskId: owner, hasBoard: true, self: false })
    expect(events.map((e) => e.data)).toContainEqual({ taskId: owner, kind: 'card', task: worker, version: 0 })
  })

  it('materializes the template the team tags pick and keeps it when the tags change later', async () => {
    const owner = await task('Checkout latency follow up')
    const worker = await task('Profile the cart service', owner)
    await setBoardCard(owner, worker, { waiting_on: 'CR review' }, { by: HUMAN })
    let board = await getBoard(owner)
    expect(board!.lanes_template).toBe('general')
    expect(board!.lanes!.map((l) => l.id)).toEqual(['todo', 'in-progress', 'waiting', 'review', 'done'])
    await task('V1000000102 timeout spike', owner, ['ticket:V1000000102'])
    await setBoardCard(owner, worker, { summary: 'still general' }, { by: HUMAN })
    board = await getBoard(owner)
    expect(board!.lanes_template).toBe('general')
    expect(board!.lanes!.map((l) => l.name)).toEqual(['To do', 'In progress', 'Waiting', 'Review', 'Done'])
  })

  it('never bumps the html version, and an html write keeps the cards', async () => {
    const owner = await task('Version check group')
    const worker = await task('One worker', owner)
    await setBoardHtml(owner, '<h1>Page</h1>', { by: HUMAN })
    await setBoardCard(owner, worker, { summary: 'a' }, { by: HUMAN })
    await moveBoardCard(owner, worker, { lane: 'in-progress', order: [worker] }, { by: HUMAN })
    let board = await getBoard(owner)
    expect(board!.version).toBe(1)
    await setBoardHtml(owner, '<h1>Page two</h1>', { by: HUMAN, expectVersion: 1 })
    board = await getBoard(owner)
    expect(board!.version).toBe(2)
    expect(board!.cards[worker]).toMatchObject({ summary: 'a', lane: 'in-progress', lane_by: 'human' })
  })
})

describe('the user vs a session (C11, G10)', () => {
  it('a session moving a card the user placed is refused, the whole write with it, and its lane is kept as a suggestion', async () => {
    const owner = await task('Triage board for refunds')
    const worker = await task('V1000000103 duplicate charge', owner, ['ticket:V1000000103'])
    const leader = `task:${owner}` as const
    await moveBoardCard(owner, worker, { lane: 'waiting-cr', order: [worker] }, { by: HUMAN })
    events = []
    const err = await boardError(() => setBoardCard(owner, worker, { lane: 'mitigating', summary: 'leader words' }, { by: leader }))
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('status_set_by_user')
    expect(err.details).toMatchObject({ task: worker, lane: 'waiting-cr' })
    expect(err.message).toMatch(/^The user placed this card in "Waiting on CR" today at \d{2}:\d{2}\. Leave lane out to keep their pick, or pass override_user: true to replace it\. Your suggestion to move it to "Mitigating" was recorded on the card; the user can accept it\.$/)
    const card = (await getBoard(owner))!.cards[worker]
    expect(card.lane).toBe('waiting-cr')
    expect(card.lane_by).toBe('human')
    expect(card.summary).toBeUndefined()
    expect(card.lane_suggested).toMatchObject({ lane: 'mitigating', by: owner })
    expect(events.map((e) => (e.data as { kind: string }).kind)).toEqual(['card'])

    // Leaving lane out is never refused; the same lane is not a change either.
    await setBoardCard(owner, worker, { summary: 'fine', lane: 'waiting-cr' }, { by: leader })
    expect((await getBoard(owner))!.cards[worker]).toMatchObject({ summary: 'fine', lane_by: 'human' })

    const moved = await setBoardCard(owner, worker, { lane: 'mitigating' }, { by: leader, overrideUser: true })
    expect(moved.lane_effective).toBe('mitigating')
    expect(moved.card).toMatchObject({ lane: 'mitigating', lane_by: leader })
    expect(moved.card.lane_suggested).toBeUndefined()
  })

  it('accept is the user\'s move to the suggested lane, dismiss only forgets it, sessions may not answer', async () => {
    const owner = await task('Suggestion board')
    const worker = await task('V1000000104 webhook retries', owner, ['ticket:V1000000104'])
    const leader = `task:${owner}` as const
    await moveBoardCard(owner, worker, { lane: 'investigating', order: [] }, { by: HUMAN })
    await boardError(() => setBoardCard(owner, worker, { lane: 'mitigating' }, { by: leader }))
    expect((await boardError(() => answerSuggestion(owner, worker, 'accept', { by: leader }))).statusCode).toBe(403)
    const accepted = await answerSuggestion(owner, worker, 'accept', { by: HUMAN })
    expect(accepted.card).toMatchObject({ lane: 'mitigating', lane_by: 'human' })
    expect(accepted.card.lane_suggested).toBeUndefined()
    expect(accepted.lane_effective).toBe('mitigating')

    await boardError(() => setBoardCard(owner, worker, { lane: 'waiting-others' }, { by: leader }))
    const dismissed = await answerSuggestion(owner, worker, 'dismiss', { by: HUMAN })
    expect(dismissed.card).toMatchObject({ lane: 'mitigating', lane_by: 'human' })
    expect(dismissed.card.lane_suggested).toBeUndefined()
    expect((await boardError(() => answerSuggestion(owner, worker, 'dismiss', { by: HUMAN }))).code).toBe('no_suggestion')
  })

  it('a human drag clears a pending suggestion; a refused clear writes nothing', async () => {
    const owner = await task('Drag clears board')
    const worker = await task('V1000000105 ledger drift', owner, ['ticket:V1000000105'])
    const leader = `task:${owner}` as const
    await moveBoardCard(owner, worker, { lane: 'investigating' }, { by: HUMAN })
    await boardError(() => setBoardCard(owner, worker, { lane: 'mitigating' }, { by: leader }))
    await moveBoardCard(owner, worker, { lane: 'waiting-others', order: [worker] }, { by: HUMAN })
    expect((await getBoard(owner))!.cards[worker].lane_suggested).toBeUndefined()
    const err = await boardError(() => setBoardCard(owner, worker, { lane: '' }, { by: leader }))
    expect(err.code).toBe('status_set_by_user')
    expect(err.message).not.toContain('suggestion')
    expect((await getBoard(owner))!.cards[worker]).toMatchObject({ lane: 'waiting-others' })
    expect((await getBoard(owner))!.cards[worker].lane_suggested).toBeUndefined()
  })
})

describe('reorder and the move route (C68)', () => {
  it('a same-lane reorder ranks the cards shown there without taking their lane; a session may then move an auto card', async () => {
    const owner = await task('Reorder board')
    const a = await task('V1000000106 a', owner, ['ticket:V1000000106'])
    const b = await task('V1000000107 b', owner)
    const c = await task('V1000000108 c', owner)
    const done = await task('V1000000109 done one', owner)
    await updateTask(done, { phase: 'COMPLETE' })
    // All four TODO with no session show in New; the done one in Resolved is ignored.
    const out = await moveBoardCard(owner, c, { lane: 'new', order: [c, a, 'zzzz-not-a-task', done, b], rank_only: true }, { by: HUMAN })
    expect(out.order).toEqual([c, a, b])
    const cards = (await getBoard(owner))!.cards
    expect(cards[c]).toMatchObject({ rank: 0, rank_lane: 'new' })
    expect(cards[a]).toMatchObject({ rank: 1, rank_lane: 'new' })
    expect(cards[b]).toMatchObject({ rank: 2, rank_lane: 'new' })
    for (const id of [a, b, c]) {
      expect(cards[id].lane).toBeUndefined()
      expect(cards[id].lane_by).toBeUndefined()
    }
    expect(cards[done]).toBeUndefined()
    const moved = await setBoardCard(owner, a, { lane: 'mitigating' }, { by: `task:${owner}` })
    expect(moved.card).toMatchObject({ lane: 'mitigating', lane_by: `task:${owner}` })
  })

  it('a done lane keeps no order, and an unknown lane is 409 lane_not_found with the lanes', async () => {
    const owner = await task('Done order board')
    const a = await task('V1000000110 a', owner, ['ticket:V1000000110'])
    const out = await moveBoardCard(owner, a, { lane: 'resolved', order: [a] }, { by: HUMAN })
    expect(out.card).toMatchObject({ lane: 'resolved', lane_by: 'human' })
    expect(out.card.rank).toBeUndefined()
    const err = await boardError(() => moveBoardCard(owner, a, { lane: 'ln-00000000', order: [] }, { by: HUMAN }))
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('lane_not_found')
    expect((err.details as { lanes: Array<{ id: string }> }).lanes.map((l) => l.id)).toContain('resolved')
  })
})

describe('lanes', () => {
  it('a table without a done lane is 400 needs_done_lane (C78)', async () => {
    const owner = await task('Done lane rule board')
    const err = await boardError(() => setBoardLanes(owner, [{ name: 'Only', kind: 'todo' }], { by: HUMAN }))
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('needs_done_lane')
    expect(await getBoard(owner)).toBeNull()
  })

  it('deleting a lane clears the lane and rank of its cards in the same write; new lanes get ln- ids', async () => {
    const owner = await task('Lane delete board')
    const a = await task('V1000000111 a', owner, ['ticket:V1000000111'])
    const b = await task('V1000000112 b', owner)
    await moveBoardCard(owner, a, { lane: 'mitigating', order: [a] }, { by: HUMAN })
    await moveBoardCard(owner, b, { lane: 'investigating', order: [b] }, { by: HUMAN })
    const lanes = (await getBoard(owner))!.lanes!.filter((l) => l.id !== 'mitigating')
    events = []
    const out = await setBoardLanes(owner, [...lanes, { name: 'Blocked on vendor', kind: 'wait' }], { by: HUMAN })
    expect(out.cards_unplaced).toEqual([a])
    expect(out.lanes.at(-1)!.id).toMatch(/^ln-[0-9a-f]{8}$/)
    const cards = (await getBoard(owner))!.cards
    // Nothing else was on that card, so it is gone; back to automatic placement.
    expect(cards[a]).toBeUndefined()
    expect(cards[b]).toMatchObject({ lane: 'investigating', rank: 0 })
    const board = await getBoard(owner)
    expect(board).toMatchObject({ lanes_by: 'human', version: 0 })
    expect(events.map((e) => e.data)).toEqual([{ taskId: owner, kind: 'lanes', version: 0 }])
  })

  it('a session over lanes the user set is 409 status_set_by_user unless override_user', async () => {
    const owner = await task('Lane owner board')
    await task('Some work', owner)
    const lanes = [{ name: 'Open', kind: 'todo' }, { name: 'Closed', kind: 'done' }]
    await setBoardLanes(owner, lanes, { by: HUMAN })
    const stored = (await getBoard(owner))!.lanes!
    const err = await boardError(() => setBoardLanes(owner, [...stored, { name: 'Review', kind: 'review' }], { by: `task:${owner}` }))
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('status_set_by_user')
    // The same table again is no change, so it is not refused.
    await setBoardLanes(owner, stored, { by: `task:${owner}` })
    const out = await setBoardLanes(owner, [...stored, { name: 'Review', kind: 'review' }], { by: `task:${owner}`, overrideUser: true })
    expect(out.lanes.map((l) => l.name)).toEqual(['Open', 'Closed', 'Review'])
    expect((await getBoard(owner))!.lanes_by).toBe(`task:${owner}`)
  })

  it('if_unchanged_since: a later lanes or card write is 409 changed_since with the current value', async () => {
    const owner = await task('Stale editor board')
    const a = await task('Editor work', owner)
    await setBoardCard(owner, a, { summary: 'first' }, { by: `task:${owner}` })
    const err = await boardError(() => setBoardCard(owner, a, { summary: 'mine' }, { by: HUMAN, ifUnchangedSince: '' }))
    expect(err.code).toBe('changed_since')
    expect(err.details).toMatchObject({ field: 'summary', current: 'first', by: `task:${owner}` })
    const at = (await getBoard(owner))!.cards[a].summary_at!
    await setBoardCard(owner, a, { summary: 'mine' }, { by: HUMAN, ifUnchangedSince: at })
    expect((await getBoard(owner))!.cards[a].summary).toBe('mine')
    await setBoardLanes(owner, [{ name: 'Open', kind: 'todo' }, { name: 'Done', kind: 'done' }], { by: HUMAN })
    const lanesErr = await boardError(() => setBoardLanes(owner, [{ name: 'X', kind: 'done' }], { by: HUMAN, ifUnchangedSince: '2000-01-01T00:00:00.000Z' }))
    expect(lanesErr.code).toBe('changed_since')
    expect((lanesErr.details as { current: unknown[] }).current).toHaveLength(2)
  })

  it('limits: lanes 1 to 12, names to 40, summary 300, waiting_on 80, each 400 bad_request with max', async () => {
    const owner = await task('Limits board')
    const a = await task('Limits work', owner)
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `Lane ${i}`, kind: i === 0 ? 'done' : 'todo' }))
    expect((await boardError(() => setBoardLanes(owner, many, { by: HUMAN }))).details).toEqual({ max: 12 })
    expect((await boardError(() => setBoardLanes(owner, [{ name: 'x'.repeat(41), kind: 'done' }], { by: HUMAN }))).details).toEqual({ max: 40 })
    expect((await boardError(() => setBoardLanes(owner, [], { by: HUMAN }))).code).toBe('bad_request')
    const long = await boardError(() => setBoardCard(owner, a, { summary: 's'.repeat(301) }, { by: HUMAN }))
    expect([long.statusCode, long.code, long.details]).toEqual([400, 'bad_request', { field: 'summary', max: 300 }])
    const wait = await boardError(() => setBoardCard(owner, a, { waiting_on: 'w'.repeat(81) }, { by: HUMAN }))
    expect(wait.details).toEqual({ field: 'waiting_on', max: 80 })
    await setBoardCard(owner, a, { summary: 's'.repeat(300), waiting_on: 'w'.repeat(80) }, { by: HUMAN })
  })
})

describe('membership and cleanup', () => {
  it('a task outside the tree is 404 not_in_team, the owner itself 400 owner_is_not_a_card; grandchildren are on the team', async () => {
    const owner = await task('Membership board')
    const child = await task('Child work', owner)
    const grandchild = await task('Grandchild work', child)
    const outsider = await task('Outsider work')
    expect((await boardError(() => setBoardCard(owner, outsider, { summary: 'x' }, { by: HUMAN }))).statusCode).toBe(404)
    expect((await boardError(() => setBoardCard(owner, outsider, { summary: 'x' }, { by: HUMAN }))).code).toBe('not_in_team')
    const self = await boardError(() => setBoardCard(owner, owner, { summary: 'x' }, { by: HUMAN }))
    expect([self.statusCode, self.code]).toEqual([400, 'owner_is_not_a_card'])
    await setBoardCard(owner, grandchild, { summary: 'deep' }, { by: HUMAN })
    expect((await getBoard(owner))!.cards[grandchild].summary).toBe('deep')
  })

  it('a card whose task was deleted or moved away is dropped on the next kanban write', async () => {
    const owner = await task('Cleanup board')
    const gone = await task('Will be deleted', owner)
    const moved = await task('Will move away', owner)
    const stays = await task('Stays here', owner)
    const elsewhere = await task('Another leader')
    for (const id of [gone, moved, stays]) await setBoardCard(owner, id, { summary: 'x' }, { by: HUMAN })
    await deleteTask(gone)
    await updateTask(moved, { parent_task_id: elsewhere })
    expect(Object.keys((await getBoard(owner))!.cards).sort()).toEqual([gone, moved, stays].sort())
    await setBoardCard(owner, stays, { summary: 'y' }, { by: HUMAN })
    expect(Object.keys((await getBoard(owner))!.cards)).toEqual([stays])
  })
})

describe('a task added from a lane (C17 server half)', () => {
  it('is a subtask of the owner in its project and folder, tagged, with no session, placed in the lane', async () => {
    const owner = await task('Add task board', undefined, ['ticket:V1000000139'])
    const out = await createBoardCardTask(owner, {
      title: 'V1000000140 checkout latency', lane: 'investigating', tags: ['ticket:V1000000140', 'sev:2'],
    }, { by: HUMAN })
    expect(out.card).toMatchObject({ lane: 'investigating', lane_by: 'human' })
    expect(out.warning).toBeUndefined()
    expect(out.task).toMatchObject({ title: 'V1000000140 checkout latency', parent_task_id: owner, project: 'acme' })
    expect(out.task.tags).toEqual(expect.arrayContaining(['ticket:V1000000140', 'sev:2']))
    expect(out.task.session_ids ?? []).toEqual([])
    expect((await getBoard(owner))!.cards[out.task.id]).toMatchObject({ lane: 'investigating' })
  })

  it('an unknown lane is refused before any task is made; an empty title is 400', async () => {
    const owner = await task('Add task refusals board')
    const err = await boardError(() => createBoardCardTask(owner, { title: 'Never made', lane: 'ln-ffffffff' }, { by: HUMAN }))
    expect(err.code).toBe('lane_not_found')
    expect((await boardError(() => createBoardCardTask(owner, { title: '   ' }, { by: HUMAN }))).statusCode).toBe(400)
    const noLane = await createBoardCardTask(owner, { title: 'Default lane work' }, { by: HUMAN })
    expect(noLane.card).toMatchObject({ lane: 'todo' })
  })

  it('a ticket: tag on the first task added to a board still on its template keeps the lanes the user added it from', async () => {
    const owner = await task('Fresh general board')
    await task('Profile the cart service', owner)
    expect(await getBoard(owner)).toBeNull()
    const out = await createBoardCardTask(owner, { title: 'Fix login', lane: 'todo', tags: ['ticket:V1000000150'] }, { by: HUMAN })
    expect(out.warning).toBeUndefined()
    expect(out.card).toMatchObject({ lane: 'todo', lane_by: 'human' })
    const board = await getBoard(owner)
    expect(board!.lanes_template).toBe('general')
    expect(board!.lanes!.map((l) => l.id)).toEqual(['todo', 'in-progress', 'waiting', 'review', 'done'])
  })
})

describe('the latest event wins after a completion (C12, N16)', () => {
  it('a user moving a completed card back to its old explicit lane puts it there, and a reload agrees', async () => {
    const owner = await task('Latest event board')
    const a = await task('V1000000120 settled twice', owner, ['ticket:V1000000120'])
    const first = await moveBoardCard(owner, a, { lane: 'mitigating', order: [a] }, { by: HUMAN })
    await new Promise((r) => setTimeout(r, 15))
    await updateTask(a, { phase: 'COMPLETE' })
    await new Promise((r) => setTimeout(r, 15))
    // The completion is later than the placement: the card shows in the done lane.
    const shown = await setBoardCard(owner, a, { summary: 'closed out' }, { by: `task:${owner}` })
    expect(shown.lane_effective).toBe('resolved')
    // The user drags it back to the same stored lane: that is a new event.
    const back = await moveBoardCard(owner, a, { lane: 'mitigating', order: [a] }, { by: HUMAN })
    expect(back.card.lane_at! > first.card.lane_at!).toBe(true)
    const reread = await setBoardCard(owner, a, { summary: 'still closed' }, { by: `task:${owner}` })
    expect(reread.lane_effective).toBe('mitigating')
  })

  it('a session writing the lane the user picked keeps the user\'s time, and the lanes 409 says when in words', async () => {
    const owner = await task('Readable time board')
    const a = await task('V1000000121 picked by the user', owner, ['ticket:V1000000121'])
    const picked = await moveBoardCard(owner, a, { lane: 'waiting-cr', order: [a] }, { by: HUMAN })
    await new Promise((r) => setTimeout(r, 15))
    const same = await setBoardCard(owner, a, { lane: 'waiting-cr' }, { by: `task:${owner}` })
    expect(same.card).toMatchObject({ lane_by: 'human', lane_at: picked.card.lane_at })
    const stored = (await getBoard(owner))!.lanes!
    await setBoardLanes(owner, stored.map((l) => ({ ...l })), { by: HUMAN })
    await setBoardLanes(owner, [...stored, { name: 'Vendor', kind: 'wait' }], { by: HUMAN })
    const err = await boardError(() => setBoardLanes(owner, stored, { by: `task:${owner}` }))
    expect(err.message).toMatch(/^The user set this board's lanes today at \d{2}:\d{2}\. Leave the lanes/)
    expect(err.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})
