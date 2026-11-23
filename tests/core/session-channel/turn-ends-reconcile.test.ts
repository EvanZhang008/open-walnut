/**
 * M3, the boot reconcile (src/core/session-channel/turn-ends.ts): a leader that stopped after a
 * host's batch committed and before its facts were said (the crash seam: the batch applied, nothing
 * emitted) sets each host-judged task's phase from its stored row at its next boot, through the
 * live path's own decision (applySessionPhase). A second boot changes nothing; a legacy session is
 * never touched; a phase the live path (or anyone) moved after the turn end stands.
 *
 * Real: the leader's session and task stores, applyHostChannelBatch, the leader side over an
 * in-memory socket to a real HostChannel and fact log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-turn-ends-reconcile'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetSessionTrackerForTesting, applyHostChannelBatch, createSessionRecord, getSessionByClaudeId, loadChannelCursor } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import * as taskDb from '../../../src/core/task-db.js'
import * as tm from '../../../src/core/task-manager.js'
import { reconcileHostTurnEnds, turnEndMarks } from '../../../src/core/session-channel/turn-ends.js'
import { turnEndEdgeOf } from '../../../src/core/sessions/turn-end-edge.js'
import { createLeaderSide, type ChannelSocket, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import { HostChannel, isChannelFrame } from '../../../src/core/session-channel/channel.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'devbox'
const born = (sid: string, taskId: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId, project: 'Marina', process_status: 'idle', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', messageCount: 1,
  statusRevision: 1, statusUpdatedAt: '2026-11-22T00:00:00.000Z', ...extra,
})

async function inProgressTask(title: string): Promise<string> {
  const { task } = await tm.addTask({ title, project: 'Marina' })
  await tm.updateTask(task.id, { phase: 'IN_PROGRESS' })
  return task.id
}
const phaseOf = async (id: string) => (await tm.getTask(id)).phase

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  taskDb.closeDb()
  tm._dropTaskStoreCacheForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => {
  closeDb()
  _resetSessionTrackerForTesting()
  taskDb.closeDb()
  tm._dropTaskStoreCacheForTesting()
})

describe('the turn-end edge a fact says by its data alone', () => {
  it('a clean result hands back; an error result and a session error are errors; work that goes on and a delivery failure move nothing', () => {
    expect(turnEndEdgeOf('session:result', { sessionId: 's' })).toBe('session:result')
    expect(turnEndEdgeOf('session:result', { isError: true })).toBe('session:error')
    expect(turnEndEdgeOf('session:result', { wakeupPending: true })).toBeNull()
    expect(turnEndEdgeOf('session:result', { detachedBgActive: true })).toBeNull()
    expect(turnEndEdgeOf('session:result', { teamActive: true })).toBeNull()
    expect(turnEndEdgeOf('session:result', { interrupted: true })).toBeNull()
    expect(turnEndEdgeOf('session:result', { interrupted: true, compactionStopped: true })).toBe('session:result')
    expect(turnEndEdgeOf('session:error', { error: 'x' })).toBe('session:error')
    expect(turnEndEdgeOf('session:error', { errorKind: 'delivery_failed' })).toBeNull()
    expect(turnEndEdgeOf('session:tool-use', {})).toBeNull()
  })
})

describe('the boot reconcile of host turn ends', () => {
  it('a batch committed and never said: the next boot sets the task from the row; a second boot changes nothing', async () => {
    const taskId = await inProgressTask('Host turn ended')
    await applyHostChannelBatch({
      hostId: HOST, rows: [{ sid: 'h1', born: true, patch: born('h1', taskId), seq: 1 }], renames: [],
      cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'h1', edge: 'session:result', seq: 2 }],
    })
    // The crash: nothing was said, so nothing moved the task.
    expect(await phaseOf(taskId)).toBe('IN_PROGRESS')
    expect(turnEndMarks().map((m) => [m.sid, m.hostId, m.edge])).toEqual([['h1', HOST, 'session:result']])
    const first = await reconcileHostTurnEnds()
    expect(first).toEqual({ looked: 1, applied: ['h1'] })
    expect(await phaseOf(taskId)).toBe('NEED_ACTION')
    expect(turnEndMarks()).toEqual([])
    const changedAt = (await tm.getTask(taskId)).phase_changed_at
    const second = await reconcileHostTurnEnds()
    expect(second).toEqual({ looked: 0, applied: [] })
    expect((await tm.getTask(taskId)).phase_changed_at).toBe(changedAt)
  })

  it('a phase moved at or after the turn end stands (the live path did it, or a person since); a row running again is left to its own turn end', async () => {
    const said = await inProgressTask('Said before the stop')
    const again = await inProgressTask('Runs again')
    await applyHostChannelBatch({
      hostId: HOST,
      rows: [{ sid: 'h2', born: true, patch: born('h2', said), seq: 1 }, { sid: 'h3', born: true, patch: born('h3', again, { process_status: 'running' }), seq: 2 }],
      renames: [], cursor: { logId: 'L1', seq: 4 },
      turnEnds: [{ sid: 'h2', edge: 'session:result', seq: 3 }, { sid: 'h3', edge: 'session:result', seq: 4 }],
    })
    await new Promise((r) => setTimeout(r, 5))
    // The live handler ran for h2 before the stop: the task moved after the mark (here: a person put it back In Progress).
    await tm.updateTask(said, { phase: 'NEED_ACTION' })
    await tm.updateTask(said, { phase: 'IN_PROGRESS' })
    const r = await reconcileHostTurnEnds()
    expect(r).toEqual({ looked: 2, applied: [] })
    expect(await phaseOf(said)).toBe('IN_PROGRESS')
    expect(await phaseOf(again)).toBe('IN_PROGRESS')
    expect(turnEndMarks()).toEqual([])
  })

  it('a legacy session is never marked, so never touched; an error turn end reads as an error', async () => {
    const legacyTask = await inProgressTask('Legacy session')
    await createSessionRecord('legacy-1', legacyTask, 'Marina', undefined, { host: HOST })
    const errTask = await inProgressTask('Host turn failed')
    await applyHostChannelBatch({
      hostId: HOST, rows: [{ sid: 'h4', born: true, patch: born('h4', errTask, { process_status: 'error' }), seq: 1 }], renames: [],
      cursor: { logId: 'L1', seq: 3 },
      turnEnds: [{ sid: 'legacy-1', edge: 'session:result', seq: 2 }, { sid: 'h4', edge: 'session:error', seq: 3 }],
    })
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['h4'])
    expect((await getSessionByClaudeId('legacy-1'))?.judge).toBeUndefined()
    const r = await reconcileHostTurnEnds()
    expect(r.applied).toEqual(['h4'])
    expect(await phaseOf(errTask)).toBe('NEED_ACTION')
    expect(await phaseOf(legacyTask)).toBe('IN_PROGRESS')
  })

  it('a later turn end with no edge (a retrier took it) removes the older mark; one with an edge replaces it', async () => {
    const taskId = await inProgressTask('Superseded')
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h9', born: true, patch: born('h9', taskId), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'h9', edge: 'session:error', seq: 2 }] })
    expect(turnEndMarks().map((m) => m.edge)).toEqual(['session:error'])
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 3 }, turnEnds: [{ sid: 'h9', edge: 'session:result', seq: 3 }] })
    expect(turnEndMarks().map((m) => m.edge)).toEqual(['session:result'])
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 4 }, turnEnds: [{ sid: 'h9', edge: null, seq: 4 }] })
    expect(turnEndMarks()).toEqual([])
  })

  it('only the named host\'s marks made before the boot are looked at', async () => {
    const a = await inProgressTask('Host A')
    const b = await inProgressTask('Host B')
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'ha', born: true, patch: born('ha', a), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 2 }, turnEnds: [{ sid: 'ha', edge: 'session:result', seq: 2 }] })
    await applyHostChannelBatch({ hostId: 'devbox-b', rows: [{ sid: 'hb', born: true, patch: { ...born('hb', b), host: 'devbox-b' }, seq: 1 }], renames: [], cursor: { logId: 'L2', seq: 2 }, turnEnds: [{ sid: 'hb', edge: 'session:result', seq: 2 }] })
    expect((await reconcileHostTurnEnds({ hostId: HOST, before: 0 })).looked).toBe(0)
    expect(await reconcileHostTurnEnds({ hostId: HOST, before: Date.now() + 1 })).toEqual({ looked: 1, applied: ['ha'] })
    expect(await phaseOf(b)).toBe('IN_PROGRESS')
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['hb'])
  })

  it('a turn end at or below the stored position (a link before this one applied it) marks nothing again', async () => {
    const taskId = await inProgressTask('Applied before')
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h5', born: true, patch: born('h5', taskId), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 5 } })
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 5 }, turnEnds: [{ sid: 'h5', edge: 'session:result', seq: 4 }] })
    expect(turnEndMarks()).toEqual([])
  })
})

describe('through the leader side: a host\'s turn end applied, the leader stopped before saying it', () => {
  let side: LeaderSide | null = null
  let dir = ''
  let log: FactLog | null = null
  afterEach(async () => {
    side?.stop(); side = null
    await log?.close().catch(() => {}); log = null
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
  })

  it('marks the turn end with its rows, says nothing, and the boot reconcile sets the phase', async () => {
    const taskId = await inProgressTask('Host turn through the channel')
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'turn-ends-'))
    log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    log.append('h6', 'row', { born: true, patch: born('h6', taskId) })
    log.append('h6', 'session:result', { sessionId: 'h6', taskId, result: 'done' })
    // A second session whose work goes on after its reply: no mark.
    const other = await inProgressTask('Work goes on')
    log.append('h7', 'row', { born: true, patch: born('h7', other) })
    log.append('h7', 'session:result', { sessionId: 'h7', taskId: other, result: 'later', wakeupPending: true })
    const channel = new HostChannel({ log, walnutId: 'w1', hostId: HOST, ownRows: async () => [] })
    const dial = async (): Promise<ChannelSocket> => {
      let onMsg: ((t: string) => void) | null = null
      let onClose: (() => void) | null = null
      const h = channel.attach({ send: (f) => setImmediate(() => onMsg?.(JSON.stringify(f))), close: () => setImmediate(() => onClose?.()) })
      return {
        send: (text) => setImmediate(() => { const f = JSON.parse(text); if (isChannelFrame(f)) h.onFrame(f) }),
        close: () => h.onClose(),
        onMessage: (fn) => { onMsg = fn },
        onClose: (fn) => { onClose = fn },
      }
    }
    const said: string[] = []
    side = createLeaderSide({
      walnutId: async () => 'w1', permit: () => ({ permitNumber: 0, epoch: 1 }), switchNow: async () => () => true,
      openStream: async () => { throw new Error('in memory') }, dial,
      applyBatch: applyHostChannelBatch, loadCursor: async () => null,
      // The crash seam: the leader stops before it says anything.
      emit: (name) => { said.push(name) },
      noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {},
      ownerOf: () => HOST, backoffMs: () => 20, log: () => {},
    })
    await side.noteHost(HOST, { connected: true, judges: true })
    await vi.waitFor(async () => {
      expect(turnEndMarks().length).toBeGreaterThan(0)
      expect(await getSessionByClaudeId('h7')).toBeTruthy()
    }, { timeout: 8000, interval: 10 })
    side.stop(); side = null
    expect(turnEndMarks().map((m) => m.sid)).toEqual(['h6'])
    // The facts were said here (the emit seam ran), but nothing acted on them: the handlers are not wired in this test.
    expect(await phaseOf(taskId)).toBe('IN_PROGRESS')
    const r = await reconcileHostTurnEnds()
    expect(r.applied).toEqual(['h6'])
    expect(await phaseOf(taskId)).toBe('NEED_ACTION')
    expect(await phaseOf(other)).toBe('IN_PROGRESS')
  })
})

describe('S1: the reconcile waits for the host\'s first catch-up after the boot', () => {
  let side: LeaderSide | null = null
  let dir = ''
  let log: FactLog | null = null
  afterEach(async () => {
    side?.stop(); side = null
    await log?.close().catch(() => {}); log = null
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
  })

  it('a host that ran a new turn while the leader was down: the rows are current when the reconcile runs, and the phase is left alone', async () => {
    const taskId = await inProgressTask('Host went on')
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'turn-ends-s1-'))
    log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    log.append('h8', 'row', { born: true, patch: born('h8', taskId) })
    log.append('h8', 'session:result', { sessionId: 'h8', taskId, result: 'first turn' })
    const channel = new HostChannel({ log, walnutId: 'w1', hostId: HOST, ownRows: async () => [] })
    const dial = async (): Promise<ChannelSocket> => {
      let onMsg: ((t: string) => void) | null = null
      let onClose: (() => void) | null = null
      const h = channel.attach({ send: (f) => setImmediate(() => onMsg?.(JSON.stringify(f))), close: () => setImmediate(() => onClose?.()) })
      return {
        send: (text) => setImmediate(() => { const f = JSON.parse(text); if (isChannelFrame(f)) h.onFrame(f) }),
        close: () => h.onClose(),
        onMessage: (fn) => { onMsg = fn },
        onClose: (fn) => { onClose = fn },
      }
    }
    const makeSide = (onCaughtUp?: (host: string) => void) => createLeaderSide({
      walnutId: async () => 'w1', permit: () => ({ permitNumber: 0, epoch: 1 }), switchNow: async () => () => true,
      openStream: async () => { throw new Error('in memory') }, dial,
      applyBatch: applyHostChannelBatch, loadCursor: async (h) => loadChannelCursor(h),
      emit: () => {}, noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {},
      ownerOf: () => HOST, backoffMs: () => 20, log: () => {}, ...(onCaughtUp ? { onCaughtUp } : {}),
    })
    // The first leader applies the turn end and stops before saying it: a mark.
    side = makeSide()
    await side.noteHost(HOST, { connected: true, judges: true })
    const end = Date.now() + 15_000
    while (turnEndMarks().length === 0) {
      if (Date.now() > end) throw new Error('the batch was not applied')
      await new Promise((r) => setTimeout(r, 10))
    }
    side.stop(); side = null
    // While the leader is down the host's session runs a new turn (a queued message).
    log.append('h8', 'row', { patch: { process_status: 'running', statusRevision: 2 } })
    await new Promise((r) => setTimeout(r, 5))
    const bootAt = Date.now()
    // The next boot: the reconcile runs when the link caught up, so it reads the running row.
    const seen: Array<{ host: string; status: string | undefined }> = []
    let ran: Promise<unknown> | null = null
    side = makeSide((host) => {
      ran = getSessionByClaudeId(host === HOST ? 'h8' : '').then((r) => { seen.push({ host, status: r?.process_status }) })
        .then(() => reconcileHostTurnEnds({ hostId: host, before: bootAt }))
    })
    await side.noteHost(HOST, { connected: true, judges: true })
    await vi.waitFor(() => expect(ran).not.toBeNull(), { timeout: Math.max(1, end - Date.now()), interval: 10 })
    const r = await ran
    expect(seen).toEqual([{ host: HOST, status: 'running' }])
    expect(r).toEqual({ looked: 1, applied: [] })
    expect(await phaseOf(taskId)).toBe('IN_PROGRESS')
  })
})

describe('the leader boot wires the reconcile per host, after its catch-up', () => {
  it('leader-boot.ts runs reconcileHostTurnEnds only from onCaughtUp, named by host and the boot time', async () => {
    const src = await fsp.readFile(new URL('../../../src/core/session-channel/leader-boot.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/onCaughtUp: reconcileTurnEnds/)
    const calls = src.match(/reconcileHostTurnEnds\(\{[^}]*/g) ?? []
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatch(/hostId, before: bootAt/)
  })
})
