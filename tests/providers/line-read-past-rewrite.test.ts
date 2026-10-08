/**
 * A line written into a CLI's stdin that the CLI never names (send-lost-line-v1).
 *
 * The incident (2026-10-05): an agent's grep named the live stdin FIFOs on its
 * command line and read them, so the lines Walnut wrote went to grep. The
 * daemon's write record said each line was in the CLI's pipe, so every resend
 * was answered "waiting", the row stayed "Delivered" and the session "Running",
 * and nothing ever asked again.
 *
 * Now a line the CLI has not named (not even `queued`) after a grace period is
 * challenged: Walnut writes a get_settings control request after a lone newline.
 * The CLI reads stdin in order and names a user line as it takes it, so an
 * ANSWER with still no word on the line proves this process read past it. The
 * rows then go out again under the same uuid with `lostPid`, and the daemon
 * writes the line again. No answer proves nothing: the line keeps waiting and is
 * asked about later. A line the CLI named is never challenged, and a daemon that
 * cannot rewrite, or a line lost twice, ends as a failed bubble with Retry.
 *
 * What's real: SessionRunner (processNext, injectMidTurn, the reclaim handler),
 * ClaudeCodeSession (writeMessage, the stream handler, the watchdog), the disk
 * queue. What's mocked: the transport (no process, no daemon).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-read-past'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000b01'
const PID = 23456

interface Write { message: string; uuid?: string; dedupe?: boolean; lostPid?: number }
type Knobs = { LINE_ACK_GRACE_MS: number; LINE_PROBE_TIMEOUT_MS: number; LINE_PROBE_MAX_INTERVAL_MS: number; MAX_LOST_REWRITES: number }
const knobs = ClaudeCodeSession as unknown as Knobs
const saved: Knobs = { ...knobs }

/** A line of some earlier turn, named `queued` by the harness CLI to show it names lines as it takes them. */
const EARLIER = '10000000-0000-4000-8000-0000000000e1'

type Fate = { fate: string; state?: string }

function harness(opts: { canRewrite?: boolean; namesQueued?: boolean; daemonSays?: (w: Write) => Fate | undefined } = {}) {
  const writes: Write[] = []
  const raws: string[] = []
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; dedupe?: boolean; lostPid?: number; onDispatch?: () => void; onFate?: (f: Fate) => void }) => {
      o?.onDispatch?.()
      const w: Write = { message, uuid: o?.uuid, dedupe: o?.dedupe, ...(o?.lostPid != null ? { lostPid: o.lostPid } : {}) }
      writes.push(w)
      // What the daemon answers instead of writing (send-dedupe-v1), when the test says so.
      const known = o?.dedupe ? opts.daemonSays?.(w) : undefined
      if (known) o?.onFate?.(known)
      return true
    },
    writeRaw: (json: string) => { raws.push(json); return true },
    canRewriteLostLine: () => opts.canRewrite !== false,
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
  const session = new ClaudeCodeSession('read-past-task', 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'idle', _active: true, pid: PID,
    resultEmitted: true, _turnResultEmitted: true, _sawCommandLifecycle: true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    injectMidTurn(sid: string): Promise<void>
    processNext(sid: string): Promise<void>
    onLinesReclaimedFor(sid: string, why?: string): void
  }
  internals.sessions.set('read-past-task', session)
  const events: Array<{ name: string; data: Record<string, unknown> }> = []
  bus.subscribe('line-read-past-test', (e) => { events.push({ name: e.name, data: e.data as Record<string, unknown> }) }, { global: true })
  const stream = (line: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify(line))
  const lifecycle = (uuid: string, state: string) => stream({ type: 'command_lifecycle', command_uuid: uuid, state })
  /** The probes written so far, parsed (each must start with a lone newline). */
  const probes = () => raws.map((raw) => {
    expect(raw.startsWith('\n')).toBe(true)
    return JSON.parse(raw.trim()) as { type: string; request_id: string; request: { subtype: string } }
  }).filter((p) => p.type === 'control_request' && p.request.subtype === 'get_settings')
  const answer = (requestId: string) => stream({
    type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { effort: 'high', model: 'test-model' } },
  })
  // Claude Code 2.1.258+ names every user line `queued` as it takes it; only then is silence evidence.
  if (opts.namesQueued !== false) lifecycle(EARLIER, 'queued')
  return { internals, session, writes, raws, probes, answer, lifecycle, events }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  Object.assign(knobs, { LINE_ACK_GRACE_MS: 40, LINE_PROBE_TIMEOUT_MS: 300, LINE_PROBE_MAX_INTERVAL_MS: 80, MAX_LOST_REWRITES: 2 })
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'read-past-task', 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
})

afterEach(async () => {
  Object.assign(knobs, saved)
  bus.unsubscribe('line-read-past-test')
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a line the CLI never names', () => {
  it('is challenged after the grace, and once the CLI answers, written again under its uuid with lostPid', async () => {
    const h = harness()
    await enqueueMessage(SID, 'are you there')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    expect(h.writes).toHaveLength(1)
    const uuid = h.writes[0].uuid!
    expect(await rows()).toEqual([{ id, status: 'processing' }])

    // No word from the CLI: a probe goes out after a lone newline.
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    expect(h.writes).toHaveLength(1)
    // The CLI answers it, still without a word on the line: it read past the line.
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]), { timeout: 2000 })

    // The runner delivers it again: same uuid, asking the daemon, naming the process that read past it.
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2), { timeout: 2000 })
    expect(h.writes[1]).toEqual({ message: 'are you there', uuid, dedupe: true, lostPid: PID })
    h.lifecycle(uuid, 'queued')
    h.lifecycle(uuid, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.events.some((e) => e.name === EventNames.SESSION_BATCH_FAILED)).toBe(false)
  })

  it('a line the CLI named as queued is never challenged (it waits behind a running turn)', async () => {
    const h = harness()
    await enqueueMessage(SID, 'behind the turn')
    await h.internals.processNext(SID)
    h.lifecycle(h.writes[0].uuid!, 'queued')
    await sleep(400)
    expect(h.raws).toEqual([])
    expect(h.writes).toHaveLength(1)
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
  })

  it('an unanswered probe proves nothing: the line is never written again, and it is asked about later', async () => {
    const h = harness()
    await enqueueMessage(SID, 'slow cli')
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    // A booting or busy CLI reads neither the line nor the probe behind it.
    await vi.waitFor(() => expect(h.probes().length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    expect(h.writes).toHaveLength(1)
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    // Then it reads the line after all: no more probes.
    h.lifecycle(h.writes[0].uuid!, 'queued')
    const asked = h.probes().length
    await sleep(800)
    expect(h.probes().length).toBeLessThanOrEqual(asked + 1)
    expect(h.writes).toHaveLength(1)
  })

  it('a daemon that cannot rewrite a lost line: the user sees it failed, never "Delivered" forever', async () => {
    const h = harness({ canRewrite: false })
    await enqueueMessage(SID, 'old daemon')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]), { timeout: 2000 })
    const failed = h.events.find((e) => e.name === EventNames.SESSION_BATCH_FAILED)
    expect(failed?.data).toMatchObject({ sessionId: SID, messageIds: [id] })
    expect(String(failed?.data.error)).toMatch(/never read this message/)
    expect(h.writes).toHaveLength(1)
  })

  it('a line lost again after two rewrites is shown as failed', async () => {
    const h = harness()
    await enqueueMessage(SID, 'keeps vanishing')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    for (let round = 1; round <= 3; round++) {
      await vi.waitFor(() => expect(h.probes()).toHaveLength(round), { timeout: 2000 })
      h.answer(h.probes()[round - 1].request_id)
      if (round === 3) break
      await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]), { timeout: 2000 })
      h.internals.onLinesReclaimedFor(SID, 'lost')
      await vi.waitFor(() => expect(h.writes).toHaveLength(round + 1), { timeout: 2000 })
    }
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]), { timeout: 2000 })
    expect(h.writes.map((w) => w.lostPid ?? null)).toEqual([null, PID, PID])
    expect(h.events.some((e) => e.name === EventNames.SESSION_BATCH_FAILED)).toBe(true)
  })

  it('a CLI never seen naming a line `queued` is never challenged (silence proves nothing there)', async () => {
    // A CLI that reports started/completed but not queued says nothing about a line behind a turn.
    const h = harness({ namesQueued: false })
    await enqueueMessage(SID, 'behind a long turn')
    await h.internals.processNext(SID)
    await sleep(400)
    expect(h.raws).toEqual([])
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
  })

  it('a line written before the process first named one `queued` (a restarted server) is watched from that word on', async () => {
    const h = harness({ namesQueued: false })
    await enqueueMessage(SID, 'redelivered after a restart')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    await sleep(200)
    expect(h.raws).toEqual([])
    // Another line, written later, is taken: now this process is known to name what it takes.
    h.lifecycle(EARLIER, 'queued')
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]), { timeout: 2000 })
  })

  it('a CLI that has not reported lifecycle is never challenged (the write is its last word)', async () => {
    const h = harness()
    Object.assign(h.session, { _sawCommandLifecycle: false })
    await enqueueMessage(SID, 'old cli')
    await h.internals.processNext(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    await sleep(300)
    expect(h.raws).toEqual([])
  })
})

describe('a lost line across a server restart, an old window, and a pending permission', () => {
  const OLD = '10000000-0000-4000-8000-0000000000a1'

  it('after a restart, a line the daemon only has a record of is watched at once in a process known to name lines', async () => {
    // The restored record says this pid names lines `queued` (lineQueuedPid): no new frame is needed.
    const h = harness({ namesQueued: false, daemonSays: (w) => (w.lostPid == null ? { fate: 'waiting' } : undefined) })
    Object.assign(h.session, { _queuedFramesFrom: PID })
    await enqueueMessage(SID, 'stolen before the deploy', { lineUuid: OLD })
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    expect(h.writes[0]).toMatchObject({ uuid: OLD, dedupe: true })
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]), { timeout: 2000 })
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2), { timeout: 2000 })
    expect(h.writes[1]).toMatchObject({ uuid: OLD, dedupe: true, lostPid: PID })
  })

  it('the first `queued` word of a process is saved on the record, so a restarted server knows it', async () => {
    const h = harness({ namesQueued: false })
    h.lifecycle(EARLIER, 'queued')
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.lineQueuedPid).toBe(PID), { timeout: 2000 })
  })

  it('a line the daemon reads back as queued (a frame from before the restart) is never challenged', async () => {
    const h = harness({ namesQueued: false, daemonSays: () => ({ fate: 'waiting', state: 'queued' }) })
    await enqueueMessage(SID, 'queued behind a long turn', { lineUuid: OLD })
    await h.internals.processNext(SID)
    await sleep(400)
    expect(h.raws).toEqual([])
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    // And that answer showed the process names lines: an unnamed line written next IS watched.
    await enqueueMessage(SID, 'a fresh line')
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.probes().length).toBeGreaterThanOrEqual(1), { timeout: 2000 })
  })

  it('a rewrite the daemon cannot judge (marker out of its window) is not asked about again', async () => {
    // The daemon writes the first copy, then answers the lostPid rewrite with a bare "waiting".
    const h = harness({ daemonSays: (w) => (w.lostPid != null ? { fate: 'waiting' } : undefined) })
    await enqueueMessage(SID, 'printed megabytes ago')
    const id = (await getQueue(SID))[0].id
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]), { timeout: 2000 })
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2), { timeout: 2000 })
    await sleep(500)
    expect(h.probes()).toHaveLength(1)
    expect(await rows()).toEqual([{ id, status: 'processing' }])
    expect(h.events.some((e) => e.name === EventNames.SESSION_BATCH_FAILED)).toBe(false)
  })

  it('one answer proves the CLI read past every unnamed line before it: they go out again in order', async () => {
    // A probe proves only the lines written before it. The first line's probe
    // waits long enough for the second line here, and the probe answered is the
    // first one written after both lines are out: on a slow runner the first
    // line could be probed alone (40 ms grace), and answering that probe rightly
    // left the second line processing (flake hunt, 2026-10-08).
    Object.assign(knobs, { LINE_ACK_GRACE_MS: 400 })
    const h = harness()
    await enqueueMessage(SID, 'first')
    await h.internals.processNext(SID)
    await enqueueMessage(SID, 'second')
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2), { timeout: 2000 })
    const before = h.probes().length
    await vi.waitFor(() => expect(h.probes().length).toBeGreaterThan(before), { timeout: 3000 })
    h.answer(h.probes()[before].request_id)
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending', 'pending']), { timeout: 2000 })
    h.internals.onLinesReclaimedFor(SID, 'lost')
    // Both go out again under their own uuid, the older line first.
    await vi.waitFor(() => expect(h.writes.filter((w) => w.lostPid === PID).map((w) => w.message)).toEqual(['first', 'second']), { timeout: 2000 })
  })

  it('writing a lost line again leaves a pending permission for the user; a new user message still denies it', async () => {
    const h = harness()
    const resolve = vi.fn()
    let pending = true
    Object.defineProperty(h.session, 'hasPendingPermission', { get: () => pending, configurable: true })
    Object.assign(h.session, {
      getPendingPermissionRequests: () => (pending ? [{ requestId: 'perm-1', toolName: 'Bash' }] : []),
      resolvePermissionRequest: (...args: unknown[]) => { resolve(...args); pending = false },
    })
    Object.defineProperty(h.session, 'hasPendingPermission', { get: () => false, configurable: true })
    await enqueueMessage(SID, 'asked before the prompt')
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.probes()).toHaveLength(1), { timeout: 2000 })
    h.answer(h.probes()[0].request_id)
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']), { timeout: 2000 })
    // The turn asked for a permission meanwhile.
    Object.defineProperty(h.session, 'hasPendingPermission', { get: () => pending, configurable: true })
    h.internals.onLinesReclaimedFor(SID, 'lost')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2), { timeout: 3000 })
    expect(resolve).not.toHaveBeenCalled()
    h.lifecycle(h.writes[1].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    // A message the user types now is a new one: the prompt is denied for it, as before.
    await enqueueMessage(SID, 'never mind, do this instead')
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith('perm-1', false, expect.stringMatching(/User sent a new message/)), { timeout: 3000 })
  })
})
