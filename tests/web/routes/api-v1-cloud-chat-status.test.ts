/**
 * The cloud companion tells the phone, ahead of any turn, whether it can answer
 * a chat turn by itself (`GET /api/v1/status` → `cloudChat`), and labels the
 * replies it gave in history (`answeredBy: 'cloud'` on GET /messages rows).
 *
 * Real: startServer in CLOUD_MODE, the api-v1 router and its SSE channel, the
 * fallback predicate (cloudChatCapability / decideCloudFallback), the per-agent
 * turn queue, runLaneTurn, the companion lane, the non-git outbox, the chat
 * history store and the fake-primary bridge socket for the relayed read.
 * Mocked: constants (temp dirs); the 'session-runner' bus subscriber (a fake CLI
 * that never spawns); the CLI probe; and the relay outcome for `server.chat.turn`
 * and `server.chat.messages` (what is under test is what happens when the relay
 * provably went nowhere).
 *
 * Matrix: exec on + CLI present → available; exec off, CLI missing, an unusable
 * chat folder (exec reports enabled, yet no turn could run) → unavailable; the
 * predicate throwing → key omitted; for every one of those the status value
 * agrees with what a real turn then does; a banked answer, its synced adopted
 * copy and a relayed primary page each carry `answeredBy` on the cloud answer
 * only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-chat-status', { CLOUD_MODE: true }))

const { relayOverride } = vi.hoisted(() => ({
  relayOverride: { fn: null as null | ((action: string) => unknown) },
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
      const forced = relayOverride.fn?.(action as string)
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
import {
  _setCloudChatCliProbeForTesting, PRIMARY_UNREACHABLE_MESSAGE, cloudChatCapability,
} from '../../../src/web/routes/cloud-chat-fallback.js'
import { CLOUD_CHAT_OUTBOX_DIR, listCloudTurns } from '../../../src/core/cloud-chat-outbox.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

const EXEC_ROOT = `${WALNUT_HOME}-status-exec-root`

let server: HttpServer
let port: number
let deviceToken: string
let starts: SessionStartEvent[] = []
const drains = new Set<Promise<void>>()

const apiUrl = (p: string): string => `http://localhost:${port}${p}`
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${deviceToken}` })

/** Fake CLI: answers every start/send on the next tick, never spawns. */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      starts.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      sid = (event.data as SessionSendEvent).sessionId
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
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: 'Answer from the companion.', isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 10)
  })
}

/** Stands in for the PRIMARY's daemon on the /bridge socket. */
class FakePrimaryDaemon extends EventEmitter {
  constructor(private readonly onControl: (action: string) => Record<string, unknown>) { super() }
  send(payload: string): void {
    const frame = JSON.parse(payload) as { id: number; cmd: string; action?: string }
    if (frame.cmd !== 'session.control') return
    const answer = this.onControl(frame.action ?? '')
    setTimeout(() => this.inbound({ id: frame.id, ...answer }), 0)
  }
  close(): void { this.emit('close') }
  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

function connectFakePrimary(onControl: (action: string) => Record<string, unknown>): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon(onControl)
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

interface SseEvt { event: string; data: Record<string, unknown> }

/** Minimal SSE reader: resolves with the first frame matching `pred`. */
async function openSse(conversationId: string): Promise<{
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}> {
  const controller = new AbortController()
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/stream`), {
    headers: auth(), signal: controller.signal,
  })
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`)
  const events: SseEvt[] = []
  const waiters: Array<{ pred: (e: SseEvt) => boolean; resolve: (e: SseEvt) => void }> = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let event = ''
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { event, data: data ? JSON.parse(data) : {} }
          events.push(evt)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(evt)) { waiters[i].resolve(evt); waiters.splice(i, 1) }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    waitFor: (pred, timeoutMs = 20_000) => {
      const hit = events.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise<SseEvt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timed out')), timeoutMs)
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e) } })
      })
    },
    close: () => controller.abort(),
  }
}

async function getStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/v1/status'), { headers: auth() })
  expect(res.status).toBe(200)
  return await res.json() as Record<string, unknown>
}

interface Row { id: string; role: string; text: string; kind?: string; answeredBy?: string }

async function getMessages(conversationId: string): Promise<Row[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), { headers: auth() })
  expect(res.status).toBe(200)
  return await res.json() as Row[]
}

/** POST one text turn and wait for its terminal frame. */
async function sendTurn(conversationId: string, text: string): Promise<SseEvt> {
  const sse = await openSse(conversationId)
  try {
    const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    })
    expect(res.status).toBe(202)
    return await sse.waitFor((e) => e.event === 'message-end' || e.event === 'error')
  } finally {
    sse.close()
  }
}

async function writeConfig(exec: false | { cwdRoot: string }): Promise<void> {
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    ...(exec ? { cloud: { exec: { enabled: true, cwd_roots: [exec.cwdRoot] } } } : {}),
  }), 'utf-8')
  resetCloudExecCache()
}

/** The relay outcome of a call that provably never reached the primary. */
const NOT_SENT = {
  ok: false,
  failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true },
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(false)
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('cloud-chat-status-phone')).token
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
  relayOverride.fn = (action) => (action === 'server.chat.turn' || action === 'server.chat.messages' ? NOT_SENT : undefined)
  _setCloudChatCliProbeForTesting(() => true)
  await writeConfig({ cwdRoot: EXEC_ROOT })
  await fs.rm(CLOUD_CHAT_OUTBOX_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.allSettled([...drains])
})

// Every state the predicate distinguishes. `execEnabled` is what the existing
// `cloudExec` field says, which is exactly why it cannot stand in for this one.
const STATES: Array<{
  label: string
  setup: () => Promise<void>
  cloudChat: 'available' | 'unavailable'
  execEnabled: boolean
  why?: string
}> = [
  { label: 'cloud exec on and the CLI present', setup: async () => {}, cloudChat: 'available', execEnabled: true },
  {
    label: 'cloud exec off', setup: () => writeConfig(false),
    cloudChat: 'unavailable', execEnabled: false, why: 'Cloud exec is not enabled',
  },
  {
    label: 'the claude CLI missing', setup: async () => { _setCloudChatCliProbeForTesting(() => false) },
    cloudChat: 'unavailable', execEnabled: true, why: 'Claude Code CLI is not installed',
  },
  {
    label: 'an exec root inside the Walnut data folder (exec says enabled, no turn can run)',
    setup: () => writeConfig({ cwdRoot: path.join(WALNUT_HOME, 'exec-inside-data') }),
    cloudChat: 'unavailable', execEnabled: true, why: 'inside the Walnut data folder',
  },
]

describe('GET /api/v1/status → cloudChat (REPLICA)', () => {
  it.each(STATES)('$label → $cloudChat', async ({ setup, cloudChat, execEnabled }) => {
    await setup()
    const status = await getStatus()
    expect(status.mode).toBe('REPLICA')
    expect(status.cloudChat).toBe(cloudChat)
    expect((status.cloudExec as { enabled?: boolean } | undefined)?.enabled).toBe(execEnabled)
  })

  it('omits the key when the check itself throws, and the rest of the status still answers', async () => {
    _setCloudChatCliProbeForTesting(() => { throw new Error('probe failed') })
    const status = await getStatus()
    expect(status.mode).toBe('REPLICA')
    expect(typeof status.serverTime).toBe('string')
    expect('cloudChat' in status).toBe(false)
  })

  it('a repeated poll answers the same, and the value tracks a config change on the next poll', async () => {
    expect((await getStatus()).cloudChat).toBe('available')
    expect((await getStatus()).cloudChat).toBe('available')
    await writeConfig(false)
    expect((await getStatus()).cloudChat).toBe('unavailable')
    await writeConfig({ cwdRoot: EXEC_ROOT })
    expect((await getStatus()).cloudChat).toBe('available')
  })
})

describe('the status value agrees with what a real turn then does', () => {
  it.each(STATES)('$label', async ({ setup, cloudChat, why }) => {
    await setup()
    expect((await getStatus()).cloudChat).toBe(cloudChat)
    expect((await cloudChatCapability()).kind).toBe(cloudChat === 'available' ? 'run' : 'refuse')

    const conv = await createConversation('general')
    const terminal = await sendTurn(conv.id, 'is anyone there?')
    if (cloudChat === 'available') {
      expect(terminal.event).toBe('message-end')
      expect(terminal.data).toMatchObject({ fullText: 'Answer from the companion.', answeredBy: 'cloud' })
      expect(starts).toHaveLength(1)
      expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(1)
    } else {
      expect(terminal.event).toBe('error')
      expect(String(terminal.data.message).startsWith(PRIMARY_UNREACHABLE_MESSAGE)).toBe(true)
      expect(String(terminal.data.message)).toContain(why!)
      expect(starts).toHaveLength(0)
      expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(0)
    }
  }, 60_000)
})

describe('GET /messages on the replica: answeredBy on the cloud answer only', () => {
  it('a banked answered turn (relay down): the answer row carries it, the user row does not', async () => {
    const conv = await createConversation('general')
    await sendTurn(conv.id, 'what is on the list today?')
    const rows = await getMessages(conv.id)
    expect(rows.map((r) => [r.id, r.role, r.text, r.answeredBy])).toEqual([
      ['m0', 'user', 'what is on the list today?', undefined],
      ['m1', 'assistant', 'Answer from the companion.', 'cloud'],
    ])
    expect('answeredBy' in rows[0]).toBe(false)
  }, 60_000)

  it('the same turn once its adopted copy synced back: still labelled, still once', async () => {
    const conv = await createConversation('general')
    await sendTurn(conv.id, 'remind me about the plants')
    const [entry] = await listCloudTurns({ conversationId: conv.id })
    // The primary's own writer, as git-sync would deliver its file back here.
    await chatHistory.adoptCloudTurn({
      agentId: 'general', conversationId: conv.id, turnId: entry.turnId, userText: entry.userText,
      userAt: entry.userAt, answerText: entry.answerText, answeredAt: entry.answeredAt, engine: entry.engine!,
    })
    const rows = await getMessages(conv.id)
    expect(rows.map((r) => [r.role, r.text, r.answeredBy])).toEqual([
      ['user', 'remind me about the plants', undefined],
      ['assistant', 'Answer from the companion.', 'cloud'],
    ])
  }, 60_000)

  it('a live relayed tail page: the primary rows pass through unlabelled, the merged banked answer is labelled', async () => {
    const conv = await createConversation('general')
    await sendTurn(conv.id, 'asked while the primary slept')

    relayOverride.fn = null // the real relay, over the fake bridge below
    const past = (ms: number) => new Date(Date.now() - ms).toISOString()
    const page = [
      { id: 'm2', role: 'user', text: 'older question', createdAt: past(600_000) },
      { id: 'm3', role: 'assistant', text: 'older answer from the primary', createdAt: past(590_000) },
    ]
    const primary = connectFakePrimary((action) => (action === 'server.chat.messages'
      ? { ok: true, result: { messages: page, source: 'lane', known: true, adoptedTurnIds: [] } }
      : { ok: false, error: `Unknown control action: ${action}` }))
    try {
      const rows = await getMessages(conv.id)
      expect(rows.map((r) => [r.id, r.role, r.text, r.answeredBy])).toEqual([
        ['m2', 'user', 'older question', undefined],
        ['m3', 'assistant', 'older answer from the primary', undefined],
        ['m4', 'user', 'asked while the primary slept', undefined],
        ['m5', 'assistant', 'Answer from the companion.', 'cloud'],
      ])
    } finally {
      primary.close()
    }
  }, 60_000)
})
