/**
 * The cloud companion answers a phone chat turn ITSELF when the primary
 * provably cannot receive it, and hands the turn to the primary later.
 *
 * Real: startServer in CLOUD_MODE, the api-v1 router and its SSE channel, the
 * per-agent turn queue, runLaneTurn, the companion lane (record in this box's own
 * SQLite registry), the non-git outbox, the flush over a real /bridge socket
 * (attachBridge/handleFrame, the test plays the primary's daemon).
 * Mocked: constants (temp dirs); the 'session-runner' bus subscriber, replaced by
 * a fake that answers like a `claude` CLI would and never spawns one; the CLI
 * probe; and, per test, the relay outcome of `server.chat.turn` (the one fact
 * under test is HOW the relay failed, which the fake primary cannot express).
 *
 * Matrix (see the task this pins): provable non-delivery answers locally with
 * the normal frames plus `answeredBy`; an ambiguous failure does not; exec off or
 * no CLI says why; two turns share one lane and the second carries what the Mac
 * answered in between; GET shows banked turns once; the flush hands them over
 * and keeps them for an old primary; a second POST during a local turn is a 409.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-cloud-fallback', { CLOUD_MODE: true }))

// Per-test override of one relay outcome; everything else takes the real path.
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
import { WALNUT_HOME, CONFIG_FILE, conversationFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation, touchLaneConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'
import { resetCloudExecCache } from '../../../src/core/cloud-owned-session.js'
import { _setCloudChatCliProbeForTesting, PRIMARY_UNREACHABLE_MESSAGE } from '../../../src/web/routes/cloud-chat-fallback.js'
import { CLOUD_CHAT_OUTBOX_DIR, listCloudTurns, flushCloudChatOutbox } from '../../../src/core/cloud-chat-outbox.js'
import { CLOUD_CHAT_ALLOWED_TOOLS, CLOUD_CHAT_TOOLS } from '../../../src/core/sessions/cloud-chat-lane.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { CATCH_UP_BANNER_OPEN } from '../../../src/core/chat-history.js'
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
/** What the fake CLI answers; `delayMs` holds the turn open (409 test). */
let reply = { text: 'Cloud answer.', delayMs: 10 }
const drains = new Set<Promise<void>>()

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      starts.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      const d = event.data as SessionSendEvent
      sends.push(d)
      sid = d.sessionId
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
    const { text, delayMs } = reply
    setTimeout(() => {
      const src = { source: 'session-runner' as const }
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: sid!, delta: 'Cloud ' }, ['main-ai'], src)
      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: sid!, toolName: 'Read', toolUseId: 'tu-1', input: { file_path: '/srv/notes.md' },
      }, ['main-ai'], src)
      bus.emit(EventNames.SESSION_TOOL_RESULT, { sessionId: sid!, toolUseId: 'tu-1', result: 'file body' }, ['main-ai'], src)
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: text, isError: false },
        ['main-ai', 'session-runner'], src)
    }, delayMs)
  })
}

// ── Fake bridge socket standing in for the PRIMARY's daemon ──

interface UplinkFrame { id: number; cmd: string; action?: string; params?: Record<string, unknown> }

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
}

function connectFakePrimary(onControl: (frame: UplinkFrame) => Record<string, unknown>): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  ws.onControl = onControl
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

// ── Minimal SSE client ──

interface SseEvt { event: string; data: Record<string, unknown> }

async function connectSse(conversationId: string): Promise<{
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}> {
  const controller = new AbortController()
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/stream`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
    signal: controller.signal,
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
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
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
    events,
    waitFor: (pred, timeoutMs = 20_000) => {
      const existing = events.find(pred)
      if (existing) return Promise.resolve(existing)
      return new Promise<SseEvt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timed out')), timeoutMs)
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e) } })
      })
    },
    close: () => controller.abort(),
  }
}

async function postMessage(conversationId: string, text: string): Promise<{ status: number; turnId: string; code?: string }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const body = await res.json().catch(() => ({})) as { turnId?: string; error?: { code?: string } }
  return { status: res.status, turnId: body.turnId ?? '', code: body.error?.code }
}

async function getMessages(conversationId: string): Promise<Array<{ id: string; role: string; text: string; createdAt: string }>> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  expect(res.status).toBe(200)
  return await res.json() as Array<{ id: string; role: string; text: string; createdAt: string }>
}

/**
 * One turn exactly as the PRIMARY persists it, arriving here by git-sync. Written
 * with the primary's own writers so the shape cannot drift from production:
 * - a phone (REST) lane turn: the user row with `displayText` + `turnId`, the
 *   answer stamped `engine: lane:<sid>` (api-v1.ts runApiV1Turn/runApiV1LaneTurn),
 *   plus that lane's `laneSeen` mark;
 * - a web chat compat copy (`stamped: false`): the answer carries no engine
 *   (routes/chat.ts), which is foreign to the companion's lane all the same.
 */
async function persistPrimaryTurn(
  conversationId: string, question: string, answer: string,
  opts: { macLaneSid: string; stamped?: boolean },
): Promise<void> {
  const turnId = crypto.randomUUID()
  await chatHistory.addUserMessage(question, { displayText: question, turnId, agentId: 'general', conversationId })
  const stamped = opts.stamped !== false
  await chatHistory.addAIMessages(
    [{ role: 'assistant', content: [{ type: 'text', text: answer }] }] as never,
    {
      agentId: 'general', conversationId,
      ...(stamped ? { engine: chatHistory.laneEngineLabel(opts.macLaneSid) } : { turnId }),
    },
  )
  if (stamped) {
    await chatHistory.recordLaneSeen('general', conversationId, chatHistory.laneEngineLabel(opts.macLaneSid),
      new Date().toISOString())
  }
}

/** The replica's own copy of the conversation file, raw. */
async function readConversationFile(conversationId: string): Promise<string> {
  return fs.readFile(conversationFile('general', conversationId), 'utf-8')
}

async function writeConfig(execOn: boolean): Promise<void> {
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    ...(execOn ? { cloud: { exec: { enabled: true, cwd_roots: [EXEC_ROOT] } } } : {}),
  }), 'utf-8')
  resetCloudExecCache()
}

/** The relay outcome of a turn that provably never reached the primary. */
const NOT_SENT = {
  ok: false,
  failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true },
}

async function until(check: () => Promise<boolean> | boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met within budget')
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(false)
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('cloud-fallback-test-phone')).token
  // Replace the real runner by NAME: nothing in this file can reach a spawn.
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
  reply = { text: 'Cloud answer.', delayMs: 10 }
  relayOverride.fn = (action) => (action === 'server.chat.turn' || action === 'server.chat.messages' ? NOT_SENT : undefined)
  _setCloudChatCliProbeForTesting(() => true)
  await writeConfig(true)
  await fs.rm(CLOUD_CHAT_OUTBOX_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.allSettled([...drains])
})

describe('provable non-delivery: the companion answers on its own lane', () => {
  it('streams the normal frames plus answeredBy, banks one outbox entry, and never writes the conversation file', async () => {
    const conv = await createConversation('general')
    const fileBefore = await readConversationFile(conv.id)
    const sse = await connectSse(conv.id)
    try {
      const posted = await postMessage(conv.id, 'what is on my plate?')
      expect(posted.status).toBe(202)

      const start = await sse.waitFor((e) => e.event === 'message-start')
      expect(start.data).toEqual({ turnId: posted.turnId, answeredBy: 'cloud' })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data).toEqual({
        turnId: posted.turnId, fullText: 'Cloud answer.', engine: 'claude-code', answeredBy: 'cloud',
      })
      // The same live frames a relayed turn carries, in causal order.
      const kinds = sse.events.map((e) => e.event)
      expect(kinds).toEqual(['message-start', 'text-delta', 'tool', 'tool-result', 'message-end'])
      expect(sse.events.find((e) => e.event === 'tool')!.data).toMatchObject({ name: 'Read', toolUseId: 'tu-1' })
      expect(sse.events.find((e) => e.event === 'tool-result')!.data).toMatchObject({ toolUseId: 'tu-1' })

      // The spawn: the companion's OWN lane key, its cwd under the exec root,
      // no Walnut MCP, a denied-unless-listed posture, and the cloud note.
      expect(starts).toHaveLength(1)
      const spawn = starts[0]
      expect(spawn.lane).toBe(`cloud-chat:general:${conv.id}`)
      expect(spawn.cwd).toBe(CHAT_CWD)
      expect(spawn.mode).toBe('dontAsk')
      expect(spawn.message).toBe('what is on my plate?')
      expect(spawn.profile?.mcpServers?.walnut).toBeUndefined()
      expect(spawn.profile?.allowedTools).toEqual(CLOUD_CHAT_ALLOWED_TOOLS)
      expect(spawn.profile?.tools).toEqual(CLOUD_CHAT_TOOLS)
      expect(spawn.profile?.tools).not.toContain('Bash')
      expect(spawn.profile?.systemPrompt).toContain('## Answering from the cloud companion')
      await expect(fs.stat(CHAT_CWD)).resolves.toBeTruthy()

      // Exactly one banked turn, answered, stamped with the companion lane.
      const banked = await listCloudTurns()
      expect(banked).toHaveLength(1)
      expect(banked[0]).toMatchObject({
        turnId: posted.turnId, conversationId: conv.id, userText: 'what is on my plate?',
        state: 'answered', answerText: 'Cloud answer.', engine: `cloud:${spawn.preassignedSessionId}`,
      })
      // One writer for the conversation file: the primary. Byte-identical here.
      expect(await readConversationFile(conv.id)).toBe(fileBefore)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('seeds a new companion lane from this box\'s synced copy of the conversation', async () => {
    const conv = await createConversation('general')
    const t0 = new Date(Date.now() - 60_000).toISOString()
    const t1 = new Date(Date.now() - 50_000).toISOString()
    await fs.writeFile(conversationFile('general', conv.id), JSON.stringify({
      version: 2, lastUpdated: t1, compactionCount: 0, compactionSummary: null,
      entries: [
        { tag: 'ai', role: 'user', content: 'remember the codeword heron', timestamp: t0 },
        { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'Noted: heron.' }], timestamp: t1, engine: 'lane:mac-1' },
      ],
    }))
    const sse = await connectSse(conv.id)
    try {
      await postMessage(conv.id, 'what was the codeword?')
      await sse.waitFor((e) => e.event === 'message-end')
      expect(starts[0].profile?.systemPrompt).toContain('remember the codeword heron')
      expect(starts[0].profile?.systemPrompt).toContain('Noted: heron.')
    } finally {
      sse.close()
    }
  }, 60_000)

  it('a phone-driven lane conversation, stored exactly as the primary stores it: the seed carries its prior Q and A', async () => {
    const conv = await createConversation('general')
    await persistPrimaryTurn(conv.id, 'remember the codeword kestrel', 'Noted: kestrel.', { macLaneSid: crypto.randomUUID() })
    // The shape measured on a real primary file: two entries, the answer stamped
    // with the Mac lane, and that lane's mark. NOT empty.
    const stored = JSON.parse(await readConversationFile(conv.id)) as {
      entries: Array<Record<string, unknown>>; laneSeen?: Record<string, string>
    }
    expect(stored.entries.map((e) => [e.role, typeof e.turnId, e.engine === undefined ? '-' : String(e.engine).slice(0, 5)]))
      .toEqual([['user', 'string', '-'], ['assistant', 'undefined', 'lane:']])
    expect(Object.keys(stored.laneSeen ?? {}).every((k) => k.startsWith('lane:'))).toBe(true)
    const fileBefore = await readConversationFile(conv.id)

    const sse = await connectSse(conv.id)
    try {
      await postMessage(conv.id, 'what was the codeword?')
      await sse.waitFor((e) => e.event === 'message-end')
      expect(starts).toHaveLength(1)
      // The seed rides the spawn profile, and the new message rides alone.
      expect(starts[0].profile?.systemPrompt).toContain('remember the codeword kestrel')
      expect(starts[0].profile?.systemPrompt).toContain('Noted: kestrel.')
      expect(starts[0].message).toBe('what was the codeword?')
      expect(await readConversationFile(conv.id)).toBe(fileBefore)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('a web chat turn in between (answer unstamped) is foreign to the companion lane and rides the next send', async () => {
    const conv = await createConversation('general')
    // A prior turn, so the mint seeds it and records a mark: from then on only
    // trigger A (answers given elsewhere, after the mark) can carry a new turn.
    await persistPrimaryTurn(conv.id, 'seeded at the mint', 'seeded answer', { macLaneSid: crypto.randomUUID() })
    const sse = await connectSse(conv.id)
    try {
      const first = await postMessage(conv.id, 'first question')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === first.turnId)
      expect(starts[0].profile?.systemPrompt).toContain('seeded at the mint')
      await persistPrimaryTurn(conv.id, 'typed in the web chat', 'answered in the web chat', {
        macLaneSid: crypto.randomUUID(), stamped: false,
      })
      const second = await postMessage(conv.id, 'second question')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === second.turnId)
      expect(sends).toHaveLength(1)
      expect(sends[0].message).toContain(CATCH_UP_BANNER_OPEN)
      expect(sends[0].message).toContain('typed in the web chat')
      expect(sends[0].message).toContain('answered in the web chat')
      // Trigger A, not a full recap: the turn the mint already gave is not repeated.
      expect(sends[0].message).not.toContain('seeded at the mint')
      expect(sends[0].message.endsWith('second question')).toBe(true)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('two turns reuse ONE lane, and the second carries the turn the Mac answered in between', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      const first = await postMessage(conv.id, 'first question')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === first.turnId)
      expect(starts).toHaveLength(1)
      const laneSid = starts[0].preassignedSessionId!

      // git-sync delivers a turn the Mac answered (web console) in between.
      const now = Date.now()
      const synced = JSON.stringify({
        version: 2, lastUpdated: new Date(now).toISOString(), compactionCount: 0, compactionSummary: null,
        entries: [
          { tag: 'ai', role: 'user', content: 'asked on the mac', timestamp: new Date(now - 2000).toISOString() },
          {
            tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'answered by the mac lane' }],
            timestamp: new Date(now - 1000).toISOString(), engine: 'lane:mac-2',
          },
        ],
      })
      await fs.writeFile(conversationFile('general', conv.id), synced)

      const second = await postMessage(conv.id, 'second question')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === second.turnId)
      expect(starts).toHaveLength(1) // no second mint
      expect(sends).toHaveLength(1)
      expect(sends[0].sessionId).toBe(laneSid)
      expect(sends[0].message).toContain(CATCH_UP_BANNER_OPEN)
      expect(sends[0].message).toContain('answered by the mac lane')
      expect(sends[0].message.endsWith('second question')).toBe(true)

      // Delivered once: the third send carries no recap (the mark lives in the
      // companion's own sidecar, never in the synced file).
      const third = await postMessage(conv.id, 'third question')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === third.turnId)
      expect(sends[1].message).toBe('third question')
      expect(await readConversationFile(conv.id)).toBe(synced)
      expect((await listCloudTurns({ conversationId: conv.id })).map((e) => e.userText))
        .toEqual(['first question', 'second question', 'third question'])
    } finally {
      sse.close()
    }
  }, 90_000)

  it('a second POST during a running companion turn gets the same 409 turn_active', async () => {
    reply = { text: 'slow answer', delayMs: 1500 }
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      const first = await postMessage(conv.id, 'take your time')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-start')
      const second = await postMessage(conv.id, 'are you there?')
      expect(second.status).toBe(409)
      expect(second.code).toBe('turn_active')
      await sse.waitFor((e) => e.event === 'message-end')
      expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 60_000)
})

describe('no local answer when it could double-answer or cannot run', () => {
  it('an ambiguous failure (timeout after send) keeps today\'s error and runs nothing', async () => {
    relayOverride.fn = (action) => (action === 'server.chat.turn'
      ? { ok: false, failure: { kind: 'bridge_offline', message: 'bridge request timed out: session.control → __local__' } }
      : undefined)
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      await postMessage(conv.id, 'hello?')
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(err.data.message).toBe(PRIMARY_UNREACHABLE_MESSAGE)
      expect(starts).toHaveLength(0)
      expect(await listCloudTurns()).toHaveLength(0)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('cloud exec off: the error says why, and nothing runs or is banked', async () => {
    await writeConfig(false)
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      await postMessage(conv.id, 'hello?')
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(String(err.data.message)).toContain(PRIMARY_UNREACHABLE_MESSAGE)
      expect(String(err.data.message)).toContain('Cloud exec is not enabled')
      expect(starts).toHaveLength(0)
      expect(await listCloudTurns()).toHaveLength(0)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('no claude CLI: the error says why, and nothing runs or is banked', async () => {
    _setCloudChatCliProbeForTesting(() => false)
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      await postMessage(conv.id, 'hello?')
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(String(err.data.message)).toContain(PRIMARY_UNREACHABLE_MESSAGE)
      expect(String(err.data.message)).toContain('Claude Code CLI is not installed')
      expect(starts).toHaveLength(0)
      expect(await listCloudTurns()).toHaveLength(0)
    } finally {
      sse.close()
    }
  }, 60_000)
})

describe('reads and the hand-over to the primary', () => {
  /** Answer one fallback turn and return its turnId. */
  async function answerOneTurn(conversationId: string, text: string): Promise<string> {
    const sse = await connectSse(conversationId)
    try {
      const posted = await postMessage(conversationId, text)
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === posted.turnId)
      return posted.turnId
    } finally {
      sse.close()
    }
  }

  it('GET shows a banked turn while unflushed (relay down), once, and not again after it synced back', async () => {
    const conv = await createConversation('general')
    const turnId = await answerOneTurn(conv.id, 'banked question')

    const rows = await getMessages(conv.id)
    expect(rows.map((r) => [r.id, r.role, r.text])).toEqual([
      ['m0', 'user', 'banked question'],
      ['m1', 'assistant', 'Cloud answer.'],
    ])

    // The adopted turn arrives back by git-sync before this box deleted its
    // entry: the synced copy wins, and the turn still shows exactly once.
    const [entry] = await listCloudTurns({ conversationId: conv.id })
    await fs.writeFile(conversationFile('general', conv.id), JSON.stringify({
      version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null,
      entries: [
        { tag: 'ai', role: 'user', content: 'banked question', timestamp: entry.userAt, turnId },
        {
          tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'Cloud answer.' }],
          timestamp: entry.answeredAt, turnId, engine: entry.engine,
        },
      ],
    }))
    expect((await getMessages(conv.id)).map((r) => r.text)).toEqual(['banked question', 'Cloud answer.'])
  }, 60_000)

  it('relay down on a phone-driven lane conversation: synced rows and banked rows merge by time, once each', async () => {
    const conv = await createConversation('general')
    await persistPrimaryTurn(conv.id, 'earlier phone question', 'earlier mac answer', { macLaneSid: crypto.randomUUID() })
    const turnId = await answerOneTurn(conv.id, 'asked while the mac slept')
    const expected = [
      ['m0', 'user', 'earlier phone question'], ['m1', 'assistant', 'earlier mac answer'],
      ['m2', 'user', 'asked while the mac slept'], ['m3', 'assistant', 'Cloud answer.'],
    ]
    expect((await getMessages(conv.id)).map((r) => [r.id, r.role, r.text])).toEqual(expected)

    // The primary adopts the turn and git-sync brings its file back BEFORE this
    // box deleted the entry: the synced copy and the outbox both hold it, and
    // turnId keeps it to one appearance. (The primary's own writer, same shape.)
    const [entry] = await listCloudTurns({ conversationId: conv.id })
    expect(await chatHistory.adoptCloudTurn({
      agentId: 'general', conversationId: conv.id, turnId, userText: entry.userText, userAt: entry.userAt,
      answerText: entry.answerText, answeredAt: entry.answeredAt, engine: entry.engine!,
    })).toBe('adopted')
    expect((await getMessages(conv.id)).map((r) => [r.id, r.role, r.text])).toEqual(expected)

    // Then the hand-over deletes the entry; the synced copy alone still shows it.
    relayOverride.fn = (action) => (action === 'server.chat.messages' ? NOT_SENT : undefined)
    const primary = connectFakePrimary((frame) => (frame.action === 'server.chat.adopt'
      ? { ok: true, result: { turnId: frame.params?.turnId, adopted: false, duplicate: true } }
      : { ok: false, error: `Unknown control action: ${frame.action}` }))
    try {
      await until(async () => (await listCloudTurns({ conversationId: conv.id })).length === 0)
    } finally {
      primary.close()
    }
    expect((await getMessages(conv.id)).map((r) => [r.id, r.role, r.text])).toEqual(expected)
  }, 60_000)

  it('relay down on a conversation driven from a Mac session panel: banked rows never stand in for its history', async () => {
    // The session panel (Ask Walnut slot) keeps its turns in the Mac's CLI
    // transcript and only bumps the index count, so the synced file is EMPTY
    // while the index says it has messages (24 of 109 conversations on a real
    // primary). iOS REPLACES its rows with a 200 body on the refetch it runs at
    // every message-end, so a page holding only the companion's own turn would
    // wipe the history the phone is showing. 503 makes it keep what it has.
    const conv = await createConversation('general')
    await touchLaneConversation('general', conv.id, 'an earlier question the Mac answered')
    await answerOneTurn(conv.id, 'asked while the mac slept')
    expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(1)

    const res = await fetch(apiUrl(`/api/v1/conversations/${conv.id}/messages`), {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('primary_unreachable')
  }, 60_000)

  it('GET through a live relay merges unadopted banked rows into the tail page, and drops adopted ones', async () => {
    const conv = await createConversation('general')
    const turnId = await answerOneTurn(conv.id, 'asked while the mac slept')

    relayOverride.fn = null // the real relay, over the fake bridge below
    const past = (ms: number) => new Date(Date.now() - ms).toISOString()
    const page = [
      { id: 'm4', role: 'user', text: 'older question', createdAt: past(600_000) },
      { id: 'm5', role: 'assistant', text: 'older answer', createdAt: past(590_000) },
    ]
    let adoptedTurnIds: string[] = []
    const primary = connectFakePrimary((frame) => {
      if (frame.action === 'server.chat.messages') {
        return { ok: true, result: { messages: page, source: 'lane', known: true, adoptedTurnIds } }
      }
      // An old primary: the hand-over must wait, not drop the turn.
      return { ok: false, error: `Unknown control action: ${frame.action}` }
    })
    try {
      const merged = await getMessages(conv.id)
      expect(merged.map((r) => [r.id, r.text])).toEqual([
        ['m4', 'older question'], ['m5', 'older answer'],
        ['m6', 'asked while the mac slept'], ['m7', 'Cloud answer.'],
      ])
      const uplink = primary.received.find((f) => f.action === 'server.chat.messages')!
      expect(uplink.params).toMatchObject({ pendingTurnIds: [turnId] })

      adoptedTurnIds = [turnId]
      expect((await getMessages(conv.id)).map((r) => r.id)).toEqual(['m4', 'm5'])
      // needs_upgrade kept the entry for later.
      expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)

  it('this box refuses server.chat.adopt itself (one writer: the primary), as a keep-it 503', async () => {
    // A cloud-exec replica runs its own loopback daemon, so its local clients can
    // reach the control relay here. Adoption must never write a file on this box.
    const conv = await createConversation('general')
    const fileBefore = await readConversationFile(conv.id)
    const { handleSessionControlRelay } = await import('../../../src/core/sessions/session-controls.js')
    const payload = {
      v: 1, turnId: 'turn-replica-refuse-1', agentId: 'general', userText: 'q', userAt: new Date().toISOString(),
      answerText: 'a', answeredAt: new Date().toISOString(), engine: 'cloud:lane-x',
    }
    const onKnown = await handleSessionControlRelay('server.chat.adopt', '__server__', { ...payload, conversationId: conv.id })
    expect(onKnown).toMatchObject({ ok: false, errorKind: 'unavailable' })
    expect(await readConversationFile(conv.id)).toBe(fileBefore)
    // Nor may it create a conversation (file or index row) it never had.
    const unknownId = 'conv-never-on-this-box-1'
    const onUnknown = await handleSessionControlRelay('server.chat.adopt', '__server__', { ...payload, conversationId: unknownId })
    expect(onUnknown).toMatchObject({ ok: false, errorKind: 'unavailable' })
    await expect(fs.stat(conversationFile('general', unknownId))).rejects.toThrow()
    const { listConversations } = await import('../../../src/core/conversations.js')
    expect((await listConversations('general')).some((c) => c.id === unknownId)).toBe(false)
  })

  it('the bridge coming back hands the turn to the primary, which deletes it here', async () => {
    const conv = await createConversation('general')
    const turnId = await answerOneTurn(conv.id, 'hand me over')
    relayOverride.fn = null

    const adopts: Array<Record<string, unknown>> = []
    const primary = connectFakePrimary((frame) => {
      if (frame.action === 'server.chat.adopt') {
        adopts.push(frame.params ?? {})
        return { ok: true, result: { turnId: frame.params?.turnId, adopted: true, duplicate: false } }
      }
      return { ok: false, error: `Unknown control action: ${frame.action}` }
    })
    try {
      await until(async () => (await listCloudTurns()).length === 0)
      expect(adopts).toHaveLength(1)
      expect(adopts[0]).toMatchObject({
        turnId, agentId: 'general', conversationId: conv.id,
        userText: 'hand me over', answerText: 'Cloud answer.',
      })
      expect(String(adopts[0].engine)).toMatch(/^cloud:/)
      // Nothing left to send: a later sweep does not re-adopt.
      await flushCloudChatOutbox()
      expect(adopts).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)

  it('an old primary (needs_upgrade) keeps the entry for a later primary', async () => {
    const conv = await createConversation('general')
    await answerOneTurn(conv.id, 'wait for an upgrade')
    relayOverride.fn = null
    const primary = connectFakePrimary((frame) => ({ ok: false, error: `Unknown control action: ${frame.action}` }))
    try {
      await until(() => primary.received.some((f) => f.action === 'server.chat.adopt'))
      await flushCloudChatOutbox()
      expect(await listCloudTurns({ conversationId: conv.id })).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 60_000)
})
