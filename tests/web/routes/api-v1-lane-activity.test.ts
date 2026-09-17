/**
 * /api/v1 chat SSE × LANE turn ACTIVITY frames — `tool`, `tool-result`, `thinking`.
 *
 * The bug this pins: `runApiV1LaneTurn` subscribed to `session:text-delta` ONLY, so
 * a Personal AI turn running on a CLI lane relayed prose and nothing else. The phone
 * has exactly one channel per conversation, and its activity line is driven by these
 * three frames — with none of them a five-minute turn of real work rendered as a
 * blinking "Thinking…" that never named a single tool.
 *
 * What's asserted here is the wire, frame by frame:
 *   - a tool call on the lane → `tool { name, toolUseId, detail?, inputPreview? }`
 *   - its result            → `tool-result { toolUseId, resultPreview? }` (a bounded,
 *     masked excerpt only; the full output stays off this channel)
 *   - reasoning             → `thinking { delta }`, COALESCED (N deltas ⇒ fewer frames)
 *     with the tail flushed before the terminal frame, never after it
 *   - a FOREIGN session id, a `replayed` event, and a `parentToolUseId` (subagent)
 *     event produce nothing
 *
 * Same harness as api-v1-lane-engine.test.ts: real Express server + router + SSE
 * channels, with the 'session-runner' bus subscriber replaced by a fake that answers
 * a lane turn from a script and NEVER spawns a `claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lane-activity'))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []

/** What the fake CLI puts on the bus for this turn, in order, before its result. */
type ScriptStep =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string; replayed?: boolean }
  | { kind: 'tool'; toolName: string; toolUseId: string; input?: Record<string, unknown>; parentToolUseId?: string; replayed?: boolean }
  | { kind: 'tool-result'; toolUseId: string; result?: string; parentToolUseId?: string; replayed?: boolean }
  /** Same event kinds, but addressed to a DIFFERENT session id. */
  | { kind: 'foreign-tool'; toolName: string; toolUseId: string }
  | { kind: 'foreign-thinking'; delta: string }

let script: ScriptStep[] = []
/** Steps emitted at a wall-clock offset, for testing the 120 ms flush window. */
let paced: Array<{ atMs: number; step: ScriptStep }> = []
/**
 * Steps the fake CLI emits AFTER its result/error line, each on its own macrotask.
 * Not an exotic case: a real CLI writes a trailing reasoning chunk after the result
 * line routinely, and by then the client has already finalized the turn.
 */
let trailing: ScriptStep[] = []
let answerMode: 'result' | 'error' = 'result'
/** Gap between the script and the answer, so paced steps can land mid-turn. */
let resultDelayMs = 0
let laneReply = 'the lane answered'
/**
 * Delay before the fake CLI starts talking, so an ordered script lands after
 * message-start AND after the relay subscribed to the bus. The relay subscribes
 * inside the turn, a tick or two after the lane spawn this timer hangs off, so a
 * near-zero delay races it: under machine load the tool frames were emitted into
 * a bus nobody was listening on yet and the turn ended with only its result.
 */
const ANSWER_DELAY_MS = 60

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

const inFlightDrains = new Set<Promise<void>>()

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

function emitStep(step: ScriptStep, sessionId: string): void {
  const targets = ['main-ai']
  const opts = { source: 'session-runner', urgency: 'urgent' as const }
  switch (step.kind) {
    case 'text':
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId, delta: step.delta }, targets, opts)
      return
    case 'thinking':
      bus.emit(EventNames.SESSION_THINKING_DELTA, {
        sessionId, delta: step.delta, msgId: 'msg_t', ...(step.replayed ? { replayed: true } : {}),
      }, targets, opts)
      return
    case 'tool':
      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId, toolName: step.toolName, toolUseId: step.toolUseId, input: step.input ?? {},
        ...(step.parentToolUseId ? { parentToolUseId: step.parentToolUseId } : {}),
        ...(step.replayed ? { replayed: true } : {}),
      }, targets, { source: 'session-runner' })
      return
    case 'tool-result':
      bus.emit(EventNames.SESSION_TOOL_RESULT, {
        sessionId, toolUseId: step.toolUseId, result: step.result ?? 'ok',
        ...(step.parentToolUseId ? { parentToolUseId: step.parentToolUseId } : {}),
        ...(step.replayed ? { replayed: true } : {}),
      }, targets, { source: 'session-runner' })
      return
    case 'foreign-tool':
      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: 'some-other-session', toolName: step.toolName, toolUseId: step.toolUseId, input: {},
      }, targets, { source: 'session-runner' })
      return
    case 'foreign-thinking':
      bus.emit(EventNames.SESSION_THINKING_DELTA, {
        sessionId: 'some-other-session', delta: step.delta,
      }, targets, opts)
      return
  }
}

/** Fake session-runner: records the start, runs `script`, then answers. */
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
    setTimeout(() => {
      for (const step of script) emitStep(step, sessionId)
      for (const { atMs, step } of paced) setTimeout(() => emitStep(step, sessionId), atMs)
      setTimeout(() => {
        if (answerMode === 'error') {
          bus.emit(EventNames.SESSION_ERROR, { sessionId, error: 'the lane blew up' },
            ['main-ai', 'session-runner'], { source: 'session-runner' })
        } else {
          bus.emit(EventNames.SESSION_RESULT, { sessionId, result: laneReply, isError: false },
            ['main-ai', 'session-runner'], { source: 'session-runner' })
        }
        // Consume: a two-turn test must not replay the first turn's tail.
        const tail = trailing
        trailing = []
        for (const [i, step] of tail.entries()) setTimeout(() => emitStep(step, sessionId), i)
      }, resultDelayMs)
    }, ANSWER_DELAY_MS)
  })
}

// ── Minimal SSE client over fetch (same shape as api-v1-lane-engine.test.ts's) ──

interface SseEvt { id?: number; event: string; data: Record<string, unknown> }
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
          let id: number | undefined
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue // comment / ping
            if (line.startsWith('id: ')) id = Number(line.slice(4))
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { id, event, data: data ? JSON.parse(data) : {} }
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
    waitFor: (pred, timeoutMs = 10_000) => {
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

async function boot(): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    agent: { provider: 'claude-code' }, // the LANE engine — the branch under test
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  installFakeRunner() // displaces the real runner by name
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function postMessage(convId: string, text: string): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
}

/** Run one lane turn with `script` on the bus and return every SSE frame it produced. */
async function runTurn(convId: string, sse: SseConn, text = 'do the thing'): Promise<SseEvt[]> {
  const before = sse.events.filter((e) => e.event === 'message-end').length
  expect((await postMessage(convId, text)).status).toBe(202)
  await sse.waitFor((e) => e.event === 'message-end'
    && sse.events.filter((x) => x.event === 'message-end').length > before)
  return sse.events
}

beforeEach(() => {
  started = []
  script = []
  paced = []
  trailing = []
  answerMode = 'result'
  resultDelayMs = 0
  laneReply = 'the lane answered'
})

afterEach(async () => {
  await Promise.all([...inFlightDrains]).catch(() => {})
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('lane SSE: tool + tool-result frames', () => {
  it('relays the tool call with its id and detail, then its result id', async () => {
    script = [
      { kind: 'tool', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls docs/', description: 'List docs' } },
      { kind: 'tool-result', toolUseId: 'toolu_1', result: 'a.md\nb.md' },
      { kind: 'text', delta: 'here you go' },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)

      const tools = events.filter((e) => e.event === 'tool')
      expect(tools).toHaveLength(1)
      // `detail` stays the collapsed one-liner (Bash prefers `description`), while
      // `inputPreview` carries the command the drawer needs.
      expect(tools[0].data).toEqual({
        name: 'Bash',
        toolUseId: 'toolu_1',
        detail: 'List docs',
        inputPreview: 'command: ls docs/\ndescription: List docs',
      })
      expect(tools[0].data.inputPreview as string).toContain('ls docs/')

      const results = events.filter((e) => e.event === 'tool-result')
      expect(results).toHaveLength(1)
      // A short result rides verbatim: this is what a finished live row shows
      // before the transcript lands (the drawer used to read "No output").
      expect(results[0].data).toEqual({ toolUseId: 'toolu_1', resultPreview: 'a.md\nb.md' })

      // Causal order the client reads as a sequence.
      const order = events.map((e) => e.event)
      expect(order.indexOf('message-start')).toBeLessThan(order.indexOf('tool'))
      expect(order.indexOf('tool')).toBeLessThan(order.indexOf('tool-result'))
      expect(order.indexOf('tool-result')).toBeLessThan(order.indexOf('message-end'))
    } finally {
      sse.close()
    }
  }, 20_000)

  it('a tool with no usable input summary still names itself (no detail key)', async () => {
    script = [{ kind: 'tool', toolName: 'Mystery', toolUseId: 'toolu_x', input: { count: 3 } }]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const tool = events.find((e) => e.event === 'tool')!
      // No `detail` (no human-readable key), but the render still has something.
      expect(tool.data).toEqual({ name: 'Mystery', toolUseId: 'toolu_x', inputPreview: 'count: 3' })
    } finally {
      sse.close()
    }
  }, 20_000)

  it('bounds a long result to the documented cap and marks the cut', async () => {
    // Two caps stack: the emitter already clips the bus event to 2000 characters,
    // and the frame clips again to the row's 700 + the ellipsis. So a `cat` of a
    // big file cannot ride a channel with a 512-event replay ring.
    script = [
      { kind: 'tool', toolName: 'Bash', toolUseId: 'toolu_big', input: { command: 'cat big.log' } },
      { kind: 'tool-result', toolUseId: 'toolu_big', result: 'x'.repeat(5_000) },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const result = events.find((e) => e.event === 'tool-result')!
      const preview = result.data.resultPreview as string
      expect(typeof preview).toBe('string')
      expect(preview.length).toBeLessThanOrEqual(701)
      expect(preview.endsWith('…')).toBe(true)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('masks a credential in the relayed result', async () => {
    // A tool's OUTPUT leaks as readily as its input (`cat .env`, a config echo), and
    // this frame crosses a LAN to a phone. Same masker the history row uses.
    const accessKeyId = 'AKIA' + 'ZZ4EXAMPLE7DEMO99' // split so the repo scanner never sees a key-shaped literal
    const secretLine = 'password=hunter2abcdef'
    script = [
      { kind: 'tool', toolName: 'Bash', toolUseId: 'toolu_secret', input: { command: 'cat config.ini' } },
      { kind: 'tool-result', toolUseId: 'toolu_secret', result: `key=${accessKeyId}\n${secretLine}\n` },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const preview = events.find((e) => e.event === 'tool-result')!.data.resultPreview as string
      expect(preview).toContain('[REDACTED]')
      expect(preview).not.toContain(accessKeyId)
      expect(preview).not.toContain('hunter2abcdef')
      // Belt and braces: nothing on the whole wire carries either secret.
      const blob = JSON.stringify(events)
      expect(blob).not.toContain(accessKeyId)
      expect(blob).not.toContain('hunter2abcdef')
    } finally {
      sse.close()
    }
  }, 20_000)

  it('omits both preview keys when there is nothing to show', async () => {
    // A present-but-empty key reads as "the tool produced an empty string", which is
    // a different claim from "this frame has no excerpt", so neither key is emitted.
    script = [
      { kind: 'tool', toolName: 'BareTool', toolUseId: 'toolu_bare' },
      { kind: 'tool-result', toolUseId: 'toolu_bare', result: '   \n\t ' },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const tool = events.find((e) => e.event === 'tool')!
      expect(tool.data).toEqual({ name: 'BareTool', toolUseId: 'toolu_bare' })
      expect('inputPreview' in tool.data).toBe(false)
      const result = events.find((e) => e.event === 'tool-result')!
      expect(result.data).toEqual({ toolUseId: 'toolu_bare' })
      expect('resultPreview' in result.data).toBe(false)
    } finally {
      sse.close()
    }
  }, 20_000)
})

describe('lane SSE: thinking frames', () => {
  it('coalesces a burst of deltas into fewer frames and loses nothing', async () => {
    // 40 token-rate deltas inside one flush window ⇒ far fewer frames, same text.
    const parts = Array.from({ length: 40 }, (_, i) => `t${i} `)
    script = parts.map((delta) => ({ kind: 'thinking' as const, delta }))
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const thinking = events.filter((e) => e.event === 'thinking')

      expect(thinking.length).toBeGreaterThan(0)
      // The whole point: 40 urgent bus events must not become 40 fan-out frames.
      expect(thinking.length).toBeLessThan(parts.length / 2)
      // ...and the coalescing is lossless — the tail is flushed at turn end.
      expect(thinking.map((e) => e.data.delta as string).join('')).toBe(parts.join(''))

      // Nothing after the terminal frame (iOS finalizes there; a later frame
      // would leave the activity line lit and would replay out of order).
      const order = events.map((e) => e.event)
      const endAt = order.indexOf('message-end')
      expect(order.slice(endAt + 1).filter((e) => e === 'thinking')).toEqual([])
    } finally {
      sse.close()
    }
  }, 20_000)

  it('flushes the reasoning tail BEFORE the tool that ended it', async () => {
    script = [
      { kind: 'thinking', delta: 'I should look at the docs' },
      { kind: 'tool', toolName: 'Read', toolUseId: 'toolu_2', input: { file_path: '/tmp/demo/a.md' } },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const order = events.map((e) => e.event)
      expect(order.indexOf('thinking')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('thinking')).toBeLessThan(order.indexOf('tool'))
      const thinking = events.filter((e) => e.event === 'thinking')
      expect(thinking.map((e) => e.data.delta as string).join('')).toBe('I should look at the docs')
    } finally {
      sse.close()
    }
  }, 20_000)
})

describe('lane SSE: what must NOT be relayed', () => {
  it('drops foreign sessions, replayed events, and subagent (parentToolUseId) activity', async () => {
    script = [
      // Another session's activity on the same process bus.
      { kind: 'foreign-tool', toolName: 'ForeignTool', toolUseId: 'toolu_foreign' },
      { kind: 'foreign-thinking', delta: 'not my reasoning' },
      // JSONL history being re-read, not this turn happening. The tool_use line is
      // the replayed one; its result arrives LIVE and unflagged, which is the shape
      // production actually emits (the earlier version of this test marked the
      // result `replayed` too, so it proved nothing about the pairing rule — it was
      // caught by the same gate as the line above it).
      { kind: 'thinking', delta: 'replayed reasoning', replayed: true },
      { kind: 'tool', toolName: 'ReplayedTool', toolUseId: 'toolu_replay', replayed: true },
      { kind: 'tool-result', toolUseId: 'toolu_replay' },
      // A SUBAGENT's nested tool call: relaying it would overwrite the Task row.
      { kind: 'tool', toolName: 'SubagentGrep', toolUseId: 'toolu_sub', parentToolUseId: 'toolu_task' },
      { kind: 'tool-result', toolUseId: 'toolu_sub', parentToolUseId: 'toolu_task' },
      // One real frame, so the assertions below prove filtering and not silence.
      { kind: 'tool', toolName: 'Glob', toolUseId: 'toolu_ok', input: { pattern: '**/*.md' } },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)

      const tools = events.filter((e) => e.event === 'tool')
      expect(tools.map((e) => e.data.name)).toEqual(['Glob'])
      const results = events.filter((e) => e.event === 'tool-result')
      expect(results).toEqual([])
      const thinking = events.filter((e) => e.event === 'thinking')
      expect(thinking).toEqual([])
      // Belt and braces: none of the dropped payloads reached the wire at all.
      const all = JSON.stringify(events)
      expect(all).not.toContain('ForeignTool')
      expect(all).not.toContain('not my reasoning')
      expect(all).not.toContain('replayed reasoning')
      expect(all).not.toContain('ReplayedTool')
      expect(all).not.toContain('SubagentGrep')
      expect(all).not.toContain('toolu_sub')
      expect(all).not.toContain('toolu_replay')
    } finally {
      sse.close()
    }
  }, 20_000)

  it('never closes an activity line it never opened (orphan tool-result)', async () => {
    // A `tool-result` says "clear the line for THIS id". One whose `tool` frame the
    // client never received leaves iOS holding a frame it cannot place — so the
    // result is only relayed for an id this turn actually announced.
    script = [
      { kind: 'tool-result', toolUseId: 'toolu_ghost', result: 'output of a tool nobody saw start' },
      { kind: 'tool', toolName: 'Glob', toolUseId: 'toolu_ok', input: { pattern: '**/*.md' } },
      { kind: 'tool-result', toolUseId: 'toolu_ok' },
      // A second result for the SAME id is a no-op too (the id is consumed).
      { kind: 'tool-result', toolUseId: 'toolu_ok' },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      const results = events.filter((e) => e.event === 'tool-result')
      expect(results.map((e) => e.data)).toEqual([{ toolUseId: 'toolu_ok', resultPreview: 'ok' }])
      expect(JSON.stringify(events)).not.toContain('toolu_ghost')
    } finally {
      sse.close()
    }
  }, 20_000)

  it("one turn's activity never leaks into the next turn's frames", async () => {
    script = [{ kind: 'thinking', delta: 'first turn reasoning' }]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      await runTurn(convId, sse, 'one')
      const firstCount = sse.events.filter((e) => e.event === 'thinking').length
      expect(firstCount).toBeGreaterThan(0)

      script = [{ kind: 'thinking', delta: 'second turn reasoning' }]
      const events = await runTurn(convId, sse, 'two')
      const deltas = events.filter((e) => e.event === 'thinking').map((e) => e.data.delta as string)
      // Exactly one frame per turn's reasoning, in turn order.
      expect(deltas.join('|')).toBe('first turn reasoning|second turn reasoning')

      // ...and the teardown itself, pinned SEPARATELY. Two independent mechanisms
      // stop a leak — `turnSettled` and the unsubscribe — so an output-only
      // assertion stays green when either one is removed (it did: deleting the
      // unsubscribe changed no frame). The bus is the only place the second one is
      // observable, so assert on it directly.
      const turnIds = sse.events.filter((e) => e.event === 'message-start')
        .map((e) => e.data.turnId as string)
      expect(turnIds).toHaveLength(2)
      for (const turnId of turnIds) {
        expect(bus.has(`api-v1-lane-relay-${turnId}`)).toBe(false)
      }
    } finally {
      sse.close()
    }
  }, 25_000)
})

describe('lane SSE: nothing after the terminal frame', () => {
  it('a trailing thinking delta and tool AFTER the CLI result line never reach the wire', async () => {
    script = [{ kind: 'thinking', delta: 'early reasoning' }]
    trailing = [
      { kind: 'thinking', delta: 'TRAILING-REASONING' },
      { kind: 'tool', toolName: 'TrailingTool', toolUseId: 'toolu_late' },
      { kind: 'thinking', delta: 'TRAILING-TWO' },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const events = await runTurn(convId, sse)
      // Long enough for every trailing macrotask AND a full 120 ms flush window.
      await new Promise((r) => setTimeout(r, 600))
      const blob = JSON.stringify(events)
      expect(blob).not.toContain('TRAILING-REASONING')
      expect(blob).not.toContain('TrailingTool')
      expect(blob).not.toContain('TRAILING-TWO')
      const order = events.map((e) => e.event)
      expect(order.slice(order.lastIndexOf('message-end') + 1)).toEqual([])
    } finally {
      sse.close()
    }
  }, 25_000)

  it('the same holds when the turn ends in an error', async () => {
    // The error path is a second `turnSettled = true`, in the catch/degrade branch.
    answerMode = 'error'
    script = [{ kind: 'thinking', delta: 'early reasoning' }]
    trailing = [
      { kind: 'thinking', delta: 'TRAILING-AFTER-ERROR' },
      { kind: 'tool', toolName: 'PostErrorTool', toolUseId: 'toolu_posterr' },
    ]
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'go')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'error' || e.event === 'message-end', 30_000)
      await new Promise((r) => setTimeout(r, 600))
      const blob = JSON.stringify(sse.events)
      expect(blob).not.toContain('TRAILING-AFTER-ERROR')
      expect(blob).not.toContain('PostErrorTool')
      const order = sse.events.map((e) => e.event)
      const terminal = Math.max(order.lastIndexOf('error'), order.lastIndexOf('message-end'))
      expect(order.slice(terminal + 1)).toEqual([])
    } finally {
      sse.close()
    }
  }, 40_000)
})

describe('lane SSE: the coalescer flushes mid-turn', () => {
  it('paints reasoning while the turn runs, not only at the terminal frame', async () => {
    // Three bursts ~250 ms apart with the answer held back ~900 ms. A version that
    // only flushed at turn end would collapse all three into ONE frame arriving at
    // the very end — which is what the burst-of-40 test above cannot tell apart,
    // because it emits everything inside a single tick.
    paced = ['aaa ', 'bbb ', 'ccc '].map((delta, i) => ({
      atMs: i * 250, step: { kind: 'thinking' as const, delta },
    }))
    resultDelayMs = 900
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'go')).status).toBe(202)
      const first = await sse.waitFor((e) => e.event === 'thinking', 10_000)
      expect(first.data.delta).toBe('aaa ')
      const beforeEnd = sse.events.filter((e) => e.event === 'thinking').length
      await sse.waitFor((e) => e.event === 'message-end', 25_000)
      await new Promise((r) => setTimeout(r, 400))
      const frames = sse.events.filter((e) => e.event === 'thinking')
      expect(frames.length).toBeGreaterThanOrEqual(3)
      expect(beforeEnd).toBeGreaterThanOrEqual(1)
      expect(frames.map((e) => e.data.delta as string).join('')).toBe('aaa bbb ccc ')
    } finally {
      sse.close()
    }
  }, 45_000)

  it('a client that disconnects with the timer armed does not crash the server', async () => {
    const crashes: unknown[] = []
    const onCrash = (e: unknown): void => { crashes.push(e) }
    process.on('unhandledRejection', onCrash)
    process.on('uncaughtException', onCrash)
    paced = [{ atMs: 0, step: { kind: 'thinking', delta: 'reasoning while the phone walks away' } }]
    resultDelayMs = 400
    await boot()
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'go')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-start')
      // Kill the reader while the turn — and the armed flush timer — is still live.
      sse.close()
      await new Promise((r) => setTimeout(r, 1500))
      const still = await fetch(apiUrl('/api/v1/status'))
      expect(still.status).toBe(200)
      expect(crashes).toEqual([])
    } finally {
      process.off('unhandledRejection', onCrash)
      process.off('uncaughtException', onCrash)
    }
  }, 30_000)
})
