/**
 * The send.delivery alarm of 2026-11-12, end to end through attachToExisting: a
 * host that takes the attach's optional reads and never answers them holds an
 * on-demand attach (a send waits on it) only for its budget; the attach then
 * goes on with the task phase as the turn's proxy and an unknown cost baseline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

const hang = vi.hoisted(() => ({ on: false, costCalls: 0, statCalls: 0, release: null as null | Promise<void> }))

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../helpers/mock-local-daemon-reader.js')
  const base = mockLocalDaemonReader()
  class HangingReader extends (base.DaemonFileReader as unknown as new (h: string) => Record<string, (...a: unknown[]) => Promise<unknown>>) {
    readCostState(...a: unknown[]) {
      hang.costCalls++
      if (hang.release) return hang.release.then(() => ({ totalCostUsd: 12.5 }))
      return hang.on ? new Promise(() => {}) : super.readCostState(...a)
    }
    stat(...a: unknown[]) {
      hang.statCalls++
      return hang.on ? new Promise(() => {}) : super.stat(...a)
    }
  }
  return { ...base, DaemonFileReader: HangingReader }
})

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
let daemon: MockDaemon

beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop().catch(() => {}) })
beforeEach(async () => {
  bus.clear()
  hang.on = false; hang.costCalls = 0; hang.statCalls = 0; hang.release = null
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})
afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('on-demand attach behind a host that never answers', () => {
  it('waits only for its evidence budget, then attaches without the evidence', async () => {
    const sid = 'ae-hang'
    await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid: 5151, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
    const record = (await getSessionByClaudeId(sid))!
    hang.on = true
    const t0 = Date.now()
    const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`, { evidenceBudgetMs: 150 })
    const took = Date.now() - t0
    // Both reads were asked (the cost state: the record seeds no watermark for this pid).
    expect(hang.costCalls).toBe(1)
    expect(hang.statCalls).toBeGreaterThanOrEqual(1)
    // Before the fix each read waited its own timeout (30 s for the cost state).
    expect(took).toBeLessThan(5_000)
    const internals = session as unknown as { _costBaselineKnown: boolean; resultEmitted: boolean }
    expect(internals._costBaselineKnown).toBe(false)
    // Task phase proxy: the (absent) task is not past IN_PROGRESS.
    expect(internals.resultEmitted).toBe(false)
    session.detach()
  })

  it('a send attach (a line follows) keeps results open; any other attach takes the phase proxy', async () => {
    // A task past IN_PROGRESS: the phase proxy alone would read its turn as processed.
    hang.on = true
    const attachWith = async (sid: string, pid: number, lineFollows: boolean) => {
      const { task } = await addTask({ title: `Waiting on a reply ${sid}` })
      await updateTaskRaw(task.id, { phase: 'NEED_ACTION' })
      await createSessionRecord(sid, task.id, 'proj', '/tmp', { pid, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
      const record = (await getSessionByClaudeId(sid))!
      const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`, { evidenceBudgetMs: 100, lineFollows })
      const emitted = (session as unknown as { resultEmitted: boolean }).resultEmitted
      session.detach()
      return emitted
    }
    expect(await attachWith('ae-line', 5153, true)).toBe(false)
    expect(await attachWith('ae-proxy', 5156, false)).toBe(true)
  })

  it('a cost state that answers after the budget still seeds the baseline, once no result did', async () => {
    const sid = 'ae-late-cost'
    await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid: 5154, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
    const record = (await getSessionByClaudeId(sid))!
    let open!: () => void
    hang.release = new Promise<void>((r) => { open = r })
    hang.on = true
    const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`, { evidenceBudgetMs: 100 })
    const internals = session as unknown as { _costBaselineKnown: boolean; _costWatermark: { value?: number } }
    expect(internals._costBaselineKnown).toBe(false)
    open()
    await vi.waitFor(() => expect(internals._costBaselineKnown).toBe(true), { timeout: 2000, interval: 20 })
    session.detach()
  })

  it('a late answer is not applied to a session detached meanwhile', async () => {
    let open!: () => void
    hang.release = new Promise<void>((r) => { open = r })
    hang.on = true
    const attachOne = async (sid: string, pid: number) => {
      await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
      const record = (await getSessionByClaudeId(sid))!
      return ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`, { evidenceBudgetMs: 100 })
    }
    const gone = await attachOne('ae-late-detached', 5155)
    const kept = await attachOne('ae-late-kept', 5157)
    gone.detach()
    open()
    // Both late answers come from the same release: once the kept one is applied, so was the other's turn.
    await vi.waitFor(() => expect((kept as unknown as { _costBaselineKnown: boolean })._costBaselineKnown).toBe(true), { timeout: 2000, interval: 20 })
    expect((gone as unknown as { _costBaselineKnown: boolean })._costBaselineKnown).toBe(false)
    kept.detach()
  })

  it('a host that answers gives the attach its evidence as before', async () => {
    const sid = 'ae-answers'
    await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid: 5152, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
    const record = (await getSessionByClaudeId(sid))!
    const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`, { evidenceBudgetMs: 5_000 })
    expect(hang.costCalls).toBe(1)
    expect(hang.statCalls).toBeGreaterThanOrEqual(1)
    session.detach()
  })
})
