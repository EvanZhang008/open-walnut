/**
 * GET /api/v1/events — the mobile live feed (SSE) on the PRIMARY box. Real
 * startServer({ port: 0, dev: true }) so the module-level bus subscription is
 * wired exactly as in production. Covers: the per-connection snapshot frame,
 * bus session:status-changed → session-upsert, task create/update/delete →
 * task-upsert/task-delete, multi-subscriber fan-out, and that emits after a
 * disconnect don't blow up the feed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-events'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createSessionRecord, getSessionByClaudeId, emitSessionStatusChanged } from '../../../src/core/session-tracker.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// ── Minimal SSE client over fetch (same shape as api-v1-session-talk.test.ts) ──

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

async function createTask(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  const { task } = await res.json() as { task: { id: string } }
  return task
}

const SID = 'events-feed-session-01'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await createSessionRecord(SID, 'task-events-1', 'events-proj', '/tmp', { title: 'events feed test' })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/events', () => {
  it('sends one snapshot frame on attach with projection-shaped rows', async () => {
    const seeded = await createTask({ title: 'Snapshot seed task' })
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      const snap = await sse.waitFor((e) => e.event === 'snapshot')
      // Snapshot is a per-connection frame — no SSE id, never in replay.
      expect(snap.id).toBeUndefined()
      const sessions = snap.data.sessions as Array<{ id: string; process_status: string }>
      const tasks = snap.data.tasks as Array<{ id: string; title: string; status: string; phase: string }>
      expect(Array.isArray(sessions)).toBe(true)
      expect(Array.isArray(tasks)).toBe(true)
      expect(sessions.some((s) => s.id === SID)).toBe(true)
      const row = tasks.find((t) => t.id === seeded.id)
      expect(row).toBeDefined()
      expect(row!.title).toBe('Snapshot seed task')
      expect(row!.status).toBe('todo')
      expect(row!.phase).toBe('TODO')
    } finally {
      sse.close()
    }
  })

  it('session:status-changed → session-upsert with the authoritative projected row', async () => {
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      const record = await getSessionByClaudeId(SID)
      expect(record).toBeTruthy()
      emitSessionStatusChanged(record!, {}, ['*'], { source: 'test' })
      const evt = await sse.waitFor((e) => e.event === 'session-upsert' && e.data.id === SID)
      // projectSession() shape — field names match GET /api/v1/sessions rows.
      expect(evt.data.process_status).toBeDefined()
      expect(evt.data.title).toBe('events feed test')
      expect(typeof evt.data.last_active_at).toBe('string')
      expect(typeof evt.data.message_count).toBe('number')
    } finally {
      sse.close()
    }
  })

  it('task create / update / delete → task-upsert / task-delete', async () => {
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')

      // Create through the real API → TASK_CREATED bus emit → task-upsert.
      const task = await createTask({ title: 'Feed lifecycle task' })
      const created = await sse.waitFor((e) => e.event === 'task-upsert' && e.data.id === task.id)
      expect(created.data.title).toBe('Feed lifecycle task')
      expect(created.data.status).toBe('todo')

      // Update through the v1 PATCH → TASK_UPDATED → task-upsert.
      const patch = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      })
      expect(patch.status).toBe(200)
      await sse.waitFor((e) =>
        e.event === 'task-upsert' && e.data.id === task.id && e.data.status === 'in_progress')

      // Delete through the web API → TASK_DELETED → task-delete { id }.
      const del = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' })
      expect(del.status).toBe(204)
      const deleted = await sse.waitFor((e) => e.event === 'task-delete' && e.data.id === task.id)
      expect(deleted.data).toEqual({ id: task.id })
    } finally {
      sse.close()
    }
  })

  it('fans out to multiple subscribers independently', async () => {
    const sse1 = await connectSse(apiUrl('/api/v1/events'))
    const sse2 = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse1.waitFor((e) => e.event === 'snapshot')
      await sse2.waitFor((e) => e.event === 'snapshot')
      const task = await createTask({ title: 'Fan-out task' })
      const [a, b] = await Promise.all([
        sse1.waitFor((e) => e.event === 'task-upsert' && e.data.id === task.id),
        sse2.waitFor((e) => e.event === 'task-upsert' && e.data.id === task.id),
      ])
      expect(a.data.title).toBe('Fan-out task')
      expect(b.data.title).toBe('Fan-out task')
    } finally {
      sse1.close()
      sse2.close()
    }
  })

  it('emits after a disconnect are safe, and a new subscriber still works', async () => {
    const sse = await connectSse(apiUrl('/api/v1/events'))
    await sse.waitFor((e) => e.event === 'snapshot')
    sse.close()
    // Give the server a beat to process the close.
    await new Promise((r) => setTimeout(r, 100))

    // This emit lands on a channel with zero live conns — must not throw.
    const task = await createTask({ title: 'Post-disconnect task' })

    // A fresh subscriber attaches fine and sees subsequent events.
    const sse2 = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse2.waitFor((e) => e.event === 'snapshot')
      const patch = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'important' }),
      })
      expect(patch.status).toBe(200)
      await sse2.waitFor((e) =>
        e.event === 'task-upsert' && e.data.id === task.id && e.data.priority === 'important')
    } finally {
      sse2.close()
    }
  })

  it('a new connection gets ONLY the snapshot — no ring replay of older events (P0-2/P0-3)', async () => {
    // Generate history on the shared channel BEFORE connecting: a task that
    // goes through several states, then a session status flap.
    const task = await createTask({ title: 'Replay pollution task' })
    const patch = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(patch.status).toBe(200)
    const record = await getSessionByClaudeId(SID)
    emitSessionStatusChanged(record!, {}, ['*'], { source: 'test' })
    // Let the emits (and the coalesced session-upsert) fully land.
    await new Promise((r) => setTimeout(r, 600))

    // Fresh connection, no Last-Event-ID: pre-fix this replayed up to 512
    // historical frames AFTER the snapshot, regressing it (done → todo).
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      const snap = await sse.waitFor((e) => e.event === 'snapshot')
      const tasks = snap.data.tasks as Array<{ id: string; status: string }>
      expect(tasks.find((t) => t.id === task.id)?.status).toBe('done')
      // Give any (buggy) replay a beat to arrive, then assert: nothing but
      // the snapshot ever landed on this connection.
      await new Promise((r) => setTimeout(r, 400))
      const nonSnapshot = sse.events.filter((e) => e.event !== 'snapshot')
      expect(nonSnapshot).toEqual([])
    } finally {
      sse.close()
    }
  })

  it('coalesces rapid session:status-changed per session; distinct sids stay independent (P1-1)', async () => {
    const OTHER_SID = 'events-feed-session-02'
    await createSessionRecord(OTHER_SID, 'task-events-2', 'events-proj', '/tmp', { title: 'coalesce other' })
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      const before = sse.events.length
      const record = await getSessionByClaudeId(SID)
      const other = await getSessionByClaudeId(OTHER_SID)
      // 5 rapid flaps on SID + 1 on OTHER_SID, all inside one 250ms window.
      for (let i = 0; i < 5; i++) emitSessionStatusChanged(record!, {}, ['*'], { source: 'test' })
      emitSessionStatusChanged(other!, {}, ['*'], { source: 'test' })
      // Wait out the coalesce window + projection read, then count frames.
      await sse.waitFor((e) => e.event === 'session-upsert' && e.data.id === OTHER_SID)
      await new Promise((r) => setTimeout(r, 600))
      const frames = sse.events.slice(before)
      const forSid = frames.filter((e) => e.event === 'session-upsert' && e.data.id === SID)
      const forOther = frames.filter((e) => e.event === 'session-upsert' && e.data.id === OTHER_SID)
      // 5 flaps → at most 2 frames (window boundary tolerance), never 5.
      expect(forSid.length).toBeGreaterThanOrEqual(1)
      expect(forSid.length).toBeLessThanOrEqual(2)
      // The other sid is not swallowed by SID's window.
      expect(forOther.length).toBeGreaterThanOrEqual(1)
    } finally {
      sse.close()
    }
  })

  it('does NOT re-emit for high-frequency streaming events (interest set)', async () => {
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      const before = sse.events.length
      // Streaming deltas are outside the feed's interest set — no frames.
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: SID, delta: 'x' }, ['*'], { source: 'test' })
      bus.emit(EventNames.SESSION_THINKING_DELTA, { sessionId: SID, delta: 'y' }, ['*'], { source: 'test' })
      await new Promise((r) => setTimeout(r, 300))
      expect(sse.events.length).toBe(before)
    } finally {
      sse.close()
    }
  })
})
