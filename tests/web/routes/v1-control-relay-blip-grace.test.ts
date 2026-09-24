/**
 * The shared control relay (v1-control-relay.ts) riding out a primary bridge blip.
 *
 * Production shape this pins: on a replica the primary's /bridge socket closes
 * and redials about 46 times a day, each hole 1.0 to 1.5s. Every relayed request
 * that landed in a hole used to fail instantly with BridgeOfflineError, which is
 * how one miss on the chat engine read left a phone's model picker wrong for
 * hours. Both relay entry points (callPrimaryControl and the HTTP driver behind
 * relayControlAction) now wait up to the blip grace for the redial and then send.
 *
 * Driven through the REAL bridge registry (attachBridge + hello, exactly as a
 * daemon registers) with fake timers, so every wait, wake and timeout is the
 * production code path and the file still runs in milliseconds.
 *
 * Invariants:
 *  - connected: sent at once, zero added delay
 *  - fresh loss + redial inside the grace: succeeds with ONE send
 *  - no redial: the same bridge_offline answer as before, after exactly the grace
 *  - grace 0 (env): the old instant failure
 *  - a failure AFTER a send (timeout, socket dropped mid-request) is never retried
 *  - concurrent requests in one hole all ride the same redial
 *  - the grace comes out of the caller's timeout (at most half of it)
 *  - a stale loss (a sleeping Mac) is not waited for
 *  - `notSent` on bridge_offline: true only when provably nothing ran
 *  - session-control-v1 (model / effort / fork) rides the same driver: a fork in
 *    a hole reaches the primary exactly once, and one lost mid-request is never
 *    re-sent
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import express, { type Response } from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-control-blip', { CLOUD_MODE: true }))

import {
  attachBridge, closeAllBridges, addPrimaryBridgeConnectedHandler,
} from '../../../src/web/ws/bridge-registry.js'
import {
  callPrimaryControl, relayControlAction, bridgeBlipGraceMs, DEFAULT_BRIDGE_BLIP_GRACE_MS,
} from '../../../src/web/routes/v1-control-relay.js'
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { getLaunchSeed, _resetLaunchSeedsForTesting } from '../../../src/core/sessions/launch-seed.js'

type Frame = Record<string, unknown>
type Replier = ((frame: Frame) => Frame) | null

const OFFLINE = 'No live bridge for host: __local__'
const GRACE_ENV = 'WALNUT_BRIDGE_BLIP_GRACE_MS'

/**
 * Fake daemon bridge socket (attachBridge only uses on/send/close). `replier`
 * answers each session.control frame on a microtask, like a fast primary; null
 * never answers, which is how a request that times out after the send is made.
 */
class FakeBridgeWs extends EventEmitter {
  sent: Frame[] = []
  constructor(
    private readonly replier: Replier,
    private readonly onControl?: (frame: Frame) => void,
  ) { super() }
  send(payload: string): void {
    const frame = JSON.parse(payload) as Frame
    this.sent.push(frame)
    if (frame.cmd === 'session.control') this.onControl?.(frame)
    if (this.replier && frame.cmd === 'session.control') {
      const answer = { id: frame.id, ...this.replier(frame) }
      void Promise.resolve().then(() => this.inbound(answer))
    }
  }
  close(): void { this.emit('close') }
  inbound(frame: Frame): void { this.emit('message', Buffer.from(JSON.stringify(frame))) }
  controlFrames(): Frame[] { return this.sent.filter((f) => f.cmd === 'session.control') }
}

const echo: Replier = (frame) => ({ ok: true, result: { action: frame.action, sessionId: frame.sessionId } })

/** Register the primary's bridge ('bridge-local' is the token identity of '__local__'). */
function connectPrimary(replier: Replier = echo, onControl?: (frame: Frame) => void): FakeBridgeWs {
  const ws = new FakeBridgeWs(replier, onControl)
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

/** A bridge that was there a moment ago: the loss clock reads "fresh". */
function dropPrimaryNow(): FakeBridgeWs {
  const ws = connectPrimary()
  ws.close()
  return ws
}

/** Minimal Express Response stand-in: the relay only calls status().json(). */
function fakeRes(): { res: Response; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) { state.status = code; return res },
    json(body: unknown) { state.body = body; return res },
  }
  return { res: res as unknown as Response, state }
}

/** Track settlement without awaiting, so a test can prove "not yet". */
function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  const promise = p.finally(() => { done = true })
  return { promise, settled: () => done }
}

beforeEach(() => {
  delete process.env[GRACE_ENV]
  vi.useFakeTimers()
})

afterEach(() => {
  closeAllBridges()
  vi.useRealTimers()
  delete process.env[GRACE_ENV]
})

describe('bridgeBlipGraceMs', () => {
  it('defaults to 5s and honours a valid override, including 0', () => {
    expect(DEFAULT_BRIDGE_BLIP_GRACE_MS).toBe(5_000)
    expect(bridgeBlipGraceMs({})).toBe(5_000)
    expect(bridgeBlipGraceMs({ [GRACE_ENV]: '1500' })).toBe(1_500)
    expect(bridgeBlipGraceMs({ [GRACE_ENV]: '0' })).toBe(0)
  })

  it('falls back to the default for a value that is not a usable duration', () => {
    for (const bad of ['', '  ', 'abc', '-5', 'NaN', 'Infinity']) {
      expect(bridgeBlipGraceMs({ [GRACE_ENV]: bad })).toBe(5_000)
    }
  })
})

describe('callPrimaryControl across a bridge blip', () => {
  it('1. connected: sends at once with no added delay', async () => {
    const ws = connectPrimary()
    const started = Date.now()

    // No timer is ever advanced: a relay that parked on a wait could not settle.
    const out = await callPrimaryControl('detail', 'sid-connected', undefined, 10_000)

    expect(out).toEqual({ ok: true, result: { action: 'detail', sessionId: 'sid-connected' } })
    expect(Date.now() - started).toBe(0)
    expect(ws.controlFrames()).toHaveLength(1)
  })

  it('2. offline, redial after 300ms inside the grace: succeeds with exactly one send', async () => {
    const gone = dropPrimaryNow()
    let back: FakeBridgeWs | undefined
    setTimeout(() => { back = connectPrimary() }, 300)
    const started = Date.now()

    const call = track(callPrimaryControl('detail', 'sid-blip', undefined, 10_000))
    await vi.advanceTimersByTimeAsync(299)
    expect(call.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const out = await call.promise

    expect(out).toEqual({ ok: true, result: { action: 'detail', sessionId: 'sid-blip' } })
    // It answered the moment the link came back, not at the end of the grace.
    expect(Date.now() - started).toBe(300)
    expect(back!.controlFrames()).toHaveLength(1)
    expect(gone.controlFrames()).toHaveLength(0)
  })

  it('3. offline and never back: the same bridge_offline answer, after exactly the grace', async () => {
    dropPrimaryNow()
    const started = Date.now()

    const call = track(callPrimaryControl('detail', 'sid-gone', undefined, 30_000))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(call.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const out = await call.promise

    expect(out).toEqual({
      ok: false,
      failure: { kind: 'bridge_offline', message: OFFLINE, notSent: true },
    })
    expect(Date.now() - started).toBe(5_000)
  })

  it('3b. an env override sets the grace', async () => {
    process.env[GRACE_ENV] = '1500'
    dropPrimaryNow()
    const started = Date.now()

    const call = track(callPrimaryControl('detail', 'sid-env', undefined, 30_000))
    await vi.advanceTimersByTimeAsync(1_499)
    expect(call.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(call.settled()).toBe(true)
    expect(await call.promise).toMatchObject({ ok: false, failure: { kind: 'bridge_offline', notSent: true } })
    expect(Date.now() - started).toBe(1_500)
  })

  it('4. grace 0 (env) keeps the old instant failure', async () => {
    process.env[GRACE_ENV] = '0'
    dropPrimaryNow()
    // A redial that WOULD rescue a waiting relay: it must not be waited for.
    let back: FakeBridgeWs | undefined
    setTimeout(() => { back = connectPrimary() }, 300)
    const started = Date.now()

    const out = await callPrimaryControl('detail', 'sid-nograce', undefined, 10_000)

    expect(out).toEqual({ ok: false, failure: { kind: 'bridge_offline', message: OFFLINE, notSent: true } })
    expect(Date.now() - started).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(back!.controlFrames()).toHaveLength(0)
  })

  it('5. a timeout AFTER the send is not retried, and is not notSent', async () => {
    const silent = connectPrimary(null)
    const started = Date.now()

    const call = track(callPrimaryControl('patch', 'sid-timeout', { title: 'x' }, 2_000))
    await vi.advanceTimersByTimeAsync(2_000)
    const out = await call.promise

    expect(out).toEqual({
      ok: false,
      failure: {
        kind: 'bridge_offline',
        message: 'bridge request timed out: session.control → __local__',
        notSent: false,
      },
    })
    expect(Date.now() - started).toBe(2_000)
    // Well past any grace: still the single frame that went out.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(silent.controlFrames()).toHaveLength(1)
  })

  it('5b. a socket that drops with the request in flight is not retried on the redial', async () => {
    const first = connectPrimary(null)
    const call = track(callPrimaryControl('patch', 'sid-midflight', { title: 'x' }, 10_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(first.controlFrames()).toHaveLength(1)

    // The primary may already be applying the patch: the redial must not get it again.
    first.close()
    const second = connectPrimary()
    const out = await call.promise

    expect(out).toEqual({
      ok: false,
      failure: { kind: 'bridge_offline', message: 'bridge disconnected', notSent: false },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(second.controlFrames()).toHaveLength(0)
  })

  it('6. concurrent requests in one hole all ride the same redial', async () => {
    dropPrimaryNow()
    let back: FakeBridgeWs | undefined
    setTimeout(() => { back = connectPrimary() }, 300)

    const calls = ['sid-a', 'sid-b', 'sid-c'].map((sid) => callPrimaryControl('detail', sid, undefined, 10_000))
    await vi.advanceTimersByTimeAsync(300)
    const outs = await Promise.all(calls)

    expect(outs.map((o) => o.ok)).toEqual([true, true, true])
    const frames = back!.controlFrames()
    expect(frames.map((f) => f.sessionId).sort()).toEqual(['sid-a', 'sid-b', 'sid-c'])
    expect(new Set(frames.map((f) => f.id)).size).toBe(3)
  })

  it('takes the grace out of the timeout: at most half of it waiting, the rest for the send', async () => {
    dropPrimaryNow()
    const started = Date.now()

    // 4s budget: the 5s grace is capped at 2s.
    const call = track(callPrimaryControl('detail', 'sid-budget', undefined, 4_000))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(call.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(call.settled()).toBe(true)
    expect(await call.promise).toMatchObject({ ok: false, failure: { kind: 'bridge_offline', notSent: true } })
    expect(Date.now() - started).toBe(2_000)
  })

  it('a send after a wait gets only what is left of the budget, so the call ends on time', async () => {
    dropPrimaryNow()
    let back: FakeBridgeWs | undefined
    setTimeout(() => { back = connectPrimary(null) }, 1_500)
    const started = Date.now()

    const call = track(callPrimaryControl('detail', 'sid-remaining', undefined, 4_000))
    await vi.advanceTimersByTimeAsync(3_999)
    expect(call.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const out = await call.promise

    expect(out).toMatchObject({ ok: false, failure: { kind: 'bridge_offline', notSent: false } })
    // 1.5s waiting + 2.5s for the send = the caller's 4s, not 1.5s + a fresh 4s.
    expect(Date.now() - started).toBe(4_000)
    expect(back!.controlFrames()).toHaveLength(1)
  })

  it('a stale loss (the Mac asleep for a while) is not waited for', async () => {
    dropPrimaryNow()
    await vi.advanceTimersByTimeAsync(31_000)
    const started = Date.now()

    const out = await callPrimaryControl('detail', 'sid-stale', undefined, 10_000)

    expect(out).toEqual({ ok: false, failure: { kind: 'bridge_offline', message: OFFLINE, notSent: true } })
    expect(Date.now() - started).toBe(0)
  })

  it('a link that comes back and drops again before the send gets no second wait', async () => {
    dropPrimaryNow()
    let back: FakeBridgeWs | undefined
    // Connected handlers run synchronously inside the registration, after the
    // waiters are woken but before their continuations: the exact window.
    const unhook = addPrimaryBridgeConnectedHandler(() => { back?.close() })
    try {
      setTimeout(() => {
        back = new FakeBridgeWs(echo)
        attachBridge(back as never, 'bridge-local')
        back.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
      }, 300)
      const started = Date.now()

      const call = track(callPrimaryControl('detail', 'sid-reflap', undefined, 30_000))
      await vi.advanceTimersByTimeAsync(299)
      expect(call.settled()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(call.settled()).toBe(true)
      const out = await call.promise

      expect(out).toEqual({ ok: false, failure: { kind: 'bridge_offline', message: OFFLINE, notSent: true } })
      expect(Date.now() - started).toBe(300)
      expect(back!.controlFrames()).toHaveLength(0)
    } finally {
      unhook()
    }
  })

  it('a daemon with no primary server behind it is bridge_offline with notSent', async () => {
    connectPrimary(() => ({ ok: false, error: 'session.control: no primary server connected' }))

    const out = await callPrimaryControl('detail', 'sid-noserver', undefined, 10_000)

    expect(out).toMatchObject({ ok: false, failure: { kind: 'bridge_offline', notSent: true } })
  })
})

describe('relayControlAction (the HTTP driver) across a bridge blip', () => {
  it('connected: answers the success status without waiting', async () => {
    const ws = connectPrimary()
    const { res, state } = fakeRes()
    const started = Date.now()

    await relayControlAction(res, 'restart', 'sid-http-ok', undefined, 200)

    expect(state).toEqual({ status: 200, body: { action: 'restart', sessionId: 'sid-http-ok' } })
    expect(Date.now() - started).toBe(0)
    expect(ws.controlFrames()).toHaveLength(1)
  })

  it('offline, redial inside the grace: the phone gets the real answer from one send', async () => {
    dropPrimaryNow()
    let back: FakeBridgeWs | undefined
    setTimeout(() => { back = connectPrimary() }, 300)
    const { res, state } = fakeRes()

    const call = relayControlAction(res, 'restart', 'sid-http-blip', undefined, 200)
    await vi.advanceTimersByTimeAsync(300)
    await call

    expect(state).toEqual({ status: 200, body: { action: 'restart', sessionId: 'sid-http-blip' } })
    expect(back!.controlFrames()).toHaveLength(1)
  })

  it('offline and never back: 503 bridge_offline after the grace, saying it waited', async () => {
    dropPrimaryNow()
    const { res, state } = fakeRes()
    const started = Date.now()

    const call = relayControlAction(res, 'restart', 'sid-http-gone', undefined, 200)
    await vi.advanceTimersByTimeAsync(5_000)
    await call

    expect(Date.now() - started).toBe(5_000)
    expect(state).toEqual({
      status: 503,
      body: {
        error: {
          code: 'bridge_offline',
          message: 'Your primary box (Mac) has been unreachable for 5 seconds. '
            + 'It may be asleep (open the lid) or offline. Waited 5s for it to reconnect.',
        },
      },
    })
  })

  it('grace 0 (env): the old instant 503 with the old sentence', async () => {
    process.env[GRACE_ENV] = '0'
    dropPrimaryNow()
    const { res, state } = fakeRes()
    const started = Date.now()

    await relayControlAction(res, 'restart', 'sid-http-nograce', undefined, 200)

    expect(Date.now() - started).toBe(0)
    expect(state).toEqual({
      status: 503,
      body: {
        error: {
          code: 'bridge_offline',
          message: 'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.',
        },
      },
    })
  })
})

/**
 * session-control-v1 (the phone's model / effort / fork routes) rides the same
 * driver. A fork is the action a duplicate would hurt most (a second task on the
 * primary), so it is the one pinned end to end: the real router over HTTP, the
 * real registry, real timers and a hole that closes after 150ms.
 */
describe('session-control-v1 fork across a bridge blip', () => {
  beforeEach(() => {
    vi.useRealTimers()
    _resetLaunchSeedsForTesting()
  })

  function createApp(): express.Express {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', sessionControlV1Router)
    return app
  }

  /** The primary's accept reply for a fork, counting how many forks it ran. */
  function forkingPrimary(counter: { forks: number }): Replier {
    return (frame) => {
      counter.forks += 1
      return {
        ok: true,
        result: {
          sessionId: 'fork-new-1', taskId: 'task-new-1', title: 'Forked', status: 'pending',
          sourceSessionId: frame.sessionId, host: '',
        },
      }
    }
  }

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('a fork during a hole creates exactly one task on the primary (one frame) and seeds its host', async () => {
    dropPrimaryNow()
    const counter = { forks: 0 }
    let back: FakeBridgeWs | undefined
    const redial = setTimeout(() => { back = connectPrimary(forkingPrimary(counter)) }, 150)
    try {
      const res = await request(createApp())
        .post('/api/v1/sessions/sid-src/fork')
        .send({ create_child_task: true, title: 'Forked' })

      expect(res.status).toBe(201)
      expect(res.body).toEqual({
        sessionId: 'fork-new-1', taskId: 'task-new-1', title: 'Forked', status: 'pending',
        sourceSessionId: 'sid-src', host: '',
      })
      // Nothing trails the answer: no second delivery, ever.
      await settle(50)
      expect(counter.forks).toBe(1)
      const frames = back!.controlFrames()
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({
        action: 'fork', sessionId: 'sid-src', params: { create_child_task: true, title: 'Forked' },
      })
      // The fork success hook still runs on the relayed path ('' = the primary).
      expect(getLaunchSeed('fork-new-1')).toMatchObject({ host: '__local__' })
    } finally {
      clearTimeout(redial)
    }
  })

  it('a fork whose socket drops mid-request is never re-sent on the redial', async () => {
    const counter = { forks: 0 }
    let second: FakeBridgeWs | undefined
    // The first primary receives the fork and goes dark before answering: it may
    // already have created the task, so the redialed link must not get it again.
    const first: FakeBridgeWs = connectPrimary(null, () => {
      setImmediate(() => {
        first.close()
        second = connectPrimary(forkingPrimary(counter))
      })
    })

    const res = await request(createApp()).post('/api/v1/sessions/sid-src/fork').send({})

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: { code: 'bridge_offline', message: 'bridge disconnected' } })
    await settle(50)
    expect(first.controlFrames()).toHaveLength(1)
    expect(second!.controlFrames()).toHaveLength(0)
    expect(counter.forks).toBe(0)
    expect(getLaunchSeed('fork-new-1')).toBeNull()
  })

  it('model and effort keep their response shapes and error ladder over the shared hop', async () => {
    connectPrimary((frame) => {
      if (frame.action === 'model') return { ok: true, result: { model: 'opus', appliedLive: true } }
      if (frame.action === 'effort') return { ok: false, error: 'invalid effort', errorKind: 'bad_request' }
      return { ok: false, error: 'unknown command: session.control' }
    })
    const app = createApp()

    const model = await request(app).post('/api/v1/sessions/sid-src/model').send({ model: 'opus' })
    expect(model.status).toBe(200)
    expect(model.body).toEqual({ model: 'opus', appliedLive: true })

    const effort = await request(app).post('/api/v1/sessions/sid-src/effort').send({ effort: 'nope' })
    expect(effort.status).toBe(400)
    expect(effort.body).toEqual({ error: { code: 'bad_request', message: 'invalid effort' } })

    const options = await request(app).get('/api/v1/sessions/sid-src/model-options')
    expect(options.status).toBe(400)
    expect(options.body.error.code).toBe('session_control_needs_upgrade')
  })
})
