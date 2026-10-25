/**
 * The FIRST line sent behind a running turn of a fresh CLI process.
 *
 * Walnut used to track a mid-turn line (keep its row until the CLI takes it) only
 * after it had seen a command_lifecycle frame from the session. Claude Code prints
 * one only for a line that waits behind a turn, so the first such line went out
 * under the old rule: its row left the queue at the write, and a process that died
 * before running it lost the message silently (the UI read "Answered").
 *
 * Claude Code declares the behaviour in its system/init (`capabilities` lists
 * `msg_lifecycle_v1`). Now an init with it tracks every mid-turn line from the
 * first one, and a line written before the process's init is held provisionally
 * until that init decides: tracked with the capability, the old rule without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-midturn-first-line'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus } from '../../src/core/event-bus.js'

let seq = 0

/** A fresh process: running its first turn, no lifecycle frame seen, its init maybe not yet read. */
function freshProcess(sid: string, opts: { initSeen?: boolean } = {}) {
  const writes: Array<{ message: string; uuid?: string }> = []
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; onDispatch?: () => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid })
      return true
    },
    writeRaw: () => true,
    renameForSession: () => {},
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 5151,
  }
  const session = new ClaudeCodeSession(`first-line-task-${sid}`, 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: sid, _transport: transport, _processStatus: 'running', _active: true, pid: 5151,
    _sawCommandLifecycle: false, _initSeenThisProcess: opts.initSeen === true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as { sessions: Map<string, ClaudeCodeSession>; injectMidTurn(sid: string): Promise<void> }
  internals.sessions.set(`first-line-task-${sid}`, session)
  const line = (o: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify(o))
  return {
    internals, session, writes,
    init: (capabilities?: string[]) => line({ type: 'system', subtype: 'init', session_id: sid, ...(capabilities ? { capabilities } : {}) }),
    lifecycle: (uuid: string, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state }),
    crash: () => (session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
      .handleRemoteProcessExit(1, 'mock CLI crashed on purpose'),
  }
}

// What Claude Code 2.1.284 lists in its system/init.
const CAPS = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1', 'mcp_read_resource_v1']

const statuses = async (sid: string) => (await getQueue(sid)).map((m) => m.status)
const settle = () => new Promise((r) => setTimeout(r, 100))

let SID = ''
beforeEach(async () => {
  SID = `20000000-0000-4000-8000-0000000f1${String(++seq).padStart(3, '0')}`
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, `first-line-task-${SID}`, 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
})

afterEach(async () => {
  bus.clear()
  resetCache()
  resetLineConsumption()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('the first mid-turn line of a fresh process', () => {
  it('written before the init, it is back in the queue when the process dies before running it', async () => {
    const p = freshProcess(SID)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    expect(p.writes.map((w) => w.message)).toEqual(['first question'])
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    p.crash()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual(['pending']))
  })

  it('written before the init, an init with msg_lifecycle_v1 keeps it until the CLI starts it', async () => {
    const p = freshProcess(SID)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    p.init(CAPS)
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    expect(p.session.reportsLineLifecycle).toBe(true)
    p.lifecycle(p.writes[0].uuid!, 'queued')
    p.lifecycle(p.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual([]))
  })

  it('written before the init, an init without the capability settles it by its write (an older CLI)', async () => {
    const p = freshProcess(SID)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    p.init()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual([]))
    // Settled: a later exit hands nothing back and writes nothing again.
    p.crash()
    await settle()
    expect(await statuses(SID)).toEqual([])
    expect(p.writes).toHaveLength(1)
  })

  it('written before the init, a command_lifecycle frame confirms it as tracked', async () => {
    const p = freshProcess(SID)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    p.lifecycle(p.writes[0].uuid!, 'queued')
    p.init()
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    p.crash()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual(['pending']))
  })

  it('written after an init with msg_lifecycle_v1, it is tracked from the first line', async () => {
    const p = freshProcess(SID, { initSeen: true })
    p.init(CAPS)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    p.crash()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual(['pending']))
  })

  it('written after an init without the capability, it follows the old rule at the write', async () => {
    const p = freshProcess(SID)
    p.init()
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual([]))
  })

  it('a replayed init without the capability does not settle a provisional line', async () => {
    const p = freshProcess(SID)
    await enqueueMessage(SID, 'first question')
    await p.internals.injectMidTurn(SID)
    Object.assign(p.session, { _isReplayedByOffset: () => true })
    p.init()
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    p.crash()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual(['pending']))
  })
})
