/**
 * Held phone sends and stops (round 2 of the 2026-10-01 hop fix).
 *
 * The phone, through the companion, on a session whose host is on the
 * companion's bridge while the Mac cannot reach it. Four gaps a review found in
 * round 1, each pinned here:
 *
 *   1. A send held behind an earlier held one was banked with NO stop fence, so
 *      on any session that was ever stopped the Mac refused it as "predates the
 *      latest stop", and the sweep then dropped it with the phone still told
 *      "queued". A held send keeps the fence the phone send had, and a held send
 *      that cannot go is reported to the phone (GET /sessions/:id/messages/:mid).
 *   2. The sweep's direct path never re-checked a stop requested after banking,
 *      so a message from before a stop the Mac could not deliver still ran.
 *   3. A relay that answered ok wrote nothing to the ledger, so a phone retry of
 *      the same id after the Mac went quiet took the direct path: two turns.
 *      Every relay outcome is recorded now (ok, refused, a host-side timeout).
 *   4. A held answer names the hop it actually waits on: the host, or the Mac
 *      when a relay already carried the message and the host is answering.
 *   5. No sentence starts in lower case or shows the Mac's daemon key.
 *   6. A session or host held in a sweep pass does not use up the pass for the
 *      rows behind it.
 *   7. A send a relay carried, whose answer was lost, used to wait for the Mac
 *      for as long as the Mac's link to the host was down (29 minutes in the
 *      gate) although the host took sends directly. The companion now asks the
 *      Mac whether its queue holds it, and sends it directly when it does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-hop-r2', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

const SID = 'hop-r2-sid-a'
const LABEL = 'New big devbox'
let stopRequest: { id: string; state: string; requestedAt?: string } | undefined
/** The session's host as the Mac's list has it ('' = the Mac itself). */
let rowHost = 'devbox'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: rowHost, ...(rowHost ? { host_label: LABEL } : {}), process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest,
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { enqueueSessionSend, flushSendQueue, listBankedSends, queuedSessionSendCount } from '../../../src/core/send-queue.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 52s ago)'
const PREDATES = 'Message predates the latest stop; send a new message to continue'

function createApp() {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/v1', sessionStreamV1Router)
  return app
}

const post = (body: Record<string, unknown>) =>
  request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send(body)
const status = (messageId: string) =>
  request(createApp()).get(`/api/v1/sessions/${SID}/messages/${messageId}`)

/** The Mac behind the host, enforcing the stop fence the way its queue does. */
function macBehindHost(latestFence: string | null) {
  bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (cmd !== 'session.message') throw new Error('unexpected command: ' + cmd)
    if ((p.stopFence ?? null) !== latestFence) return { ok: false, error: PREDATES, errorKind: 'session_stopped' }
    return { ok: true, result: { messageId: p.messageId } }
  })
}

/** The host on the bridge, no primary behind it, a live CLI that takes FIFO writes. */
function hostWithoutPrimary(over: Partial<Record<string, (p: Record<string, unknown>) => unknown>> = {}) {
  bridgeRequestMock.mockImplementation(async (_host: string, cmd: string, params: Record<string, unknown> = {}) => {
    if (over[cmd]) return over[cmd]!(params)
    switch (cmd) {
      case 'session.message': return { ok: false, error: NO_PRIMARY }
      case 'status': return { exists: true, alive: true }
      case 'send': return { ok: true }
      case 'appendUserMarker': return { ok: true }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}

const directSends = (): string[] =>
  bridgeRequestMock.mock.calls.filter((c) => c[1] === 'send').map((c) => String(c[2].message))
const relayCount = (messageId: string): number =>
  bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.message' && c[2]?.messageId === messageId).length

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  stopRequest = undefined
  rowHost = 'devbox'
})

afterEach(async () => {
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('1. a held send keeps its stop fence, and the phone hears when one cannot go', () => {
  it('a send held behind an earlier one carries the fence the phone send had', async () => {
    stopRequest = { id: 'stop-1', state: 'confirmed' }
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'first', messageId: 'qm-mobile-fen000000001' })).status).toBe(202)
    // The first is still held, so the second waits behind it (banked before
    // any relay is tried: the held-behind path).
    const second = await post({ text: 'second', messageId: 'qm-mobile-fen000000002' })
    expect(second.status).toBe(202)
    expect(second.body.queued).toBe(true)
    const rows = await listBankedSends()
    expect(rows.map((r) => [r.messageId, r.stopFence])).toEqual([
      ['qm-mobile-fen000000001', 'stop-1'],
      ['qm-mobile-fen000000002', 'stop-1'],
    ])
  })

  it('on a session stopped once before, both held sends reach the Mac\'s queue (none refused as predating the stop)', async () => {
    stopRequest = { id: 'stop-1', state: 'confirmed' }
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    await post({ text: 'first', messageId: 'qm-mobile-fen000000003' })
    await post({ text: 'second', messageId: 'qm-mobile-fen000000004' })
    await flushSendQueue() // let the held-behind send's own drain finish (still offline)
    bridgeRequestMock.mockClear()
    // The host and the Mac behind it are back.
    macBehindHost('stop-1')
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(0)
    expect(directSends()).toEqual([])
    const relayed = bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.message').map((c) => [c[2].messageId, c[2].stopFence])
    expect(relayed).toEqual([['qm-mobile-fen000000003', 'stop-1'], ['qm-mobile-fen000000004', 'stop-1']])
    for (const id of ['qm-mobile-fen000000003', 'qm-mobile-fen000000004']) {
      const s = await status(id)
      expect(s.status, s.text).toBe(200)
      expect(s.body.state, `${id}: ${s.text}`).toBe('delivered')
    }
  })

  it('a held send the Mac refuses (a stop came after it) is reported to the phone, and a retry is answered, not re-sent', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'held', messageId: 'qm-mobile-ref000000001' })).status).toBe(202)
    macBehindHost('stop-9')
    await flushSendQueue()
    expect(await queuedSessionSendCount(), 'the row is settled, not kept').toBe(0)
    const s = await status('qm-mobile-ref000000001')
    expect(s.status, s.text).toBe(200)
    expect(s.body).toMatchObject({ messageId: 'qm-mobile-ref000000001', state: 'not_sent', code: 'session_stopped' })
    expect(String(s.body.message)).toMatch(/stopped after you sent/)
    bridgeRequestMock.mockClear()
    const retry = await post({ text: 'held', messageId: 'qm-mobile-ref000000001' })
    expect(retry.status).toBe(409)
    expect(retry.body.error.code).toBe('session_stopped')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a held send is "held" while it waits, naming the host', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    await post({ text: 'wait', messageId: 'qm-mobile-wai000000001' })
    const s = await status('qm-mobile-wai000000001')
    expect(s.status, s.text).toBe(200)
    expect(s.body).toMatchObject({ state: 'held', waitingFor: 'devbox', waitingForName: LABEL, heldNote: `Can't reach ${LABEL} right now.` })
  })
})

describe('2. a stop requested after a send was held is checked at delivery time', () => {
  it('the sweep\'s direct path does not deliver a message from before a stop the Mac could not deliver', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'before the stop', messageId: 'qm-mobile-stp000000001' })).status).toBe(202)
    // The phone stopped the session; the Mac recorded it but cannot reach the host.
    stopRequest = { id: 'stop-2', state: 'pending' }
    hostWithoutPrimary()
    await flushSendQueue()
    expect(directSends(), 'never delivered past the stop').toEqual([])
    expect(await queuedSessionSendCount()).toBe(0)
    const s = await status('qm-mobile-stp000000001')
    expect(s.body).toMatchObject({ state: 'not_sent', code: 'session_stopped' })
  })

  it('the route\'s direct path re-checks a stop that arrived while the relay was out', async () => {
    hostWithoutPrimary({
      'session.message': () => {
        stopRequest = { id: 'stop-3', state: 'pending' }
        return { ok: false, error: NO_PRIMARY }
      },
    })
    const res = await post({ text: 'racing the stop', messageId: 'qm-mobile-stp000000002' })
    expect(res.status, res.text).toBe(409)
    expect(res.body.error.code).toBe('session_stopped')
    expect(directSends()).toEqual([])
  })

  it('a stop the phone asked for through the companion holds back older held sends before the Mac\'s list shows it', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    await post({ text: 'older', messageId: 'qm-mobile-stp000000003' })
    const { noteStopRequested } = await import('../../../src/core/sessions/cloud-stop-fence.js')
    await noteStopRequested(SID)
    hostWithoutPrimary()
    await flushSendQueue()
    expect(directSends()).toEqual([])
    expect((await status('qm-mobile-stp000000003')).body.state).toBe('not_sent')
    // A send made after that stop is not refused by it. The stop was never
    // answered, though (it may have landed on the Mac), so the send is held for
    // the Mac rather than sent by the host's own path (gate r2), and the Mac
    // takes it once it reaches the host again.
    await new Promise((r) => setTimeout(r, 5))
    const after = await post({ text: 'newer', messageId: 'qm-mobile-stp000000004' })
    expect(after.status, after.text).toBe(202)
    expect(after.body.queued).toBe(true)
    await flushSendQueue()
    expect(directSends()).toEqual([])
    macBehindHost(null)
    await flushSendQueue()
    expect(relayCount('qm-mobile-stp000000004')).toBeGreaterThan(1)
    expect((await status('qm-mobile-stp000000004')).body.state).toBe('delivered')
    expect(directSends()).toEqual([])
  })
})

describe('3. a relay that answered ok is remembered for that message id', () => {
  it('a retry after the Mac went quiet is answered, never sent by the direct path', async () => {
    macBehindHost(null)
    const first = await post({ text: 'once', messageId: 'qm-mobile-rel000000001' })
    expect(first.status).toBe(202)
    expect(first.body.queued).toBeUndefined()
    // The Mac's link to the host died; the phone retries the same id.
    hostWithoutPrimary()
    const retry = await post({ text: 'once', messageId: 'qm-mobile-rel000000001' })
    expect(retry.status).toBe(202)
    expect(retry.body).toEqual({ messageId: 'qm-mobile-rel000000001' })
    expect(directSends(), 'the Mac already has it').toEqual([])
    expect(relayCount('qm-mobile-rel000000001')).toBe(1)
    expect((await status('qm-mobile-rel000000001')).body.state).toBe('delivered')
  })

  it('the same for a held send the sweep relayed', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    await post({ text: 'swept', messageId: 'qm-mobile-rel000000002' })
    macBehindHost(null)
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(0)
    hostWithoutPrimary()
    bridgeRequestMock.mockClear()
    const retry = await post({ text: 'swept', messageId: 'qm-mobile-rel000000002' })
    expect(retry.status).toBe(202)
    expect(directSends()).toEqual([])
    expect(relayCount('qm-mobile-rel000000002')).toBe(0)
  })
})

describe('3b. every relay outcome is recorded, text and image', () => {
  it('a relay that timed out at the host is relay-only from then on: its retry is held, never sent direct', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: false, error: 'session.message: primary server timed out' }
      throw new Error('unexpected command: ' + cmd)
    })
    const first = await post({ text: 'slow', messageId: 'qm-mobile-tmo000000001' })
    expect(first.status, first.text).toBe(503)
    hostWithoutPrimary()
    const retry = await post({ text: 'slow', messageId: 'qm-mobile-tmo000000001' })
    expect(retry.status, retry.text).toBe(202)
    expect(retry.body.queued).toBe(true)
    expect(directSends(), 'the Mac may hold the first try').toEqual([])
    await flushSendQueue()
    expect(directSends(), 'nor does the sweep send it direct').toEqual([])
    expect(await queuedSessionSendCount()).toBe(1)
  })

  it('a relay the Mac refused as predating a stop is answered from the ledger on a retry', async () => {
    macBehindHost('stop-5')
    const first = await post({ text: 'late', messageId: 'qm-mobile-ref000000002' })
    expect(first.status, first.text).toBe(409)
    expect(first.body.error.code).toBe('session_stopped')
    hostWithoutPrimary()
    bridgeRequestMock.mockClear()
    const retry = await post({ text: 'late', messageId: 'qm-mobile-ref000000002' })
    expect(retry.status, retry.text).toBe(409)
    expect(retry.body.error.code).toBe('session_stopped')
    expect(bridgeRequestMock, 'nothing goes out again').not.toHaveBeenCalled()
    expect((await status('qm-mobile-ref000000002')).body).toMatchObject({ state: 'not_sent', code: 'session_stopped' })
  })
})

describe('4. a held answer names the hop it waits on', () => {
  it('a relay-only send held while the host answers names the Mac, here and in the status', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') throw new Error('socket hang up')
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await post({ text: 'maybe', messageId: 'qm-mobile-hop000000001' })).status).toBe(503)
    hostWithoutPrimary()
    const retry = await post({ text: 'maybe', messageId: 'qm-mobile-hop000000001' })
    expect(retry.status, retry.text).toBe(202)
    const mac = { waitingFor: '', waitingForName: 'your Mac', heldNote: `Your Mac can't reach ${LABEL} right now.` }
    expect(retry.body).toMatchObject({ queued: true, ...mac })
    expect((await status('qm-mobile-hop000000001')).body).toMatchObject({ state: 'held', ...mac })
  })

  it('a send held because the host is off the companion names the host', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await post({ text: 'off', messageId: 'qm-mobile-hop000000002' })
    expect(res.body).toMatchObject({ queued: true, waitingFor: 'devbox', waitingForName: LABEL, heldNote: `Can't reach ${LABEL} right now.` })
  })
})

describe('5. sentences', () => {
  it('a sentence about the Mac starts with a capital', async () => {
    rowHost = ''
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const img = { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }
    // An image send is held like a text one now (round 3), its pictures with it.
    const res = await post({ text: 'pic', images: [img], messageId: 'qm-mobile-sen000000001' })
    expect(res.status, res.text).toBe(202)
    expect(res.body).toMatchObject({ queued: true, waitingFor: '', waitingForName: 'your Mac', heldNote: "Can't reach your Mac right now." })
  })

  it('a relay error that mentions the Mac\'s daemon key reads "your Mac"', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: false, error: 'session.message: relay to __local__ failed' }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await post({ text: 'x', messageId: 'qm-mobile-sen000000002' })
    expect(res.status, res.text).toBe(503)
    expect(res.text).not.toContain('__local__')
    expect(res.body.error.message).toBe(`Couldn't hand the message to ${LABEL} (relay to your Mac failed). Try again shortly.`)
  })
})

describe('6. the sweep budget', () => {
  it('rows held behind a held host or session do not use up the pass for a row after them', async () => {
    // 55 rows for a host that is off the companion, 55 relay-only rows of one
    // session the Mac must deliver, then one send nothing ever carried.
    for (let i = 0; i < 55; i++) {
      await enqueueSessionSend('hop-r2-sid-off', 'offbox', `off ${i}`, `qm-mobile-off${String(i).padStart(9, '0')}`, null, { provablyUnsent: true })
    }
    for (let i = 0; i < 55; i++) {
      await enqueueSessionSend('hop-r2-sid-mac', 'devbox', `mac ${i}`, `qm-mobile-mac${String(i).padStart(9, '0')}`, null)
    }
    await enqueueSessionSend(SID, 'devbox', 'behind them', 'qm-mobile-bud000000001', null, { provablyUnsent: true, hostName: LABEL })
    hostWithoutPrimary()
    const offline = bridgeRequestMock.getMockImplementation()!
    bridgeRequestMock.mockImplementation(async (h: string, cmd: string, p?: Record<string, unknown>) => {
      if (h === 'offbox') throw new BridgeOfflineError(h)
      return offline(h, cmd, p)
    })
    await flushSendQueue()
    expect(directSends()).toEqual(['behind them'])
    expect(await queuedSessionSendCount()).toBe(110)
    const relays = bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.message').length
    expect(relays, 'one try per held host or session, then the row behind them').toBe(3)
    expect((await status('qm-mobile-bud000000001')).body.state).toBe('delivered')
  })
})

describe('7. a relay-only send goes to the host directly once the Mac says it does not hold it', () => {
  /** The relay's answer was lost (the Mac may hold it), then the host has no Mac behind it. */
  async function relayOnly(text: string, messageId: string) {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') throw new Error('socket hang up')
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await post({ text, messageId })).status).toBe(503)
  }
  const withdraws = () => bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.control' && c[2]?.action === 'message.withdraw')
  /** The host takes sends; the Mac, over its own bridge, answers the withdraw with `state`. */
  const macSays = (state: string, over: Partial<Record<string, (p: Record<string, unknown>) => unknown>> = {}) => hostWithoutPrimary({
    'session.control': (p) => {
      if (p.action !== 'message.withdraw') throw new Error('unexpected action: ' + String(p.action))
      return { ok: true, result: { state } }
    },
    ...over,
  })

  for (const state of ['not-received', 'withdrawn']) {
    it(`the Mac answers ${state}: delivered directly, once, and a retry is answered`, async () => {
      const mid = state === 'withdrawn' ? 'qm-mobile-wdr000000001' : 'qm-mobile-wdr000000002'
      await relayOnly('lost answer', mid)
      macSays(state)
      const retry = await post({ text: 'lost answer', messageId: mid })
      expect(retry.status, retry.text).toBe(202)
      expect(retry.body.waitingForName, 'held for the Mac until it answers').toBe('your Mac')
      await flushSendQueue()
      expect(withdraws().map((c) => c[2].params?.messageId)).toContain(mid)
      expect(directSends()).toEqual(['lost answer'])
      expect(await queuedSessionSendCount()).toBe(0)
      expect((await status(mid)).body.state).toBe('delivered')
      bridgeRequestMock.mockClear()
      const again = await post({ text: 'lost answer', messageId: mid })
      expect(again.status).toBe(202)
      expect(directSends(), 'never a second turn').toEqual([])
    })
  }

  it('the Mac answers delivered (its queue took it): never sent directly, and the phone hears it went', async () => {
    await relayOnly('ran there', 'qm-mobile-wdr000000003')
    macSays('delivered')
    expect((await post({ text: 'ran there', messageId: 'qm-mobile-wdr000000003' })).status).toBe(202)
    await flushSendQueue()
    expect(directSends()).toEqual([])
    expect(await queuedSessionSendCount()).toBe(0)
    expect((await status('qm-mobile-wdr000000003')).body.state).toBe('delivered')
  })

  for (const [what, setup] of [
    ['mid-delivery', () => macSays('delivering')],
    ['cannot be asked', () => hostWithoutPrimary({ 'session.control': () => { throw new BridgeOfflineError('__local__') } })],
  ] as const) {
    it(`the Mac is ${what}: kept for the Mac, never sent directly`, async () => {
      await relayOnly('wait', 'qm-mobile-wdr000000004')
      setup()
      expect((await post({ text: 'wait', messageId: 'qm-mobile-wdr000000004' })).status).toBe(202)
      await flushSendQueue()
      expect(directSends()).toEqual([])
      expect(await queuedSessionSendCount()).toBe(1)
      expect((await status('qm-mobile-wdr000000004')).body).toMatchObject({ state: 'held', waitingForName: 'your Mac' })
    })
  }

  it('the sends held behind it follow it, in order, once each', async () => {
    await relayOnly('first', 'qm-mobile-wdr000000005')
    // The Mac answers only once the second send is in: until then the first is
    // banked (the drain its 202 starts is waiting on that answer), so the
    // second must wait behind it rather than overtake it.
    let answer!: () => void
    const answered = new Promise<void>((resolve) => { answer = resolve })
    macSays('not-received', {
      'session.control': async (p) => {
        if (p.action !== 'message.withdraw') throw new Error('unexpected action: ' + String(p.action))
        await answered
        return { ok: true, result: { state: 'not-received' } }
      },
    })
    const first = await post({ text: 'first', messageId: 'qm-mobile-wdr000000005' })
    expect(first.status).toBe(202)
    const second = await post({ text: 'second', messageId: 'qm-mobile-wdr000000006' })
    expect(second.status).toBe(202)
    expect(second.body.queued).toBe(true)
    expect(directSends(), 'nothing goes before the Mac answers').toEqual([])
    answer()
    await flushSendQueue()
    expect(directSends()).toEqual(['first', 'second'])
    expect(await queuedSessionSendCount()).toBe(0)
  })

  it('an image send is held like a text one, and goes directly once the Mac says it never had it', async () => {
    const img = { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'image.save') return { ok: true, path: '/tmp/img-0.png' }
      if (cmd === 'session.message') return { ok: false, error: 'session.message: primary server timed out' }
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await post({ text: 'pic', images: [img], messageId: 'qm-mobile-wdr000000007' })).status).toBe(503)
    macSays('not-received', { 'image.save': () => ({ ok: true, path: '/tmp/img-1.png' }) })
    const retry = await post({ text: 'pic', images: [img], messageId: 'qm-mobile-wdr000000007' })
    expect(retry.status, retry.text).toBe(202)
    expect(retry.body).toMatchObject({ queued: true, waitingForName: 'your Mac' })
    await flushSendQueue()
    expect(withdraws().map((c) => c[2].params?.messageId), 'the Mac is asked first').toContain('qm-mobile-wdr000000007')
    expect(directSends()).toHaveLength(1)
    expect(directSends()[0]).toContain('/tmp/img-1.png')
  })

  /** An image relay whose answer was lost, then a retry once the host has no Mac behind it. */
  async function imageRelayLost(messageId: string) {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'image.save') return { ok: true, path: '/tmp/img-0.png' }
      if (cmd === 'session.message') return { ok: false, error: 'session.message: primary server timed out' }
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await post({ text: 'pic', images: [IMG], messageId })).status).toBe(503)
  }
  const IMG = { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }

  it('an image send the Mac already delivered is answered, never sent a second time', async () => {
    await imageRelayLost('qm-mobile-wdr000000008')
    macSays('delivered', { 'image.save': () => ({ ok: true, path: '/tmp/img-1.png' }) })
    const retry = await post({ text: 'pic', images: [IMG], messageId: 'qm-mobile-wdr000000008' })
    expect(retry.status, retry.text).toBe(202)
    await flushSendQueue()
    expect(directSends(), 'the Mac ran it: no second turn').toEqual([])
    expect((await status('qm-mobile-wdr000000008')).body.state).toBe('delivered')
  })

  it('an image send the Mac cannot be asked about is held in the Mac\'s name, and is not sent', async () => {
    await imageRelayLost('qm-mobile-wdr000000009')
    hostWithoutPrimary({
      'image.save': () => ({ ok: true, path: '/tmp/img-1.png' }),
      'session.control': () => { throw new BridgeOfflineError('__local__') },
    })
    const retry = await post({ text: 'pic', images: [IMG], messageId: 'qm-mobile-wdr000000009' })
    expect(retry.status, retry.text).toBe(202)
    expect(retry.body).toMatchObject({ queued: true, waitingFor: '', waitingForName: 'your Mac' })
    await flushSendQueue()
    expect(directSends()).toEqual([])
  })
})
