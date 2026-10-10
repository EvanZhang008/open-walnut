/**
 * r6 gate M1: a line handed to the transport while the line before it is still
 * being confirmed (the daemon died inside its write, and
 * RemoteSessionManager.confirmSend asks again). The confirm comes back cut, so the
 * process holds a cut copy at the head of its pipe and exits on it without reading
 * the next line. The next line's fate is decided only once its own write has its
 * answer, and so after the line before it has its own: it is kept for that
 * process, reaches the next one, and the user is told "delivered" once, when it
 * does. The gate's probe PG2 lost it: it was removed on its write and reported
 * delivered.
 *
 * What's real: SessionRunner (processNext, injectMidTurn), ClaudeCodeSession, the
 * RemoteSessionManager write chain and confirmSend, the disk queue. Scripted: the
 * daemon connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-cut-concurrent'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000c03'

type Reply = Record<string, unknown> | Error
type Internals = {
  sessions: Map<string, ClaudeCodeSession>
  activeProcessing: Set<string>
  processNext(sid: string): Promise<void>
  injectMidTurn(sid: string): Promise<void>
}

let delivered: string[][] = []
let held: string[][] = []
const settle = () => new Promise((r) => setTimeout(r, 80))
const rows = async () => (await getQueue(SID)).map((m) => ({ text: m.message, status: m.status }))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'concurrent-task', 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
  delivered = []
  held = []
  bus.subscribe('main-ai', (event) => {
    const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) delivered.push(ids)
    if (event.name === EventNames.SESSION_DELIVERY_HELD) held.push(ids)
  })
})

afterEach(async () => {
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

/** A live session on a real RemoteSessionManager whose daemon answers each send from `plan` (ok when it runs out). */
function liveSession(opts: { tracked: boolean }) {
  const sends: Array<{ pid: number | null; message: string; uuid?: string }> = []
  const plan: Array<() => Promise<Reply>> = []
  const session = new ClaudeCodeSession('concurrent-task', 'test', '/bin/true')
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1'].includes(c),
    onEvent: () => () => {},
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      if (cmd !== 'send') return { ok: true }
      sends.push({ pid: (session as unknown as { pid: number | null }).pid, message: String(payload.message), uuid: payload.uuid as string | undefined })
      const step = plan.shift()
      const reply = step ? await step() : { ok: true }
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
  const mgr = new RemoteSessionManager(SID, '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn, _sid: SID, _hasPipe: true, _pid: 12345 })
  Object.assign(session, {
    claudeSessionId: SID, _transport: mgr, _processStatus: 'idle', _active: true, pid: 12345,
    resultEmitted: true, _turnResultEmitted: true, _sawCommandLifecycle: opts.tracked,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as Internals
  internals.sessions.set('concurrent-task', session)
  /** Claude Code exits 1 on the cut copy it cannot parse. */
  const cliExits = () => (session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
    .handleRemoteProcessExit(1, 'Error parsing streaming input line')
  /** The next process, resumed: alive, idle, its own pid. */
  const respawn = (pid: number) => {
    Object.assign(session, { _processStatus: 'idle', _active: true, pid, resultEmitted: true, _turnResultEmitted: true })
    Object.assign(mgr as unknown as Record<string, unknown>, { _hasPipe: true, _pid: pid })
  }
  /** The CLI's own word on a line (command_lifecycle). */
  const lifecycle = (uuid: string, state: string) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state }))
  return { runner, internals, sends, plan, cliExits, respawn, lifecycle }
}

/**
 * The first line's write dies with the daemon, and its confirm is answered cut.
 * The second line is handed over either while that confirm is still out
 * (`during`) or after its answer.
 */
async function secondLineAroundACut(opts: { tracked: boolean; during: boolean }) {
  const l = liveSession(opts)
  let answerConfirm!: (r: Reply) => void
  l.plan.push(async () => new Error('connection closed'))
  l.plan.push(() => new Promise<Reply>((resolve) => { answerConfirm = resolve }))
  await enqueueMessage(SID, 'first message')
  const first = l.internals.processNext(SID)
  await vi.waitFor(() => expect(l.sends).toHaveLength(2), { timeout: 10_000 })
  let second: Promise<void>
  if (opts.during) {
    // The runner is mid-delivery, so a new message goes the mid-turn way.
    expect(l.internals.activeProcessing.has(SID)).toBe(true)
    await enqueueMessage(SID, 'second message')
    second = l.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
    answerConfirm({ ok: true, cut: true })
  } else {
    answerConfirm({ ok: true, cut: true })
    await first
    await settle()
    await enqueueMessage(SID, 'second message')
    second = l.internals.injectMidTurn(SID)
  }
  await first
  await second
  await settle()
  const [rowA, rowB] = await getQueue(SID)
  const beforeExit = { rows: await rows(), delivered: [...delivered] }
  l.cliExits()
  await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending', 'pending']), { timeout: 10_000 })
  l.respawn(12346)
  await l.internals.processNext(SID)
  await vi.waitFor(() => expect(l.sends.filter((s) => s.pid === 12346)).toHaveLength(2), { timeout: 10_000 })
  await settle()
  return { l, rowA, rowB, beforeExit }
}

describe('a line handed over while the line before it is confirmed, then answered cut (r6 gate M1)', () => {
  it('untracked (probe PG2): kept through the exit, delivered once to the next process, after the first', async () => {
    const { l, rowA, rowB, beforeExit } = await secondLineAroundACut({ tracked: false, during: true })
    // Both went into the process that holds the cut copy, and neither left on its write.
    expect(l.sends.filter((s) => s.pid === 12345).map((s) => s.message)).toEqual(['first message', 'first message', 'second message'])
    expect(beforeExit.rows.map((r) => r.status)).toEqual(['processing', 'processing'])
    expect(beforeExit.delivered).toEqual([])
    expect(l.sends.filter((s) => s.pid === 12346).map((s) => s.message)).toEqual(['first message', 'second message'])
    expect(delivered).toEqual([[rowA.id], [rowB.id]])
    l.runner.destroyAndKill()
  }, 30_000)

  it('tracked: not reported at its write; delivered once, when the next process gets it', async () => {
    const { l, rowA, rowB, beforeExit } = await secondLineAroundACut({ tracked: true, during: true })
    expect(beforeExit.rows.map((r) => r.status)).toEqual(['processing', 'processing'])
    expect(beforeExit.delivered).toEqual([])
    expect(l.sends.filter((s) => s.pid === 12346).map((s) => s.message)).toEqual(['first message', 'second message'])
    expect(delivered).toEqual([[rowA.id], [rowB.id]])
    l.runner.destroyAndKill()
  }, 30_000)

  it('control (probe PG2c): the second line handed over after the cut answer ends the same way', async () => {
    const { l, rowA, rowB, beforeExit } = await secondLineAroundACut({ tracked: false, during: false })
    expect(beforeExit.rows.map((r) => r.status)).toEqual(['processing', 'processing'])
    expect(beforeExit.delivered).toEqual([])
    expect(l.sends.filter((s) => s.pid === 12346).map((s) => s.message)).toEqual(['first message', 'second message'])
    expect(delivered).toEqual([[rowA.id], [rowB.id]])
    l.runner.destroyAndKill()
  }, 30_000)
})

describe('a line that waited behind an unanswered one while the CLI showed it reports its queue (r6 gate M1, the rule)', () => {
  it('its rows wait for the CLI\'s word, so a crash before the CLI takes it hands it to the next process', async () => {
    const l = liveSession({ tracked: false })
    let answerConfirm!: (r: Reply) => void
    l.plan.push(async () => new Error('connection closed'))
    l.plan.push(() => new Promise<Reply>((resolve) => { answerConfirm = resolve }))
    await enqueueMessage(SID, 'first message')
    const first = l.internals.processNext(SID)
    await vi.waitFor(() => expect(l.sends).toHaveLength(2), { timeout: 10_000 })
    await enqueueMessage(SID, 'second message')
    const second = l.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
    // The CLI takes the first line and names it: the first frame of its queue reports.
    l.lifecycle(l.sends[0].uuid!, 'started')
    answerConfirm({ ok: true })
    await first
    await second
    await settle()
    expect(l.sends.filter((s) => s.pid === 12345).map((s) => s.message)).toEqual(['first message', 'first message', 'second message'])
    // The first line ran; the second waits for the CLI's word on it.
    expect((await rows()).map((r) => `${r.text}:${r.status}`)).toEqual(['second message:processing'])
    l.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']), { timeout: 10_000 })
    l.respawn(12346)
    await l.internals.processNext(SID)
    await vi.waitFor(() => expect(l.sends.filter((s) => s.pid === 12346)).toHaveLength(1), { timeout: 10_000 })
    expect(l.sends.filter((s) => s.pid === 12346).map((s) => s.message)).toEqual(['second message'])
    l.runner.destroyAndKill()
  }, 30_000)
})
