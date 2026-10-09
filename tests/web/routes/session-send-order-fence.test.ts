/**
 * The companion half of the withdraw protocol (gate r2 regressions, G1 to G12),
 * against a model of the Mac and the host.
 *
 * The model: the host daemon answers the relay with "no primary" when the Mac's
 * link is quiet, else it forwards the frame to the Mac, which takes it into its
 * queue (deduped by its fates) and answers. A frame can be held in transit
 * (`deferRelays`), which is what a link that stalls and then resumes does. The
 * Mac's withdraw follows core/relay-fates.ts: it fences what it gives back or
 * never saw, answers 'behind' while an earlier message of the session waits in
 * its queue, and refuses a fenced id later. The host's stream records a
 * delivery marker per message (the Mac's runner and the direct path write one).
 * `cli` records every message the CLI received, in order, by either path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-send-fence', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
const onBridge = new Map<string, boolean>()
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: (h: string) => ({ connected: onBridge.get(h) ?? true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
  addPrimaryBridgeConnectedHandler: () => () => {},
  addBridgeConnectedHandler: () => () => {},
}))

const SID = 'fence-cloud-sid'
const LABEL = 'Marina devbox'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', host_label: LABEL, process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus',
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { flushSendQueue, queuedSessionSendCount } from '../../../src/core/send-queue.js'
import { flushOnce } from '../../../src/core/send-queue-sweep.js'
import { forgetRunningDirectSends } from '../../../src/core/sessions/direct-host-send.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 52s ago)'
const app = () => {
  const a = express(); a.use(express.json({ limit: '5mb' }))
  a.use('/api/v1', sessionStreamV1Router); a.use('/api/v1', sessionExtrasV1Router); return a
}
const post = (body: Record<string, unknown>) => request(app()).post(`/api/v1/sessions/${SID}/messages`).send(body)
const statusOf = (mid: string) => request(app()).get(`/api/v1/sessions/${SID}/messages/${mid}`)
const IMG = { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }

type Fate = 'taken' | 'removed' | 'withdrawn' | 'fenced'
interface MacRow { id: string; text: string; status: 'pending' | 'processing' }
let mac: {
  link: 'up' | 'quiet'; bridge: boolean; queue: MacRow[]; fates: Map<string, Fate>
  deferRelays: boolean; inFlight: Array<(land?: boolean) => void>
  onWithdraw?: (state: string) => void | Promise<void>
}
/** Every message the CLI received, in order. */
let cli: string[] = []
/** The session's stream on the host: one marker per delivered message. */
let hostStream: string[] = []
let hostUp = true
let markerHang: Promise<void> | null = null

const marker = (id: string) => JSON.stringify({ type: 'user', subtype: 'walnut-injected', walnutMessageId: id })

function macTakes(p: Record<string, unknown>): Record<string, unknown> {
  const id = String(p.messageId)
  const fate = mac.fates.get(id)
  if (fate === 'withdrawn' || fate === 'fenced') return { ok: false, error: 'the companion took this message back before it arrived', errorKind: 'withdrawn' }
  if (fate === 'removed') return { ok: false, error: 'it was removed on the Mac before it ran', errorKind: 'removed' }
  if (fate === 'taken' || mac.queue.some((r) => r.id === id)) return { ok: true, result: { messageId: id } }
  mac.queue.push({ id, text: String(p.message), status: 'pending' })
  mac.fates.set(id, 'taken')
  return { ok: true, result: { messageId: id } }
}
/** The Mac's link to the host is back: its queue delivers, in order, each with its marker. */
function macDeliverAll(): void {
  for (const row of mac.queue.splice(0)) { cli.push(row.text); hostStream.push(marker(row.id)) }
}
function macWithdraw(id: string): string {
  const at = mac.queue.findIndex((r) => r.id === id)
  if (at !== -1) {
    if (mac.queue[at].status === 'processing') return 'delivering'
    if (mac.queue.slice(0, at).length > 0) return 'behind'
    mac.queue.splice(at, 1)
    mac.fates.set(id, 'withdrawn')
    return 'withdrawn'
  }
  const fate = mac.fates.get(id)
  if (fate === 'taken') return 'delivered'
  if (fate === 'removed') return 'removed'
  if (fate === 'withdrawn') return 'withdrawn'
  if (fate === 'fenced') return 'not-received'
  if (mac.queue.length > 0) return 'behind'
  mac.fates.set(id, 'fenced')
  return 'not-received'
}

function wire(): void {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (host === '__local__') {
      if (!mac.bridge) throw new BridgeOfflineError('__local__')
      if (cmd === 'session.control' && p.action === 'message.withdraw') {
        const state = macWithdraw(String((p.params as Record<string, unknown>).messageId))
        await mac.onWithdraw?.(state)
        return { ok: true, result: { state } }
      }
      if (cmd === 'session.control' && p.action === 'queue') {
        return { ok: true, result: { messages: mac.queue.map((r) => ({ id: r.id, sessionId: SID, message: r.text, status: r.status })) } }
      }
      throw new Error(`unexpected __local__ ${cmd} ${String(p.action)}`)
    }
    if (!hostUp) throw new BridgeOfflineError(host)
    switch (cmd) {
      case 'session.message':
        if (mac.link === 'quiet') return { ok: false, error: NO_PRIMARY }
        if (mac.deferRelays) {
          return new Promise((resolve) => {
            // A held frame either lands on the Mac (its answer lost) or is lost on the way; either
            // way the relay's own timer ends it with a transport timeout, as the real one does.
            mac.inFlight.push((land = true) => { if (land) macTakes(p); resolve({ ok: false, error: 'session.message: primary server timed out' }) })
          })
        }
        return macTakes(p)
      case 'ping': return { ok: true }
      case 'status': return { exists: true, alive: true }
      case 'send': cli.push(String(p.message)); return { ok: true }
      case 'appendUserMarker':
        if (markerHang) await markerHang
        hostStream.push(marker(String(p.messageId)))
        return { ok: true }
      case 'read-history': return { ok: true, main: hostStream.join('\n') }
      case 'image.save': return { ok: true, path: '/tmp/img-1.png' }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}
const count = (text: string) => cli.filter((t) => t === text || t.endsWith(`\n\n${text}`)).length
/** Let the route's after-answer work run (its drain leaves a row whose relay is still out alone). */
const settle = () => new Promise((r) => setTimeout(r, 150))
/** Frames held in transit land on the Mac now. */
const landFrames = () => { for (const f of mac.inFlight.splice(0)) f(true) }
/** Frames held in transit were lost with the link: the Mac never sees them. */
const loseFrames = () => { for (const f of mac.inFlight.splice(0)) f(false) }
const textOrder = () => cli.map((t) => t.split('\n\n').pop())

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  mac = { link: 'up', bridge: true, queue: [], fates: new Map(), deferRelays: false, inFlight: [] }
  cli = []
  hostStream = []
  hostUp = true
  markerHang = null
  onBridge.clear()
  wire()
})
afterEach(async () => {
  loseFrames()
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('G1 the Mac answered not-received while the first relay was still in transit', () => {
  it('the late frame is refused there: one delivery', async () => {
    mac.deferRelays = true
    const first = await post({ text: 'g1-text', messageId: 'qm-mobile-g10000000001' })
    expect(first.status).toBe(202)
    expect(first.body.queued).toBe(true)
    mac.link = 'quiet'
    await flushSendQueue()
    // The stalled link resumes: the frame lands on the Mac, whose link to the host then returns.
    landFrames()
    await new Promise((r) => setTimeout(r, 50))
    mac.link = 'up'
    macDeliverAll()
    expect({ deliveries: count('g1-text'), macQueue: mac.queue.length }).toEqual({ deliveries: 1, macQueue: 0 })
  }, 40_000)
})

describe('G2 an earlier message of the session still waits in the Mac\'s queue', () => {
  it('the later one is not given back, so it never overtakes', async () => {
    expect((await post({ text: 'g2-earlier', messageId: 'qm-mobile-g20000000001' })).status).toBe(202)
    mac.deferRelays = true
    expect((await post({ text: 'g2-later', messageId: 'qm-mobile-g20000000002' })).status).toBe(202)
    await settle()
    landFrames() // the frame lands; its answer was lost
    await new Promise((r) => setTimeout(r, 50))
    mac.deferRelays = false
    mac.link = 'quiet'
    await flushSendQueue()
    expect(cli).toEqual([])
    mac.link = 'up'
    macDeliverAll()
    await flushSendQueue()
    expect(textOrder()).toEqual(['g2-earlier', 'g2-later'])
  }, 40_000)
})

describe('G3 a new send while the Mac\'s queue still holds an earlier relayed one (host has no Mac behind it)', () => {
  it('the new send is held for the Mac and goes after the earlier one', async () => {
    expect((await post({ text: 'g3-earlier', messageId: 'qm-mobile-g30000000001' })).status).toBe(202)
    mac.link = 'quiet'
    const later = await post({ text: 'g3-later', messageId: 'qm-mobile-g30000000002' })
    expect(later.status).toBe(202)
    expect(later.body).toMatchObject({ queued: true, waitingForName: 'your Mac' })
    expect(cli).toEqual([])
    mac.link = 'up'
    macDeliverAll()
    await flushSendQueue()
    macDeliverAll()
    expect(textOrder()).toEqual(['g3-earlier', 'g3-later'])
  })

  it('with the Mac off the companion, an earlier relay nobody saw delivered still holds it', async () => {
    expect((await post({ text: 'g3b-earlier', messageId: 'qm-mobile-g30000000003' })).status).toBe(202)
    mac.link = 'quiet'
    mac.bridge = false
    const later = await post({ text: 'g3b-later', messageId: 'qm-mobile-g30000000004' })
    expect(later.body).toMatchObject({ queued: true, waitingForName: 'your Mac' })
    expect(cli).toEqual([])
    // The earlier one's delivery marker shows on the host: the later one may go directly.
    macDeliverAll()
    await flushSendQueue()
    expect(textOrder()).toEqual(['g3b-earlier', 'g3b-later'])
  })
})

describe('G4 the Mac answers delivering, then delivered', () => {
  it('held for the Mac, then settled delivered, never sent directly', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'g4', messageId: 'qm-mobile-g40000000001' })).status).toBe(202)
    await settle()
    landFrames()
    await new Promise((r) => setTimeout(r, 50))
    mac.deferRelays = false
    mac.queue[0].status = 'processing'
    mac.link = 'quiet'
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(1)
    expect((await statusOf('qm-mobile-g40000000001')).body).toMatchObject({ state: 'held', waitingForName: 'your Mac' })
    macDeliverAll()
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(0)
    expect((await statusOf('qm-mobile-g40000000001')).body.state).toBe('delivered')
    expect(count('g4')).toBe(1)
  }, 40_000)
})

describe('G5 the Mac off the companion, then back', () => {
  it('held naming the Mac, listed by the queue route, then delivered once', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'g5', messageId: 'qm-mobile-g50000000001' })).status).toBe(202)
    // The frame was lost with the link (never lands).
    await settle()
    loseFrames()
    mac.deferRelays = false
    mac.link = 'quiet'
    mac.bridge = false
    onBridge.set('__local__', false)
    await flushSendQueue()
    const st = await statusOf('qm-mobile-g50000000001')
    expect(st.body).toMatchObject({ state: 'held', waitingFor: '', waitingForName: 'your Mac', heldNote: "Your Mac isn't connected right now." })
    const q = await request(app()).get(`/api/v1/sessions/${SID}/queue`)
    expect(q.status).toBe(200)
    expect(q.body.partial).toBe(true)
    expect(q.body.messages.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([['qm-mobile-g50000000001', 'held']])
    expect(cli).toEqual([])
    mac.bridge = true
    onBridge.set('__local__', true)
    await flushSendQueue()
    expect(count('g5')).toBe(1)
    expect(await queuedSessionSendCount()).toBe(0)
  }, 40_000)
})

describe('G6 the Mac withdrew it but its answer was lost', () => {
  it('asked again: the same answer, delivered once', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'g6', messageId: 'qm-mobile-g60000000001' })).status).toBe(202)
    await settle()
    landFrames()
    await new Promise((r) => setTimeout(r, 50))
    mac.deferRelays = false
    mac.link = 'quiet'
    let lose = true
    mac.onWithdraw = () => { if (lose) { lose = false; throw new Error('bridge request timed out: session.control') } }
    await flushSendQueue()
    expect(cli).toEqual([])
    await flushSendQueue()
    mac.link = 'up'
    macDeliverAll()
    expect(count('g6')).toBe(1)
  }, 40_000)
})

describe('G7 concurrent retries of one id, host with no Mac behind it', () => {
  it('one delivery', async () => {
    mac.link = 'quiet'
    const [a, b, c] = await Promise.all([
      post({ text: 'g7', messageId: 'qm-mobile-g70000000001' }),
      post({ text: 'g7', messageId: 'qm-mobile-g70000000001' }),
      post({ text: 'g7', messageId: 'qm-mobile-g70000000001' }),
    ])
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202])
    await flushSendQueue()
    expect(count('g7')).toBe(1)
  })
})

describe('G8 an image send while an earlier text send of the session is held for the Mac', () => {
  it('the image does not overtake the held text', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'g8-text', messageId: 'qm-mobile-g80000000001' })).status).toBe(202)
    await settle()
    loseFrames()
    mac.deferRelays = false
    mac.link = 'quiet'
    mac.bridge = false
    await flushSendQueue()
    const img = await post({ text: 'g8-image', images: [IMG], messageId: 'qm-mobile-g80000000002' })
    expect(img.status).toBe(202)
    expect(img.body.queued).toBe(true)
    expect(textOrder()).toEqual([])
  }, 40_000)
})

describe('G9 the companion restarts after a direct delivery went out, before it recorded it', () => {
  async function sendDirectAndHang(mid: string): Promise<{ release: () => void; old: Promise<unknown> }> {
    hostUp = false
    expect((await post({ text: mid, messageId: mid })).status).toBe(202)
    hostUp = true
    mac.link = 'quiet'
    let release!: () => void
    markerHang = new Promise<void>((r) => { release = r })
    const old = flushSendQueue()
    for (let i = 0; i < 100 && count(mid) === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(count(mid)).toBe(1)
    return { release, old }
  }

  it('a pass in the same process leaves the running delivery alone', async () => {
    const { release, old } = await sendDirectAndHang('qm-mobile-g90000000001')
    markerHang = null
    await flushOnce()
    const deliveries = count('qm-mobile-g90000000001')
    release(); await old
    expect({ deliveries }).toEqual({ deliveries: 1 })
  })

  it('a restarted process asks the host and never sends it blind', async () => {
    const { release, old } = await sendDirectAndHang('qm-mobile-g90000000002')
    // A new process: nothing in memory, only what is on disk.
    forgetRunningDirectSends()
    await flushOnce()
    const deliveries = count('qm-mobile-g90000000002')
    // No marker on the host (the old process died before writing it): told it may have run.
    const st = await statusOf('qm-mobile-g90000000002')
    markerHang = null
    release(); await old
    expect({ deliveries, state: st.body.state }).toEqual({ deliveries: 1, state: 'unknown' })
  })

  it('a restarted process that finds the marker settles it delivered', async () => {
    const { release, old } = await sendDirectAndHang('qm-mobile-g90000000003')
    hostStream.push(marker('qm-mobile-g90000000003'))
    forgetRunningDirectSends()
    await flushOnce()
    const deliveries = count('qm-mobile-g90000000003')
    const st = await statusOf('qm-mobile-g90000000003')
    markerHang = null
    release(); await old
    expect({ deliveries, state: st.body.state }).toEqual({ deliveries: 1, state: 'delivered' })
  })
})

describe('G10 a stop asked while the withdraw was out', () => {
  it('the withdrawn message is not delivered, and the phone hears not_sent', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'g10', messageId: 'qm-mobile-g100000000001' })).status).toBe(202)
    await settle()
    loseFrames()
    mac.deferRelays = false
    mac.link = 'quiet'
    const { noteStopRequested } = await import('../../../src/core/sessions/cloud-stop-fence.js')
    mac.onWithdraw = async () => { await noteStopRequested(SID) }
    await flushSendQueue()
    await new Promise((r) => setTimeout(r, 50))
    await flushSendQueue()
    expect(count('g10')).toBe(0)
    expect((await statusOf('qm-mobile-g100000000001')).body.state).toBe('not_sent')
  }, 40_000)
})

describe('G11 the answer deadline on the direct path', () => {
  it('answers within 8 s even when the host is slow to take the direct send, and delivers once', async () => {
    mac.link = 'quiet'
    bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (host === '__local__') throw new BridgeOfflineError('__local__')
      switch (cmd) {
        case 'session.message': return { ok: false, error: NO_PRIMARY }
        case 'status': await new Promise((r) => setTimeout(r, 6_000)); return { exists: true, alive: true }
        case 'send': await new Promise((r) => setTimeout(r, 6_000)); cli.push(String(p.message)); return { ok: true }
        case 'appendUserMarker': return { ok: true }
        default: throw new Error('unexpected ' + cmd)
      }
    })
    const t0 = Date.now()
    const res = await post({ text: 'g11', messageId: 'qm-mobile-g110000000001' })
    const ms = Date.now() - t0
    expect({ status: res.status, queued: res.body.queued, within8s: ms <= 8_500 }).toEqual({ status: 202, queued: true, within8s: true })
    // A retry while the delivery is still out is answered from the hold, not sent again.
    const retry = await post({ text: 'g11', messageId: 'qm-mobile-g110000000001' })
    expect(retry.status).toBe(202)
    await flushSendQueue()
    for (let i = 0; i < 100 && count('g11') === 0; i++) await new Promise((r) => setTimeout(r, 100))
    await new Promise((r) => setTimeout(r, 200))
    expect(count('g11')).toBe(1)
    expect((await statusOf('qm-mobile-g110000000001')).body.state).toBe('delivered')
    expect(await queuedSessionSendCount()).toBe(0)
  }, 40_000)
})

describe('G12 held while the host was off the companion, the host returns while the Mac still reaches it', () => {
  it('delivered once through the Mac, and a retry after the Mac goes quiet is not a second turn', async () => {
    hostUp = false
    expect((await post({ text: 'g12', messageId: 'qm-mobile-g120000000001' })).status).toBe(202)
    hostUp = true
    await flushSendQueue()
    expect(mac.queue.map((r) => r.id)).toEqual(['qm-mobile-g120000000001'])
    macDeliverAll()
    mac.link = 'quiet'
    const retry = await post({ text: 'g12', messageId: 'qm-mobile-g120000000001' })
    expect(retry.status).toBe(202)
    expect(count('g12')).toBe(1)
    expect((await statusOf('qm-mobile-g120000000001')).body.state).toBe('delivered')
  })
})

describe('a message removed on the Mac', () => {
  it('is reported not sent, removed on the Mac, never delivered', async () => {
    mac.deferRelays = true
    expect((await post({ text: 'rm', messageId: 'qm-mobile-rm0000000001' })).status).toBe(202)
    await settle()
    landFrames()
    await new Promise((r) => setTimeout(r, 50))
    mac.deferRelays = false
    // A person discards it on the Mac.
    mac.queue = []
    mac.fates.set('qm-mobile-rm0000000001', 'removed')
    mac.link = 'quiet'
    await flushSendQueue()
    expect(cli).toEqual([])
    expect((await statusOf('qm-mobile-rm0000000001')).body).toMatchObject({ state: 'not_sent', code: 'removed_on_mac' })
    const retry = await post({ text: 'rm', messageId: 'qm-mobile-rm0000000001' })
    expect(retry.status).toBe(409)
    expect(retry.body.error.code).toBe('removed_on_mac')
  }, 40_000)
})

describe('an image send whose earlier try was relayed, with the Mac off the companion', () => {
  it('is held naming the Mac\'s own link, not the Mac\'s link to the host', async () => {
    mac.deferRelays = true
    const first = await post({ text: 'img-relayed', images: [IMG], messageId: 'qm-mobile-im0000000001' })
    expect(first.status).toBe(202)
    await settle()
    loseFrames()
    mac.deferRelays = false
    mac.link = 'quiet'
    mac.bridge = false
    onBridge.set('__local__', false)
    const retry = await post({ text: 'img-relayed', images: [IMG], messageId: 'qm-mobile-im0000000001' })
    expect(retry.status).toBe(202)
    expect(retry.body).toMatchObject({ queued: true, waitingForName: 'your Mac', heldNote: "Your Mac isn't connected right now." })
    expect(cli).toEqual([])
  }, 40_000)
})
