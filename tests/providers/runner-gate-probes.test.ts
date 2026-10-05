/**
 * The round-1 gate's probes (G1-G8, G7b), ported as regression tests, plus the
 * behaviors its surviving mutants showed were unpinned (M3, M4b) and P7. Each
 * test asserts the CONTRACT the gate checked; every one of G1-G5, G7, G7b and G8
 * failed on round 1 (G6 passed there and is kept as a regression).
 *
 * Harness: tests/helpers/runner-probe-harness.ts (real runner, session, queue
 * and line registry; a faked transport). In G4/G5/G6 the real
 * RemoteSessionManager runs its confirm loop over a faked daemon connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-runner-gate-probes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue, isMessageQueued, loadQueue, removeTaken, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { EventNames } from '../../src/core/event-bus.js'
import {
  SID, crash, harness, named, probeSetup, probeTeardown, rows, settle, turnEnds, turnStarts, type Harness,
} from '../helpers/runner-probe-harness.js'

beforeEach(probeSetup)
afterEach(probeTeardown)

describe('G1 (and M4b): two lines queued behind a turn, a crash between them being taken', () => {
  it('a turn end never counts a line as taken: the second line is still queued when the CLI crashes', async () => {
    const h = harness()
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'm1')
    await h.internals.injectMidTurn(SID)
    await enqueueMessage(SID, 'm2')
    await h.internals.injectMidTurn(SID)
    const [l1, l2] = h.writes.map((w) => w.uuid!)
    h.lifecycle(l1, 'queued')
    h.lifecycle(l2, 'queued')
    await settle()
    turnEnds(h) // turn A ends; the CLI runs m1 as turn B (one queued line per turn)
    await settle(200)
    turnStarts(h)
    h.lifecycle(l1, 'started')
    await settle()
    turnEnds(h) // turn B ends; m2 is still waiting in the CLI's queue
    await settle(200)
    expect(await rows()).toEqual(['m2:processing'])
    crash(h)
    await settle(300)
    // Not lost: back in the queue, and anything written for it again carries its own uuid.
    expect((await rows()).map((r) => r.split(':')[0])).toEqual(['m2'])
    expect(h.writes.filter((w) => w.message === 'm2').every((w) => w.uuid === l2)).toBe(true)
  })
})

describe('G2 (B3): a teardown Walnut asked for, with a human line queued in the CLI', () => {
  it('the user learns the message never ran, and its text is kept', async () => {
    const h = harness()
    await enqueueMessage(SID, 'please also run the tests')
    await h.internals.injectMidTurn(SID)
    const [row] = await getQueue(SID)
    h.lifecycle(h.writes[0].uuid!, 'queued')
    await settle()
    // The agent completes its own task mid-turn: completeTaskSessions marks the teardown and stops the CLI.
    h.session.markExpectedTeardown('task_completed')
    ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void }).handleRemoteProcessExit(143)
    await settle(200)
    expect(named(h, EventNames.SESSION_BATCH_FAILED, row.id)).toHaveLength(1)
    expect(await isMessageQueued(SID, row.id)).toBe(true)
    expect(await rows()).toEqual(['please also run the tests:parked'])
    // Never delivered to a new process on its own.
    expect(h.resumes).toEqual([])
  })
})

describe('G3 (B4): the CLI took the line, the reply never came', () => {
  it('a started line is never reported failed, and a Retry of it keeps its uuid', async () => {
    let first = true
    const ref: { h?: Harness } = {}
    const h = harness({
      running: false,
      script: async (_m, o) => {
        if (!first) return true
        first = false
        // The CLI starts the line at once; only the daemon's reply to the send is lost.
        ref.h!.lifecycle(o.uuid!, 'started')
        await settle(50)
        throw new SendOutcomeUnknownError('daemon command timeout: send (30000ms)')
      },
    })
    ref.h = h
    await enqueueMessage(SID, 'deploy the fix')
    const [row] = await getQueue(SID)
    await h.internals.processNext(SID)
    await settle(150)
    expect(named(h, EventNames.SESSION_BATCH_FAILED, row.id)).toHaveLength(0)
    expect(await isMessageQueued(SID, row.id)).toBe(false)
    // Even an explicit resend of that row (the web Retry's fresh enqueue) goes out under the same uuid.
    const { settledLineUuid } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(SID, 'deploy the fix', { lineUuid: await settledLineUuid(row.id) })
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await h.internals.processNext(SID)
    expect(new Set(h.writes.map((w) => w.uuid)).size).toBe(1)
  })
})

describe('G4: a second send while the first is being confirmed', () => {
  const deadline = RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS
  afterEach(() => { RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = deadline })

  it('is shown waiting for the first one at once, and keeps its order', async () => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = 3_000
    const t0 = Date.now()
    const sends: Array<{ at: number; message: unknown; dedupe: boolean }> = []
    const conn = {
      connected: true,
      hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1'].includes(c),
      send: async (cmd: string, p: Record<string, unknown>) => {
        if (cmd !== 'send') return { ok: true }
        sends.push({ at: Date.now() - t0, message: p.message, dedupe: p.dedupe === true })
        await settle(150)
        throw new Error('daemon command timeout: send (30000ms)')
      },
    }
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: SID })
    const h = harness({ transport: mgr, running: false })
    await enqueueMessage(SID, 'first')
    const firstRun = h.internals.processNext(SID)
    await settle(300)
    await enqueueMessage(SID, 'second')
    const secondId = (await getQueue(SID)).find((m) => m.message === 'second')!.id
    const secondRun = h.internals.injectMidTurn(SID)
    await settle(500)
    expect(named(h, EventNames.SESSION_DELIVERY_HELD, secondId)).toHaveLength(1)
    await Promise.allSettled([firstRun, secondRun])
    // 'second' never reached the daemon ahead of 'first' being settled.
    expect(sends.every((s) => s.message === 'first')).toBe(true)
    // Both wait, in order, under their own uuid; the user was told about both.
    const queue = await getQueue(SID)
    expect(queue.map((m) => `${m.message}:${m.status}`)).toEqual(['first:pending', 'second:pending'])
    expect(named(h, EventNames.SESSION_BATCH_FAILED, secondId)).toHaveLength(1)
    // The next delivery asks about 'first' alone before anything else goes out.
    const { markProcessing } = await import('../../src/core/session-message-queue.js')
    expect((await markProcessing(SID)).map((m) => [m.message, m.lineTries])).toEqual([['first', 2]])
  }, 30_000)
})

/** A daemon connection whose replies to `send` are lost until the session is stopped. */
function laggingConn(t0: number) {
  const log: Array<{ at: number; cmd: string; message?: unknown; dedupe?: boolean }> = []
  let stopped = false
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1', 'owner-home-v1', 'cron-supervision-v1'].includes(c),
    send: async (cmd: string, p: Record<string, unknown>) => {
      log.push({ at: Date.now() - t0, cmd, message: p.message, dedupe: p.dedupe === true })
      if (cmd === 'stop') { stopped = true; return { ok: true, stopped: true } }
      if (cmd === 'sendRaw') return { ok: true }
      if (cmd !== 'send') return { ok: true }
      if (stopped) { await settle(30); return { ok: false, reason: 'not_found' } }
      await settle(120)
      throw new Error('daemon command timeout: send (30000ms)')
    },
  }
  return { conn, log }
}

describe('G5: a user Stop while the first send is being confirmed', () => {
  const deadline = RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS
  afterEach(() => { RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = deadline })

  it('the stopped message is not resent after the Stop, on any process; the user may Retry it', async () => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = 20_000
    const t0 = Date.now()
    const { conn, log } = laggingConn(t0)
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: SID, _hasPipe: true })
    const h = harness({ transport: mgr, running: false })
    await enqueueMessage(SID, 'refactor the parser')
    const [row] = await getQueue(SID)
    const run = h.internals.processNext(SID)
    await settle(400)
    const stopAt = Date.now() - t0
    // The Stop button: session:interrupt -> SESSION_INTERRUPT -> interruptNativeSession.
    await (h.runner as unknown as { interruptNativeSession(sid: string): Promise<void> }).interruptNativeSession(SID)
    await Promise.race([run, settle(15_000)])
    expect(h.resumes).toEqual([])
    // No 'send' after the Stop carries the line.
    expect(log.filter((l) => l.cmd === 'send' && l.at > stopAt + 300)).toEqual([])
    // Not lost and not silent: either parked behind a failed bubble that offers
    // Retry, or (the Stop ended the process) handed back to the composer.
    const queue = await rows()
    const failed = named(h, EventNames.SESSION_BATCH_FAILED, row.id).length
    const returned = named(h, EventNames.SESSION_QUEUED_CANCELLED, row.id).length
    expect(failed + returned).toBeGreaterThan(0)
    if (queue.length > 0) expect(queue).toEqual(['refactor the parser:parked'])
    else expect(returned).toBeGreaterThan(0)
  }, 40_000)
})

describe('G6: the daemon restarts while the first send is being confirmed', () => {
  const deadline = RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS
  afterEach(() => { RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = deadline })

  it.each([['landed before the restart', true], ['lost with the old daemon', false]])('the line reaches the CLI once: %s', async (_name, landed) => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = 10_000
    const lines: string[] = []
    let first = true
    const conn = {
      connected: true,
      hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1'].includes(c),
      send: async (cmd: string, p: Record<string, unknown>) => {
        if (cmd !== 'send') return { ok: true }
        const ids = (p.markers as Array<{ messageId: string }>).map((m) => m.messageId).join(',')
        if (first) {
          first = false
          if (landed) lines.push(ids)
          await settle(50)
          throw new Error('connection closed')
        }
        if (p.dedupe === true && lines.includes(ids)) return { ok: true, duplicate: true, fate: 'waiting' }
        lines.push(ids)
        return { ok: true }
      },
    }
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: SID, _hasPipe: true })
    const h = harness({ transport: mgr, running: false })
    await enqueueMessage(SID, 'once only')
    await h.internals.processNext(SID)
    expect({ lines: lines.length, resumes: h.resumes.length, failed: named(h, EventNames.SESSION_BATCH_FAILED).length })
      .toEqual({ lines: 1, resumes: 0, failed: 0 })
  }, 30_000)
})

describe('G7 (B1): a server restart (deploy) while lines wait in the CLI queue', () => {
  it('the restarted server writes nothing for them except under the uuid the CLI already holds', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first aside')
    await h.internals.injectMidTurn(SID)
    await enqueueMessage(SID, 'second aside')
    await h.internals.injectMidTurn(SID)
    const sent = h.writes.map((w) => w.uuid!)
    h.lifecycle(sent[0], 'queued')
    h.lifecycle(sent[1], 'queued')
    await settle()
    // The server restarts: in-memory line registry gone, the disk queue recovers processing -> pending.
    resetLineConsumption()
    resetCache()
    await loadQueue()
    const h2 = harness({ task: 'gate-task-2' })
    await h2.internals.processNext(SID)
    await settle(300)
    const resent = h2.writes.map((w) => ({ uuid: w.uuid, text: w.message, dedupe: w.dedupe }))
    expect(resent.length).toBeGreaterThan(0)
    // Each goes out alone, under its own uuid, asking the daemon first.
    expect(resent).toEqual(resent.map((w, i) => ({ uuid: sent[i], text: ['first aside', 'second aside'][i], dedupe: true })))
  })

  it('G7b: a new message after the restart never carries the old line under a new uuid', async () => {
    const h = harness()
    await enqueueMessage(SID, 'only aside')
    await h.internals.injectMidTurn(SID)
    const sent = h.writes.map((w) => w.uuid!)
    h.lifecycle(sent[0], 'queued')
    await settle()
    resetLineConsumption()
    resetCache()
    await loadQueue()
    await enqueueMessage(SID, 'new question after the deploy')
    const h2 = harness({ task: 'gate-task-2' })
    await h2.internals.processNext(SID)
    await settle(300)
    const carriesOld = h2.writes.filter((w) => w.message.includes('only aside'))
    expect(carriesOld.length).toBeGreaterThan(0)
    expect(carriesOld.every((w) => w.uuid === sent[0] && w.message === 'only aside')).toBe(true)
    // The daemon said the old line waits in the live CLI: the new one goes out on its own line.
    const fresh = h2.writes.filter((w) => w.message === 'new question after the deploy')
    expect(fresh.every((w) => w.uuid !== sent[0])).toBe(true)
  })
})

describe('G8: a CLI that reports no command_lifecycle (2.1.88) absorbed a mid-turn line, then crashed in the next turn', () => {
  it('the absorbed line is not handed to the resumed CLI again (base behavior)', async () => {
    const h = harness({ lifecycle: false })
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'absorbed aside')
    await h.internals.injectMidTurn(SID)
    turnEnds(h) // turn A (which answered the aside) ends
    await settle(200)
    await enqueueMessage(SID, 'next question')
    Object.assign(h.session, { _processStatus: 'idle', _turnResultEmitted: true, resultEmitted: true })
    await h.internals.processNext(SID)
    await settle(100)
    crash(h) // turn B dies
    await settle(300)
    expect((await rows()).some((r) => r.startsWith('absorbed aside'))).toBe(false)
    expect(h.resumes.some((m) => m.includes('absorbed aside'))).toBe(false)
    expect(h.writes.filter((w) => w.message === 'absorbed aside')).toHaveLength(1)
  })
})

describe('M3: a resume whose outcome is unknown never brings back a row that is gone', () => {
  it('a row removed while the spawn went unanswered stays removed and is not reported failed', async () => {
    // The live write is refused (the process is gone), so the runner resumes.
    const h = harness({ running: false, script: async () => false })
    await enqueueMessage(SID, 'resume me')
    const [row] = await getQueue(SID)
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.resumeSettles).toHaveLength(1))
    // Meanwhile the row left the queue (the CLI reported taking it, or the user deleted it).
    await removeTaken(SID, [row.id])
    h.resumeSettles[0](false, new SendOutcomeUnknownError('daemon command timeout: start (30000ms)'))
    await settle(200)
    expect(await getQueue(SID)).toEqual([])
    expect(named(h, EventNames.SESSION_BATCH_FAILED, row.id)).toHaveLength(0)
  })
})

describe('P7: one session\'s slow delivery does not hold up the others on the host', () => {
  it('reconnect redelivery runs per session', async () => {
    const SID_B = '30000000-0000-4000-8000-0000000000b2'
    await createSessionRecord(SID_B, 'gate-task-b', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
    // A's write hangs (its answer is being asked for); B's goes through at once.
    let releaseA!: () => void
    const a = harness({ running: false, script: () => new Promise<boolean>((resolve) => { releaseA = () => resolve(true) }) })
    const b = harness({ running: false, sid: SID_B, task: 'gate-task-b' })
    // One runner owns both sessions, as in production.
    a.internals.sessions.set('gate-task-b', b.session)
    await enqueueMessage(SID, 'slow one')
    await enqueueMessage(SID_B, 'quick one')
    const t0 = Date.now()
    const run = a.internals.redeliverPendingForHost('__local__')
    await vi.waitFor(() => expect(b.writes.map((w) => w.message)).toEqual(['quick one']), { timeout: 3_000 })
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(a.writes.map((w) => w.message)).toEqual(['slow one'])
    releaseA()
    await run
  })
})
