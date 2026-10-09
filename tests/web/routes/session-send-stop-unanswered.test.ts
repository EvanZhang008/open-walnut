/**
 * A message sent after a stop the phone asked for through the companion that
 * the Mac has not confirmed never goes by the host's direct path: the stop may
 * have landed on the Mac, which alone applies it to a message. (Gate r2: such a
 * send went straight to the host and ran past the stop.)
 *
 * The model: the Mac is either on the companion's bridge or off it, and its
 * link to the host either carries the relay or answers "no primary". A stop
 * that reaches the Mac is recorded there, and its queue refuses a message whose
 * fence is not its latest stop. `cli` records every message the CLI received
 * by the direct path; `macQueue` every one the Mac took.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-send-stop-unanswered', { CLOUD_MODE: true }))

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

const SID = 'stop-unanswered-sid'
let listedStop: { id: string; state: string; requestedAt?: string } | undefined
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', host_label: 'Marina devbox', process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest: listedStop,
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { flushSendQueue } from '../../../src/core/send-queue.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 40s ago)'
const app = () => {
  const a = express(); a.use(express.json())
  a.use('/api/v1', sessionStreamV1Router); a.use('/api/v1', sessionLifecycleV1Router); return a
}
const post = (body: Record<string, unknown>) => request(app()).post(`/api/v1/sessions/${SID}/messages`).send(body)
const stop = () => request(app()).post(`/api/v1/sessions/${SID}/terminate`).send({})
const statusOf = (mid: string) => request(app()).get(`/api/v1/sessions/${SID}/messages/${mid}`)

let mac: {
  onCompanion: boolean; reachesHost: boolean; latestStop: string | null
  stopAnswer: 'terminated' | 'pending' | 'lost'
}
let cli: string[] = []
let macQueue: string[] = []

function setMacOnCompanion(on: boolean): void {
  mac.onCompanion = on
  onBridge.set('__local__', on)
}

function wire(): void {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (host === '__local__') {
      if (!mac.onCompanion) throw new BridgeOfflineError('__local__')
      if (cmd === 'session.control' && p.action === 'terminate') {
        // The answer is lost on the way (the stop never got to the Mac's queue here).
        if (mac.stopAnswer === 'lost') throw new Error('bridge request timed out after 15000ms: session.control')
        const id = `stop-${Date.now()}`
        mac.latestStop = id
        const stopRequest = { id, state: mac.stopAnswer === 'pending' ? 'pending' : 'confirmed', requestedAt: new Date().toISOString() }
        return { ok: true, result: { status: mac.stopAnswer, sessionId: SID, stopRequest } }
      }
      if (cmd === 'session.control' && p.action === 'message.withdraw') return { ok: true, result: { state: 'not-received' } }
      if (cmd === 'session.control' && p.action === 'queue') return { ok: true, result: { messages: [] } }
      throw new Error(`unexpected __local__ ${cmd} ${String(p.action)}`)
    }
    switch (cmd) {
      case 'session.message':
        if (!mac.reachesHost) return { ok: false, error: NO_PRIMARY }
        if ((p.stopFence ?? null) !== mac.latestStop) {
          return { ok: false, error: 'Message predates the latest stop; send a new message to continue', errorKind: 'session_stopped' }
        }
        macQueue.push(String(p.message))
        return { ok: true, result: { messageId: p.messageId } }
      case 'ping': return { ok: true }
      case 'status': return { exists: true, alive: true }
      case 'send': cli.push(String(p.message)); return { ok: true }
      case 'bridgeResume': cli.push(String(p.message)); return { ok: true }
      case 'appendUserMarker': return { ok: true }
      case 'read-history': return { ok: true, main: '' }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  onBridge.clear()
  mac = { onCompanion: true, reachesHost: true, latestStop: null, stopAnswer: 'terminated' }
  listedStop = undefined
  cli = []
  macQueue = []
  wire()
})
afterEach(async () => {
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a send after a stop nobody answered', () => {
  it('the answer lost on the way: held for the Mac, never sent directly, handed over once the Mac reaches the host', async () => {
    mac.stopAnswer = 'lost'
    mac.reachesHost = false
    expect((await stop()).status).toBe(503)
    const mid = 'qm-mobile-sulost000000001'
    const res = await post({ text: 'after an unanswered stop', messageId: mid })
    expect(res.status).toBe(202)
    expect(res.body.queued).toBe(true)
    expect(cli).toEqual([])
    await flushSendQueue()
    expect(cli).toEqual([])
    // The Mac is back on the companion, its link to the host still down: the
    // Mac could give the message back now, but the stop is still unanswered.
    setMacOnCompanion(true)
    await flushSendQueue()
    expect(cli).toEqual([])
    // Its link to the host returns: the Mac, which never got the stop, takes it.
    mac.reachesHost = true
    await flushSendQueue()
    expect({ cli, macQueue }).toEqual({ cli: [], macQueue: ['after an unanswered stop'] })
    expect((await statusOf(mid)).body.state).toBe('delivered')
  }, 30_000)

  it('a stop that provably never left (the Mac off the companion) asks nothing: a later send goes by the direct path, once', async () => {
    setMacOnCompanion(false)
    mac.reachesHost = false
    expect((await stop()).status).toBe(503)
    const res = await post({ text: 'after a stop that never left', messageId: 'qm-mobile-suoff000000001' })
    expect(res.status).toBe(202)
    await flushSendQueue()
    expect({ cli, macQueue }).toEqual({ cli: ['after a stop that never left'], macQueue: [] })
    await flushSendQueue()
    expect(cli).toHaveLength(1)
  }, 30_000)

  it('a stop the list shows since answers the ask: a message sent after it, under it, goes by the direct path', async () => {
    mac.stopAnswer = 'lost'
    mac.reachesHost = false
    expect((await stop()).status).toBe(503)
    // The stop had landed after all, and the session list shows it now.
    listedStop = { id: 'stop-landed', state: 'confirmed', requestedAt: new Date().toISOString() }
    mac.latestStop = 'stop-landed'
    const res = await post({ text: 'sent after the stop showed', messageId: 'qm-mobile-su0000000004' })
    expect(res.status).toBe(202)
    await flushSendQueue()
    expect(cli).toEqual(['sent after the stop showed'])
    expect((await statusOf('qm-mobile-su0000000004')).body.state).toBe('delivered')
  }, 30_000)

  it('a stop the list shows since answers it: the held message is not run', async () => {
    mac.stopAnswer = 'lost'
    mac.reachesHost = false
    expect((await stop()).status).toBe(503)
    expect((await post({ text: 'sent before the stop showed', messageId: 'qm-mobile-su0000000002' })).status).toBe(202)
    // The stop had landed after all: the session list now shows it.
    listedStop = { id: 'stop-landed', state: 'confirmed', requestedAt: new Date().toISOString() }
    await flushSendQueue()
    expect(cli).toEqual([])
    expect((await statusOf('qm-mobile-su0000000002')).body.state).toBe('not_sent')
  }, 30_000)
})

describe('a send after a stop the Mac answered as still pending', () => {
  it('is refused stop_pending though the list does not show the stop yet, nothing handed over', async () => {
    mac.stopAnswer = 'pending'
    const stopped = await stop()
    expect(stopped.status).toBe(503)
    expect(stopped.body.error.code).toBe('stop_pending')
    bridgeRequestMock.mockClear()
    const res = await post({ text: 'while the stop is pending', messageId: 'qm-mobile-su0000000003' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('stop_pending')
    expect(bridgeRequestMock.mock.calls.filter((c) => ['session.message', 'send', 'bridgeResume'].includes(c[1] as string))).toEqual([])
  })
})
