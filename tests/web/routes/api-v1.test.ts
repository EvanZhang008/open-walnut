/**
 * /api/v1 facade integration tests — real startServer({ port: 0 }) with an
 * isolated temp OPEN_WALNUT_HOME (constants mock, same bootstrap pattern as
 * setup.test.ts). Only the agent loop is mocked.
 *
 * Covers: status shape, conversation CRUD + message turn + SSE streaming,
 * 409 on a concurrent turn, Last-Event-ID / mid-turn replay, notes CRUD with
 * optimistic locking, and the frozen error shape on 404.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-test'))

// ── Agent loop mock: emits 2 text deltas, optionally pausing after the first
//    (lets tests join the SSE stream mid-turn / hold a turn active). ──
const mockState = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  onFirstDelta: null as (() => void) | null,
}))

vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (
    userContent: string | unknown[],
    history: Array<{ role: string; content: unknown }>,
    callbacks: { onTextDelta?: (d: string) => void },
  ) => {
    callbacks.onTextDelta?.('Hello ')
    mockState.onFirstDelta?.()
    if (mockState.gate) await mockState.gate
    callbacks.onTextDelta?.('world')
    const userMsg = {
      role: 'user',
      content: typeof userContent === 'string'
        ? [{ type: 'text', text: userContent }]
        : userContent,
    }
    const aiMsg = { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }
    return {
      messages: [...history, userMsg, aiMsg],
      newMessages: [userMsg, aiMsg],
      response: 'Hello world',
      aborted: false,
    }
  }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// ── Minimal SSE client over fetch ──

interface SseEvt { id?: number; event: string; data: Record<string, unknown> }

interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string, headers?: Record<string, string>): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { headers, signal: controller.signal })
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

async function createConversation(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  const { id } = await res.json() as { id: string }
  expect(id).toMatch(/^conv-/)
  return id
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  resetIndexBootstrap()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/status', () => {
  it('returns the frozen status shape + X-Walnut-API header', async () => {
    const res = await fetch(apiUrl('/api/v1/status'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-api')).toBe('1')
    const body = await res.json() as Record<string, unknown>
    expect(body.mode).toBe('LIVE') // mock constants: CLOUD_MODE false
    expect(body.cloud).toBe(false)
    expect(typeof body.version).toBe('string')
    expect(typeof body.serverTime).toBe('string')
    expect(Number.isNaN(Date.parse(body.serverTime as string))).toBe(false)
  })
})

describe('conversations + messages + SSE', () => {
  it('create → list → send message → SSE events → messages persisted', async () => {
    mockState.gate = null
    const convId = await createConversation()

    // List contains it, most-recent first shape.
    const listRes = await fetch(apiUrl('/api/v1/conversations?limit=10'))
    expect(listRes.status).toBe(200)
    const list = await listRes.json() as Array<{ id: string; updatedAt: string; messageCount: number }>
    expect(list.some((c) => c.id === convId)).toBe(true)

    // Open the SSE stream BEFORE sending.
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const sendRes = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi walnut' }),
      })
      expect(sendRes.status).toBe(202)
      const { turnId } = await sendRes.json() as { turnId: string }
      expect(typeof turnId).toBe('string')

      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.turnId).toBe(turnId)
      expect(end.data.fullText).toBe('Hello world')

      const start = sse.events.find((e) => e.event === 'message-start')
      expect(start?.data.turnId).toBe(turnId)
      const deltas = sse.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(deltas).toEqual(['Hello ', 'world'])
      // Monotonic seq ids
      const ids = sse.events.map((e) => e.id!)
      expect([...ids].sort((a, b) => a - b)).toEqual(ids)

      // Messages endpoint shows the user + assistant messages.
      const msgsRes = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages?limit=50`))
      expect(msgsRes.status).toBe(200)
      const msgs = await msgsRes.json() as Array<{ role: string; text: string; kind?: string }>
      const plain = msgs.filter((m) => !m.kind)
      expect(plain.some((m) => m.role === 'user' && m.text === 'hi walnut')).toBe(true)
      expect(plain.some((m) => m.role === 'assistant' && m.text === 'Hello world')).toBe(true)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('409 turn_active on a concurrent turn for the same conversation', async () => {
    const convId = await createConversation()
    let release!: () => void
    mockState.gate = new Promise<void>((r) => { release = r })
    const firstDelta = new Promise<void>((r) => { mockState.onFirstDelta = r })

    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const first = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'first' }),
      })
      expect(first.status).toBe(202)
      await firstDelta // the turn is now mid-flight, blocked on the gate

      const second = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      })
      expect(second.status).toBe(409)
      const body = await second.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('turn_active')

      release()
      await sse.waitFor((e) => e.event === 'message-end')

      // After the turn ends the slot frees up again.
      mockState.gate = null
      mockState.onFirstDelta = null
      const third = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'third' }),
      })
      expect(third.status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end' && sse.events.filter((x) => x.event === 'message-end').length >= 2)
    } finally {
      mockState.gate = null
      mockState.onFirstDelta = null
      sse.close()
    }
  }, 20_000)

  it('emits a queued SSE event when another turn holds the agent queue', async () => {
    // Two DIFFERENT conversations share the 'general' agent queue — the
    // second turn is accepted (202) but waits; the client must see `queued`
    // on its stream so the pre-message-start silence doesn't read as a freeze.
    const convA = await createConversation()
    const convB = await createConversation()
    let release!: () => void
    mockState.gate = new Promise<void>((r) => { release = r })
    const firstDelta = new Promise<void>((r) => { mockState.onFirstDelta = r })

    const sseB = await connectSse(apiUrl(`/api/v1/conversations/${convB}/stream`))
    try {
      const first = await fetch(apiUrl(`/api/v1/conversations/${convA}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'long turn on A' }),
      })
      expect(first.status).toBe(202)
      await firstDelta // A's turn is mid-flight, holding the queue

      mockState.onFirstDelta = null
      const second = await fetch(apiUrl(`/api/v1/conversations/${convB}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'queued turn on B' }),
      })
      expect(second.status).toBe(202)

      const queued = await sseB.waitFor((e) => e.event === 'queued')
      expect(typeof queued.data.turnId).toBe('string')
      expect(typeof queued.data.position).toBe('number')
      // B has NOT started yet — no message-start before A releases.
      expect(sseB.events.some((e) => e.event === 'message-start')).toBe(false)

      release()
      mockState.gate = null
      await sseB.waitFor((e) => e.event === 'message-end')
      expect(sseB.events.some((e) => e.event === 'message-start')).toBe(true)
    } finally {
      mockState.gate = null
      mockState.onFirstDelta = null
      sseB.close()
    }
  }, 20_000)

  it('replays the current turn to a late joiner and honors Last-Event-ID', async () => {
    const convId = await createConversation()
    let release!: () => void
    mockState.gate = new Promise<void>((r) => { release = r })
    const firstDelta = new Promise<void>((r) => { mockState.onFirstDelta = r })

    const sendRes = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'replay me' }),
    })
    expect(sendRes.status).toBe(202)
    await firstDelta // 1 delta already emitted, no SSE client was connected

    // Late joiner (no Last-Event-ID) → ring buffer replays the turn so far.
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const replayed = await sse.waitFor((e) => e.event === 'text-delta')
      expect(replayed.data.delta).toBe('Hello ')
      expect(sse.events.some((e) => e.event === 'message-start')).toBe(true)

      release()
      mockState.gate = null
      mockState.onFirstDelta = null
      await sse.waitFor((e) => e.event === 'message-end')
      const deltas = sse.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(deltas).toEqual(['Hello ', 'world'])

      // Reconnect with Last-Event-ID of the first delta → only later events replay.
      const firstDeltaId = sse.events.find((e) => e.event === 'text-delta')!.id!
      const sse2 = await connectSse(
        apiUrl(`/api/v1/conversations/${convId}/stream`),
        { 'Last-Event-ID': String(firstDeltaId) },
      )
      try {
        await sse2.waitFor((e) => e.event === 'message-end')
        expect(sse2.events.some((e) => e.event === 'message-start')).toBe(false)
        const deltas2 = sse2.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
        expect(deltas2).toEqual(['world'])
      } finally {
        sse2.close()
      }
    } finally {
      mockState.gate = null
      mockState.onFirstDelta = null
      sse.close()
    }
  }, 20_000)

  it('404 with the frozen error shape for an unknown conversation', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/v1/conversations/conv-does-not-exist/messages', undefined],
      ['POST', '/api/v1/conversations/conv-does-not-exist/messages', JSON.stringify({ text: 'x' })],
      ['GET', '/api/v1/conversations/conv-does-not-exist/stream', undefined],
    ] as const) {
      const res = await fetch(apiUrl(path), {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      })
      expect(res.status).toBe(404)
      const json = await res.json() as { error: { code: string; message: string } }
      expect(json.error.code).toBe('not_found')
      expect(typeof json.error.message).toBe('string')
    }
  })

  it('400 bad_request when text is missing', async () => {
    const convId = await createConversation()
    const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('bad_request')
  })
})

describe('notes', () => {
  it('create → read hash → stale PUT 409 with server copy → correct PUT 200 → tree', async () => {
    // Create
    const createRes = await fetch(apiUrl('/api/v1/notes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Mobile/Hello', content: '# Hello from iOS' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { path: string; contentHash: string; updatedAt: string }
    expect(created.path).toBe('Mobile/Hello.md')
    expect(typeof created.contentHash).toBe('string')

    // Read — hash matches what create returned (id stamping happened at create).
    const getRes = await fetch(apiUrl('/api/v1/notes/content/Mobile/Hello'))
    expect(getRes.status).toBe(200)
    const got = await getRes.json() as { content: string; contentHash: string; updatedAt: string }
    expect(got.contentHash).toBe(created.contentHash)
    expect(got.content).toContain('# Hello from iOS')

    // Stale PUT → 409 with serverHash + serverContent
    const staleRes = await fetch(apiUrl('/api/v1/notes/content/Mobile/Hello'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Overwrite', expectedHash: 'deadbeef' }),
    })
    expect(staleRes.status).toBe(409)
    const conflict = await staleRes.json() as {
      error: { code: string }; serverHash: string; serverContent: string
    }
    expect(conflict.error.code).toBe('conflict')
    expect(conflict.serverHash).toBe(got.contentHash)
    expect(conflict.serverContent).toContain('# Hello from iOS')

    // Correct PUT → 200 with the new hash
    const okRes = await fetch(apiUrl('/api/v1/notes/content/Mobile/Hello'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: got.content + '\nupdated', expectedHash: got.contentHash }),
    })
    expect(okRes.status).toBe(200)
    const updated = await okRes.json() as { contentHash: string }
    expect(updated.contentHash).not.toBe(got.contentHash)

    // Tree contains the file
    const treeRes = await fetch(apiUrl('/api/v1/notes'))
    expect(treeRes.status).toBe(200)
    const { tree } = await treeRes.json() as {
      tree: Array<{ name: string; type: string; children?: Array<{ name: string; path: string }> }>
    }
    const mobile = tree.find((n) => n.name === 'Mobile' && n.type === 'folder')
    expect(mobile).toBeDefined()
    expect(mobile!.children!.some((c) => c.path === 'Mobile/Hello.md')).toBe(true)
  })

  it('POST an existing note → 409; DELETE → ok; GET deleted → 404', async () => {
    const dupRes = await fetch(apiUrl('/api/v1/notes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Mobile/Hello' }),
    })
    expect(dupRes.status).toBe(409)

    const delRes = await fetch(apiUrl('/api/v1/notes/Mobile/Hello'), { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    const goneRes = await fetch(apiUrl('/api/v1/notes/content/Mobile/Hello'))
    expect(goneRes.status).toBe(404)
    const gone = await goneRes.json() as { error: { code: string } }
    expect(gone.error.code).toBe('not_found')
  })

  it('rejects path traversal with 400', async () => {
    const res = await fetch(apiUrl('/api/v1/notes/content/..%2F..%2Fetc%2Fpasswd'))
    expect([400, 404]).toContain(res.status)
  })
})

describe('tasks (read-only projection)', () => {
  it('serves the projected task list with status filter + syncedAt', async () => {
    // Seed real tasks through the task manager (SQLite in the temp home).
    const tm = await import('../../../src/core/task-manager.js')
    await tm.createCategory('Inbox', 'local').catch(() => { /* pre-seeded */ })
    await tm.createProject('Inbox', 'General').catch(() => { /* pre-seeded */ })
    const { task: open } = await tm.addTask({
      title: 'Buy milk', category: 'Inbox', project: 'General',
      priority: 'important', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    const { task: toFinish } = await tm.addTask({
      title: 'Ship v1', category: 'Inbox', project: 'General',
      priority: 'none', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    await tm.completeTask(toFinish.id)

    const res = await fetch(apiUrl('/api/v1/tasks'))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      tasks: Array<{ id: string; title: string; status: string; phase: string }>
      syncedAt: string
    }
    expect(typeof body.syncedAt).toBe('string')
    const titles = body.tasks.map((t) => t.title)
    expect(titles).toContain('Buy milk')
    expect(titles).toContain('Ship v1') // completed recently → still in scope
    const openTask = body.tasks.find((t) => t.id === open.id)!
    expect(openTask.status).toBe('todo')
    // Slim contract: no heavy fields leak through.
    expect(openTask).not.toHaveProperty('note')
    expect(openTask).not.toHaveProperty('conversation_log')
    expect(openTask).not.toHaveProperty('description')

    // status filter
    const doneRes = await fetch(apiUrl('/api/v1/tasks?status=done'))
    const doneBody = await doneRes.json() as { tasks: Array<{ title: string; status: string }> }
    expect(doneBody.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(doneBody.tasks.map((t) => t.title)).toContain('Ship v1')
    expect(doneBody.tasks.map((t) => t.title)).not.toContain('Buy milk')
  })

  it('serves the projected session list with status filter + slim shape', async () => {
    const st = await import('../../../src/core/session-tracker.js')
    const tm = await import('../../../src/core/task-manager.js')
    await tm.createCategory('Inbox', 'local').catch(() => { /* pre-seeded */ })
    await tm.createProject('Inbox', 'General').catch(() => { /* pre-seeded */ })
    const { task } = await tm.addTask({
      title: 'Session host task', category: 'Inbox', project: 'General',
      priority: 'important', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])

    await st.createSessionRecord('sess-proj-live', task.id, 'General', '/tmp/proj', {
      title: 'Live remote session', host: 'devbox', description: 'working on the thing',
    })
    await st.createSessionRecord('sess-proj-old', task.id, 'General', '/tmp/proj', {
      title: 'Ancient stopped session',
    })
    // Age the second one out: stopped long before the retention window.
    await st.updateSessionRecord('sess-proj-old', { process_status: 'stopped' })
    const { getDb } = await import('../../../src/core/session-db.js')
    getDb()!.prepare(
      "UPDATE sessions SET last_active_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z' WHERE claude_session_id = 'sess-proj-old'",
    ).run()

    const res = await fetch(apiUrl('/api/v1/sessions'))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      sessions: Array<Record<string, unknown>>
      syncedAt: string
    }
    expect(typeof body.syncedAt).toBe('string')
    const live = body.sessions.find((s) => s.id === 'sess-proj-live')!
    expect(live).toBeDefined()
    expect(live.title).toBe('Live remote session')
    expect(live.host).toBe('devbox')
    expect(live.task_id).toBe(task.id)
    expect(live.task_title).toBe('Session host task')
    expect(live.category).toBe('Inbox')
    expect(typeof live.process_status).toBe('string')
    // Slim contract: registry internals don't leak.
    expect(live).not.toHaveProperty('pid')
    expect(live).not.toHaveProperty('outputFile')
    // Retention: the ancient stopped session is dropped.
    expect(body.sessions.map((s) => s.id)).not.toContain('sess-proj-old')

    // status filter round-trips.
    const filtered = await fetch(apiUrl(`/api/v1/sessions?status=${live.process_status}`))
    const filteredBody = await filtered.json() as { sessions: Array<{ id: string; process_status: string }> }
    expect(filteredBody.sessions.every((s) => s.process_status === live.process_status)).toBe(true)
    expect(filteredBody.sessions.map((s) => s.id)).toContain('sess-proj-live')
  })

  it('serves a synced session transcript tail and 404s for unknown/unsafe ids', async () => {
    const { SESSION_TRANSCRIPTS_DIR } = await import('../../../src/core/session-projection.js')
    // Simulate what the primary's export sweep writes (this box acts as the
    // cloud reader: the file is the contract, not the exporter internals).
    await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
    await fs.writeFile(
      `${SESSION_TRANSCRIPTS_DIR}/sess-transcript-1.json`,
      JSON.stringify({
        version: 1,
        sessionId: 'sess-transcript-1',
        exportedAt: new Date().toISOString(),
        truncated: false,
        messages: [
          { role: 'user', text: 'fix the bug', timestamp: '2026-07-10T00:00:00.000Z' },
          { role: 'assistant', text: 'Read', timestamp: '2026-07-10T00:00:01.000Z', kind: 'tool' },
          { role: 'assistant', text: 'Done — the null guard was missing.', timestamp: '2026-07-10T00:00:02.000Z' },
        ],
      }),
    )

    const res = await fetch(apiUrl('/api/v1/sessions/sess-transcript-1/transcript'))
    expect(res.status).toBe(200)
    const body = await res.json() as { sessionId: string; messages: Array<{ role: string; text: string; kind?: string }> }
    expect(body.sessionId).toBe('sess-transcript-1')
    expect(body.messages).toHaveLength(3)
    expect(body.messages[1].kind).toBe('tool')

    const missing = await fetch(apiUrl('/api/v1/sessions/sess-nope/transcript'))
    expect(missing.status).toBe(404)
    const missingBody = await missing.json() as { error: { code: string } }
    expect(missingBody.error.code).toBe('not_found')

    // Path traversal in the id must not escape the transcripts dir.
    const evil = await fetch(apiUrl('/api/v1/sessions/..%2F..%2Fconfig/transcript'))
    expect([400, 404]).toContain(evil.status)
  })

  it('exportTaskProjection drops done tasks older than the retention window', async () => {
    const { exportTaskProjection, readTaskProjection } = await import('../../../src/core/task-projection.js')
    const tm = await import('../../../src/core/task-manager.js')
    // Seed a long-ago-completed task directly (updateTask strips completed_at).
    await tm.addTaskFull({
      title: 'Ancient chore', category: 'Inbox', project: 'General',
      status: 'done', phase: 'COMPLETE', priority: 'none', source: 'local',
      session_ids: [], description: '', summary: '', note: '',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-02T00:00:00.000Z',
      completed_at: '2020-01-02T00:00:00.000Z',
    })

    await exportTaskProjection()
    const projection = await readTaskProjection()
    expect(projection).not.toBeNull()
    expect(projection!.version).toBe(1)
    expect(projection!.tasks.map((t) => t.title)).not.toContain('Ancient chore')
  })
})
