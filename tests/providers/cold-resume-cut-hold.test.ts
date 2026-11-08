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

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { closeDb as closeTaskDb } from '../../src/core/task-db.js'
import { addTasksBulk, _resetForTesting as resetTaskStore } from '../../src/core/task-manager.js'
import { ClaudeCodeSession, SessionRunner, sessionRunner } from '../../src/providers/claude-code-session.js'
import { retrySession } from '../../src/core/sessions/session-lifecycle.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, getQueue, loadQueue, markProcessing, resetCache } from '../../src/core/session-message-queue.js'
import { awaitLine, lineRows, markUnconfirmed, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { readQueueFileFresh } from '../../src/core/session-queue-store.js'
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
  return { conn, sent, listenerCount: () => listeners.size, emit: (event: Record<string, unknown>) => { for (const fn of listeners) fn(event) } }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status, lineUuid: m.lineUuid }))
const diskRows = async () => (JSON.parse(await fs.readFile(SESSION_QUEUE_FILE, 'utf8')).queues[SID] ?? [])

/** Hold the real atomic queue replacement, not a mocked removeTaken result. */
function holdQueueDeletion() {
  let release!: () => void
  let entered!: () => void
  let done!: () => void
  const held = new Promise<void>((r) => { release = r })
  const started = new Promise<void>((r) => { entered = r })
  const settled = new Promise<void>((r) => { done = r })
  const rename = fs.rename.bind(fs)
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === SESSION_QUEUE_FILE && !(JSON.parse(await fs.readFile(from, 'utf8')).queues[SID]?.length)) {
      entered()
      await held
      try { await rename(from, to) } finally { done() }
      return
    }
    return rename(from, to)
  })
  return { started, settled, release, spy }
}

let delivered: string[][] = []
let failed: string[][] = []
/** A short wait before a check that something did NOT happen (no second send, no park before its 2 s settle). */
const settle = () => new Promise((r) => setTimeout(r, 80))

beforeEach(async () => {
  closeDb()
  closeTaskDb()
  resetTaskStore()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  // The launch gate reads the record's task, so the task must exist.
  const now = new Date().toISOString()
  await addTasksBulk([
    {
      id: 'resume-task', title: 'Line test task', status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none',
      project: 'testproject', source: 'local', session_ids: [], created_at: now, updated_at: now,
      description: '', summary: '', note: '',
    },
  ])
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
  closeTaskDb()
  resetTaskStore()
  _resetSessionTrackerForTesting()
  const { unregisterSessionManager } = await import('../../src/providers/session-manager.js')
  unregisterSessionManager(SID)
  vi.restoreAllMocks()
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
    // A short wait for something that must NOT happen: the spawn callback removing the batch.
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

    // The next delivery finds the process gone and resumes a new one, which gets it once:
    // its rows leave the queue once that process shows it read them (its init).
    await internals.processNext(SID)
    await vi.waitFor(() => expect(second.sent.filter((s) => s.cmd === 'send')).toHaveLength(1), { timeout: 10_000 })
    second.emit(initLine())
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    const intoNext = second.sent.filter((s) => s.cmd === 'send')
    expect(intoNext).toHaveLength(1)
    expect(intoNext[0].payload).toMatchObject({ uuid, dedupe: true })
    expect(delivered).toEqual([[row.id]])
    runner.destroyAndKill()
  }, 30_000)

  it('control: a plain first line is reported delivered at the spawn, and leaves the queue at the CLI\'s init', async () => {
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
    await vi.waitFor(() => expect(delivered).toEqual([[row.id]]), { timeout: 10_000 })
    // Kept until the resumed process shows it read the line: a CLI that cannot load
    // the session exits before its init, and the line must outlive it.
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    only.emit(initLine())
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    expect(delivered).toEqual([[row.id]])
    runner.destroyAndKill()
  }, 30_000)
})

describe('a cold --resume whose process ends before its init', () => {
  const resume = async () => {
    const only = scriptedDaemon({
      start: [{ ok: true, pid: 4646, outputFile: '/nonexistent/cold-resume.jsonl', offset: 0 }],
      send: [{ ok: true }],
    })
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: only.conn, ensureConnected: async () => only.conn })
      return mgr
    }
    await enqueueMessage(SID, 'the decision')
    const runner = new SessionRunner('/bin/true')
    await (runner as unknown as { processNext(sid: string): Promise<void> }).processNext(SID)
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 10_000 })
    return { only, runner }
  }

  it('it never read the line: parked with the CLI\'s words once its last lines had time to land', async () => {
    const { only, runner } = await resume()
    only.emit({ ev: 'exit', sid: SID, code: 1, stderr: 'Error: could not load the conversation' })
    // Not at once: the daemon's exit can overtake the process's last stream lines.
    await settle()
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 10_000 })
    expect((await getQueue(SID))[0].parkedReason).toMatch(/^Not delivered: Claude Code exited with code 1 while resuming this session.*could not load the conversation/)
    runner.destroyAndKill()
  }, 30_000)

  it('its init lands just after the exit event: the line ran, and it leaves the queue', async () => {
    const { only, runner } = await resume()
    only.emit({ ev: 'exit', sid: SID, code: 1, stderr: 'boom' })
    only.emit(initLine())
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    // A wait for something that must NOT happen: past the exit's 2 s settle
    // (RESUME_LINE_SETTLE_MS), the parked-line timer finds nothing to park.
    await new Promise((r) => setTimeout(r, 2_500))
    expect(await rows()).toEqual([])
    runner.destroyAndKill()
  }, 30_000)
})

/** The resumed CLI's system/init, as the daemon streams it (it prints it once it took the line). */
function initLine(): Record<string, unknown> {
  return { ev: 'jsonl', sid: SID, line: JSON.stringify({ type: 'system', subtype: 'init', session_id: SID, cwd: WALNUT_HOME, tools: [], model: 'test' }) }
}

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
    // The row's removal (removeTaken, a locked queue write) and the composer event (a
    // setTimeout 0) are not ordered: wait for the queue's final state, not the event's.
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    expect(delivered).toEqual([])
    expect(session()?.processStatus).toBe('idle')
    runner.destroyAndKill()
  }, 30_000)

  it('cancelled by a Stop: durable deletion finishes before the composer event, including the cached queue', async () => {
    const cancelled: string[][] = []
    const queueAtEvent: Array<Promise<{ cache: unknown[]; disk: unknown[] }>> = []
    bus.subscribe('web-ui', (event) => {
      if (event.name !== EventNames.SESSION_QUEUED_CANCELLED) return
      cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
      queueAtEvent.push(Promise.all([rows(), diskRows()]).then(([cache, disk]) => ({ cache, disk })))
    })
    let gate: ReturnType<typeof holdQueueDeletion> | undefined
    const { row, runner } = await resumeWithFate({ fate: 'cancelled', state: 'cancelled' }, () => { gate = holdQueueDeletion() })
    try {
      await gate!.started
      // A real timer turn has passed while the real queue rename is blocked.
      await settle()
      expect((await rows()).map((r) => r.status)).toEqual(['processing'])
      expect((await diskRows()).map((r: { status: string }) => r.status)).toEqual(['processing'])
      expect(cancelled, 'composer cancellation must not overtake durable queue deletion').toEqual([])
      gate!.release()
      await gate!.settled
      await vi.waitFor(() => expect(cancelled).toEqual([[row.id]]))
      expect(await Promise.all(queueAtEvent)).toEqual([{ cache: [], disk: [] }])
      expect(await rows()).toEqual([])
      expect(await diskRows()).toEqual([])
      expect(delivered).toEqual([])
      await settle()
      expect(cancelled).toEqual([[row.id]])
    } finally {
      gate!.release()
      await gate!.settled
      gate!.spy.mockRestore()
      runner.destroyAndKill()
    }
  }, 30_000)

  it('dropped by the CLI: parked and the user told, never reported delivered', async () => {
    const { row, runner } = await resumeWithFate({ fate: 'dropped', state: 'discarded' })
    await vi.waitFor(() => expect(failed).toEqual([[row.id]]), { timeout: 10_000 })
    expect((await rows()).map((r) => r.status)).toEqual(['parked'])
    expect(delivered).toEqual([])
    runner.destroyAndKill()
  }, 30_000)
})

type CancelInternals = {
  _queuedLines: Map<string, Array<{ message: string; messageId: string }>>
  _cancelReturnsInFlight: Map<string, Promise<boolean>>
  returnCancelledLines(uuids: unknown[]): Promise<boolean>
  settleLineFate(uuid: string, rows: Awaited<ReturnType<typeof getQueue>>, markers: Array<{ message: string; messageId: string }>, known: { fate: string }): void
  releaseLineRows(rows: Awaited<ReturnType<typeof getQueue>>, why: string): Promise<boolean>
}

async function cancellationHarness(phoneIds = false) {
  await enqueueMessage(SID, 'first follow-up', phoneIds ? { id: 'qm-mobile-cancel-recovery-one' } : undefined)
  await enqueueMessage(SID, 'second follow-up', phoneIds ? { id: 'qm-mobile-cancel-recovery-two' } : undefined)
  const batch = await markProcessing(SID)
  const uuid = batch[0].lineUuid!
  const markers = batch.map((r) => ({ message: r.message, messageId: r.id }))
  const session = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
  Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true })
  const inner = session as unknown as CancelInternals
  inner._queuedLines.set(uuid, markers)
  awaitLine(SID, uuid, batch)
  const cancelled: string[][] = []
  bus.subscribe('web-ui', (event) => {
    if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
  })
  return { session, inner, batch, uuid, markers, cancelled }
}

function failQueueDeletion() {
  const rename = fs.rename.bind(fs)
  let deletionFailures = 0
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fs.readFile(from, 'utf8')).queues[SID]?.length) {
      deletionFailures++
      throw new Error('injected queue replacement failure')
    }
    return rename(from, to)
  })
  return { spy, failures: () => deletionFailures, mockRestore: () => spy.mockRestore() }
}

describe('every cancellation return waits for durable deletion', () => {
  for (const path of ['daemon fate', 'lifecycle and receipt', 'hard Stop'] as const) {
    it(`${path}: concurrent cancellation waits for deletion and returns a multi-row line once`, async () => {
      const h = await cancellationHarness()
      // Exercise hard Stop's untaken-lines branch, not its lifecycle-markers branch.
      if (path === 'hard Stop') h.inner._queuedLines.clear()
      const gate = holdQueueDeletion()
      const cancel = () => path === 'daemon fate'
        ? h.inner.settleLineFate(h.uuid, h.batch, h.markers, { fate: 'cancelled' })
        : path === 'lifecycle and receipt' ? h.inner.returnCancelledLines([h.uuid, h.uuid]) : h.session.stopProcess()
      try {
        const first = cancel()
        await gate.started
        const second = cancel()
        await settle()
        expect(h.cancelled).toEqual([])
        expect(await getQueue(SID)).toEqual(h.batch)
        expect((await readQueueFileFresh()).queues[SID]).toEqual(h.batch)
        gate.release()
        await Promise.all([first, second, gate.settled])
        await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
        expect(await rows()).toEqual([])
        expect(await diskRows()).toEqual([])
        expect(lineRows(SID, h.uuid)).toEqual([])
        expect(h.inner._queuedLines.has(h.uuid)).toBe(false)
        h.inner.returnCancelledLines([h.uuid])
        await settle()
        expect(h.cancelled).toHaveLength(1)
        expect(delivered).toEqual([])
      } finally {
        gate.release()
        await gate.settled
        gate.spy.mockRestore()
      }
    })

    it(`${path}: a real write failure keeps disk, cache and registration, and the same cancellation can recover`, async () => {
      const h = await cancellationHarness()
      if (path === 'hard Stop') h.inner._queuedLines.clear()
      const fault = failQueueDeletion()
      const cancel = () => path === 'daemon fate'
        ? h.inner.settleLineFate(h.uuid, h.batch, h.markers, { fate: 'cancelled' })
        : path === 'lifecycle and receipt' ? h.inner.returnCancelledLines([h.uuid]) : h.session.stopProcess()
      try {
        await cancel()
        await vi.waitFor(() => expect(fault!.failures()).toBe(1))
        await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
        await settle()
        expect(h.cancelled).toEqual([])
        expect(await getQueue(SID)).toEqual(h.batch)
        expect((await readQueueFileFresh()).queues[SID]).toEqual(h.batch)
        expect(lineRows(SID, h.uuid)).toEqual(h.batch)
        expect(h.inner._queuedLines.get(h.uuid)).toBe(path === 'hard Stop' ? undefined : h.markers)
        fault.mockRestore()
        await cancel()
        await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
        expect(await rows()).toEqual([])
        expect(await diskRows()).toEqual([])
        expect(delivered).toEqual([])
      } finally { fault.mockRestore() }
    })
  }

  it('a rebuilt instance after boot keeps the stopped line uuid, asks its durable daemon fate and returns cancellation without another write', async () => {
    const stopped = await cancellationHarness()
    const fault = failQueueDeletion()
    await stopped.session.stopProcess()
    expect(fault.failures()).toBe(1)
    expect(await getQueue(SID)).toEqual(stopped.batch)
    fault.mockRestore()
    // The old in-memory registrations are gone; boot uses the existing queue reset.
    resetLineConsumption()
    resetCache()
    await loadQueue()
    expect((await getQueue(SID)).map((r) => [r.status, r.lineUuid])).toEqual(stopped.batch.map((r) => ['pending', r.lineUuid]))
    const daemon = scriptedDaemon({
      start: [{ ok: true, pid: 4848, outputFile: '/nonexistent/rebuilt-cancelled.jsonl', offset: 0 }],
      send: [{ ok: true, duplicate: true, fate: 'cancelled', state: 'cancelled' }],
    })
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: daemon.conn, ensureConnected: async () => daemon.conn })
      return mgr
    }
    const runner = new SessionRunner('/bin/true')
    try {
      await (runner as unknown as Internals).processNext(SID)
      await vi.waitFor(() => expect(stopped.cancelled).toEqual([stopped.batch.map((r) => r.id)]))
      expect(await rows()).toEqual([])
      expect(await diskRows()).toEqual([])
      const sends = daemon.sent.filter((s) => s.cmd === 'send')
      expect(sends).toHaveLength(1)
      expect(sends[0].payload).toMatchObject({ uuid: stopped.uuid, dedupe: true })
      // The scripted daemon returned the existing fate without writing a CLI line.
      expect(delivered).toEqual([])
      await (runner as unknown as Internals).processNext(SID)
      expect(daemon.sent.filter((s) => s.cmd === 'send')).toHaveLength(1)
      expect(stopped.cancelled).toHaveLength(1)
    } finally { runner.destroyAndKill() }
  })

  it.each(['started', 'completed'])('a fresh CCS restores a durable cancelled snapshot from a read-only %s fate without spawning or writing', async (state) => {
    const stopped = await cancellationHarness()
    const { removeTaken, settledLineUuid } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    await loadQueue()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    const query = vi.fn(async () => ({ fate: 'ran', state, answer: state === 'started' ? 'pending' : 'yes' } as const))
    const writes = vi.fn(async () => true)
    const spawn = vi.fn(async () => { throw new Error('must not spawn for cancelled recovery') })
    Object.assign(fresh, { claudeSessionId: SID, _transport: { readLineFate: query, judgesAnswers: true, writeMessage: writes, start: spawn, stopTail: vi.fn(), hasPipe: true, fileSize: 0 } })
    expect(await fresh.recoverCancelledRows()).toBe(true)
    expect(query).toHaveBeenCalledWith(stopped.uuid, stopped.batch.map((r) => r.id))
    if (state === 'started') {
      expect(await getQueue(SID)).toEqual(stopped.batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(stopped.batch)
      expect(await settledLineUuid(stopped.batch[0].id)).toBeUndefined()
      ;(fresh as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    } else expect(await getQueue(SID)).toEqual([])
    expect(await settledLineUuid(stopped.batch[0].id)).toBe(stopped.uuid)
    expect(stopped.cancelled).toEqual([])
    expect(writes).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a fresh CCS keeps a cancelled snapshot on read-only repair failure and real Retry returns 503 until persistence works', async () => {
    const stopped = await cancellationHarness()
    const { removeTaken } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    await loadQueue()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    const query = vi.fn(async () => ({ fate: 'ran', state: 'started', answer: 'pending' } as const))
    const writes = vi.fn(async () => true)
    Object.assign(fresh, { claudeSessionId: SID, _processStatus: 'stopped', _transport: { readLineFate: query, judgesAnswers: true, writeMessage: writes, stopTail: vi.fn(), hasPipe: true, fileSize: 0 } })
    const rename = fs.rename.bind(fs)
    const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected fresh CCS durable repair failure')
      return rename(from, to)
    })
    const liveness = await import('../../src/utils/session-liveness.js')
    vi.spyOn(liveness, 'isSessionProcessAlive').mockResolvedValue(false)
    const files = await import('../../src/core/session-file-reader.js')
    vi.spyOn(files, 'findLocalJsonlPath').mockResolvedValue('/fake/recovered-cancel.jsonl')
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? fresh : undefined)
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await updateSessionRecord(SID, { process_status: 'stopped' })
    try {
      expect(await fresh.recoverCancelledRows()).toBe(false)
      expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      fault.mockRestore()
      await fresh.retryCancelledLines()
      expect(await getQueue(SID)).toEqual(stopped.batch)
      expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]).toBeUndefined()
      expect(writes).not.toHaveBeenCalled()
      expect(stopped.cancelled).toEqual([])
    } finally { fault.mockRestore() }
  })

  it('offline and old transports retain terminal cancelled evidence without a query, send or active cancellation gate', async () => {
    const stopped = await cancellationHarness()
    const { removeTaken } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    Object.assign(fresh, { claudeSessionId: SID, _transport: { stopTail: vi.fn(), hasPipe: false, fileSize: 0 } })
    expect(await fresh.recoverCancelledRows()).toBe(true)
    expect((fresh as unknown as { _pendingCancellations: Map<string, unknown> })._pendingCancellations.size).toBe(0)
    expect(await getQueue(SID)).toEqual([])
    expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
    // The durable backup is the cancellation's own confirmation: a missing fate reader cannot undo it.
    expect(await fresh.retryCancelledLines()).toBe(true)
    expect(await getQueue(SID)).toEqual([])
    expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
    expect(stopped.cancelled).toEqual([])
  })

  it.each(['started', 'completed'])('read-only cancelled recovery preserves a new UUID row with the same id after old %s fate', async (state) => {
    const stopped = await cancellationHarness()
    const { removeTaken } = await import('../../src/core/session-message-queue.js')
    const { mutateStore } = await import('../../src/core/session-queue-store.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    const replacement = stopped.batch.map((r) => ({ ...r, lineUuid: '55555555-5555-4555-8555-555555555555', message: 'new UUID delivery' }))
    await mutateStore((s) => { s.queues[SID] = replacement }, true, true)
    resetLineConsumption()
    resetCache()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    Object.assign(fresh, { claudeSessionId: SID, _transport: { readLineFate: async () => ({ fate: 'ran', state, answer: state === 'started' ? 'pending' : 'yes' }), judgesAnswers: true, stopTail: vi.fn(), hasPipe: false, fileSize: 0 } })
    await fresh.recoverCancelledRows()
    if (state === 'started') {
      ;(fresh as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }))
      await settle()
    }
    expect(await getQueue(SID)).toEqual(replacement)
    expect((await readQueueFileFresh()).queues[SID]).toEqual(replacement)
  })

  it.each([true, false])('no-wrapper started recovery attaches only with a live proof (%s) and never spawns or writes a FIFO line', async (alive) => {
    const stopped = await cancellationHarness(true)
    const { removeTaken, settledLineUuid } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    await loadQueue()
    const daemon = scriptedDaemon({
      'line.fate': [{ ok: true, fate: 'ran', state: 'started', answer: 'pending' }, { ok: true, fate: 'ran', state: 'started', answer: 'pending' }],
      attach: [{ ok: true, alive: true, pid: 4848, currentOffset: 0 }],
    })
    daemon.conn.hasCapability = (c) => ['line-fate-read-v1', 'line-answer-v1', 'send-markers-v1', 'send-dedupe-v1', 'owner-home-v1'].includes(c)
    const connection = await import('../../src/providers/daemon-connection.js')
    vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(daemon.conn as never)
    const probe = vi.spyOn(connection, 'probeDaemonSession').mockResolvedValue({ alive, pid: alive ? 4848 : undefined })
    const files = await import('../../src/core/daemon-file-reader.js')
    vi.spyOn(files.DaemonFileReader.prototype, 'readCostState').mockResolvedValue(null)
    const reconcile = await import('../../src/core/session-reconcile.js')
    vi.spyOn(reconcile, 'fetchStreamTailFold').mockResolvedValue('unavailable')
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr, { conn: daemon.conn, ensureConnected: async () => daemon.conn })
      return mgr
    }
    const runner = new SessionRunner('/bin/true')
    const attach = vi.spyOn(ClaudeCodeSession, 'attachToExisting')
    try {
      expect(await runner.recoverCancelledForSession(SID, true)).toBe(alive)
      expect(probe).toHaveBeenCalledWith('__local__', SID)
      if (alive) {
        expect(attach).toHaveBeenCalledOnce()
        expect(attach.mock.calls[0][0]).toMatchObject({ claudeSessionId: SID, pid: 4848 })
        expect(runner.findSessionByClaudeId(SID)).toBeDefined()
        expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineUuid])).toEqual(stopped.batch.map((r) => [r.id, 'processing', stopped.uuid]))
        expect((await readQueueFileFresh()).relay?.[stopped.batch[0].id]?.[0]).toBe('taken')
        expect(delivered).toEqual([])
        daemon.emit({ ev: 'jsonl', sid: SID, line: JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }) })
        await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
        expect(await settledLineUuid(stopped.batch[0].id)).toBe(stopped.uuid)
      } else {
        expect(attach).not.toHaveBeenCalled()
        expect(await getQueue(SID)).toEqual([])
        expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
        vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockReturnValue(undefined)
        vi.spyOn(sessionRunner, 'recoverCancelledForSession').mockImplementation((sid, required) => runner.recoverCancelledForSession(sid, required))
        await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
        expect(attach).not.toHaveBeenCalled()
        expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
      }
      expect(daemon.sent.filter((s) => s.cmd === 'start' || s.cmd === 'send')).toEqual([])
      expect(stopped.cancelled).toEqual([])
      // The actual completion retains the original delivery-report contract.
      expect(delivered).toEqual(alive ? [stopped.batch.map((r) => r.id)] : [])
    } finally { runner.destroyAndKill() }
  })

  it.each(['dead', 'failed', 'replaced'])('a live probe followed by an attach that is %s retains the backup and returns Retry failure without spawning', async (outcome) => {
    const stopped = await cancellationHarness(true)
    const { removeTaken } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    const daemon = scriptedDaemon({
      'line.fate': Array.from({ length: 4 }, () => ({ ok: true, fate: 'ran', state: 'started', answer: 'pending' })),
      attach: outcome !== 'failed' ? [{ ok: true, alive: false, pid: 4848 }] : [new Error('injected attach failure')],
    })
    daemon.conn.hasCapability = (c) => ['line-fate-read-v1', 'line-answer-v1', 'owner-home-v1'].includes(c)
    const connection = await import('../../src/providers/daemon-connection.js')
    vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(daemon.conn as never)
    vi.spyOn(connection, 'probeDaemonSession').mockResolvedValue({ alive: true, pid: 4848 })
    const files = await import('../../src/core/daemon-file-reader.js')
    vi.spyOn(files.DaemonFileReader.prototype, 'readCostState').mockResolvedValue(null)
    const reconcile = await import('../../src/core/session-reconcile.js')
    vi.spyOn(reconcile, 'fetchStreamTailFold').mockResolvedValue('unavailable')
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr, { conn: daemon.conn, ensureConnected: async () => daemon.conn })
      return mgr
    }
    const runner = new SessionRunner('/bin/true')
    const { getRegisteredSessionManager, registerSessionManager } = await import('../../src/providers/session-manager.js')
    const successor = { detach: vi.fn() } as never
    if (outcome === 'replaced') {
      const attach = ClaudeCodeSession.attachToExisting.bind(ClaudeCodeSession)
      vi.spyOn(ClaudeCodeSession, 'attachToExisting').mockImplementation(async (...args) => {
        const candidate = await attach(...args)
        registerSessionManager(SID, successor)
        return candidate
      })
    }
    try {
      expect(await runner.recoverCancelledForSession(SID, true)).toBe(false)
      expect(runner.findSessionByClaudeId(SID)).toBeUndefined()
      expect(getRegisteredSessionManager(SID)).toBe(outcome === 'replaced' ? successor : undefined)
      expect(await getQueue(SID)).toEqual([])
      expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
      expect(daemon.sent.filter((s) => ['start', 'send', 'stop'].includes(s.cmd))).toEqual([])
      expect(stopped.cancelled).toEqual([])
      expect(delivered).toEqual([])
    } finally { runner.destroyAndKill() }
  })

  it.each([false, true])('a cold known cancellation with no registry holds its late started line through completion (empty duplicate receipt=%s)', async (duplicate) => {
    const stopped = await cancellationHarness(true)
    resetLineConsumption()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    const writes = vi.fn(async () => true)
    Object.assign(fresh, { claudeSessionId: SID, _transport: { judgesAnswers: true, writeMessage: writes, stopTail: vi.fn(), hasPipe: true, fileSize: 0 } })
    const inner = fresh as unknown as CancelInternals & { handleStreamLine(line: string): void }
    inner.settleLineFate(stopped.uuid, stopped.batch, stopped.markers, { fate: 'cancelled' })
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
    await settle()
    expect(stopped.cancelled).toEqual([stopped.batch.map((r) => r.id)])
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'started' }))
    if (duplicate) await inner.returnCancelledLines([stopped.uuid])
    await vi.waitFor(async () => expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineUuid])).toEqual(stopped.batch.map((r) => [r.id, 'processing', stopped.uuid])))
    const { hasAnsweringLines } = await import('../../src/providers/line-consumption.js')
    expect(hasAnsweringLines(SID)).toBe(true)
    expect((await readQueueFileFresh()).relay?.[stopped.batch[0].id]?.[0]).toBe('taken')
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }))
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    const { settledLineUuid } = await import('../../src/core/session-message-queue.js')
    expect(await settledLineUuid(stopped.batch[0].id)).toBe(stopped.uuid)
    expect(stopped.cancelled).toEqual([stopped.batch.map((r) => r.id)])
    expect(writes).not.toHaveBeenCalled()
  })

  it.each(['two recoveries', 'startup and strict Retry', 'control attach and recovery', 'destroy while attaching'])('native attach has one live answer owner during %s', async (path) => {
    const stopped = await cancellationHarness(true)
    const { removeTaken, settledLineUuid } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    const daemon = scriptedDaemon({})
    daemon.conn.hasCapability = (c) => ['line-fate-read-v1', 'line-answer-v1', 'owner-home-v1'].includes(c)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let fateReads = 0
    let attaches = 0
    daemon.conn.send.mockImplementation(async (cmd, payload) => {
      daemon.sent.push({ cmd, payload })
      if (cmd === 'attach') { attaches++; return { ok: true, alive: true, pid: 4848, currentOffset: 0 } }
      if (cmd === 'line.fate') {
        fateReads++
        const firstHeld = path === 'two recoveries' ? 2 : 1
        if (fateReads === firstHeld || attaches > 1) await held
        return { ok: true, fate: 'ran', state: 'started', answer: 'pending' }
      }
      return { ok: true, alive: true, pid: 4848 }
    })
    const connection = await import('../../src/providers/daemon-connection.js')
    vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(daemon.conn as never)
    vi.spyOn(connection, 'probeDaemonSession').mockResolvedValue({ alive: true, pid: 4848 })
    const files = await import('../../src/core/daemon-file-reader.js')
    vi.spyOn(files.DaemonFileReader.prototype, 'readCostState').mockResolvedValue(null)
    const reconcile = await import('../../src/core/session-reconcile.js')
    vi.spyOn(reconcile, 'fetchStreamTailFold').mockResolvedValue('unavailable')
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr, { conn: daemon.conn, ensureConnected: async () => daemon.conn })
      return mgr
    }
    const runner = new SessionRunner('/bin/true')
    vi.spyOn(runner as unknown as { isSessionStillAlive(record: unknown): Promise<boolean> }, 'isSessionStillAlive').mockResolvedValue(true)
    const attach = vi.spyOn(ClaudeCodeSession, 'attachToExisting')
    const record = (await getSessionByClaudeId(SID))!
    let first: Promise<unknown>
    if (path === 'startup and strict Retry') { runner.init([{ ...record, pid: 4848 }]); first = Promise.resolve() }
    else first = path === 'control attach and recovery' || path === 'destroy while attaching' ? runner.getOrAttachLiveSession(SID) : runner.recoverCancelledForSession(SID)
    try {
      await vi.waitFor(() => expect(fateReads).toBeGreaterThanOrEqual(path === 'two recoveries' ? 2 : 1))
      if (path === 'destroy while attaching') {
        const disconnect = vi.spyOn(connection, 'disconnectAllDaemons').mockImplementation(() => {})
        runner.destroy()
        release()
        expect(await first).toBeUndefined()
        expect(runner.findSessionByClaudeId(SID)).toBeUndefined()
        const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')
        expect(getRegisteredSessionManager(SID)).toBeUndefined()
        expect(daemon.listenerCount()).toBe(0)
        expect(daemon.sent.filter((s) => ['start', 'send', 'stop'].includes(s.cmd))).toEqual([])
        disconnect.mockRestore()
        return
      }
      let second: Promise<unknown>
      if (path === 'startup and strict Retry') {
        vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => runner.findSessionByClaudeId(sid))
        vi.spyOn(sessionRunner, 'recoverCancelledForSession').mockImplementation((sid, required) => runner.recoverCancelledForSession(sid, required))
        const liveness = await import('../../src/utils/session-liveness.js')
        vi.spyOn(liveness, 'isSessionProcessAlive').mockResolvedValue(true)
        second = retrySession(SID)
      } else second = runner.recoverCancelledForSession(SID, true)
      await settle()
      release()
      await Promise.all([first, second])
      await vi.waitFor(() => expect(runner.findSessionByClaudeId(SID)).toBeDefined())
      const owner = runner.findSessionByClaudeId(SID)!
      const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')
      expect(attach).toHaveBeenCalledOnce()
      expect(getRegisteredSessionManager(SID)).toBe(owner.transport)
      expect(daemon.listenerCount()).toBe(1)
      daemon.emit({ ev: 'jsonl', sid: SID, line: JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }) })
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(stopped.batch[0].id)).toBe(stopped.uuid)
      expect(daemon.sent.filter((s) => s.cmd === 'start' || s.cmd === 'send')).toEqual([])
      expect(stopped.cancelled).toEqual([])
    } finally { release(); runner.destroyAndKill() }
  })

  it('every native attach entry shares the constructor instead of registering a competing output consumer', async () => {
    const source = await fs.readFile(new URL('../../src/providers/claude-code-session.ts', import.meta.url), 'utf8')
    const runner = source.slice(source.indexOf('export class SessionRunner'))
    expect(runner.match(/ClaudeCodeSession\.attachToExisting\(/g)).toHaveLength(1)
    expect(runner.match(/this\.attachNativeRecord\(/g)).toHaveLength(5)
    expect(runner.match(/this\.nativeAttachPromises\.clear\(\)/g)).toHaveLength(2)
  })

  it('a strict Retry beside a background recovery of an unknown-fate snapshot keeps the backup and sends nothing', async () => {
    const stopped = await cancellationHarness(true)
    const { removeTaken } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    const connection = await import('../../src/providers/daemon-connection.js')
    vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(null)
    const liveness = await import('../../src/utils/session-liveness.js')
    vi.spyOn(liveness, 'isSessionProcessAlive').mockResolvedValue(false)
    const files = await import('../../src/core/session-file-reader.js')
    vi.spyOn(files, 'findLocalJsonlPath').mockResolvedValue('/fake/unknown-fate-cancel.jsonl')
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await updateSessionRecord(SID, { process_status: 'stopped' })
    const runner = new SessionRunner('/bin/true')
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockReturnValue(undefined)
    vi.spyOn(sessionRunner, 'recoverCancelledForSession').mockImplementation((sid, required) => runner.recoverCancelledForSession(sid, required))
    try {
      const background = runner.recoverCancelledForSession(SID)
      const strict = retrySession(SID)
      expect(await background).toBe(true)
      // The durable backup is the cancellation's confirmation: an unknown fate cannot fail it.
      expect(await strict).toMatchObject({ status: 'resumable', sessionId: SID })
      expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]?.rows).toEqual(stopped.batch)
      expect(await getQueue(SID)).toEqual([])
      expect(stopped.cancelled).toEqual([])
      expect(delivered).toEqual([])
    } finally { runner.destroyAndKill() }
  })

  it('a late started query cannot recreate answer ownership after its loaded scope completed', async () => {
    const stopped = await cancellationHarness(true)
    const { removeTaken, settledLineUuid } = await import('../../src/core/session-message-queue.js')
    await removeTaken(SID, stopped.batch.map((r) => r.id), { ran: false, rows: stopped.batch })
    resetLineConsumption()
    resetCache()
    const fresh = new ClaudeCodeSession('resume-task', 'test', '/bin/true')
    let release!: (fate: { fate: 'ran'; state: 'started'; answer: 'pending' }) => void
    const query = vi.fn(() => new Promise<{ fate: 'ran'; state: 'started'; answer: 'pending' }>((resolve) => { release = resolve }))
    Object.assign(fresh, { claudeSessionId: SID, _transport: { readLineFate: query, judgesAnswers: true, stopTail: vi.fn(), hasPipe: true, fileSize: 0 } })
    const recovering = fresh.recoverCancelledRows()
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    ;(fresh as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: stopped.uuid, state: 'completed' }))
    await vi.waitFor(async () => expect(await settledLineUuid(stopped.batch[0].id)).toBe(stopped.uuid))
    release({ fate: 'ran', state: 'started', answer: 'pending' })
    expect(await recovering).toBe(true)
    const { hasAnsweringLines } = await import('../../src/providers/line-consumption.js')
    expect(hasAnsweringLines(SID)).toBe(false)
    expect(await getQueue(SID)).toEqual([])
    expect((await readQueueFileFresh()).cancelled?.[SID]?.[stopped.uuid]).toBeUndefined()
    expect(stopped.cancelled).toEqual([])
  })

  it('a daemon cancellation arriving after the lifecycle cancellation settled never returns the same text twice', async () => {
    const h = await cancellationHarness()
    await h.inner.returnCancelledLines([h.uuid])
    await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
    h.inner.settleLineFate(h.uuid, h.batch, h.markers, { fate: 'cancelled' })
    await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
    await settle()
    expect(h.cancelled).toEqual([h.batch.map((r) => r.id)])
    expect(await rows()).toEqual([])
    expect(await diskRows()).toEqual([])
    expect(delivered).toEqual([])
  })

  it('a cold cancelled fate with no registered line retains its markers on write failure and deletes only their rows on recovery', async () => {
    let fault: ReturnType<typeof failQueueDeletion> | undefined
    const { row, runner, session } = await resumeWithFate({ fate: 'cancelled', state: 'cancelled' }, () => { fault = failQueueDeletion() })
    const cancelled: string[][] = []
    bus.subscribe('web-ui', (event) => {
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
    })
    try {
      await vi.waitFor(() => expect(fault!.failures()).toBe(1))
      const inner = session() as unknown as CancelInternals
      await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
      const liveness = await import('../../src/utils/session-liveness.js')
      vi.spyOn(liveness, 'isSessionProcessAlive').mockResolvedValue(false)
      const files = await import('../../src/core/session-file-reader.js')
      vi.spyOn(files, 'findLocalJsonlPath').mockResolvedValue('/fake/cold-cancelled.jsonl')
      vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session() : undefined)
      const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
      await updateSessionRecord(SID, { process_status: 'stopped' })
      expect(() => session()!.send('new turn must wait for cancellation', WALNUT_HOME, SID)).toThrow('Retry before starting another turn')
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(fault!.failures()).toBe(2)
      expect(await rows()).toEqual([{ id: row.id, status: 'processing', lineUuid: (await getQueue(SID))[0].lineUuid }])
      expect((await readQueueFileFresh()).queues[SID]).toHaveLength(1)
      expect(cancelled).toEqual([])
      expect(delivered).toEqual([])
      fault!.mockRestore()
      // Keep the runner from consuming the unrelated row; this assertion is about cancellation's id filter.
      vi.spyOn(runner as unknown as Internals, 'processNext').mockResolvedValue()
      const other = await enqueueMessage(SID, 'unrelated pending message')
      expect(await retrySession(SID)).toMatchObject({ status: 'resuming', restoredMessages: 1 })
      expect((await getQueue(SID)).map((r) => r.id)).toEqual([other.id])
      await vi.waitFor(() => expect(cancelled).toEqual([[row.id]]))
      expect((await getQueue(SID)).map((r) => r.id)).toEqual([other.id])
      expect((await readQueueFileFresh()).queues[SID].map((r) => r.id)).toEqual([other.id])
      expect(delivered).toEqual([])
    } finally {
      fault!.mockRestore()
      runner.destroyAndKill()
    }
  }, 30_000)

  it.each(['started', 'completed'])('%s overtaking a delayed cancellation never returns that taken line to the composer', async (state) => {
    const h = await cancellationHarness()
    const gate = holdQueueDeletion()
    try {
      h.inner.returnCancelledLines([h.uuid])
      await gate.started
      ;(h.session as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state }))
      gate.release()
      await gate.settled
      await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
      await settle()
      expect(h.cancelled).toEqual([])
    } finally {
      gate.release()
      await gate.settled
      gate.spy.mockRestore()
    }
  })

  it('a newer registration of the same uuid survives an older delayed cancellation without a false composer return', async () => {
    const h = await cancellationHarness()
    const gate = holdQueueDeletion()
    try {
      h.inner.returnCancelledLines([h.uuid])
      await gate.started
      const newer = h.batch.map((r) => ({ ...r, id: `${r.id}-new` }))
      const markers = newer.map((r) => ({ message: r.message, messageId: r.id }))
      awaitLine(SID, h.uuid, newer)
      h.inner._queuedLines.set(h.uuid, markers)
      gate.release()
      await gate.settled
      await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
      await settle()
      expect(lineRows(SID, h.uuid)).toEqual(newer)
      expect(h.inner._queuedLines.get(h.uuid)).toBe(markers)
      expect(h.cancelled).toEqual([])
    } finally {
      gate.release()
      await gate.settled
      gate.spy.mockRestore()
    }
  })

  it('marker-only cancellations still return once per burst without registered rows', async () => {
    const h = await cancellationHarness()
    // This line's rows already left by the old CLI rule, but it still has queued markers.
    await h.inner.releaseLineRows(h.batch, 'cancelled')
    resetLineConsumption()
    h.inner.returnCancelledLines([h.uuid, h.uuid])
    await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
    expect(delivered).toEqual([])
  })

  it.each(['ran', 'answered'])('%s keeps its existing delivery timing while the real queue write is delayed', async (why) => {
    const h = await cancellationHarness()
    const gate = holdQueueDeletion()
    const removed = h.inner.releaseLineRows(h.batch, why)
    try {
      expect(delivered).toEqual([h.batch.map((r) => r.id)])
      await gate.started
      expect(await getQueue(SID)).toEqual(h.batch)
      expect(h.cancelled).toEqual([])
      gate.release()
      expect(await removed).toBe(true)
      expect(await rows()).toEqual([])
      expect(await diskRows()).toEqual([])
    } finally {
      gate.release()
      await gate.settled
      gate.spy.mockRestore()
    }
  })
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
