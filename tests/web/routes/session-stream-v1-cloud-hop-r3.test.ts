/**
 * Phone sends through the companion (round 3 of the 2026-10-01 hop fix). Each
 * case is a cell of the connection matrix that still failed after round 2:
 *
 *   1. ORDER: a send that reached the companion while an earlier one of the
 *      same session was still being handed over could reach the CLI first
 *      (matrix L5, D2, S5, W3). A later send now waits for the earlier one's
 *      answer, and is held behind one still out at its own deadline.
 *   4. STOP: a message sent after the phone saw its stop finish was refused as
 *      "predates the latest stop" for the 3 to 6 s the companion's session
 *      list lagged (N0, W1). The fence is the stop the Mac named in its answer.
 *   9. WORDING: a 503 read "Send relay failed: bridge disconnected" or
 *      "session.message: primary server timed out". Every one names the hop.
 *      A relay still out whose host does not answer a ping names the host.
 *   7. PICTURES: an image send could not be held, so it waited out the save's
 *      30 s timeout (W1: a 48 s ack). It is held now, its pictures with it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-hop-r3', { CLOUD_MODE: true }))

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

const SID = 'hop-r3-sid-a'
const LABEL = 'New big devbox'
let stopRequest: { id: string; state: string; requestedAt?: string } | undefined
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', host_label: LABEL, process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest,
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { WALNUT_HOME, SEND_QUEUE_DIR } from '../../../src/constants.js'
import { flushSendQueue, queuedSessionSendCount } from '../../../src/core/send-queue.js'

/** The primary box's own first line for a message with pictures (the CLI reads the files). */
const IMAGES_ATTACHED_LINE = '[Images attached \u2014 use the Read tool to view them]'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const app = () => {
  const a = express()
  a.use(express.json({ limit: '5mb' }))
  a.use('/api/v1', sessionStreamV1Router)
  a.use('/api/v1', sessionLifecycleV1Router)
  return a
}
const post = (body: Record<string, unknown>) => request(app()).post(`/api/v1/sessions/${SID}/messages`).send(body)
const status = (messageId: string) => request(app()).get(`/api/v1/sessions/${SID}/messages/${messageId}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const calls = (cmd: string) => bridgeRequestMock.mock.calls.filter((c) => c[1] === cmd)

/** What the Mac's queue took, in the order it took it (the order the CLI runs them). */
let macQueue: string[] = []
/** A hop that never answers, until the test is over (so nothing outlives it). */
let hanging = true
const hang = async () => { while (hanging) await sleep(25) }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  stopRequest = undefined
  macQueue = []
  hanging = true
})

afterEach(async () => {
  hanging = false
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('1. a later send never runs before an earlier accepted one', () => {
  it('a send arriving while an earlier one is still being handed over waits for it', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd !== 'session.message') throw new Error('unexpected command: ' + cmd)
      // The first relay takes 2 s to reach the Mac's queue (a slow hop); the second is quick.
      if (p.messageId === 'qm-mobile-ord300000001') await sleep(2_000)
      macQueue.push(String(p.message))
      return { ok: true, result: { messageId: p.messageId } }
    })
    const first = post({ text: 'first', messageId: 'qm-mobile-ord300000001' }).then((r) => r)
    await sleep(150)
    const second = await post({ text: 'second', messageId: 'qm-mobile-ord300000002' })
    expect((await first).status).toBe(202)
    expect(second.status).toBe(202)
    expect(macQueue).toEqual(['first', 'second'])
  })

  it('a send still out at the later one\'s deadline holds the later one behind it, and the drain keeps the order', async () => {
    let macBack = false
    const taken = new Set<unknown>()
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'ping') return { ok: true }
      if (cmd !== 'session.message') throw new Error('unexpected command: ' + cmd)
      // The hop to the Mac is down until it comes back; its queue dedupes by id.
      while (!macBack && hanging) await sleep(50)
      if (!taken.has(p.messageId)) { taken.add(p.messageId); macQueue.push(String(p.message)) }
      return { ok: true, result: { messageId: p.messageId } }
    })
    const first = post({ text: 'first', messageId: 'qm-mobile-ord300000003' }).then((r) => r)
    await sleep(150)
    const second = await post({ text: 'second', messageId: 'qm-mobile-ord300000004' })
    expect((await first).body).toMatchObject({ queued: true })
    expect(second.body).toMatchObject({ queued: true })
    expect(calls('session.message').some((c) => c[2].messageId === 'qm-mobile-ord300000004'),
      'the second was never handed over while the first was still out').toBe(false)
    macBack = true
    // The first relay, still out, lands now. The sweep leaves a row whose relay
    // is out alone until it answers (it would only hand it over twice).
    for (let i = 0; i < 100 && !macQueue.includes('first'); i++) await sleep(20)
    await sleep(100)
    await flushSendQueue()
    expect(macQueue).toEqual(['first', 'second'])
  }, 30_000)
})

describe('4. a message sent after the phone saw the stop finish is accepted', () => {
  it.each([
    ['the list still shows an older stop', { id: 'stop-1', state: 'confirmed', requestedAt: '2026-10-01T00:00:00.000Z' }],
    ['the list shows no stop yet', undefined],
  ])('%s', async (_what, lagging) => {
    stopRequest = lagging
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'session.control' && p.action === 'terminate') {
        return { ok: true, result: { status: 'terminated', sessionId: SID, stopRequest: { id: 'stop-2', requestedAt: new Date().toISOString(), state: 'confirmed' } } }
      }
      if (cmd === 'session.message') {
        // The Mac's queue: a message is taken only when its fence is the latest stop.
        if ((p.stopFence ?? null) !== 'stop-2') return { ok: false, error: 'Message predates the latest stop; send a new message to continue', errorKind: 'session_stopped' }
        macQueue.push(String(p.message))
        return { ok: true, result: { messageId: p.messageId } }
      }
      throw new Error('unexpected command: ' + cmd)
    })
    const stop = await request(app()).post(`/api/v1/sessions/${SID}/terminate`).send({})
    expect(stop.status).toBe(200)
    const res = await post({ text: 'after the stop', messageId: 'qm-mobile-stp300000001' })
    expect(res.status, res.text).toBe(202)
    expect(macQueue).toEqual(['after the stop'])
  })

  it('a stop the list shows LATER than the one answered here wins', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'session.control') return { ok: true, result: { status: 'terminated', sessionId: SID, stopRequest: { id: 'stop-2', requestedAt: '2026-10-02T00:00:00.000Z', state: 'confirmed' } } }
      if (cmd === 'session.message') { macQueue.push(String(p.stopFence)); return { ok: true, result: { messageId: p.messageId } } }
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await request(app()).post(`/api/v1/sessions/${SID}/terminate`).send({})).status).toBe(200)
    // Then the console stopped it again; the list shows that one.
    stopRequest = { id: 'stop-3', state: 'confirmed', requestedAt: '2026-10-02T00:05:00.000Z' }
    expect((await post({ text: 'x', messageId: 'qm-mobile-stp300000002' })).status).toBe(202)
    expect(macQueue).toEqual(['stop-3'])
  })
})

describe('9. every 503 names the hop in one plain sentence', () => {
  it.each([
    ['Send relay failed: bridge disconnected', `${LABEL} isn't connected to the companion right now. Try again shortly.`],
    ['session.message: primary server timed out', `Your Mac can't reach ${LABEL} right now. Try again shortly.`],
    ['bridge request timed out after 50000ms', `${LABEL} didn't answer in time. Try again shortly.`],
    ['devbox: disk full', `Couldn't hand the message to ${LABEL} (${LABEL}: disk full). Try again shortly.`],
  ])('relay error %j', async (raw, sentence) => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: raw })
    const res = await post({ text: 'x', messageId: 'qm-mobile-wrd300000001' })
    expect(res.status).toBe(503)
    expect(res.body.error).toEqual({ code: 'bridge_offline', message: sentence })
    expect(res.body.error.message).not.toMatch(/session\.message|relay failed|[\u2013\u2014]/)
  })

  it('a relay still out whose host does not answer a ping is held naming the host, not the Mac', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') { await hang(); return { ok: false, error: 'bridge request timed out' } }
      if (cmd === 'ping') { await sleep(2_500); throw new Error('bridge request timed out') }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await post({ text: 'into a half-open link', messageId: 'qm-mobile-wrd300000002' })
    expect(res.body).toMatchObject({ queued: true, waitingFor: 'devbox', waitingForName: LABEL, heldNote: `Can't reach ${LABEL} right now.` })
    expect(calls('ping')[0]?.[2]).toEqual({ ackSeq: -1 })
  }, 20_000)

  it('a relay still out whose host answers a ping is held naming the Mac behind it', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') { await hang(); return { ok: false, error: 'session.message: primary server timed out' } }
      if (cmd === 'ping') return { ok: true }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await post({ text: 'the Mac is the slow hop', messageId: 'qm-mobile-wrd300000003' })
    expect(res.body).toMatchObject({ queued: true, waitingFor: '', waitingForName: 'your Mac' })
  }, 20_000)
})

describe('7. an image send is held like a text one, its pictures with it', () => {
  const imageFiles = async () => (await fs.readdir(path.join(SEND_QUEUE_DIR, 'images')).catch(() => [] as string[]))

  it('no bridge to the host: held at once with its pictures, and the drain saves them before the text goes', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await post({ text: 'look', messageId: 'qm-mobile-img300000001', images: [{ data: PNG, mediaType: 'image/png' }] })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ queued: true, waitingForName: LABEL })
    expect(await imageFiles()).toHaveLength(1)

    bridgeRequestMock.mockReset()
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'image.save') return { ok: true, path: '/home/user/.walnut/images/a.png' }
      if (cmd === 'session.message') { macQueue.push(String(p.message)); return { ok: true, result: { messageId: p.messageId } } }
      throw new Error('unexpected command: ' + cmd)
    })
    await flushSendQueue()
    expect(bridgeRequestMock.mock.calls.map((c) => c[1])).toEqual(['image.save', 'session.message'])
    expect(macQueue).toEqual([`${IMAGES_ATTACHED_LINE}\n- /home/user/.walnut/images/a.png\n\nlook`])
    expect(await queuedSessionSendCount()).toBe(0)
    expect(await imageFiles()).toEqual([])
  })

  it('a picture save still out at the deadline: held by then, and the late save is used, never made twice', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'image.save') { await sleep(9_500); return { ok: true, path: '/home/user/.walnut/images/slow.png' } }
      if (cmd === 'session.message') { macQueue.push(String(p.message)); return { ok: true, result: { messageId: p.messageId } } }
      if (cmd === 'ping') return { ok: true }
      throw new Error('unexpected command: ' + cmd)
    })
    const started = Date.now()
    const res = await post({ text: 'slow link', messageId: 'qm-mobile-img300000002', images: [{ data: PNG, mediaType: 'image/png' }] })
    expect(Date.now() - started).toBeLessThan(9_000)
    expect(res.body).toMatchObject({ queued: true })
    await flushSendQueue()
    expect(calls('session.message'), 'nothing goes before its picture is on the host').toHaveLength(0)
    for (let i = 0; i < 60 && macQueue.length === 0; i++) await sleep(100)
    expect(macQueue).toEqual([`${IMAGES_ATTACHED_LINE}\n- /home/user/.walnut/images/slow.png\n\nslow link`])
    expect(calls('image.save')).toHaveLength(1)
    expect(await imageFiles()).toEqual([])
  }, 25_000)

  it('a host that turns the picture down at the drain: the phone is told it was not sent, and why', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'old host', messageId: 'qm-mobile-img300000003', images: [{ data: PNG, mediaType: 'image/png' }] })).status).toBe(202)
    bridgeRequestMock.mockReset()
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'image.save') return { ok: false, error: 'unknown command: image.save' }
      throw new Error('unexpected command: ' + cmd)
    })
    await flushSendQueue()
    expect((await status('qm-mobile-img300000003')).body).toMatchObject({
      state: 'not_sent', code: 'images_need_daemon_upgrade',
      message: "Not sent: This host's daemon predates image support. It upgrades on its own the next time your Mac connects to it.",
    })
    expect(calls('session.message')).toHaveLength(0)
    expect(await imageFiles()).toEqual([])
  })
})
