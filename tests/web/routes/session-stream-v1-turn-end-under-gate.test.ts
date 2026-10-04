/**
 * `GET /api/v1/sessions/:id/stream` × the snapshot gate at turn end.
 *
 * The bug this pins (2026-10-03, the phone stuck on "Thinking…" after a reply had
 * landed): at turn end the runner writes `process_status: 'idle'` UN-stamped. For a
 * snapshot-covered session in enforce mode the C2 gate strips that status, so the
 * write returns the record as it was, still `running`. The runner then published
 * that stale record as 'session-runner', and the stream route maps a
 * 'session-runner' `running` to `turn-start {reset: true}`: the turn-end it had
 * just sent was wiped from the replay window and the phone saw a new turn begin.
 *
 * What's real: the server, the SSE route, the session tracker with its gate, and a
 * ClaudeCodeSession fed a production `result` line through handleStreamLine. What's
 * mocked: the transport (no process is spawned).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-sstream-gate-turn-end'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import {
  setSnapshotModeForTests,
  markSnapshotCovered,
  _resetSnapshotGateForTests,
} from '../../../src/core/session-snapshot-apply.js'
import { ClaudeCodeSession } from '../../../src/providers/claude-code-session.js'

let server: HttpServer
let port: number

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
            if (line.startsWith(':')) continue
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

function resultLine(sessionId: string): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1500, num_turns: 1, result: 'Done, the file has three TODOs.',
    session_id: sessionId, total_cost_usd: 0.003,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

function mockTransport() {
  return {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null,
    outputFile: null, host: null, fileSize: 0,
    imageCache: new Map<string, string>(), lastEventAt: 0, tailOffset: 0,
    writeMessage: (_message: string, opts?: { onDispatch?: () => void }) => { opts?.onDispatch?.(); return true },
    writeRaw: () => true, writeSyntheticUserEvent: () => {}, deletePipe: () => {},
    renameForSession: () => {}, kill: () => {}, stop: async () => {},
  }
}

interface Internals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  _statusCommit: Promise<void>
  claudeSessionId: string | null
  handleStreamLine(line: string, v?: number): void
}

function runningSession(sid: string): Internals {
  const session = new ClaudeCodeSession('', 'test-project', '/bin/true') as unknown as Internals
  session._transport = mockTransport()
  session._active = true
  session._processStatus = 'running'
  session.claudeSessionId = sid
  return session
}

async function seedRunning(sid: string): Promise<void> {
  await createSessionRecord(sid, '', 'test-project', '/tmp', { title: 'gate turn end' })
  await updateSessionRecord(sid, { process_status: 'running' } as never)
}

/** Status events the runner published, with the source each one carried. */
function recordStatusEvents(): Array<{ source?: string; status: unknown }> {
  const seen: Array<{ source?: string; status: unknown }> = []
  bus.subscribe('test-status-watch', (e: BusEvent) => {
    if (e.name !== EventNames.SESSION_STATUS_CHANGED) return
    seen.push({ source: e.source, status: (e.data as Record<string, unknown>).process_status })
  }, { global: true })
  return seen
}

/** Long enough for the deferred status commit and any late SSE frame. */
const settle = () => new Promise((r) => setTimeout(r, 300))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterEach(() => {
  bus.unsubscribe('test-status-watch')
  _resetSnapshotGateForTests()
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('session stream: turn end on a snapshot-covered session', () => {
  it('the gated idle write does not reopen the turn, live or on replay', async () => {
    const sid = 'sstream-gate-turn-end-0001'
    await seedRunning(sid)
    setSnapshotModeForTests('enforce')
    markSnapshotCovered(sid)
    const statuses = recordStatusEvents()

    const live = await connectSse(`http://localhost:${port}/api/v1/sessions/${sid}/stream`)
    try {
      await live.waitFor((e) => e.event === 'snapshot')
      const session = runningSession(sid)
      session.handleStreamLine(resultLine(sid), 1000)
      await session._statusCommit
      await live.waitFor((e) => e.event === 'turn-end')
      await settle()

      // What the phone saw: the turn ended and nothing reopened it.
      const endAt = live.events.findIndex((e) => e.event === 'turn-end')
      expect(live.events.slice(endAt).map((e) => e.event)).not.toContain('turn-start')

      // Why: the gate held (the record is still the snapshot's 'running'), and the
      // runner's echo of that record is labelled as the tracker's, not a verdict.
      expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
      expect(statuses).toContainEqual({ source: 'session-tracker', status: 'running' })
      expect(statuses).not.toContainEqual({ source: 'session-runner', status: 'running' })
    } finally {
      live.close()
    }

    // A phone that reconnects now replays the window and still finds the turn's end.
    const late = await connectSse(`http://localhost:${port}/api/v1/sessions/${sid}/stream`)
    try {
      await late.waitFor((e) => e.event === 'turn-end', 3_000)
    } finally {
      late.close()
    }
  }, 30_000)

  it('a status event older than one already relayed is dropped', async () => {
    // Two writers' events can reach the bus out of order: the runner's echo of an
    // older record after the snapshot's newer one. The web console sorts them by
    // statusRevision; the phone's frame carries none, so the route must.
    const sid = 'sstream-gate-turn-end-0003'
    await createSessionRecord(sid, '', 'test-project', '/tmp', { title: 'status order' })
    const live = await connectSse(`http://localhost:${port}/api/v1/sessions/${sid}/stream`)
    const status = (rev: number, ps: string, source: string) => bus.emit(
      EventNames.SESSION_STATUS_CHANGED,
      { sessionId: sid, process_status: ps, statusRevision: rev },
      ['*'], { source },
    )
    try {
      await live.waitFor((e) => e.event === 'snapshot')
      status(7, 'idle', 'snapshot:daemon-push')
      await live.waitFor((e) => e.event === 'status' && e.data.processStatus === 'idle')
      status(6, 'running', 'session-runner')
      status(8, 'running', 'session-runner')
      await live.waitFor((e) => e.event === 'turn-start')
      await live.waitFor((e) => e.event === 'status' && e.data.processStatus === 'running')
      await settle()
      expect(live.events.filter((e) => e.event === 'status').map((e) => e.data.processStatus))
        .toEqual(['idle', 'running'])
      expect(live.events.filter((e) => e.event === 'turn-start')).toHaveLength(1)
    } finally {
      live.close()
    }
  }, 30_000)

  it('an ungated session publishes its own idle as the runner, and the turn stays ended', async () => {
    const sid = 'sstream-gate-turn-end-0002'
    await seedRunning(sid)
    setSnapshotModeForTests('enforce')
    // Not covered: the runner is still the authoritative writer for this session.
    const statuses = recordStatusEvents()

    const live = await connectSse(`http://localhost:${port}/api/v1/sessions/${sid}/stream`)
    try {
      await live.waitFor((e) => e.event === 'snapshot')
      const session = runningSession(sid)
      session.handleStreamLine(resultLine(sid), 1000)
      await session._statusCommit
      await live.waitFor((e) => e.event === 'turn-end')
      await live.waitFor((e) => e.event === 'status' && e.data.processStatus === 'idle')
      await settle()

      expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
      expect(statuses).toContainEqual({ source: 'session-runner', status: 'idle' })
      const endAt = live.events.findIndex((e) => e.event === 'turn-end')
      expect(live.events.slice(endAt).map((e) => e.event)).not.toContain('turn-start')
    } finally {
      live.close()
    }
  }, 30_000)
})
