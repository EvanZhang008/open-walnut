/**
 * The chat send's message id on a cloud companion that is an EXECUTION HOST, so it
 * answers a turn itself when the primary provably did not get it
 * (cloud-chat-fallback.ts). Two rules of chat-send-once.ts, pinned through the real
 * route and the real fallback lane:
 *
 *  - the companion's own fallback turn marks the id started before it runs, so a
 *    repeat after that turn ended is answered once (send-once gate r1, LOW-4: its
 *    mutant S10, which drops that mark, survived every shipped test);
 *  - a retry of a relay that MAY have reached the primary is never answered here,
 *    even when this retry's own relay provably went nowhere: the earlier one may be
 *    running over there (MEDIUM-1). It is told the primary is unreachable, the id
 *    stays, and the next retry is relayed again under the same turnId and messageId.
 *
 * Harness copied from api-v1-chat-cloud-fallback.test.ts: real startServer in
 * CLOUD_MODE, the per-agent turn queue, the companion lane, the non-git outbox; the
 * 'session-runner' subscriber is a fake that answers like a `claude` CLI and never
 * spawns one; the relay outcome is forced per test. Imports nothing the send-once
 * change adds, so a tree without it fails here by behavior, not at import.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-send-once-fallback', { CLOUD_MODE: true }))

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
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'
import { resetCloudExecCache } from '../../../src/core/cloud-owned-session.js'
import { _setCloudChatCliProbeForTesting } from '../../../src/web/routes/cloud-chat-fallback.js'
import { CLOUD_CHAT_OUTBOX_DIR, listCloudTurns } from '../../../src/core/cloud-chat-outbox.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

const EXEC_ROOT = `${WALNUT_HOME}-exec-root`

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

async function postMessage(
  conversationId: string, text: string, messageId?: string,
): Promise<{ status: number; turnId: string; duplicate?: boolean; code?: string }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(messageId ? { messageId } : {}) }),
  })
  const body = await res.json().catch(() => ({})) as { turnId?: string; duplicate?: boolean; error?: { code?: string } }
  return { status: res.status, turnId: body.turnId ?? '', duplicate: body.duplicate, code: body.error?.code }
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
  deviceToken = (await createDevice('send-once-fallback-test-phone')).token
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


const AMBIGUOUS = {
  ok: false,
  failure: { kind: 'bridge_offline', message: 'request timed out after the send', notSent: false },
}

/** The params of every `server.chat.turn` the route tried to relay. */
let relayed: Array<Record<string, unknown>> = []

function forceTurnRelay(answer: (params: Record<string, unknown>) => unknown): void {
  relayOverride.fn = (action, params) => {
    if (action === 'server.chat.messages') return NOT_SENT
    if (action !== 'server.chat.turn') return undefined
    relayed.push(params)
    return answer(params)
  }
}

describe('the message id on an execution-host companion', () => {
  beforeEach(() => { relayed = [] })

  it('S10: the companion\'s own fallback turn keeps its id, so a repeat after it ended runs nothing', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      forceTurnRelay(() => NOT_SENT)
      const first = await postMessage(conv.id, 'answer it here', 'qm-cloud-fallback-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end')
      expect(starts).toHaveLength(1)
      // The turn is over and its POST's promise settled: a dropped id would be gone now.
      await until(async () => (await listCloudTurns()).some((t) => t.state === 'answered'))
      await new Promise((r) => setTimeout(r, 200))

      const repeat = await postMessage(conv.id, 'answer it here', 'qm-cloud-fallback-1')
      expect(repeat).toEqual({ status: 202, turnId: first.turnId, duplicate: true, code: undefined })
      await new Promise((r) => setTimeout(r, 300))
      expect(starts).toHaveLength(1)
      expect(sends).toHaveLength(0)
      expect(sse.events.filter((e) => e.event === 'message-start')).toHaveLength(1)
      expect(relayed).toHaveLength(1)
      expect(relayed[0].messageId).toBe('qm-cloud-fallback-1')
    } finally {
      sse.close()
    }
  }, 60_000)

  it('a retry of an unsure relay is never answered here, even when its own relay provably went nowhere', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(conv.id)
    try {
      forceTurnRelay(() => AMBIGUOUS)
      const first = await postMessage(conv.id, 'maybe over there', 'qm-cloud-unsure-host-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error')
      expect(starts).toHaveLength(0)

      forceTurnRelay(() => NOT_SENT)
      const retry = await postMessage(conv.id, 'maybe over there', 'qm-cloud-unsure-host-1')
      expect(retry.status).toBe(503)
      expect(retry.code).toBe('primary_unreachable')
      await new Promise((r) => setTimeout(r, 500))
      expect(starts, 'the companion answered a message the primary may be running').toHaveLength(0)
      expect(await listCloudTurns()).toHaveLength(0)

      // The primary is back and never got it: it runs now, under the same ids.
      forceTurnRelay((params) => ({ ok: true, result: { accepted: true, turnId: params.turnId, engine: 'claude-code' } }))
      const back = await postMessage(conv.id, 'maybe over there', 'qm-cloud-unsure-host-1')
      expect(back).toEqual({ status: 202, turnId: first.turnId, duplicate: undefined, code: undefined })
      expect(relayed.map((p) => [p.turnId, p.messageId])).toEqual([
        [first.turnId, 'qm-cloud-unsure-host-1'],
        [first.turnId, 'qm-cloud-unsure-host-1'],
        [first.turnId, 'qm-cloud-unsure-host-1'],
      ])
      expect(starts).toHaveLength(0)
    } finally {
      sse.close()
    }
  }, 60_000)
})
