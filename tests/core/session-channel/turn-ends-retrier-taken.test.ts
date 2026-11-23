/**
 * Review round 1, B1 (inverted proof): a host turn end its retrier took (hostTakenBy names a reason
 * that keeps the phase: a usage-limit or endpoint wait, a restart recovery, a safeguard switch, a
 * context recovery) is held by the leader's live handler, and so must never be replayed into
 * NEED_ACTION at the leader's next boot. Two guards, each tested:
 *   - turnEndEdgeOf says no edge for it (enumerated from TURN_RETRY_TRAITS: a new retrier that keeps
 *     the phase fails here until it holds), so nothing marks it;
 *   - a mark the live handler ran for is cleared, whatever it decided (clearingTurnEndMarks), so a
 *     mark means only "the handler never ran"; a newer turn end's mark committed while it ran stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-land6-retrier-taken'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetSessionTrackerForTesting, applyHostChannelBatch } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import * as taskDb from '../../../src/core/task-db.js'
import * as tm from '../../../src/core/task-manager.js'
import { clearingTurnEndMarks, reconcileHostTurnEnds, turnEndMarks } from '../../../src/core/session-channel/turn-ends.js'
import { turnEndEdgeOf } from '../../../src/core/sessions/turn-end-edge.js'
import { turnEndTakenBy, TURN_RETRY_TRAITS } from '../../../src/core/sessions/turn-run.js'

const HOST = 'devbox'
const row = (sid: string, taskId: string) => ({
  claudeSessionId: sid, taskId, project: 'Marina', process_status: 'idle', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', messageCount: 1, statusRevision: 1, statusUpdatedAt: '2026-11-22T00:00:00.000Z',
})
beforeEach(async () => {
  closeDb(); _resetSessionTrackerForTesting(); taskDb.closeDb(); tm._dropTaskStoreCacheForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); taskDb.closeDb(); tm._dropTaskStoreCacheForTesting() })

describe('a turn end a host retrier took is never replayed at boot', () => {
  it('the reviewer\'s case: the live handler holds it, nothing marks it, the boot reconcile leaves the task In Progress', async () => {
    const data = { sessionId: 'h1', isError: true, result: 'usage limit reached', hostTakenBy: 'usage_limit' }
    const taken = await turnEndTakenBy({ ...data, event: 'result', record: null } as never)
    expect(taken).toBe('usage_limit')
    expect(TURN_RETRY_TRAITS[taken!].keepsPhase).toBe(true)
    expect(turnEndEdgeOf('session:result', data)).toBeNull()
    const { task } = await tm.addTask({ title: 'Waiting on a usage limit', project: 'Marina' })
    await tm.updateTask(task.id, { phase: 'IN_PROGRESS' })
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', born: true, seq: 1, patch: row('h1', task.id) }], renames: [], cursor: { logId: 'L1', seq: 2 } })
    expect(turnEndMarks()).toEqual([])
    expect((await reconcileHostTurnEnds()).applied).toEqual([])
    expect((await tm.getTask(task.id)).phase).toBe('IN_PROGRESS')
  })

  it('every reason that keeps the phase gives no edge, on a result and on an error; one that does not keep it still does', () => {
    for (const [reason, traits] of Object.entries(TURN_RETRY_TRAITS)) {
      for (const name of ['session:result', 'session:error']) {
        const edge = turnEndEdgeOf(name, { sessionId: 's', isError: true, hostTakenBy: reason })
        expect([reason, name, edge === null]).toEqual([reason, name, traits.keepsPhase])
      }
    }
    expect(turnEndEdgeOf('session:result', { sessionId: 's', hostTakenBy: null })).toBe('session:result')
  })

  it('a mark the live handler ran for goes, whatever it decided; a newer turn end marked while it ran stays', async () => {
    const { task } = await tm.addTask({ title: 'Handled live', project: 'Marina' })
    await tm.updateTask(task.id, { phase: 'IN_PROGRESS' })
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h2', born: true, seq: 1, patch: row('h2', task.id) }], renames: [], cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'h2', edge: 'session:error', seq: 2 }] })
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['h2'])
    // The handler held the phase (it decided nothing); its mark still goes.
    await clearingTurnEndMarks(async () => {})({ name: 'session:error', data: { sessionId: 'h2' }, source: 'host-channel' })
    expect(turnEndMarks()).toEqual([])
    expect((await reconcileHostTurnEnds()).applied).toEqual([])
    expect((await tm.getTask(task.id)).phase).toBe('IN_PROGRESS')
    // A newer turn end of the same session committed while a handler runs keeps its mark.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const running = clearingTurnEndMarks(async () => { await gate })({ name: 'session:result', data: { sessionId: 'h2' }, source: 'host-channel' })
    await new Promise((r) => setTimeout(r, 5))
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 3 }, turnEnds: [{ sid: 'h2', edge: 'session:result', seq: 3 }] })
    release(); await running
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['h2'])
  })

  it('a legacy session\'s event (not from the channel) goes straight through, marking nothing', async () => {
    let ran = 0
    await clearingTurnEndMarks(() => { ran++ })({ name: 'session:result', data: { sessionId: 'x' }, source: 'session-runner' })
    expect(ran).toBe(1)
  })
})

describe('the leader\'s turn-end handler is wrapped', () => {
  it('server.ts subscribes its session:result / session:error handler through clearingTurnEndMarks', async () => {
    const src = await fsp.readFile(new URL('../../../src/web/server.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/bus\.subscribe\('main-ai', clearingTurnEndMarks\(/)
  })
})

describe('round 2, N2 and N3: which mark the handler clears', () => {
  it('a handler that threw keeps the mark (the boot looks again); a normal return clears it', async () => {
    const { task } = await tm.addTask({ title: 'Handler threw', project: 'Marina' })
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h3', born: true, seq: 1, patch: row('h3', task.id) }], renames: [], cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'h3', edge: 'session:result', seq: 2 }] })
    await expect(clearingTurnEndMarks(async () => { throw new Error('task ref did not resolve') })({ name: 'session:result', data: { sessionId: 'h3' }, source: 'host-channel' })).rejects.toThrow('task ref')
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['h3'])
    await clearingTurnEndMarks(async () => {})({ name: 'session:result', data: { sessionId: 'h3' }, source: 'host-channel' })
    expect(turnEndMarks()).toEqual([])
  })

  it('a newer mark committed in the same millisecond the handler began is kept', async () => {
    const { task } = await tm.addTask({ title: 'Same millisecond', project: 'Marina' })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
    try {
      await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h4', born: true, seq: 1, patch: row('h4', task.id) }], renames: [], cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'h4', edge: 'session:error', seq: 2 }] })
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const running = clearingTurnEndMarks(async () => { await gate })({ name: 'session:error', data: { sessionId: 'h4' }, source: 'host-channel' })
      // The clock has not moved: the newer batch commits in the same millisecond.
      await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 3 }, turnEnds: [{ sid: 'h4', edge: 'session:result', seq: 3 }] })
      release(); await running
      expect(turnEndMarks().map((m) => [m.sid, m.edge])).toEqual([['h4', 'session:result']])
    } finally { now.mockRestore() }
  })
})
