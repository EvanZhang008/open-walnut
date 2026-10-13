/**
 * r7 gate N1: a line the r7 rule keeps for the CLI's word is watched like a
 * tracked line (send-lost-line-v1).
 *
 * The shape: the first line's write dies with the daemon, and while its confirm
 * is out the second line is handed over (it waits behind it). Meanwhile the CLI
 * takes the first line and names it, so it reports its queue. The second line was
 * handed over untracked, but its rows now wait for the CLI's word (cutLineHold
 * awaitWord). The gate's probe PN1q showed it was never watched: a tracked line
 * written right after it was. If the word never came (another reader took the
 * bytes), only the tracked line behind it was challenged and written again, so it
 * overtook the waiting one, and the waiting one sat unnamed until the process
 * ended.
 *
 * What's real: SessionRunner (processNext, injectMidTurn, the reclaim handler),
 * ClaudeCodeSession (writeMessage, the stream handler, the watch), the
 * RemoteSessionManager write chain, confirmSend and writeRaw, the disk queue.
 * Scripted: the daemon connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-awaited-word-watch'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { onLinesReclaimed, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000c04'
const PID = 12345

type Reply = Record<string, unknown> | Error
type Knobs = { LINE_ACK_GRACE_MS: number; LINE_PROBE_TIMEOUT_MS: number; LINE_PROBE_MAX_INTERVAL_MS: number }
const knobs = ClaudeCodeSession as unknown as Knobs
const saved: Knobs = { ...knobs }

let delivered: string[][] = []
let held: string[][] = []
const settle = () => new Promise((r) => setTimeout(r, 80))
const rows = async () => (await getQueue(SID)).map((m) => `${m.message}:${m.status}`)

beforeEach(async () => {
  Object.assign(knobs, { LINE_ACK_GRACE_MS: 1_000, LINE_PROBE_TIMEOUT_MS: 2_000, LINE_PROBE_MAX_INTERVAL_MS: 2_000 })
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'watch-task', 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
  delivered = []
  held = []
  bus.subscribe('main-ai', (event) => {
    const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) delivered.push(ids)
    if (event.name === EventNames.SESSION_DELIVERY_HELD) held.push(ids)
  })
})

afterEach(async () => {
  Object.assign(knobs, saved)
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

type Send = { message: string; uuid?: string; dedupe?: boolean; lostPid?: number }

/** A live session on a real RemoteSessionManager; the daemon answers each send from `plan` (ok when it runs out). */
function liveSession() {
  const sends: Send[] = []
  const raws: string[] = []
  const plan: Array<() => Promise<Reply>> = []
  const session = new ClaudeCodeSession('watch-task', 'test', '/bin/true')
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1', 'send-lost-line-v1'].includes(c),
    onEvent: () => () => {},
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      if (cmd === 'sendRaw') { raws.push(String(payload.raw)); return { ok: true } }
      if (cmd !== 'send') return { ok: true }
      sends.push({
        message: String(payload.message), uuid: payload.uuid as string | undefined,
        ...(payload.dedupe ? { dedupe: true } : {}), ...(payload.lostPid != null ? { lostPid: payload.lostPid as number } : {}),
      })
      const step = plan.shift()
      const reply = step ? await step() : { ok: true }
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
  const mgr = new RemoteSessionManager(SID, '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn, _sid: SID, _hasPipe: true, _pid: PID })
  Object.assign(session, {
    claudeSessionId: SID, _transport: mgr, _processStatus: 'idle', _active: true, pid: PID,
    resultEmitted: true, _turnResultEmitted: true, _sawCommandLifecycle: false,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    activeProcessing: Set<string>
    processNext(sid: string): Promise<void>
    injectMidTurn(sid: string): Promise<void>
    onLinesReclaimedFor(sid: string, why?: string): void
  }
  internals.sessions.set('watch-task', session)
  // As SessionRunner.init() wires it: a line handed back is delivered again by the runner.
  onLinesReclaimed((sid, why) => internals.onLinesReclaimedFor(sid, why))
  const stream = (line: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify(line))
  const lifecycle = (uuid: string, state: string) => stream({ type: 'command_lifecycle', command_uuid: uuid, state })
  /** The line probes written so far (each after a lone newline). */
  const probes = () => raws.map((raw) => {
    expect(raw.startsWith('\n')).toBe(true)
    return JSON.parse(raw.trim()) as { type: string; request_id: string; request: { subtype: string } }
  }).filter((p) => p.type === 'control_request' && p.request.subtype === 'get_settings')
  const answer = (requestId: string) => stream({
    type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { effort: 'high', model: 'test-model' } },
  })
  const deliverNext = () => (internals.activeProcessing.has(SID) ? internals.injectMidTurn(SID) : internals.processNext(SID))
  return { runner, internals, sends, plan, lifecycle, probes, answer, deliverNext }
}

/**
 * The first line's write dies with the daemon and its confirm stays out while the
 * second line is handed over; the CLI takes the first line and names it meanwhile
 * (`queued`, then `started`); then the confirm is answered ok. The second line's
 * rows now wait for the CLI's word.
 */
async function waitedLineKeptForTheWord() {
  const l = liveSession()
  let answerConfirm!: (r: Reply) => void
  l.plan.push(async () => new Error('connection closed'))
  l.plan.push(() => new Promise<Reply>((resolve) => { answerConfirm = resolve }))
  await enqueueMessage(SID, 'first message')
  const first = l.internals.processNext(SID)
  await vi.waitFor(() => expect(l.sends).toHaveLength(2), { timeout: 10_000 })
  await enqueueMessage(SID, 'second message')
  // Read while both rows are queued (the first one leaves on its write).
  const ids = new Map((await getQueue(SID)).map((m) => [m.message, m.id]))
  const second = l.internals.injectMidTurn(SID)
  await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
  const uuidA = l.sends[0].uuid!
  l.lifecycle(uuidA, 'queued')
  l.lifecycle(uuidA, 'started')
  answerConfirm({ ok: true })
  await first
  await second
  await settle()
  // The first row leaves the disk queue on its own write after it started; a fixed
  // 80 ms was not always enough on a loaded CI runner (2026-10-13, run 38441396838).
  await vi.waitFor(async () => expect((await rows()).filter((r) => r.startsWith('first message:'))).toEqual([]), { timeout: 10_000 })
  const uuidB = l.sends.find((s) => s.message === 'second message')!.uuid!
  return { l, uuidB, ids }
}

describe('a line kept for the CLI\'s word by the r7 rule (r7 gate N1)', () => {
  it('the word never comes: challenged once, written again once under its uuid, told delivered once, and it stays ahead of the line behind it', async () => {
    const { l, uuidB, ids } = await waitedLineKeptForTheWord()
    expect(await rows()).toEqual(['second message:processing'])
    // A tracked line written behind it.
    await enqueueMessage(SID, 'third message')
    const idC = (await getQueue(SID)).find((m) => m.message === 'third message')!.id
    await l.deliverNext()
    await settle()
    const uuidC = l.sends.find((s) => s.message === 'third message')!.uuid!
    expect(await rows()).toEqual(['second message:processing', 'third message:processing'])

    // No word on either. The first probe goes out behind the waiting line (its watch is
    // the older one); the CLI answers it without naming either line: it read past both.
    await vi.waitFor(() => expect(l.probes().length).toBeGreaterThan(0), { timeout: 5_000 })
    // Nothing was written again before the CLI answered it.
    expect(l.sends.filter((s) => s.lostPid != null)).toEqual([])
    l.answer(l.probes()[0].request_id)
    await vi.waitFor(() => expect(l.sends.filter((s) => s.lostPid != null)).toHaveLength(2), { timeout: 5_000 })
    // Written again in queue order, each under its own uuid, naming the process that read past it.
    expect(l.sends.filter((s) => s.lostPid != null)).toEqual([
      { message: 'second message', uuid: uuidB, dedupe: true, lostPid: PID },
      { message: 'third message', uuid: uuidC, dedupe: true, lostPid: PID },
    ])
    // The CLI takes them now.
    for (const uuid of [uuidB, uuidC]) { l.lifecycle(uuid, 'queued'); l.lifecycle(uuid, 'started') }
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 5_000 })
    await settle()

    // Each written again exactly once (a later probe of the line behind finds it rewritten).
    expect(l.sends.map((s) => s.message)).toEqual([
      'first message', 'first message', 'second message', 'third message', 'second message', 'third message',
    ])
    expect(delivered).toEqual([[ids.get('first message')], [ids.get('second message')], [idC]])
    l.runner.destroyAndKill()
  }, 30_000)

  it('control: named `queued` by the CLI, it is never challenged', async () => {
    const { l, uuidB } = await waitedLineKeptForTheWord()
    expect(await rows()).toEqual(['second message:processing'])
    l.lifecycle(uuidB, 'queued')
    await new Promise((r) => setTimeout(r, 2 * knobs.LINE_ACK_GRACE_MS + 300))
    expect(l.probes()).toEqual([])
    expect(l.sends.filter((s) => s.message === 'second message')).toHaveLength(1)
    l.lifecycle(uuidB, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]), { timeout: 5_000 })
    l.runner.destroyAndKill()
  }, 30_000)
})
