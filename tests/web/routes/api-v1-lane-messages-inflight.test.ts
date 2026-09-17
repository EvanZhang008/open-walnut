/**
 * GET /api/v1/conversations/:id/messages × the additive `inFlight` marker.
 *
 * The defect this pins (found by the gate after the tool-preview fix): the phone's
 * turn watchdog refetches this list when the SSE channel has been quiet for 30s (an
 * ordinary `sleep 45` does it) and concluded "the turn is over" as soon as it saw an
 * assistant row after the user's message. A lane transcript makes that verdict
 * false, because it carries the model's INTERMEDIATE text ("I will run the first
 * command..."): the phone cleared its live state, unlocked the composer, and
 * re-rendered the still-running tool from this list, where a tool that has not
 * returned yet has no `resultPreview`. So a finished-looking row said "No output".
 *
 * What is asserted, on the real route:
 *  - mid-turn, every row AFTER the last user row carries `inFlight: true`, and the
 *    user row plus every earlier turn does not;
 *  - the in-flight tool row is exactly the shape that misled the phone (no
 *    `resultPreview` yet), so the marker is the only honest signal;
 *  - once the turn's terminal SSE frame has been sent, an immediate refetch carries
 *    no `inFlight` key at all;
 *  - a turn that has produced nothing yet marks nothing (no boundary to mark from).
 *
 * Real: startServer, the api-v1 router + SSE channels, the conversation registry,
 * the chat-history store, session records in SQLite, and the whole lane transcript
 * read (buildSessionTranscript → the JSONL on disk). Mocked: constants (temp dirs),
 * the '__local__' daemon file reader, and the session runner, which is replaced by a
 * fake that answers a lane turn ONLY when the test releases it and never spawns a
 * `claude`.
 *
 * Siblings: api-v1-lane-messages.test.ts (the read itself),
 * api-v1-lane-messages-inflight-cloud.test.ts (the replica half).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-inflight'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import {
  WALNUT_HOME, CLAUDE_HOME, CONFIG_FILE, conversationFile,
} from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { listSessionsByLane, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import type { ChatEntry, ChatHistoryStore } from '../../../src/core/types.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

interface V1Message {
  id: string
  role: string
  text: string
  kind?: string
  detail?: string
  resultPreview?: string
  inFlight?: true
}

// ── The fake session runner: it answers a lane turn only when released ──

let started: SessionStartEvent[] = []
let releaseTurn: (() => void) | null = null
let held: Promise<void> = Promise.resolve()
const inFlightDrains = new Set<Promise<void>>()

/** Arm the gate the fake runner waits on before it ends the turn. */
function holdNextTurn(): void {
  held = new Promise<void>((resolve) => { releaseTurn = resolve })
}

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      started.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      sid = (event.data as SessionSendEvent).sessionId
    }
    if (!sid) return
    const sessionId = sid
    drainQueue(sessionId)
    void (async () => {
      await held
      bus.emit(EventNames.SESSION_RESULT, { sessionId, result: 'the lane answered', isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    })()
  })
}

// ── Minimal SSE client over fetch (same shape as api-v1-lane-activity.test.ts's) ──

interface SseEvt { event: string; data: Record<string, unknown> }
interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  if (res.status !== 200 || !res.body) {
    controller.abort()
    throw new Error(`SSE connect failed: ${res.status}`)
  }
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
            if (line.startsWith(':')) continue // comment / ping
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { event, data: data ? JSON.parse(data) : {} }
          events.push(evt)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(evt)) {
              waiters[i].resolve(evt)
              waiters.splice(i, 1)
            }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    events,
    waitFor: (pred, timeoutMs = 15_000) => {
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

// ── Fixtures ──

let seq = 0
const T = (): string => new Date(Date.UTC(2026, 0, 1, 0, ++seq)).toISOString()
const userLine = (text: string): unknown => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: T(),
  message: { role: 'user', content: text },
})
const asstLine = (text: string): unknown => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: T(),
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})
/** A tool call with NO result line after it: the in-flight tool the phone rendered. */
const toolLine = (toolUseId: string): unknown => ({
  type: 'assistant', uuid: `t-${++seq}`, timestamp: T(),
  message: {
    role: 'assistant', id: `msg-${seq}`,
    content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 45' } }],
  },
})

async function writeJsonl(cwd: string, sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function writeChatHistory(convId: string, entries: ChatEntry[]): Promise<void> {
  const store: ChatHistoryStore = {
    version: 2, lastUpdated: new Date().toISOString(),
    compactionCount: 0, compactionSummary: null, entries,
  }
  const file = conversationFile('general', convId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store))
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function getMessages(convId: string): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages?limit=50`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

async function postMessage(convId: string, text: string): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
}

/** Wait until the turn has minted its lane, i.e. it is really under way. */
async function waitForLane(convId: string): Promise<{ sessionId: string; cwd: string }> {
  for (let i = 0; i < 100; i++) {
    const records = await listSessionsByLane(`chat:general:${convId}`)
    if (records.length > 0) return { sessionId: records[0].claudeSessionId, cwd: records[0].cwd }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the lane session was never minted')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    agent: { provider: 'claude-code' }, // the LANE engine: a turn runs on a CLI lane
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  installFakeRunner() // displaces the real runner by name
}, 60_000)

afterAll(async () => {
  releaseTurn?.()
  await Promise.all([...inFlightDrains]).catch(() => {})
  await stopServer()
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('inFlight marks the running turn, and only it', () => {
  it('marks the rows after the last user row mid-turn, then nothing once it ends', async () => {
    started = []
    holdNextTurn()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'run it')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-start')
      const lane = await waitForLane(convId)
      // Two fixture nudges, both mirroring what production writes: a real spawn
      // records a pid (a pid-less record inside the spawn grace window reads as
      // "nothing to read yet"), and an old `startedAt` puts the whole transcript
      // after the prefix cutoff, so the eager chat-history copy of this turn's user
      // message is not also rendered ahead of the lane (see assembleLaneConversation).
      await updateSessionRecord(lane.sessionId, { pid: 4242, startedAt: '2025-01-01T00:00:00.000Z' })
      // The transcript as it stands MID-TURN: one finished turn, then this turn's
      // user line, its intermediate text, and the tool that has not returned.
      await writeJsonl(lane.cwd, lane.sessionId, [
        userLine('earlier question'),
        asstLine('earlier answer'),
        userLine('run it'),
        asstLine('I will run the first command...'),
        toolLine('tu-inflight'),
      ])

      const mid = await getMessages(convId)
      expect(mid.map((m) => `${m.role}:${m.kind ?? 'text'}:${m.text}`)).toEqual([
        'user:text:earlier question',
        'assistant:text:earlier answer',
        'user:text:run it',
        'assistant:text:I will run the first command...',
        'assistant:tool:Bash',
      ])
      // The running turn's own output, and nothing else.
      expect(mid.map((m) => m.inFlight)).toEqual([undefined, undefined, undefined, true, true])
      // The exact shape that misled the phone: the tool has started and has no
      // output yet, so `inFlight` is the only thing that says "wait".
      const tool = mid[4]
      expect(tool.detail).toContain('sleep 45')
      expect(tool.resultPreview).toBeUndefined()
      // Absent, not false: a client decoding a strict shape must see no key.
      expect(Object.keys(mid[2])).not.toContain('inFlight')

      // Let the turn finish. By the time the client can react to the terminal
      // frame, the rows it refetches must already be clean.
      releaseTurn?.()
      await sse.waitFor((e) => e.event === 'message-end', 30_000)
      const after = await getMessages(convId)
      expect(after.every((m) => !('inFlight' in m))).toBe(true)
    } finally {
      releaseTurn?.()
      sse.close()
    }
  }, 60_000)

  it('marks nothing while the turn has produced no rows of its own', async () => {
    started = []
    holdNextTurn()
    const convId = await createConv()
    // One finished turn on disk; the new turn's eager user row lands after it.
    await writeChatHistory(convId, [
      { tag: 'ai', role: 'user', content: 'first question', displayText: 'first question', timestamp: T() },
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: T() },
    ] as ChatEntry[])
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'and now this')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-start')
      await waitForLane(convId)

      const mid = await getMessages(convId)
      // The user row is the last row, so there is no boundary to mark from: the
      // turn is in flight and has produced nothing yet.
      expect(mid.map((m) => m.text)).toEqual(['first question', 'first answer', 'and now this'])
      expect(mid.every((m) => !('inFlight' in m))).toBe(true)
    } finally {
      releaseTurn?.()
      await sse.waitFor((e) => e.event === 'message-end', 30_000).catch(() => {})
      sse.close()
    }
  }, 60_000)
})
