/**
 * The first line of a cold --resume, written behind a cut copy of it (r5 gate
 * N1, the whole chain). The gate showed it in two halves: start() resolved as a
 * plain start although the confirm resend was answered cut (probe PC), and the
 * runner's spawn callback then removed the batch at once (probe PC2). The CLI
 * exits on the cut copy, so the message was gone: the r4c gate's F1 loss, on
 * the path a resumed CLI most often takes (it reads no stdin until it booted,
 * so its first line waits on a full pipe).
 *
 * What's real: SessionRunner.processNext and its cold resume, ClaudeCodeSession
 * (send, the spawn callback, the exit path, writeMessage), RemoteSessionManager
 * (start, the deferred first line, confirmSend), the disk queue. Scripted: the
 * daemon connection (its replies and its exit event).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cold-resume-cut-hold'))

const h = vi.hoisted(() => ({ make: null as null | ((tmpId: string) => unknown) }))
vi.mock('../../src/providers/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/session-manager.js')>()),
  createSessionManager: (tmpId: string) => h.make!(tmpId),
  ensureLocalDaemon: async () => {},
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, getQueue, markProcessing, resetCache } from '../../src/core/session-message-queue.js'
import { markUnconfirmed, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000c02'

type Reply = Record<string, unknown> | Error

/** A daemon connection that answers from a script, per command, and can push events. */
function scriptedDaemon(replies: Record<string, Reply[]>) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const fallback: Record<string, Reply> = { stop: { ok: true, stopped: true }, status: { ok: true, exists: false } }
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1', 'owner-home-v1'].includes(c),
    onEvent: (fn: (event: Record<string, unknown>) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload })
      const next = replies[cmd]?.shift() ?? fallback[cmd] ?? { ok: true }
      if (next instanceof Error) throw next
      return next
    }),
  }
  return { conn, sent, emit: (event: Record<string, unknown>) => { for (const fn of listeners) fn(event) } }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status, lineUuid: m.lineUuid }))

let delivered: string[][] = []
let failed: string[][] = []
const settle = () => new Promise((r) => setTimeout(r, 80))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'resume-task', 'test', WALNUT_HOME, { initialProcessStatus: 'stopped' })
  delivered = []
  failed = []
  bus.subscribe('main-ai', (event) => {
    const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) delivered.push(ids)
    if (event.name === EventNames.SESSION_BATCH_FAILED) failed.push(ids)
  })
})

afterEach(async () => {
  h.make = null
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a cold --resume whose first line went in behind a cut copy (r5 gate N1)', () => {
  it('the batch is kept through the CLI\'s exit, not reported delivered, and the next process gets it once', async () => {
    // The first process: spawned, then the deferred first line's write died with the
    // daemon, and the confirm resend went in behind the piece it left (cut).
    const first = scriptedDaemon({
      start: [{ ok: true, pid: 4242, outputFile: '/nonexistent/cold-resume.jsonl', offset: 0 }],
      send: [new Error('connection closed'), { ok: true, cut: true }, { ok: false, reason: 'session_dead' }],
    })
    const second = scriptedDaemon({
      start: [{ ok: true, pid: 4343, outputFile: '/nonexistent/cold-resume.jsonl', offset: 0 }],
      send: [{ ok: true }],
    })
    const daemons = [first, second]
    h.make = (tmpId: string) => {
      const d = daemons.shift()!
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: d.conn, ensureConnected: async () => d.conn })
      return mgr
    }
    await enqueueMessage(SID, 'first message')
    const [row] = await getQueue(SID)
    const runner = new SessionRunner('/bin/true')
    const internals = runner as unknown as { processNext(sid: string): Promise<void> }

    await internals.processNext(SID)
    await vi.waitFor(() => expect(first.sent.filter((s) => s.cmd === 'send')).toHaveLength(2), { timeout: 10_000 })
    await new Promise((r) => setTimeout(r, 100))
    // Not removed by the spawn callback, and the user is not told "delivered".
    const held = await rows()
    expect(held.map((r) => r.status)).toEqual(['processing'])
    expect(delivered).toEqual([])
    const uuid = first.sent[1].payload.uuid as string
    expect(held[0].lineUuid).toBe(uuid)

    // The CLI reads the piece, cannot parse it, and exits: the line goes back, same uuid.
    first.emit({ ev: 'exit', sid: SID, code: 1, stderr: 'Error parsing streaming input line' })
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    expect((await rows())[0].lineUuid).toBe(uuid)

    // The next delivery finds the process gone and resumes a new one, which gets it once.
    await internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    const intoNext = second.sent.filter((s) => s.cmd === 'send')
    expect(intoNext).toHaveLength(1)
    expect(intoNext[0].payload).toMatchObject({ uuid, dedupe: true })
    expect(delivered).toEqual([[row.id]])
    runner.destroyAndKill()
  }, 30_000)

  it('control: a plain first line is removed at the spawn and reported delivered once', async () => {
    const only = scriptedDaemon({
      start: [{ ok: true, pid: 4444, outputFile: '/nonexistent/cold-resume.jsonl', offset: 0 }],
      send: [{ ok: true }],
    })
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: only.conn, ensureConnected: async () => only.conn })
      return mgr
    }
    await enqueueMessage(SID, 'plain message')
    const [row] = await getQueue(SID)
    const runner = new SessionRunner('/bin/true')
    await (runner as unknown as { processNext(sid: string): Promise<void> }).processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    expect(delivered).toEqual([[row.id]])
    runner.destroyAndKill()
  }, 30_000)
})

type Internals = {
  sessions: Map<string, ClaudeCodeSession>
  activeProcessing: Set<string>
  processNext(sid: string): Promise<void>
  settleResumeSuccess(sid: string, s: ClaudeCodeSession, m: unknown[], first?: object): void
}

/** A cold resume whose deferred first line the daemon answers with a fate it already knew (nothing written). */
async function resumeWithFate(fate: Record<string, unknown>, before?: (rowId: string) => void) {
  const only = scriptedDaemon({
    start: [{ ok: true, pid: 4545, outputFile: '/nonexistent/cold-resume.jsonl', offset: 0 }],
    send: [{ ok: true, duplicate: true, ...fate }],
  })
  h.make = (tmpId: string) => {
    const mgr = new RemoteSessionManager(tmpId, '__local__', null)
    Object.assign(mgr as unknown as Record<string, unknown>, { conn: only.conn, ensureConnected: async () => only.conn })
    return mgr
  }
  await enqueueMessage(SID, 'first message')
  const [row] = await getQueue(SID)
  before?.(row.id)
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as Internals
  await internals.processNext(SID)
  const session = () => [...internals.sessions.values()].find((s) => s.claudeSessionId === SID)
  return { row, runner, internals, session, only }
}

describe('a cold --resume whose first line the daemon already settled, so nothing is written', () => {
  it('ran: reported delivered once, also for a row the user was told was unconfirmed (r6 gate L2, probe PD2)', async () => {
    const { row, runner, only } = await resumeWithFate({ fate: 'ran', state: 'completed' }, (id) => markUnconfirmed(SID, [id]))
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    await settle()
    expect(only.sent.filter((s) => s.cmd === 'send')).toHaveLength(1)
    expect(delivered).toEqual([[row.id]])
    runner.destroyAndKill()
  }, 30_000)

  it('ran: no turn runs, so the turn is not awaited and the session waits idle (r6 gate L4, probe PI)', async () => {
    const { runner, internals, session } = await resumeWithFate({ fate: 'ran', state: 'completed' })
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    expect(internals.activeProcessing.has(SID)).toBe(false)
    expect(session()?.processStatus).toBe('idle')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.process_status).toBe('idle'))
    runner.destroyAndKill()
  }, 30_000)

  it('cancelled by a Stop: the text goes back to the composer, never reported delivered', async () => {
    const cancelled: string[][] = []
    bus.subscribe('web-ui', (event) => {
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
    })
    const { row, runner, session } = await resumeWithFate({ fate: 'cancelled', state: 'cancelled' })
    await vi.waitFor(() => expect(cancelled).toEqual([[row.id]]), { timeout: 10_000 })
    expect(await rows()).toEqual([])
    expect(delivered).toEqual([])
    expect(session()?.processStatus).toBe('idle')
    runner.destroyAndKill()
  }, 30_000)

  it('dropped by the CLI: parked and the user told, never reported delivered', async () => {
    const { row, runner } = await resumeWithFate({ fate: 'dropped', state: 'discarded' })
    await vi.waitFor(() => expect(failed).toEqual([[row.id]]), { timeout: 10_000 })
    expect((await rows()).map((r) => r.status)).toEqual(['parked'])
    expect(delivered).toEqual([])
    runner.destroyAndKill()
  }, 30_000)
})

describe('the cut first line of a process that ended before start() answered (r6 gate L3)', () => {
  it('goes back to pending at once, never reported delivered', async () => {
    await enqueueMessage(SID, 'first line, cut')
    const batch = await markProcessing(SID)
    const runner = new SessionRunner('/bin/true')
    const session = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    Object.assign(session, { claudeSessionId: SID, pid: 4747 })
    const endsBefore = session.processEndCount
    // The process exits while its first line's answer is still being asked for.
    session.reclaimUntakenLines('exit')
    ;(runner as unknown as Internals).settleResumeSuccess(SID, session, batch, { lineUuid: batch[0].lineUuid, line: { cut: true }, endsBefore })
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    expect((await getQueue(SID))[0].lineUuid).toBe(batch[0].lineUuid)
    expect(delivered).toEqual([])
    runner.destroyAndKill()
  })
})
