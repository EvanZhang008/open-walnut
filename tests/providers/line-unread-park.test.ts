/**
 * A line written into a CLI process that never reads its input.
 *
 * The incident (2026-10-06): a trigger fire was written into a CLI whose
 * transcript then had no entries at all. The daemon's write record kept
 * answering "waiting" (the line is in that process's pipe), every probe written
 * behind the line went unanswered (which proves nothing), so the row stayed in
 * flight for four days, until the session resumed as a new process and the line
 * was written for the first time the CLI actually read it: as news, four days late.
 *
 * Now "waiting" holds only while the process shows it is alive: a line still
 * unnamed in a process that answers nothing AND prints nothing for
 * LINE_UNREAD_PARK_MS has its rows parked (the user is told, nothing goes out on
 * its own). A turn that runs prints (tool_progress beats every 30 s), so a long
 * turn is never parked. Nothing is ever delivered twice: the line stays known to
 * the session, so a late read settles the parked row as delivered, and a Retry
 * goes out under the same uuid with dedupe, which the daemon answers from its
 * record instead of writing a second copy.
 *
 * What's real: SessionRunner (processNext), ClaudeCodeSession (writeMessage, the
 * stream handler, the line watch), the disk queue. What's mocked: the transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-unread-park'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache, unparkMessage } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000c01'
const PID = 34567
const EARLIER = '10000000-0000-4000-8000-0000000000e2'
const OLD = '10000000-0000-4000-8000-0000000000a2'

interface Write { message: string; uuid?: string; dedupe?: boolean; lostPid?: number }
type Fate = { fate: string; state?: string; writtenAt?: number; quiet?: true }
type Knobs = {
  LINE_ACK_GRACE_MS: number; LINE_PROBE_TIMEOUT_MS: number; LINE_PROBE_MAX_INTERVAL_MS: number
  MAX_LOST_REWRITES: number; LINE_UNREAD_PARK_MS: number
}
const knobs = ClaudeCodeSession as unknown as Knobs
const saved: Knobs = { ...knobs }
/** Every session a test made: its line watches are stopped after the test, so none outlives it. */
const made: ClaudeCodeSession[] = []

function harness(opts: { daemonSays?: (w: Write) => Fate | undefined } = {}) {
  const writes: Write[] = []
  const raws: string[] = []
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; dedupe?: boolean; lostPid?: number; onDispatch?: () => void; onFate?: (f: Fate) => void }) => {
      o?.onDispatch?.()
      const w: Write = { message, uuid: o?.uuid, dedupe: o?.dedupe, ...(o?.lostPid != null ? { lostPid: o.lostPid } : {}) }
      writes.push(w)
      const known = o?.dedupe ? opts.daemonSays?.(w) : undefined
      if (known) o?.onFate?.(known)
      return true
    },
    writeRaw: (json: string) => { raws.push(json); return true },
    canRewriteLostLine: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: PID,
  }
  const session = new ClaudeCodeSession('unread-park-task', 'test', '/bin/true')
  made.push(session)
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'idle', _active: true, pid: PID,
    resultEmitted: true, _turnResultEmitted: true, _sawCommandLifecycle: true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    processNext(sid: string): Promise<void>
  }
  internals.sessions.set('unread-park-task', session)
  const events: Array<{ name: string; data: Record<string, unknown> }> = []
  bus.subscribe('line-unread-park-test', (e) => { events.push({ name: e.name, data: e.data as Record<string, unknown> }) }, { global: true })
  const stream = (line: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify(line))
  const lifecycle = (uuid: string, state: string) => stream({ type: 'command_lifecycle', command_uuid: uuid, state })
  const probes = () => raws.map((raw) => JSON.parse(raw.trim()) as { type: string; request?: { subtype?: string } })
    .filter((p) => p.type === 'control_request' && p.request?.subtype === 'get_settings')
  // This process names every line `queued` as it takes it: only then is silence about a line evidence.
  lifecycle(EARLIER, 'queued')
  return { internals, session, writes, probes, stream, lifecycle, events }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status, parkedReason: m.parkedReason }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failed = (events: Array<{ name: string; data: Record<string, unknown> }>) =>
  events.filter((e) => e.name === EventNames.SESSION_BATCH_FAILED)

beforeEach(async () => {
  Object.assign(knobs, {
    LINE_ACK_GRACE_MS: 40, LINE_PROBE_TIMEOUT_MS: 60, LINE_PROBE_MAX_INTERVAL_MS: 80, MAX_LOST_REWRITES: 2,
    LINE_UNREAD_PARK_MS: 700,
  })
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'unread-park-task', 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
})

afterEach(async () => {
  for (const s of made.splice(0)) (s as unknown as { clearAllLineAcks(): void }).clearAllLineAcks()
  Object.assign(knobs, saved)
  bus.unsubscribe('line-unread-park-test')
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a line in a process that reads nothing and prints nothing', () => {
  it('is parked once the process has been still past the bound, and nothing is written again', async () => {
    const h = harness()
    await enqueueMessage(SID, 'trigger fired: pipeline is red')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    expect(h.writes).toHaveLength(1)
    // Unanswered probes, before the bound: proof of nothing, the row stays in flight.
    await vi.waitFor(() => expect(h.probes().length).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    // Past the bound with no answer and no output: parked, the user told it was not read.
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 3000 })
    const [row] = await rows()
    expect(row.id).toBe(id)
    expect(row.parkedReason).toMatch(/^Not read yet: this message reached Claude Code at /)
    expect(failed(h.events)[0]?.data).toMatchObject({ sessionId: SID, messageIds: [id] })
    expect(h.writes).toHaveLength(1)
    // No more questions about a parked line.
    const asked = h.probes().length
    await sleep(400)
    expect(h.probes().length).toBe(asked)
  })

  it('a long turn that keeps printing is never parked, however long it runs', async () => {
    const h = harness()
    await enqueueMessage(SID, 'behind a long build')
    await h.internals.processNext(SID)
    const uuid = h.writes[0].uuid!
    // A foreground tool running: Claude Code prints a tool_progress beat while it runs.
    const beat = setInterval(() => h.stream({ type: 'tool_progress', tool_use_id: 't-1', tool_name: 'Bash', elapsed_time_seconds: 30 }), 100)
    try {
      await sleep(2000)
      expect((await rows()).map((r) => r.status)).toEqual(['processing'])
      expect(failed(h.events)).toEqual([])
    } finally {
      clearInterval(beat)
    }
    // The turn ends and the CLI takes the line: delivered once.
    h.lifecycle(uuid, 'queued')
    h.lifecycle(uuid, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.writes).toHaveLength(1)
  })

  it('a process that went still after printing is parked a bound after its last output', async () => {
    const h = harness()
    await enqueueMessage(SID, 'written mid-turn')
    await h.internals.processNext(SID)
    const beat = setInterval(() => h.stream({ type: 'tool_progress', tool_use_id: 't-1', elapsed_time_seconds: 30 }), 100)
    await sleep(900)
    clearInterval(beat)
    const stoppedAt = Date.now()
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 3000 })
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(600)
  })

  it('a parked line the CLI reads after all settles as delivered, with no second copy', async () => {
    const h = harness()
    await enqueueMessage(SID, 'late reader')
    await h.internals.processNext(SID)
    const uuid = h.writes[0].uuid!
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 3000 })
    h.lifecycle(uuid, 'queued')
    h.lifecycle(uuid, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.writes).toHaveLength(1)
  })

  it('a Retry into the same still process writes no second copy and is parked again', async () => {
    // The daemon holds the first write's record: a resend under the same uuid is answered, not written.
    let writtenAt = 0
    const h = harness({ daemonSays: () => ({ fate: 'waiting', writtenAt, quiet: true }) })
    await enqueueMessage(SID, 'retried while still stuck')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    writtenAt = Date.now()
    const uuid = h.writes[0].uuid!
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 3000 })
    expect(await unparkMessage(SID, id)).toBe(true)
    await h.internals.processNext(SID)
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]).toMatchObject({ uuid, dedupe: true })
    expect(h.writes[1].lostPid).toBeUndefined()
    // Still nothing from the process: parked again at the next unanswered question.
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 1500 })
    expect((await rows())[0].parkedReason).toMatch(/^Not read yet/)
    expect(h.writes).toHaveLength(2)
  })
})

describe('after a server restart the daemon says how long the line has waited', () => {
  it('a line the daemon says went in long ago into a quiet process is parked at the first unanswered question', async () => {
    const writtenAt = Date.now() - 4 * 24 * 3600_000
    const h = harness({ daemonSays: () => ({ fate: 'waiting', writtenAt, quiet: true }) })
    await enqueueMessage(SID, 'fired four days ago', { lineUuid: OLD })
    await h.internals.processNext(SID)
    expect(h.writes[0]).toMatchObject({ uuid: OLD, dedupe: true })
    const started = Date.now()
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['parked']), { timeout: 1500 })
    // Not a fresh bound from the restart: the daemon's record dates the wait.
    expect(Date.now() - started).toBeLessThan(knobs.LINE_UNREAD_PARK_MS)
    expect((await rows())[0].parkedReason).toContain(new Date(writtenAt).toISOString())
    expect(h.writes).toHaveLength(1)
  })

  it('a daemon that saw the CLI print since the line (a running turn) starts the bound now, not from the write', async () => {
    const h = harness({ daemonSays: () => ({ fate: 'waiting', writtenAt: Date.now() - 4 * 24 * 3600_000 }) })
    await enqueueMessage(SID, 'behind a turn before the restart', { lineUuid: OLD })
    await h.internals.processNext(SID)
    await sleep(400)
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    expect(failed(h.events)).toEqual([])
  })

  it('a line the daemon read back as queued is never parked (the CLI holds it)', async () => {
    const h = harness({ daemonSays: () => ({ fate: 'waiting', state: 'queued' }) })
    await enqueueMessage(SID, 'queued behind a turn', { lineUuid: OLD })
    await h.internals.processNext(SID)
    await sleep(1200)
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    expect(h.probes()).toEqual([])
  })
})
