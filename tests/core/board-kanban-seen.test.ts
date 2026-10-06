/**
 * The user's kanban "Changed" baseline (src/core/boards/board-kanban-seen.ts):
 * humans only, the first write creates the file and the baseline, 'all' and a
 * visit's end move `at` to `previous_at`, a snapshot entry wins over the
 * server's own computation, listed cards are computed with the web's rules,
 * and entries of tasks no longer on the team are dropped.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-board-kanban-seen'))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { addTask, deleteTask, updateSummary } from '../../src/core/task-manager.js'
import { BoardError, getBoard } from '../../src/core/boards/board-store.js'
import { setBoardCard } from '../../src/core/boards/board-kanban.js'
import { setKanbanSeen } from '../../src/core/boards/board-kanban-seen.js'
import { displayedSummary, summaryHash } from '../../src/core/boards/board-lanes.js'

async function task(title: string, parent?: string, tags?: string[]): Promise<string> {
  const { task: t } = await addTask({ title, project: 'acme', ...(parent ? { parent_task_id: parent } : {}), ...(tags ? { tags } : {}) })
  return t.id
}

const tick = () => new Promise((r) => setTimeout(r, 15))
const events: Array<Record<string, unknown>> = []

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bus.subscribe('test-kanban-seen-spy', (e: BusEvent) => { events.push(e.data as Record<string, unknown>) },
    { global: true, interest: [EventNames.BOARD_CHANGED] })
})

afterAll(async () => {
  bus.unsubscribe('test-kanban-seen-spy')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('kanban seen baseline', () => {
  it('a session is 403 human_only and writes nothing', async () => {
    const owner = await task('Seen refusal board')
    const err = await setKanbanSeen(owner, { cards: 'all' }, { by: `task:${owner}` }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BoardError)
    expect([(err as BoardError).statusCode, (err as BoardError).code]).toEqual([403, 'human_only'])
    expect(await getBoard(owner)).toBeNull()
  })

  it('the first write creates the file and the baseline; all and visit_end move at to previous_at', async () => {
    const owner = await task('Seen board', undefined, ['ticket:V1000000300'])
    const a = await task('V1000000301 a', owner)
    const b = await task('V1000000302 b', owner)
    await updateSummary(b, '**Bold** worker summary')
    const first = await setKanbanSeen(owner, { cards: 'all' }, { by: 'human' })
    expect((await getBoard(owner))).toMatchObject({ html: '', version: 0 })
    expect(first.kanban_seen.previous_at).toBeUndefined()
    expect(first.kanban_seen.cards[a]).toEqual({ lane: 'new', summaryHash: summaryHash(''), unread: false })
    expect(first.kanban_seen.cards[b].summaryHash).toBe(summaryHash(displayedSummary(undefined, '**Bold** worker summary')!.text))
    expect(events.at(-1)).toEqual({ taskId: owner, kind: 'seen', kanban: true, version: 0 })
    await tick()
    const listed = await setKanbanSeen(owner, { cards: [a] }, { by: 'human' })
    expect(listed.kanban_seen.at).toBe(first.kanban_seen.at)
    await tick()
    const ended = await setKanbanSeen(owner, { visit_end: true }, { by: 'human' })
    expect(ended.kanban_seen.previous_at).toBe(first.kanban_seen.at)
    expect(ended.kanban_seen.at > first.kanban_seen.at).toBe(true)
    await tick()
    const all = await setKanbanSeen(owner, { cards: 'all' }, { by: 'human' })
    expect(all.kanban_seen.previous_at).toBe(ended.kanban_seen.at)
  })

  it('a snapshot entry is what the user saw and wins; listed ids without one are computed; deleted tasks drop out', async () => {
    const owner = await task('Snapshot board', undefined, ['ticket:V1000000310'])
    const a = await task('V1000000311 a', owner)
    const b = await task('V1000000312 b', owner)
    const gone = await task('V1000000313 gone', owner)
    await setBoardCard(owner, a, { summary: 'Card words', lane: 'mitigating' }, { by: `task:${owner}` })
    const out = await setKanbanSeen(owner, {
      cards: [a, b, gone, 'zzzz-not-on-team'],
      snapshot: { [b]: { lane: 'investigating', summaryHash: 'deadbeef', outputAt: '2026-10-01T08:30:00.000Z' } },
    }, { by: 'human' })
    expect(out.kanban_seen.cards[a]).toEqual({ lane: 'mitigating', summaryHash: summaryHash('Card words'), unread: false })
    expect(out.kanban_seen.cards[b]).toEqual({ lane: 'investigating', summaryHash: 'deadbeef', outputAt: '2026-10-01T08:30:00.000Z' })
    expect(Object.keys(out.kanban_seen.cards).sort()).toEqual([a, b, gone].sort())
    await deleteTask(gone)
    const next = await setKanbanSeen(owner, { cards: [] }, { by: 'human' })
    expect(Object.keys(next.kanban_seen.cards).sort()).toEqual([a, b].sort())
  })

  it('bad input is 400', async () => {
    const owner = await task('Seen bad input board')
    const bad = async (input: unknown) => (await setKanbanSeen(owner, input as never, { by: 'human' }).catch((e: BoardError) => e) as BoardError).statusCode
    expect(await bad({ cards: 'some' })).toBe(400)
    expect(await bad({ snapshot: { x: { lane: 1 } } })).toBe(400)
    expect(await bad({ visit_end: 'yes' })).toBe(400)
  })
})
