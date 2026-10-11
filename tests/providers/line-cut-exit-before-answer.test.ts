/**
 * r7 gate N2 (mutant g770, probe PG2x): a process that holds a cut copy of a line
 * exits while the answer to the next line's write is still out.
 *
 * Whether that next line went in behind the cut copy is asked once its own write
 * has its answer (r6 gate M1), and so after the process it went into is gone. It
 * must be asked about THAT process (the pid captured before the write), not about
 * whatever the session holds by then (no process at all): otherwise the write
 * into the dead process counts as a delivery, its rows are removed, and the line
 * never reaches the next process although the user was told "delivered".
 *
 * The gate's probe only read this: its fake daemon kept taking writes after the
 * exit, so the runner wrote the lines straight back into the dead process. Here
 * the daemon answers every send after the exit as the real one does (the session
 * is dead), so the delivery resumes a new process and the test can assert that
 * the line was handed back and written again.
 *
 * What's real: SessionRunner (processNext and its cold resume, injectMidTurn, the
 * reclaim handler), ClaudeCodeSession (send, the spawn callback, the exit path,
 * writeMessage), RemoteSessionManager (start, the deferred first line,
 * confirmSend, the write chain), the disk queue. Scripted: the daemon connections.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-cut-exit-before-answer'))

const h = vi.hoisted(() => ({ make: null as null | ((tmpId: string) => unknown) }))
vi.mock('../../src/providers/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/session-manager.js')>()),
  createSessionManager: (tmpId: string) => h.make!(tmpId),
  ensureLocalDaemon: async () => {},
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { SessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { onLinesReclaimed, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000c05'

type Reply = Record<string, unknown> | Error
type Step = Reply | (() => Promise<Reply>)

/**
 * One daemon process: answers from a script per command and pushes events. After
 * `exit()` every send is answered as the real daemon answers a dead session.
 */
function scriptedDaemon(replies: Record<string, Step[]>) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const fallback: Record<string, Reply> = { stop: { ok: true, stopped: true }, status: { ok: true, exists: false } }
  let dead = false
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1', 'owner-home-v1'].includes(c),
    onEvent: (fn: (event: Record<string, unknown>) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload })
      const step = dead && cmd === 'send' ? { ok: false, reason: 'session_dead', exitCode: 1 } : replies[cmd]?.shift() ?? fallback[cmd] ?? { ok: true }
      const next = typeof step === 'function' ? await step() : step
      if (next instanceof Error) throw next
      return next
    }),
  }
  const exit = () => {
    dead = true
    for (const fn of listeners) fn({ ev: 'exit', sid: SID, code: 1, stderr: 'Error parsing streaming input line' })
  }
  const lines = () => sent.filter((s) => s.cmd === 'send').map((s) => ({ message: String(s.payload.message), uuid: s.payload.uuid, dedupe: s.payload.dedupe === true }))
  return { conn, sent, exit, lines }
}

const rows = async () => (await getQueue(SID)).map((m) => `${m.message}:${m.status}`)
let delivered: string[][] = []
const settle = () => new Promise((r) => setTimeout(r, 80))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'exit-task', 'test', WALNUT_HOME, { initialProcessStatus: 'stopped' })
  delivered = []
  bus.subscribe('main-ai', (event) => {
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) delivered.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
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

describe('a process holding a cut copy exits while the next line\'s write is unanswered (r7 gate N2, g770)', () => {
  it('that line is handed back at its answer, written again to the next process after the first, and told delivered once', async () => {
    let answerB!: (r: Reply) => void
    let startNext!: () => void
    const first = scriptedDaemon({
      start: [{ ok: true, pid: 4646, outputFile: '/nonexistent/exit-before-answer.jsonl', offset: 0 }],
      // The deferred first line dies with the daemon; the confirm goes in behind the piece (cut).
      // The next line's write: its answer comes only after the exit.
      send: [new Error('connection closed'), { ok: true, cut: true }, () => new Promise<Reply>((resolve) => { answerB = resolve })],
    })
    const next = scriptedDaemon({
      start: [() => new Promise<Reply>((resolve) => {
        startNext = () => resolve({ ok: true, pid: 4747, outputFile: '/nonexistent/exit-before-answer.jsonl', offset: 0 })
      })],
    })
    const daemons = [first, next]
    h.make = (tmpId: string) => {
      const d = daemons.shift()!
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: d.conn, ensureConnected: async () => d.conn })
      return mgr
    }
    const runner = new SessionRunner('/bin/true')
    const internals = runner as unknown as {
      activeProcessing: Set<string>
      processNext(sid: string): Promise<void>
      injectMidTurn(sid: string): Promise<void>
      onLinesReclaimedFor(sid: string, why?: string): void
    }
    // As SessionRunner.init() wires it: a line handed back is delivered again by the runner.
    onLinesReclaimed((sid, why) => internals.onLinesReclaimedFor(sid, why))

    await enqueueMessage(SID, 'first message')
    await internals.processNext(SID)
    await vi.waitFor(() => expect(first.lines()).toHaveLength(2), { timeout: 10_000 })
    await settle()
    expect(await rows()).toEqual(['first message:processing'])

    await enqueueMessage(SID, 'second message')
    const ids = new Map((await getQueue(SID)).map((m) => [m.message, m.id]))
    const second = internals.activeProcessing.has(SID) ? internals.injectMidTurn(SID) : internals.processNext(SID)
    await vi.waitFor(() => expect(first.lines()).toHaveLength(3), { timeout: 10_000 })
    const uuidB = first.lines()[2].uuid

    // The CLI exits on the cut copy; only then does the second line's write get its answer.
    first.exit()
    await settle()
    answerB({ ok: true })
    await second
    await settle()
    // The hand-back asks the runner to deliver again; a delivery already under way makes
    // that a no-op. Either way the next delivery finds the process dead and resumes.
    if (!next.sent.some((s) => s.cmd === 'start')) await internals.processNext(SID)
    await vi.waitFor(() => expect(next.sent.some((s) => s.cmd === 'start')).toBe(true), { timeout: 10_000 })
    await settle()

    // Handed back, not removed, and not told delivered: the process it went into is gone.
    expect(await rows()).toContain('second message:pending')
    expect(delivered.flat()).not.toContain(ids.get('second message'))

    // The next process gets both, in order, each asked first (dedupe), each told once.
    startNext()
    await vi.waitFor(() => expect(next.lines()).toHaveLength(2), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 10_000 })
    await settle()
    expect(next.lines().map((l) => [l.message, l.dedupe])).toEqual([['first message', true], ['second message', true]])
    expect(next.lines()[1].uuid).toBe(uuidB)
    expect(delivered).toEqual([[ids.get('first message')], [ids.get('second message')]])
    runner.destroyAndKill()
  }, 30_000)
})
