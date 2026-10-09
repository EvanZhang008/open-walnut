/**
 * Phone sends through the companion, round 4 of the 2026-10-01 hop fix: the gate's r3 probes
 * and r4 matrix findings, pinned. The model (the gate's): the host daemon answers the relay
 * "no primary" when the Mac's link to it is quiet, else forwards the frame to the Mac, whose
 * queue is the real relay-fates.ts. `cli` = every message the CLI got, by either path;
 * `hostStream` = the host's delivery markers (written inside a send by a send-markers-v1 host,
 * `hostOrdered`, else appended after). A companion restart is vi.resetModules(): a fresh module
 * graph over the same data dir, the old one parked on the request it was waiting on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const H = vi.hoisted(() => {
  class BridgeOfflineError extends Error { constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) } }
  return {
    bridgeRequestMock: vi.fn(), BridgeOfflineError, onBridge: new Map<string, boolean>(), hostConnected: new Set<(hostAlias: string) => void>(),
    since: new Map<string, number>(), // when each host's current link to the companion came up (bridgeHosts().since)
    stopRequest: undefined as undefined | { id: string; state: string; requestedAt?: string },
  }
})

vi.mock('../../../src/constants.js', async () => {
  // One data dir for every module graph of this file (a restart keeps the disk).
  const g = globalThis as unknown as { __hopR4?: Record<string, unknown> }
  if (!g.__hopR4) {
    const { createMockConstants } = await import('../../helpers/mock-constants.js')
    g.__hopR4 = createMockConstants('walnut-cloud-hop-r4', { CLOUD_MODE: true })
  }
  return g.__hopR4
})

vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: H.bridgeRequestMock,
  BridgeOfflineError: H.BridgeOfflineError,
  bridgeForHost: (h: string) => ({ connected: H.onBridge.get(h) ?? true }),
  bridgeHosts: () => [...H.since].map(([hostAlias, since]) => ({ hostAlias, since })),
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
  addPrimaryBridgeConnectedHandler: () => () => {},
  addBridgeConnectedHandler: (fn: (hostAlias: string) => void) => { H.hostConnected.add(fn); return () => H.hostConnected.delete(fn) },
}))

const SID = 'hop-r4-sid'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: 'hop-r4-sid', host: 'devbox', host_label: 'Marina devbox', process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest: H.stopRequest,
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME, SEND_QUEUE_DIR } from '../../../src/constants.js'
import * as F from '../../../src/core/relay-fates.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 52s ago)'
const { BridgeOfflineError, bridgeRequestMock } = H

let appNow: express.Express
async function buildApp(): Promise<express.Express> {
  const { sessionStreamV1Router } = await import('../../../src/web/routes/session-stream-v1.js')
  const { sessionLifecycleV1Router } = await import('../../../src/web/routes/session-lifecycle-v1.js')
  const a = express(); a.use(express.json({ limit: '5mb' }))
  a.use('/api/v1', sessionStreamV1Router); a.use('/api/v1', sessionLifecycleV1Router)
  return a
}
async function restart(): Promise<void> {
  vi.resetModules()
  appNow = await buildApp()
}
const post = (body: Record<string, unknown>) => request(appNow).post(`/api/v1/sessions/${SID}/messages`).send(body)
const statusOf = (mid: string) => request(appNow).get(`/api/v1/sessions/${SID}/messages/${mid}`)
const stopIt = () => request(appNow).post(`/api/v1/sessions/${SID}/terminate`).send({})
const flush = async (): Promise<void> => { await (await import('../../../src/core/send-queue.js')).flushSendQueue() }
const flushOnce = async (): Promise<void> => { await (await import('../../../src/core/send-queue-sweep.js')).flushOnce() }
const outcomeFile = (mid: string) => path.join(SEND_QUEUE_DIR, 'outcomes', `${createHash('sha256').update(JSON.stringify([SID, mid])).digest('hex')}.json`)
const outcome = async (mid: string) => JSON.parse(await fs.readFile(outcomeFile(mid), 'utf-8')) as Record<string, unknown>

// ── The Mac and the host ──
interface MacRow { id: string; text: string; status: 'pending' | 'processing' | 'parked'; parkedReason?: string }
let mac: {
  link: 'up' | 'quiet'; bridge: boolean
  store: { queues: Record<string, MacRow[]>; relay?: Record<string, [string, number]> }
  /** The frame reaches the Mac, and the companion dies before any answer. */
  hangNextRelay: boolean
  /** The companion dies with the relay out, before its frame left (nothing reaches the Mac). */
  dropNextRelay: boolean
  /** The Mac takes the frame and its answer is lost: the host answers "timed out". */
  answerLost: boolean
  /** The Mac's latest stop, named in a 'stopped' withdraw answer. */
  stop?: { id: string; state: string; requestedAt: string }
}
let cli: string[] = []
let hostStream: string[] = []
let hostUp = true
let hostOrdered = false
let hostMarkerFind = true
let hangNextMarker = false
let hangNextSend: 'before' | 'after' | null = null
let slowHost = 0
const forever = () => new Promise<never>(() => {}), q = (): MacRow[] => (mac.store.queues[SID] ??= [])
const markerLine = (id: string) => JSON.stringify({ type: 'user', subtype: 'walnut-injected', walnutMessageId: id })
const hasMarker = (id: string) => hostStream.join('\n').includes(`"walnutMessageId":${JSON.stringify(id)}`)

function macTakes(p: Record<string, unknown>): Record<string, unknown> {
  const id = String(p.messageId)
  const fate = F.fateOf(mac.store as never, id)
  if (F.isRelayFence(fate)) return { ok: false, error: 'the companion took this message back before it arrived', errorKind: 'withdrawn' }
  if (fate === 'removed') return { ok: false, error: 'it was removed on the Mac before it ran', errorKind: 'removed' }
  if (fate === 'taken') return { ok: true, result: { messageId: id } }
  F.setFate(mac.store as never, id, 'taken')
  if (!q().some((r) => r.id === id)) q().push({ id, text: String(p.message), status: 'pending' })
  return { ok: true, result: { messageId: id } }
}
/** The Mac's link to the host is back: its queue delivers what may run, in order, with a marker each. */
function macDeliverAll(): void {
  const rows = q().filter((r) => r.status !== 'parked')
  for (const row of rows) { cli.push(row.text); hostStream.push(markerLine(row.id)) }
  F.noteDelivered(mac.store as never, rows as never)
  mac.store.queues[SID] = q().filter((r) => r.status === 'parked')
}

function wire(): void {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (host === '__local__') {
      if (!mac.bridge) throw new BridgeOfflineError('__local__')
      if (cmd === 'session.control' && p.action === 'message.withdraw') {
        const state = F.withdrawIn(mac.store as never, SID, String((p.params as Record<string, unknown>).messageId))
        return { ok: true, result: { state, ...(state === 'stopped' && mac.stop ? { stop: mac.stop } : {}) } }
      }
      if (cmd === 'session.control' && p.action === 'queue') {
        return { ok: true, result: { messages: q().map((r) => ({ id: r.id, sessionId: SID, message: r.text, status: r.status })) } }
      }
      if (cmd === 'session.control' && p.action === 'terminate') {
        return { ok: true, result: { status: 'terminated', sessionId: SID, stopRequest: { id: `stop-${Date.now()}`, state: 'confirmed', requestedAt: new Date().toISOString() } } }
      }
      throw new Error(`unexpected __local__ ${cmd} ${String(p.action)}`)
    }
    if (!hostUp) throw new BridgeOfflineError(host)
    switch (cmd) {
      case 'session.message':
        if (mac.link === 'quiet') return { ok: false, error: NO_PRIMARY }
        if (mac.dropNextRelay) { mac.dropNextRelay = false; return forever() }
        if (mac.hangNextRelay) { mac.hangNextRelay = false; macTakes(p); return forever() }
        if (mac.answerLost) { mac.answerLost = false; macTakes(p); return { ok: false, error: 'session.message: primary server timed out' } }
        return macTakes(p)
      case 'status':
        if (slowHost) await new Promise((r) => setTimeout(r, slowHost))
        return { exists: true, alive: true, ...(hostOrdered ? { sendMarkers: true } : {}) }
      case 'send': {
        if (slowHost) await new Promise((r) => setTimeout(r, slowHost))
        if (hangNextSend === 'before') { hangNextSend = null; return forever() }
        // send-markers-v1: the marker is in the stream before the line reaches the CLI.
        for (const m of (p.markers as Array<{ messageId: string }> | undefined) ?? []) hostStream.push(markerLine(m.messageId))
        cli.push(String(p.message))
        if (hangNextSend === 'after') { hangNextSend = null; return forever() }
        return { ok: true }
      }
      case 'appendUserMarker':
        if (hangNextMarker) { hangNextMarker = false; return forever() }
        hostStream.push(markerLine(String(p.messageId)))
        return { ok: true }
      case 'markers.find': {
        if (!hostMarkerFind) return { ok: false, error: 'unknown command: markers.find' }
        const ids = p.ids as string[]
        return { ok: true, found: ids.filter(hasMarker), complete: true, ordered: hostOrdered, size: 1, scanned: 1 }
      }
      case 'read-history': return { ok: true, main: hostStream.join('\n').slice(-Number(p.tailBytes ?? Infinity)) }
      case 'ping': return { ok: true }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}
const count = (text: string) => cli.filter((t) => t === text || t.endsWith(`\n\n${text}`)).length
const calls = (cmd: string) => bridgeRequestMock.mock.calls.filter((c) => c[1] === cmd)
async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20))
}
function macAway(): void {
  mac.link = 'quiet'
  mac.bridge = false
  H.onBridge.set('__local__', false)
}
function macBackOnCompanion(): void { mac.bridge = true; H.onBridge.set('__local__', true) }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  mac = { link: 'up', bridge: true, store: { queues: {}, relay: {} }, hangNextRelay: false, dropNextRelay: false, answerLost: false }
  cli = []
  hostStream = []
  hostUp = true
  hostOrdered = false
  hostMarkerFind = true
  hangNextMarker = false
  hangNextSend = null
  slowHost = 0
  H.stopRequest = undefined
  H.onBridge.clear()
  H.hostConnected.clear()
  H.since.clear()
  wire()
  await restart()
})
afterEach(async () => {
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flush().catch(() => {})
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('B3 the companion restarts after a direct delivery went out, before it recorded it', () => {
  it('the restarted sweep does not deliver it again; the phone is told it may have run', async () => {
    hostUp = false
    expect((await post({ text: 'b3', messageId: 'qm-mobile-r4b3000000001' })).status).toBe(202)
    hostUp = true
    mac.link = 'quiet'
    hangNextMarker = true
    void flush()
    await until(() => count('b3') === 1)
    expect(count('b3')).toBe(1)
    // The process dies here (parked on the marker). The restarted one runs over what is on disk.
    await restart()
    await flushOnce()
    await flushOnce()
    expect(count('b3')).toBe(1)
    expect((await statusOf('qm-mobile-r4b3000000001')).body.state).toBe('unknown')
  }, 40_000)
})

describe('N1 the residual window on the route path (a host without send-markers-v1)', () => {
  it('the companion dies after the direct send, before the marker: no second delivery, the phone is told it may have run', async () => {
    mac.link = 'quiet'
    hangNextMarker = true
    const first = post({ text: 'n1', messageId: 'qm-mobile-r4n1000000001' }).then((r) => r)
    await until(() => count('n1') === 1)
    await restart()
    expect((await post({ text: 'n1', messageId: 'qm-mobile-r4n1000000001' })).status).toBe(202)
    await flush()
    await flush()
    expect(count('n1')).toBe(1)
    expect((await statusOf('qm-mobile-r4n1000000001')).body.state).toBe('unknown')
    await first
  }, 40_000)
})

describe('G11 the text answer deadline on the direct path', () => {
  it('answers within 8 s even when the host is slow to take the direct send, and it runs once', async () => {
    macAway()
    slowHost = 6_000
    const t0 = Date.now()
    const res = await post({ text: 'g11', messageId: 'qm-mobile-r4g11000000001' })
    const ms = Date.now() - t0
    await until(() => count('g11') === 1, 14_000)
    expect({ status: res.status, within8s: ms <= 8_500, deliveries: count('g11') }).toEqual({ status: 202, within8s: true, deliveries: 1 })
  }, 40_000)
})

describe('N2 the relay intent is on disk before the first relay byte', () => {
  it('N2a: the companion dies with a relay out that the Mac took and ran; a phone retry after the restart is not a second turn', async () => {
    mac.hangNextRelay = true
    const first = post({ text: 'n2a', messageId: 'qm-mobile-r4n2a00000001' }).then((r) => r)
    await until(() => q().some((r) => r.id === 'qm-mobile-r4n2a00000001'))
    macDeliverAll()
    macAway()
    await restart()
    expect((await post({ text: 'n2a', messageId: 'qm-mobile-r4n2a00000001' })).status).toBe(202)
    await flush()
    expect(count('n2a')).toBe(1)
    await first
  }, 40_000)

  it('N2b: the sweep\'s relay of a banked send is out when the companion dies (the Mac took it and ran it): never sent again directly', async () => {
    hostUp = false
    expect((await post({ text: 'n2b', messageId: 'qm-mobile-r4n2b00000001' })).status).toBe(202)
    hostUp = true
    mac.hangNextRelay = true
    void flush()
    await until(() => q().some((r) => r.id === 'qm-mobile-r4n2b00000001'))
    macDeliverAll()
    macAway()
    await restart()
    await flushOnce()
    await flushOnce()
    expect(count('n2b')).toBe(1)
  }, 40_000)

  it('the restart window: the intent was written and the frame never left; held while the Mac cannot be asked, then sent once', async () => {
    mac.dropNextRelay = true
    const first = post({ text: 'n2c', messageId: 'qm-mobile-r4n2c00000001' }).then((r) => r)
    await until(() => calls('session.message').length === 1)
    // Before the frame: the message is relay-only on disk, and the session's relay index names it.
    expect(await outcome('qm-mobile-r4n2c00000001')).toMatchObject({ state: 'maybe-relayed', relayIntent: true })
    await restart()
    macAway()
    expect((await post({ text: 'n2c', messageId: 'qm-mobile-r4n2c00000001' })).status).toBe(202)
    await flush()
    expect(count('n2c'), 'the Mac may hold it: never sent another way while it cannot be asked').toBe(0)
    // The Mac is back on the companion (its link to the host still down): it never saw the id.
    macBackOnCompanion()
    await flush()
    expect(count('n2c')).toBe(1)
    await flush()
    expect(count('n2c')).toBe(1)
    await first
  }, 40_000)
})

describe('N3 a stop pressed while the Mac is off the companion (it provably never left)', () => {
  it('closes the ask: a later send still reaches the host by its direct path', async () => {
    macAway()
    expect((await stopIt()).status).toBe(503)
    expect((await post({ text: 'n3', messageId: 'qm-mobile-r4n3000000001' })).status).toBe(202)
    await flush()
    expect(count('n3')).toBe(1)
  }, 40_000)
})

describe('N5 a message the Mac parked, the session list not showing any stop', () => {
  /** The Mac takes it and its answer is lost (the host answers "timed out"); the phone's retry is held for the Mac. */
  async function takenAnswerLost(text: string, mid: string): Promise<void> {
    mac.answerLost = true
    expect((await post({ text, messageId: mid })).status).toBe(503)
    expect(q().map((r) => r.id)).toEqual([mid])
    mac.link = 'quiet'
    expect((await post({ text, messageId: mid })).status).toBe(202)
  }

  it('parked there for a person to retry: held, never handed to the direct path', async () => {
    await takenAnswerLost('n5a', 'qm-mobile-r4n5a00000001')
    q()[0].status = 'parked'
    await flush()
    await flush()
    expect(count('n5a')).toBe(0)
    expect((await statusOf('qm-mobile-r4n5a00000001')).body.state).toBe('held')
  }, 40_000)

  it('parked by a stop there: never runs, nor does a message sent before the companion knew of that stop', async () => {
    await takenAnswerLost('n5b', 'qm-mobile-r4n5b00000001')
    q()[0].status = 'parked'
    q()[0].parkedReason = F.STOP_PARKED_REASON
    mac.stop = { id: 'mac-stop-1', state: 'confirmed', requestedAt: new Date().toISOString() }
    expect((await post({ text: 'n5b-later', messageId: 'qm-mobile-r4n5b00000002' })).status).toBe(202)
    await flush()
    await flush()
    expect(count('n5b') + count('n5b-later')).toBe(0)
    expect((await statusOf('qm-mobile-r4n5b00000001')).body).toMatchObject({ state: 'not_sent', code: 'session_stopped' })
    expect((await statusOf('qm-mobile-r4n5b00000002')).body).toMatchObject({ state: 'not_sent', code: 'session_stopped' })
    // A message sent now carries that stop as its fence: it goes.
    expect((await post({ text: 'n5b-new', messageId: 'qm-mobile-r4n5b00000003' })).status).toBe(202)
    await flush()
    expect(count('n5b-new')).toBe(1)
  }, 40_000)
})

describe('N6 the Mac asleep, a session whose last relayed message ran long ago', () => {
  it('the host searches its own stream (markers.find): a new send goes by the direct path', async () => {
    expect((await post({ text: 'n6-old', messageId: 'qm-mobile-r4n6000000001' })).status).toBe(202)
    macDeliverAll()
    hostStream.push('x'.repeat(3 * 1024 * 1024)) // hours of output since: past the old 2 MB tail
    macAway()
    expect((await post({ text: 'n6-new', messageId: 'qm-mobile-r4n6000000002' })).status).toBe(202)
    await flush()
    expect(count('n6-new')).toBe(1)
    expect(calls('read-history')).toEqual([])
  }, 40_000)

  it('a host without markers.find keeps the old bounded read, held, and is not asked for the command again on every pass', async () => {
    hostMarkerFind = false
    expect((await post({ text: 'n6b-old', messageId: 'qm-mobile-r4n6b00000001' })).status).toBe(202)
    macDeliverAll()
    hostStream.push('x'.repeat(3 * 1024 * 1024))
    macAway()
    expect((await post({ text: 'n6b-new', messageId: 'qm-mobile-r4n6b00000002' })).status).toBe(202)
    await flush()
    await flush()
    expect(count('n6b-new')).toBe(0)
    expect(calls('markers.find')).toHaveLength(1)
    expect(calls('read-history').length).toBeGreaterThanOrEqual(2)
  }, 40_000)
})

describe('send-markers-v1: a direct delivery whose marker rides inside the send', () => {
  const MID = 'qm-mobile-r4or000000001'
  async function bankedWhileHostAway(text: string): Promise<void> {
    hostOrdered = true
    hostUp = false
    expect((await post({ text, messageId: MID })).status).toBe(202)
    hostUp = true
    mac.link = 'quiet'
  }

  it('the companion dies after the line reached the CLI: its marker proves it ran, never sent again', async () => {
    await bankedWhileHostAway('or-ran')
    hangNextSend = 'after'
    void flush()
    await until(() => count('or-ran') === 1)
    await restart()
    await flushOnce()
    await flushOnce()
    expect(count('or-ran')).toBe(1)
    expect((await statusOf(MID)).body.state).toBe('delivered')
  }, 40_000)

  it('the companion dies before the send reached the host: held while it could still land, then sent once', async () => {
    await bankedWhileHostAway('or-lost')
    hangNextSend = 'before'
    void flush()
    await until(() => calls('send').length === 1)
    expect(await outcome(MID)).toMatchObject({ state: 'direct-intent', ordered: true })
    await restart()
    // Two sweeps inside the settle window: one that judged "not delivered" clears
    // the intent, and only the next one sends it (gate r4, mutant mV).
    await flushOnce()
    await flushOnce()
    expect(count('or-lost'), 'within the settle window nothing is sent').toBe(0)
    // Past the settle window: no marker in the whole stream proves the CLI never got it.
    await fs.writeFile(outcomeFile(MID), JSON.stringify({ ...(await outcome(MID)), at: new Date(Date.now() - 120_000).toISOString() }))
    await flushOnce()
    await flushOnce()
    expect(count('or-lost')).toBe(1)
    await flushOnce()
    expect(count('or-lost')).toBe(1)
    expect((await statusOf(MID)).body.state).toBe('delivered')
  }, 40_000)
})

describe('a held send drains on its own host\'s return, not on the 60 s sweep', () => {
  it('the host\'s bridge connecting drains what was banked for it, at once', async () => {
    const { startSendQueueFlush } = await import('../../../src/core/send-queue.js')
    const drain = startSendQueueFlush()
    try {
      await until(() => H.hostConnected.size > 0)
      expect(H.hostConnected.size).toBeGreaterThan(0)
      hostUp = false
      expect((await post({ text: 't1', messageId: 'qm-mobile-r4t1000000001' })).status).toBe(202)
      hostUp = true
      const t0 = Date.now()
      for (const fn of H.hostConnected) fn('devbox')
      await until(() => q().some((r) => r.id === 'qm-mobile-r4t1000000001'), 5_000)
      expect(q().map((r) => r.id)).toEqual(['qm-mobile-r4t1000000001'])
      expect(Date.now() - t0).toBeLessThan(3_000)
    } finally { drain.stop() }
  }, 40_000)
})

describe('D2 the held sentence after the host daemon restarted', () => {
  /** Held while the host is away; it comes back with no Mac behind it yet, and takes the direct send slowly. */
  async function heldThenHostBack(sinceOffsetMs: number): Promise<Record<string, unknown>> {
    hostUp = false
    expect((await post({ text: 'd2-first', messageId: 'qm-mobile-r4d2000000001' })).body.heldNote).toBe("Can't reach Marina devbox right now.")
    hostUp = true
    H.since.set('devbox', Date.now() + sinceOffsetMs)
    mac.link = 'quiet'
    slowHost = 1_500
    const draining = flush()
    await until(() => calls('send').length === 1, 10_000)
    const second = await post({ text: 'd2-second', messageId: 'qm-mobile-r4d2000000002' })
    await draining
    await flush()
    expect([count('d2-first'), count('d2-second')]).toEqual([1, 1])
    return second.body as Record<string, unknown>
  }

  it('the host came back after the message was held: the host is named, not the Mac', async () => {
    const held = await heldThenHostBack(0)
    expect(held).toMatchObject({ queued: true, waitingFor: 'devbox', waitingForName: 'Marina devbox', heldNote: 'Marina devbox is reconnecting.' })
  }, 40_000)

  it('a host link older than the message: the Mac\'s link to it is what is down', async () => {
    const held = await heldThenHostBack(-5_000)
    expect(held).toMatchObject({ queued: true, waitingFor: '', heldNote: "Your Mac can't reach Marina devbox right now." })
  }, 40_000)
})

describe('W2 a message held behind one that waits on the Mac', () => {
  it('still names the Mac once that one has gone (the probe at the clear)', async () => {
    const mac0 = "Your Mac can't reach Marina devbox right now."
    mac.hangNextRelay = true // the Mac is frozen: the relay is out, unanswered
    expect((await post({ text: 'w2-a', messageId: 'qm-mobile-r4w2000000001' })).body.heldNote).toBe(mac0)
    expect((await post({ text: 'w2-b', messageId: 'qm-mobile-r4w2000000002' })).body.heldNote).toBe(mac0)
    // The Mac thaws and runs the first one; the second has not gone yet.
    await (await import('../../../src/web/routes/cloud-send-words.js')).unbankSend('qm-mobile-r4w2000000001')
    const probe = await post({ text: 'w2-c', messageId: 'qm-mobile-r4w2000000003' })
    expect(probe.body).toMatchObject({ queued: true, waitingFor: '', heldNote: mac0 })
  }, 40_000)
})
