/**
 * The phone's chat model pill on a CLOUD REPLICA while the Mac is out of reach.
 *
 * When the primary provably did not get a turn, the companion answers it on its
 * own lane (api-v1-chat-cloud-fallback.test.ts). The pill used to ask the Mac all
 * the same, get 503 `primary_unreachable`, and show "Can't reach your Mac" while
 * the companion was the one answering (2026-10-06, three cloud-answered turns
 * under a pill that never left that state). This file pins the other half: under
 * the SAME proof a turn needs, the engine routes describe the companion's lane,
 * and that lane's model-options / model / effort / controls answer on this box.
 *
 * Real: startServer in CLOUD_MODE, the api-v1 routers, the companion lane (record
 * in this box's own SQLite registry), the turn fallback, a real /bridge socket
 * (the test plays the primary's daemon) for the bridge-up and relayed cases.
 * Mocked: constants (temp dirs); the 'session-runner' bus subscriber, replaced by
 * a fake that answers like a `claude` CLI and never spawns one; the CLI probe;
 * and, per test, the relay outcome of the box-level chat actions (HOW the relay
 * failed is the fact under test, which the fake primary cannot express).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-engine-cloud-lane', { CLOUD_MODE: true }))

const { relayOverride } = vi.hoisted(() => ({
  relayOverride: { fn: null as null | ((action: string, params: Record<string, unknown>) => unknown) },
}))
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()
  return {
    ...actual,
    callPrimaryControl: async (
      action: Parameters<typeof actual.callPrimaryControl>[0],
      sessionId: string,
      params: Record<string, unknown> | undefined,
      timeoutMs?: number,
    ) => {
      const forced = relayOverride.fn?.(action as string, params ?? {})
      if (forced !== undefined) return forced
      return actual.callPrimaryControl(action, sessionId, params, timeoutMs)
    },
  }
})

import yaml from 'js-yaml'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'
import { resetCloudExecCache } from '../../../src/core/cloud-owned-session.js'
import { _setCloudChatCliProbeForTesting } from '../../../src/web/routes/cloud-chat-fallback.js'
import { CLOUD_CHAT_OUTBOX_DIR } from '../../../src/core/cloud-chat-outbox.js'
import { CLOUD_CHAT_ALLOWED_TOOLS, CLOUD_CHAT_TOOLS, getOrCreateCloudChatLane } from '../../../src/core/sessions/cloud-chat-lane.js'
import { createSessionRecord, getSessionByClaudeId, listSessions, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

const EXEC_ROOT = `${WALNUT_HOME}-exec-root`
const CHAT_CWD = path.join(EXEC_ROOT, 'chat')

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Fake session runner: answers like a `claude` CLI, never spawns one ──

let starts: SessionStartEvent[] = []
let sends: SessionSendEvent[] = []
const drains = new Set<Promise<void>>()

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    let message = ''
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      starts.push(d)
      sid = d.preassignedSessionId
      message = d.message ?? ''
    } else if (event.name === EventNames.SESSION_SEND) {
      const d = event.data as SessionSendEvent
      sends.push(d)
      sid = d.sessionId
      message = 'send'
    }
    if (!sid) return
    const p = (async () => {
      try {
        const batch = await markProcessing(sid!)
        if (batch.length > 0) await removeProcessed(sid!, batch.map((m) => m.id))
      } catch { /* store torn down between tests */ }
    })()
    drains.add(p)
    void p.finally(() => drains.delete(p))
    // A message-less spawn (the pill's mint) starts a CLI that waits for input:
    // no turn, so no result.
    if (!message) return
    setTimeout(() => {
      const src = { source: 'session-runner' as const }
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: sid!, delta: 'Cloud ' }, ['main-ai'], src)
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: 'Cloud answer.', isError: false },
        ['main-ai', 'session-runner'], src)
    }, 10)
  })
}

// ── Fake bridge socket standing in for the PRIMARY's daemon ──

interface UplinkFrame { id: number; cmd: string; action?: string; sessionId?: string; params?: Record<string, unknown> }

class FakePrimaryDaemon extends EventEmitter {
  received: UplinkFrame[] = []
  onControl: ((frame: UplinkFrame) => Record<string, unknown>) | null = null
  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    if (frame.cmd === 'session.control' && this.onControl) {
      const answer = this.onControl(frame)
      setTimeout(() => this.inbound({ id: frame.id, ...answer }), 0)
    }
  }
  close(): void { this.emit('close') }
  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
  controlFrames(action: string): UplinkFrame[] {
    return this.received.filter((f) => f.cmd === 'session.control' && f.action === action)
  }
}

function connectFakePrimary(onControl: (frame: UplinkFrame) => Record<string, unknown>): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  ws.onControl = onControl
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

// ── HTTP helpers ──

async function call(
  method: string, p: string, body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(p), {
    method,
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

const getEngine = (convId: string) => call('GET', `/api/v1/chat/engine?conversationId=${convId}`)
const mintEngine = (convId: string) => call('POST', `/api/v1/chat/engine/session?conversationId=${convId}`, {})

function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code
}

/** One SSE turn on a conversation: post it, wait for its terminal frame. */
async function runTurn(conversationId: string, text: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/stream`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
    signal: controller.signal,
  })
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  try {
    const posted = await call('POST', `/api/v1/conversations/${conversationId}/messages`, { text })
    expect(posted.status).toBe(202)
    let buffer = ''
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7)
        const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
        if (event === 'message-end' || event === 'error') return { event, ...(data ? JSON.parse(data) : {}) }
      }
    }
    throw new Error('turn did not end')
  } finally {
    controller.abort()
  }
}

/** `maxSessions` is high by default: lanes minted by earlier tests stay in the
 *  registry, and only the cap test is about the cap. */
async function writeConfig(execOn: boolean, maxSessions = 50): Promise<void> {
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    ...(execOn ? { cloud: { exec: { enabled: true, cwd_roots: [EXEC_ROOT], max_sessions: maxSessions } } } : {}),
  }), 'utf-8')
  resetCloudExecCache()
}

/** A relay that provably never reached the primary (no bridge after the grace). */
const NOT_SENT = {
  ok: false,
  failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true },
}
/** Sent, then timed out: the primary MAY have it. */
const AMBIGUOUS = {
  ok: false,
  failure: { kind: 'bridge_offline', message: 'bridge request timed out after 15000ms', notSent: false },
}
const OLD_PRIMARY = {
  ok: false,
  failure: { kind: 'needs_upgrade', message: 'The primary box predates this mobile action' },
}

/** Every box-level chat action fails the same way (the Mac is away). */
function macAway(outcome: unknown = NOT_SENT): void {
  relayOverride.fn = (action) => (action.startsWith('server.chat.') ? outcome : undefined)
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(true)
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('chat-engine-cloud-lane-phone')).token
  installFakeRunner()
}, 90_000)

afterAll(async () => {
  closeAllBridges()
  _setCloudChatCliProbeForTesting(null)
  await Promise.allSettled([...drains])
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(EXEC_ROOT, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  closeAllBridges()
  resetChatTurnRelayState()
  starts = []
  sends = []
  macAway()
  _setCloudChatCliProbeForTesting(() => true)
  await writeConfig(true)
  await fs.rm(CLOUD_CHAT_OUTBOX_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.allSettled([...drains])
})

describe('the Mac is provably away and this box answers turns: the engine is its own lane', () => {
  it('GET names the companion lane and never spawns; POST mints it once; the next turn runs on it', async () => {
    const conv = await createConversation('general')

    // 1. Before anything ran here: a lane engine with no session yet, on THIS box.
    const before = await getEngine(conv.id)
    expect(before.status).toBe(200)
    expect(before.body).toEqual({
      engine: 'lane', sessionId: null, cwd: CHAT_CWD, host: '__cloud__', answeredBy: 'cloud',
    })
    expect(starts).toHaveLength(0)

    // 2. The pill mints, exactly as it does against the Mac.
    const minted = await mintEngine(conv.id)
    expect(minted.status).toBe(200)
    const sid = minted.body.sessionId as string
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    expect(minted.body).toMatchObject({
      engine: 'lane', switchable: true, cwd: CHAT_CWD, host: '__cloud__', answeredBy: 'cloud', created: true,
    })
    expect(starts).toHaveLength(1)
    // The spawn is the turn fallback's own posture, with no message to answer.
    expect(starts[0]).toMatchObject({
      lane: `cloud-chat:general:${conv.id}`, cwd: CHAT_CWD, mode: 'dontAsk', message: '', preassignedSessionId: sid,
    })
    expect(starts[0].profile?.allowedTools).toEqual(CLOUD_CHAT_ALLOWED_TOOLS)
    expect(starts[0].profile?.tools).toEqual(CLOUD_CHAT_TOOLS)
    expect(starts[0].profile?.mcpServers?.walnut).toBeUndefined()

    // 3. A second mint and a re-read reuse it.
    const again = await mintEngine(conv.id)
    expect(again.body).toMatchObject({ sessionId: sid, created: false })
    const after = await getEngine(conv.id)
    expect(after.body).toEqual({
      engine: 'lane', sessionId: sid, switchable: true, cwd: CHAT_CWD, host: '__cloud__', answeredBy: 'cloud',
    })
    expect(starts).toHaveLength(1)

    // 4. The next turn is answered on THAT lane: no second spawn, one send to it.
    const end = await runTurn(conv.id, 'hello from the phone')
    expect(end).toMatchObject({ event: 'message-end', answeredBy: 'cloud', fullText: 'Cloud answer.' })
    expect(starts).toHaveLength(1)
    expect(sends.map((s) => s.sessionId)).toEqual([sid])
  }, 60_000)

  it("a first turn that joins the pill's in-flight mint still sends its own message", async () => {
    const conv = await createConversation('general')
    const [mint, turn] = await Promise.all([
      getOrCreateCloudChatLane('general', conv.id, CHAT_CWD, ''),
      getOrCreateCloudChatLane('general', conv.id, CHAT_CWD, 'hello'),
    ])
    expect(turn.sessionId).toBe(mint.sessionId)
    expect(starts).toHaveLength(1)
    expect(starts[0].message).toBe('')
    expect(mint.created).toBe(true)
    // created=true would tell the turn its message rode a spawn that carried none.
    expect(turn.created).toBe(false)
  }, 60_000)

  it('the real relay with no bridge at all proves non-delivery on its own (nothing forced)', async () => {
    relayOverride.fn = null
    const conv = await createConversation('general')
    const res = await getEngine(conv.id)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ engine: 'lane', host: '__cloud__', answeredBy: 'cloud' })
  }, 60_000)

  it("the pill's mints stop at the CLI cap; the conversation's first turn still gets its lane", async () => {
    // Earlier tests' lanes are never confirmed by the fake runner, so they would
    // all count: retire them, then hold the box to two.
    for (const s of await listSessions()) {
      if (s.lane?.startsWith('cloud-chat:')) await updateSessionRecord(s.claudeSessionId, { process_status: 'stopped' })
    }
    await writeConfig(true, 2)
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => createConversation('general')))
    expect((await mintEngine(a.id)).status).toBe(200)
    expect((await mintEngine(b.id)).status).toBe(200)
    const third = await mintEngine(c.id)
    expect(third.status).toBe(409)
    expect(errorCode(third.body)).toBe('cloud_lane_capacity')
    expect(starts).toHaveLength(2)
    // A re-mint of a conversation that HAS its lane is not a new CLI: still fine.
    expect((await mintEngine(a.id)).body).toMatchObject({ created: false })
    // The read never spawns, so it still answers, with no session yet.
    expect((await getEngine(c.id)).body).toMatchObject({ sessionId: null, answeredBy: 'cloud' })
    // The turn is not the pill: it mints its lane as before.
    const end = await runTurn(c.id, 'first message')
    expect(end).toMatchObject({ event: 'message-end', answeredBy: 'cloud' })
    expect(starts).toHaveLength(3)
  }, 60_000)

  it("the lane's model-options, model and effort answer on this box with no bridge at all", async () => {
    const conv = await createConversation('general')
    const sid = (await mintEngine(conv.id)).body.sessionId as string
    relayOverride.fn = null // nothing below may reach for the primary

    const options = await call('GET', `/api/v1/sessions/${sid}/model-options`)
    expect(options.status).toBe(200)
    const models = options.body.models as Array<{ id: string; supportedEffortLevels?: string[] }>
    expect(models.length).toBeGreaterThan(0)

    const pick = models.find((m) => m.id !== options.body.current) ?? models[0]
    const switched = await call('POST', `/api/v1/sessions/${sid}/model`, { model: pick.id })
    expect(switched.status).toBe(200)
    expect(switched.body).toMatchObject({ model: pick.id, appliedLive: false })
    const record = await getSessionByClaudeId(sid)
    expect(record?.cliModel).toBe(switched.body.cliModel)

    const reread = await call('GET', `/api/v1/sessions/${sid}/model-options`)
    expect(reread.status).toBe(200)
    expect(reread.body.current).toBe(pick.id)

    const effort = await call('POST', `/api/v1/sessions/${sid}/effort`, { effort: 'low' })
    expect(effort.status).toBe(200)
    expect((await getSessionByClaudeId(sid))?.effort).toBe('low')
  }, 60_000)

  it("the lane's mode is shown as its one fixed value and a switch is refused", async () => {
    const conv = await createConversation('general')
    const sid = (await mintEngine(conv.id)).body.sessionId as string
    relayOverride.fn = null

    const controls = await call('GET', `/api/v1/sessions/${sid}/controls`)
    expect(controls.status).toBe(200)
    expect(controls.body).toEqual({
      engine: 'claude',
      controls: [{
        id: 'mode', name: 'Mode', type: 'select', currentValue: 'dontAsk',
        options: [{ value: 'dontAsk', name: expect.any(String) }],
      }],
    })

    const refused = await call('POST', `/api/v1/sessions/${sid}/controls`, { id: 'mode', value: 'bypass' })
    expect(refused.status).toBe(409)
    expect(errorCode(refused.body)).toBe('conflict')
    expect((await getSessionByClaudeId(sid))?.mode).toBe('dontAsk')

    const same = await call('POST', `/api/v1/sessions/${sid}/controls`, { id: 'mode', value: 'dontAsk' })
    expect(same.status).toBe(200)
    expect(same.body).toEqual(controls.body)
  }, 60_000)
})

describe('anything short of that proof keeps the 503', () => {
  it('a relay that may have reached the primary (sent, then timed out)', async () => {
    const conv = await createConversation('general')
    await mintEngine(conv.id) // a lane exists, and still must not be reported
    macAway(AMBIGUOUS)
    for (const res of [await getEngine(conv.id), await mintEngine(conv.id)]) {
      expect(res.status).toBe(503)
      expect(errorCode(res.body)).toBe('primary_unreachable')
      expect(res.body.sessionId).toBeUndefined()
    }
  }, 60_000)

  it('an old primary that does not know the engine action (the turn may still go there)', async () => {
    const conv = await createConversation('general')
    macAway(OLD_PRIMARY)
    const res = await getEngine(conv.id)
    expect(res.status).toBe(503)
    expect(errorCode(res.body)).toBe('primary_unreachable')
    expect(starts).toHaveLength(0)
  }, 60_000)

  it('cloud exec off, or no Claude Code CLI on the box: nothing here could answer', async () => {
    const conv = await createConversation('general')
    await writeConfig(false)
    expect((await getEngine(conv.id)).status).toBe(503)
    expect((await mintEngine(conv.id)).status).toBe(503)

    await writeConfig(true)
    _setCloudChatCliProbeForTesting(() => false)
    expect((await getEngine(conv.id)).status).toBe(503)
    expect((await mintEngine(conv.id)).status).toBe(503)
    expect(starts).toHaveLength(0)
  }, 60_000)

  it('a lane minted while the Mac was away is not answered here once exec is turned off', async () => {
    const conv = await createConversation('general')
    const sid = (await mintEngine(conv.id)).body.sessionId as string
    await writeConfig(false)
    relayOverride.fn = null
    // Not ours any more → relayed, and with no bridge that is the plain 503.
    const options = await call('GET', `/api/v1/sessions/${sid}/model-options`)
    expect(options.status).toBe(503)
    expect(errorCode(options.body)).toBe('bridge_offline')
    const controls = await call('GET', `/api/v1/sessions/${sid}/controls`)
    expect(controls.status).toBe(503)
  }, 60_000)
})

describe('the Mac is reachable: nothing changes', () => {
  it("GET returns the primary's own lane even when a companion lane exists for the conversation", async () => {
    const conv = await createConversation('general')
    await mintEngine(conv.id)
    relayOverride.fn = null
    const primary = connectFakePrimary(() => ({
      ok: true, result: { engine: 'lane', sessionId: 'mac-lane-1', switchable: true, host: '' },
    }))
    try {
      const res = await getEngine(conv.id)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ engine: 'lane', sessionId: 'mac-lane-1', switchable: true, host: '' })
      expect(primary.controlFrames('server.chat.engine')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)

  it("a primary REFUSAL passes through: it ran the action", async () => {
    const conv = await createConversation('general')
    relayOverride.fn = null
    const primary = connectFakePrimary(() => ({ ok: false, error: 'Agent not found', errorKind: 'not_found' }))
    try {
      const res = await getEngine(conv.id)
      expect(res.status).toBe(404)
      expect(starts).toHaveLength(0)
    } finally {
      primary.close()
    }
  }, 60_000)

  it("a session the Mac runs still relays model-options and controls", async () => {
    relayOverride.fn = null
    // The primary's lane record, git-synced here would never be in this registry;
    // a session id this box has never heard of is the normal case.
    const primary = connectFakePrimary((frame) => {
      if (frame.action === 'model-options') return { ok: true, result: { models: [{ id: 'opus', label: 'Opus' }], current: 'opus', currentEffort: null } }
      if (frame.action === 'controls') return { ok: true, result: { engine: 'claude', controls: [] } }
      return { ok: false, error: 'unexpected', errorKind: 'internal' }
    })
    try {
      const options = await call('GET', '/api/v1/sessions/mac-session-1/model-options')
      expect(options.status).toBe(200)
      expect(options.body.current).toBe('opus')
      const controls = await call('GET', '/api/v1/sessions/mac-session-1/controls')
      expect(controls.status).toBe(200)
      expect(primary.controlFrames('model-options')).toHaveLength(1)
      expect(primary.controlFrames('controls')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)

  it('the fixed mode is the chat lane\'s alone: another session this box runs is not answered with it', async () => {
    relayOverride.fn = null
    await createSessionRecord('cloud-exec-sess-1', '', '', EXEC_ROOT, { title: 'cloud work', mode: 'default' })
    const primary = connectFakePrimary((frame) => (frame.action === 'controls'
      ? { ok: true, result: { engine: 'claude', controls: [] } }
      : { ok: false, error: 'unexpected', errorKind: 'internal' }))
    try {
      // model-options answers here (this box owns the record)...
      const options = await call('GET', '/api/v1/sessions/cloud-exec-sess-1/model-options')
      expect(options.status).toBe(200)
      expect(primary.controlFrames('model-options')).toHaveLength(0)
      // ...but its controls are outside this change (they relay as before).
      const controls = await call('GET', '/api/v1/sessions/cloud-exec-sess-1/controls')
      expect(controls.body).not.toMatchObject({ controls: [{ currentValue: 'dontAsk' }] })
      expect(primary.controlFrames('controls')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)
})
