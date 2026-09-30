/**
 * The phone's REST turn when its lane turn has no answer (yet).
 *
 * 2026-09-26: a 16.7-minute lane turn hit the old 10-minute wall clock, the
 * route persisted "[Error: The main AI did not answer this turn]" while the CLI
 * was still working, and the real answer (6.7 minutes later) was attached to the
 * next turn. lane-turn.ts now reports WHY a turn has no answer; this file pins
 * what the route does with each verdict, on the real server:
 *
 *   - stalled with the CLI still running: the SSE `error` notice goes out (the
 *     phone's composer unlocks, `laneStillRunning` says the turn is not over) but
 *     NO error row is written; when the late answer lands it is persisted under
 *     THIS turn's id and announced as `message-late`, then as the ordinary
 *     `message-end` an app without `message-late` support acts on;
 *   - the next turn, sent after the notice, waits for the stalled one and says so
 *     (`queued`); the late `message-end` does not release it, and the server
 *     re-announces it (`message-start`) for clients that read that frame as the
 *     end of whatever turn they are streaming;
 *   - on the PRIMARY of a cloud-relayed turn, the late frames still go down the
 *     bridge after the turn function returned at the stall (armLateMirror), and
 *     the late answer of a turn that was not relayed never goes down under the
 *     id of a relayed turn running after it;
 *   - a late watch that gives up writes the error row then, without a second
 *     `error` frame (that frame could land on the phone's next turn);
 *   - a dead CLI is a plain failure: SSE `error` plus the error row, as before;
 *     so is a turn refused because its lane is still busy with an earlier turn
 *     that did not end even after an interrupt (nothing was sent).
 *
 * Real: startServer, the api-v1 router, SSE channels, the conversation store.
 * Mocked: constants (temp dirs), runLaneTurn itself, whose liveness and
 * correlation rules are pinned in tests/core/lane-turn-liveness.test.ts, and the
 * bridge hop of the relay mirror (forwardMobileEventToBridge), whose far side is
 * covered end to end in tests/e2e/chat-late-answer-relay-e2e.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import type { LaneTurnResult } from '../../../src/core/sessions/lane-turn.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lane-stall'))

const runLaneTurn = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/sessions/lane-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/lane-turn.js')>()),
  runLaneTurn,
}))

const forwardMobileEventToBridge = vi.hoisted(() => vi.fn(async (_kind: string, _data: unknown) => true))
vi.mock('../../../src/web/routes/events-v1.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web/routes/events-v1.js')>()),
  forwardMobileEventToBridge,
}))

import { WALNUT_HOME, CONFIG_FILE, conversationFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus } from '../../../src/core/event-bus.js'
import type { ChatHistoryStore } from '../../../src/core/types.js'
import { LANE_STALL_NOTICE } from '../../../src/web/routes/lane-turn-late.js'
import {
  handlePrimaryChatTurnRelay, activeRelayedTurnCount, mirrorRelayedChatFrame, CHAT_TURN_FRAME_KIND,
} from '../../../src/web/routes/chat-turn-relay.js'

let server: HttpServer
let port: number
const LANE = 'lane-stall-0000-1111'

const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface SseEvt { event: string; data: Record<string, unknown> }

async function connectSse(url: string): Promise<{ events: SseEvt[]; waitFor: (p: (e: SseEvt) => boolean, ms?: number) => Promise<SseEvt>; close: () => void }> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`)
  const events: SseEvt[] = []
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
          if (event) events.push({ event, data: data ? JSON.parse(data) : {} })
        }
      }
    } catch { /* aborted */ }
  })()
  const waitFor = async (pred: (e: SseEvt) => boolean, ms = 15_000): Promise<SseEvt> => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = events.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error('SSE waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { events, waitFor, close: () => controller.abort() }
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function postRaw(convId: string, text: string): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
}

async function post(convId: string, text: string): Promise<string> {
  const res = await postRaw(convId, text)
  expect(res.status).toBe(202)
  return (await res.json() as { turnId: string }).turnId
}

async function until(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A stalled turn: the notice now, the answer (or null) whenever `late` settles. */
function stalledTurn(late: Promise<string | null>) {
  return async (_a: string, _c: string, _m: string, opts: { onSessionId?: (s: string) => void }): Promise<LaneTurnResult> => {
    opts.onSessionId?.(LANE)
    return { sessionId: LANE, resultText: null, failure: 'stalled', laneStillRunning: true, lateResult: late }
  }
}

async function storedRows(convId: string): Promise<Array<{ role: string; text: string; turnId?: string; source?: string }>> {
  try {
    const store = JSON.parse(await fs.readFile(conversationFile('general', convId), 'utf-8')) as ChatHistoryStore
    return (store.entries ?? []).map((e) => {
      const content = e.content as unknown
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? '').join('') : ''
      return { role: e.role, text, turnId: e.turnId, source: e.source }
    })
  } catch { return [] }
}

async function waitRows(convId: string, pred: (rows: Awaited<ReturnType<typeof storedRows>>) => boolean): Promise<Awaited<ReturnType<typeof storedRows>>> {
  for (let i = 0; i < 300; i++) {
    const rows = await storedRows(convId)
    if (pred(rows)) return rows
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('rows never matched: ' + JSON.stringify(await storedRows(convId)))
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
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
}, 60_000)

afterAll(async () => {
  await stopServer()
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a stalled lane turn whose CLI is still running', () => {
  it('shows the notice, writes no error row, and files the late answer under its own turn', async () => {
    const late = deferred<string | null>()
    runLaneTurn.mockImplementationOnce(stalledTurn(late.promise))
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const turnId = await post(convId, 'a long question')
      const notice = await sse.waitFor((e) => e.event === 'error')
      expect(notice.data).toEqual({ message: LANE_STALL_NOTICE, turnId, laneStillRunning: true })
      // Give the route every chance to (wrongly) persist something.
      await new Promise((r) => setTimeout(r, 300))
      const during = await storedRows(convId)
      expect(during.filter((r) => r.role === 'assistant')).toEqual([])

      late.resolve('the late but real answer')
      const rows = await waitRows(convId, (rs) => rs.some((r) => r.role === 'assistant'))
      const answer = rows.filter((r) => r.role === 'assistant')
      expect(answer).toHaveLength(1)
      expect(answer[0]).toMatchObject({ text: 'the late but real answer', turnId })
      expect(answer[0].source).not.toBe('agent-error')
      const frame = await sse.waitFor((e) => e.event === 'message-late')
      expect(frame.data).toEqual({ turnId, fullText: 'the late but real answer' })
      // The frame the shipped phone app acts on: it ends the turn and refetches.
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data).toEqual({ turnId, fullText: 'the late but real answer' })
      const names = sse.events.map((e) => e.event)
      expect(names.indexOf('message-late')).toBeLessThan(names.indexOf('message-end'))
      // Nothing was running after it, so nothing is re-announced.
      await new Promise((r) => setTimeout(r, 200))
      expect(sse.events.filter((e) => e.event === 'message-start')).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('the next turn waits for it (queued), and the late message-end neither ends nor unlocks that turn', async () => {
    const late = deferred<string | null>()
    const secondAnswer = deferred<string>()
    runLaneTurn.mockImplementationOnce(stalledTurn(late.promise))
    // The follow-up as lane-turn.ts runs it on a lane held by a stalled turn:
    // onQueued, then the gate (the earlier turn's late watch), then its own turn.
    runLaneTurn.mockImplementationOnce(async (_a: string, _c: string, _m: string, opts: { onSessionId?: (s: string) => void; onQueued?: () => void }) => {
      opts.onQueued?.()
      await late.promise
      opts.onSessionId?.(LANE)
      return { sessionId: LANE, resultText: await secondAnswer.promise } satisfies LaneTurnResult
    })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const first = await post(convId, 'the long one')
      await sse.waitFor((e) => e.event === 'error' && e.data.turnId === first)

      // The notice released the guard: the next message is accepted.
      const second = await post(convId, 'and meanwhile this')
      const queued = await sse.waitFor((e) => e.event === 'queued' && e.data.turnId === second)
      expect(queued.data).toEqual({ turnId: second, position: 1 })
      expect((await postRaw(convId, 'a third')).status).toBe(409)

      late.resolve('the long answer')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === first)
      // The second turn is still the conversation's running turn.
      expect((await postRaw(convId, 'a fourth')).status).toBe(409)
      await until(() => sse.events.filter((e) => e.event === 'message-start' && e.data.turnId === second).length === 2,
        'the second turn re-announced after the late message-end')
      const names = sse.events.map((e) => `${e.event}:${String(e.data.turnId ?? '')}`)
      const lateEnd = names.indexOf(`message-end:${first}`)
      expect(names.indexOf(`message-late:${first}`)).toBeLessThan(lateEnd)
      expect(names.lastIndexOf(`message-start:${second}`)).toBeGreaterThan(lateEnd)

      secondAnswer.resolve('the second answer')
      const end2 = await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === second)
      expect(end2.data.fullText).toBe('the second answer')
      const rows = await waitRows(convId, (rs) => rs.filter((r) => r.role === 'assistant').length === 2)
      expect(rows.filter((r) => r.role === 'assistant').map((r) => [r.text, r.turnId ?? null])).toEqual([
        ['the long answer', first],
        ['the second answer', null],
      ])
    } finally {
      sse.close()
    }
  }, 60_000)

  it('writes the error row only once the late watch gives up, with no second error frame', async () => {
    const late = deferred<string | null>()
    runLaneTurn.mockImplementationOnce(async () => ({
      sessionId: LANE, resultText: null, failure: 'stalled', laneStillRunning: true, lateResult: late.promise,
    } satisfies LaneTurnResult))
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      await post(convId, 'another question')
      await sse.waitFor((e) => e.event === 'error')
      late.resolve(null)
      const rows = await waitRows(convId, (rs) => rs.some((r) => r.role === 'assistant'))
      expect(rows.filter((r) => r.role === 'assistant')).toEqual([
        expect.objectContaining({ text: '[Error: The main AI stopped responding on this turn.]', source: 'agent-error' }),
      ])
      await new Promise((r) => setTimeout(r, 200))
      expect(sse.events.filter((e) => e.event === 'error')).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 60_000)
})

describe('a cloud-relayed turn that stalls (primary side)', () => {
  it('keeps sending that turn\'s late frames down the bridge after the turn function returned', async () => {
    const late = deferred<string | null>()
    runLaneTurn.mockImplementationOnce(stalledTurn(late.promise))
    forwardMobileEventToBridge.mockClear()
    const convId = await createConv()
    const turnId = `relay-late-${Date.now()}`
    const frames = (): Array<{ turnId: string; event: string; data: Record<string, unknown> }> =>
      forwardMobileEventToBridge.mock.calls
        .filter((c) => c[0] === CHAT_TURN_FRAME_KIND)
        .map((c) => c[1] as { turnId: string; event: string; data: Record<string, unknown> })
        .filter((f) => f.event !== '__keepalive')

    const accepted = await handlePrimaryChatTurnRelay({ agentId: 'general', conversationId: convId, text: 'relayed question', turnId })
    expect(accepted).toMatchObject({ accepted: true, turnId })
    await until(() => frames().some((f) => f.event === 'error'), 'the relayed stall notice')
    expect(frames().find((f) => f.event === 'error')).toMatchObject({ turnId, data: { laneStillRunning: true, turnId } })
    // The relayed turn is over on this box: its ordinary mirror is disarmed.
    await until(() => activeRelayedTurnCount() === 0, 'the relayed turn to settle')

    late.resolve('the relayed late answer')
    await until(() => frames().some((f) => f.event === 'message-end'), 'the late message-end on the bridge')
    const lateFrames = frames().filter((f) => f.event === 'message-late' || f.event === 'message-end')
    expect(lateFrames).toEqual([
      { conversationId: convId, turnId, event: 'message-late', data: { turnId, fullText: 'the relayed late answer' } },
      { conversationId: convId, turnId, event: 'message-end', data: { turnId, fullText: 'the relayed late answer' } },
    ])

    // Once the late watch is over, a frame naming that turn goes nowhere.
    await new Promise((r) => setTimeout(r, 50))
    const before = forwardMobileEventToBridge.mock.calls.length
    mirrorRelayedChatFrame(convId, 'message-end', { turnId, fullText: 'a stray repeat' })
    await new Promise((r) => setTimeout(r, 50))
    expect(forwardMobileEventToBridge.mock.calls.length).toBe(before)
  }, 60_000)

  it('the late answer of a turn that was NOT relayed never rides the live relayed turn', async () => {
    // A phone on the Mac directly asks, the turn stalls, the phone moves to the
    // replica and asks again. The first turn's late message-end must not go down
    // the bridge as the relayed turn's end (the replica would end that turn on it
    // and drop its real frames).
    const late = deferred<string | null>()
    const secondAnswer = deferred<string>()
    runLaneTurn.mockImplementationOnce(stalledTurn(late.promise))
    runLaneTurn.mockImplementationOnce(async (_a: string, _c: string, _m: string, opts: { onSessionId?: (s: string) => void; onQueued?: () => void }) => {
      opts.onQueued?.()
      await late.promise
      opts.onSessionId?.(LANE)
      return { sessionId: LANE, resultText: await secondAnswer.promise } satisfies LaneTurnResult
    })
    forwardMobileEventToBridge.mockClear()
    const frames = (): Array<{ turnId: string; event: string; data: Record<string, unknown> }> =>
      forwardMobileEventToBridge.mock.calls
        .filter((c) => c[0] === CHAT_TURN_FRAME_KIND)
        .map((c) => c[1] as { turnId: string; event: string; data: Record<string, unknown> })
        .filter((f) => f.event !== '__keepalive')
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const local = await post(convId, 'asked on the Mac directly')
      await sse.waitFor((e) => e.event === 'error' && e.data.turnId === local)
      const relayed = `relay-after-local-${Date.now()}`
      expect(await handlePrimaryChatTurnRelay({ agentId: 'general', conversationId: convId, text: 'asked on the replica', turnId: relayed }))
        .toMatchObject({ accepted: true, turnId: relayed })
      await until(() => frames().some((f) => f.event === 'queued'), 'the relayed turn queued on the bridge')

      late.resolve('the local late answer')
      await sse.waitFor((e) => e.event === 'message-end' && e.data.turnId === local)
      await until(() => frames().filter((f) => f.event === 'message-start').length === 2, 'the relayed turn re-announced')
      secondAnswer.resolve('the relayed answer')
      await until(() => frames().some((f) => f.event === 'message-end'), "the relayed turn's own message-end")

      // Every frame on the bridge is the relayed turn's, under its own id.
      expect(frames().every((f) => f.turnId === relayed)).toBe(true)
      expect(frames().filter((f) => typeof f.data?.turnId === 'string').map((f) => `${f.event}:${String(f.data.turnId)}`)).toEqual([
        `message-start:${relayed}`, `queued:${relayed}`, `message-start:${relayed}`, `message-end:${relayed}`,
      ])
      expect(frames().find((f) => f.event === 'message-end')?.data.fullText).toBe('the relayed answer')
      expect(frames().some((f) => f.event === 'message-late')).toBe(false)
    } finally {
      sse.close()
    }
  }, 60_000)
})

describe('a lane turn that fails outright', () => {
  it('a dead CLI is a plain failure: error frame plus error row', async () => {
    runLaneTurn.mockImplementationOnce(async () => ({ sessionId: LANE, resultText: null, failure: 'died' } satisfies LaneTurnResult))
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      await post(convId, 'a question')
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(err.data.message).toBe('The main AI stopped before it answered this turn.')
      const rows = await waitRows(convId, (rs) => rs.some((r) => r.role === 'assistant'))
      expect(rows.filter((r) => r.role === 'assistant')).toEqual([
        expect.objectContaining({ text: '[Error: The main AI stopped before it answered this turn.]', source: 'agent-error' }),
      ])
    } finally {
      sse.close()
    }
  }, 60_000)

  it('a turn refused because the lane is still busy says so, in the frame and in the row', async () => {
    runLaneTurn.mockImplementationOnce(async () => ({ sessionId: LANE, resultText: null, failure: 'busy' } satisfies LaneTurnResult))
    const busy = 'The main AI is still busy with an earlier turn that did not stop. Try again in a few minutes.'
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      await post(convId, 'a question behind a wedged turn')
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(err.data.message).toBe(busy)
      expect(err.data.laneStillRunning).toBeFalsy()
      const rows = await waitRows(convId, (rs) => rs.some((r) => r.role === 'assistant'))
      expect(rows.filter((r) => r.role === 'assistant')).toEqual([
        expect.objectContaining({ text: `[Error: ${busy}]`, source: 'agent-error' }),
      ])
    } finally {
      sse.close()
    }
  }, 60_000)
})
