/**
 * r4c gate F1, server half: a line the daemon wrote behind a cut copy of it
 * (onCut, `{ ok: true, cut: true }`) is no delivery. The CLI exits on the cut
 * copy without running either, so the rows must survive that exit and go to
 * the next process. The gate's case was the FIRST line a process got: no
 * lifecycle seen yet, so the base rule removed the rows on the write ack, and
 * the message was lost (0 runs after a 202 and a "delivered" log).
 *
 * What's real: SessionRunner.processNext, ClaudeCodeSession (writeMessage, the
 * lifecycle handler, the exit path), the disk queue. Mocked: the transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-cut-hold'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { markUnconfirmed, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'

const SID = '10000000-0000-4000-8000-000000000c01'

/** The row ids each "delivered" event told the user about, in order. */
function deliveredEvents(): () => string[][] {
  const seen: string[][] = []
  bus.subscribe('main-ai', (event) => {
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) seen.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
  })
  return () => seen
}

interface WriteOpts {
  uuid?: string; dedupe?: boolean; onDispatch?: () => void; onCut?: () => void
  onFate?: (fate: { fate: string; state?: string }) => void
}
type Exit = { handleRemoteProcessExit(code: number, stderr?: string): void }

function harness(opts: { reportsLifecycle?: boolean } = {}) {
  const writes: Array<{ message: string; uuid?: string; dedupe?: boolean }> = []
  /** What the daemon does with the next write: report a cut or a fate it knew, and maybe something before it. */
  let next: { cut?: boolean; fate?: { fate: string; state?: string }; throws?: Error; before?: () => void } = {}
  const transport = {
    writeMessage: async (message: string, o?: WriteOpts) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid, dedupe: o?.dedupe })
      const now = next
      next = {}
      if (now.throws) throw now.throws
      now.before?.()
      if (now.fate) o?.onFate?.(now.fate)
      if (now.cut) o?.onCut?.()
      return true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: vi.fn(async () => {}),
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
  }
  const session = new ClaudeCodeSession('cut-task', 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'idle', _active: true, pid: 12345,
    resultEmitted: true, _turnResultEmitted: true, _sawCommandLifecycle: opts.reportsLifecycle === true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as { sessions: Map<string, ClaudeCodeSession>; processNext(sid: string): Promise<void> }
  internals.sessions.set('cut-task', session)
  const lifecycle = (uuid: string, state: string) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state }))
  /** The CLI exits on the cut copy (Claude Code exits 1 on a line it cannot parse). */
  const cliExits = () => (session as unknown as Exit).handleRemoteProcessExit(1, 'Error parsing streaming input line')
  /** The next process, resumed: alive, idle, its own pid. */
  const respawn = (pid: number) => Object.assign(session, {
    _processStatus: 'idle', _active: true, pid, resultEmitted: true, _turnResultEmitted: true,
  })
  return { internals, session, writes, lifecycle, cliExits, respawn, daemonNext: (n: typeof next) => { next = n } }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status }))
const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'cut-task', 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
})

afterEach(async () => {
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a line written behind a cut copy of it (r4c F1)', () => {
  it('the first line of a CLI with no lifecycle seen: kept through the exit, delivered once to the next process', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first message')
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    // Not removed on the write: the CLI is about to exit on the cut copy.
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    const uuid = h.writes[0].uuid!
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    expect((await getQueue(SID))[0].lineUuid).toBe(uuid)
    // The next process gets it under the same uuid; there the base rule holds again.
    h.respawn(12346)
    await h.internals.processNext(SID)
    expect(h.writes.map((w) => w.uuid)).toEqual([uuid, uuid])
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('the process ended before the answer came: the line goes back at once', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first message')
    h.daemonNext({ cut: true, before: () => h.cliExits() })
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
  })

  it('the CLI named the line between the write and the answer: settled by its word', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first message')
    h.daemonNext({ cut: true, before: () => h.lifecycle(h.writes[0].uuid!, 'started') })
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    h.cliExits()
    await settle()
    expect(await rows()).toEqual([])
    expect(h.writes).toHaveLength(1)
  })

  it('a CLI that reports its queue keeps the line as before, and the exit hands it back', async () => {
    const h = harness({ reportsLifecycle: true })
    await enqueueMessage(SID, 'tracked message')
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
  })

  // The r5 gate's N2 (probe PG): the CLI exits on the cut copy at the head of its pipe,
  // so a line written into that process after the cut answer is never read by it.
  it('a second line written into the process after the cut answer reaches the next process too', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first message')
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    await enqueueMessage(SID, 'second message')
    await h.internals.processNext(SID)
    await settle()
    // Both went into the process that holds the cut copy; neither leaves on its write.
    expect(h.writes.map((w) => w.message)).toEqual(['first message', 'second message'])
    expect((await rows()).map((r) => r.status)).toEqual(['processing', 'processing'])
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending', 'pending']))
    h.respawn(12346)
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.writes.slice(2).map((w) => w.message)).toEqual(['first message', 'second message'])
  })

  it('control for N2 (probe PH): without a cut, both lines leave on their writes and nothing goes to the next process', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first message')
    await h.internals.processNext(SID)
    await enqueueMessage(SID, 'second message')
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    h.cliExits()
    h.respawn(12346)
    await h.internals.processNext(SID)
    await settle()
    expect(h.writes.map((w) => w.message)).toEqual(['first message', 'second message'])
  })

  // The r5 gate's N6: a write behind a cut copy is no delivery, so the user is not told
  // "delivered" at the write; they are when the CLI takes the line, or when the next process gets it.
  it('no "delivered" for a write behind a cut copy; told once the CLI names the line', async () => {
    const delivered = deliveredEvents()
    const h = harness()
    await enqueueMessage(SID, 'first message')
    const [row] = await getQueue(SID)
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    expect(delivered()).toEqual([])
    // The cut was not real: the CLI read past it and names the line as it takes it.
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(delivered()).toEqual([[row.id]])
  })

  it('no "delivered" while the cut copy waits; the CLI exits on it: told once, when the next process gets the line', async () => {
    const delivered = deliveredEvents()
    const h = harness()
    await enqueueMessage(SID, 'first message')
    const [row] = await getQueue(SID)
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    expect(delivered()).toEqual([])
    h.respawn(12346)
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(delivered()).toEqual([[row.id]])
  })

  it('control (G8 holds): without a cut, the first line of an untracked CLI leaves on the write, and an exit re-sends nothing', async () => {
    const h = harness()
    await enqueueMessage(SID, 'plain message')
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    h.cliExits()
    await settle()
    expect(await rows()).toEqual([])
    expect(h.writes).toHaveLength(1)
  })
})

// "Delivered" is told once per row, at the first proof a CLI has its line (r6 gate L1, L2).
describe('delivered exactly once', () => {
  for (const reportsLifecycle of [false, true]) {
    it(`the CLI names a cut line before the cut answer comes (${reportsLifecycle ? 'tracked' : 'untracked'}, probes PD${reportsLifecycle ? 4 : 3}): told once`, async () => {
      const delivered = deliveredEvents()
      const h = harness({ reportsLifecycle })
      await enqueueMessage(SID, 'first message')
      const [row] = await getQueue(SID)
      h.daemonNext({ cut: true, before: () => h.lifecycle(h.writes[0].uuid!, 'started') })
      await h.internals.processNext(SID)
      await vi.waitFor(async () => expect(await rows()).toEqual([]))
      await settle()
      expect(delivered()).toEqual([[row.id]])
    })
  }

  it('a tracked cut write is not reported at the write; told once when the CLI names the line', async () => {
    const delivered = deliveredEvents()
    const h = harness({ reportsLifecycle: true })
    await enqueueMessage(SID, 'tracked message')
    const [row] = await getQueue(SID)
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    expect(delivered()).toEqual([])
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(delivered()).toEqual([[row.id]])
  })

  it('a resend the daemon says already ran, for a row the user was told was unconfirmed: told once', async () => {
    const delivered = deliveredEvents()
    const h = harness()
    await enqueueMessage(SID, 'first message')
    const [row] = await getQueue(SID)
    markUnconfirmed(SID, [row.id])
    h.daemonNext({ fate: { fate: 'ran', state: 'completed' } })
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    await settle()
    expect(delivered()).toEqual([[row.id]])
  })

  it('a tracked write of a row the user was told was unconfirmed, then the CLI names it: told once', async () => {
    const delivered = deliveredEvents()
    const h = harness({ reportsLifecycle: true })
    await enqueueMessage(SID, 'tracked message')
    const [row] = await getQueue(SID)
    markUnconfirmed(SID, [row.id])
    await h.internals.processNext(SID)
    await settle()
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    await settle()
    expect(delivered()).toEqual([[row.id]])
  })

  it('a line the daemon says waits in a process that holds a cut copy is kept for the next process (r6 gate L3)', async () => {
    const delivered = deliveredEvents()
    const h = harness()
    await enqueueMessage(SID, 'first message')
    h.daemonNext({ cut: true })
    await h.internals.processNext(SID)
    await settle()
    await enqueueMessage(SID, 'second message')
    // Already in that process's pipe (an earlier attempt), behind the cut copy.
    h.daemonNext({ fate: { fate: 'waiting' } })
    await h.internals.processNext(SID)
    await settle()
    expect((await rows()).map((r) => r.status)).toEqual(['processing', 'processing'])
    expect(delivered()).toEqual([])
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending', 'pending']))
    h.respawn(12346)
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.writes.slice(2).map((w) => w.message)).toEqual(['first message', 'second message'])
    expect(delivered()).toHaveLength(2)
  })

  it('told again after the user was told it is unconfirmed: a row delivered, handed back, then unanswered, then named by the CLI', async () => {
    const seen: Array<[string, string[]]> = []
    bus.subscribe('main-ai', (event) => {
      const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
      if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) seen.push(['delivered', ids])
      if (event.name === EventNames.SESSION_BATCH_FAILED) seen.push(['failed', ids])
    })
    const h = harness({ reportsLifecycle: true })
    await enqueueMessage(SID, 'tracked message')
    const [row] = await getQueue(SID)
    await h.internals.processNext(SID)
    await settle()
    h.cliExits()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    h.respawn(12346)
    h.daemonNext({ throws: new SendOutcomeUnknownError('no answer') })
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(seen.map(([kind]) => kind)).toEqual(['delivered', 'failed']))
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(seen).toEqual([['delivered', [row.id]], ['failed', [row.id]], ['delivered', [row.id]]])
  })
})
