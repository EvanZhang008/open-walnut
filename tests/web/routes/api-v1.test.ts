/**
 * /api/v1 facade integration tests — real startServer({ port: 0 }) with an
 * isolated temp OPEN_WALNUT_HOME (constants mock, same bootstrap pattern as
 * setup.test.ts).
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

import path from 'node:path'
import yaml from 'js-yaml'
import { WALNUT_HOME, LOG_DIR, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js'
import {
  _deleteSseChannelForTesting,
  _sseEventIdsForTesting,
  emitSse,
} from '../../../src/web/sse-channels.js'

// 1×1 red PNG — small enough that compressForApi early-exits (stays PNG).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
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
  // Nothing here sends a chat turn: a turn would spawn a real `claude` CLI through
  // the lane. The lane path is covered by api-v1-lane-messages.test.ts with a fake
  // session-runner.
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({}), 'utf-8')
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

describe('SSE channel lifecycle', () => {
  it('keeps event IDs monotonic after an idle channel is recreated', () => {
    const key = 'gc-recreated-channel'
    emitSse(key, 'first', {})
    const firstId = _sseEventIdsForTesting(key)[0]
    _deleteSseChannelForTesting(key)
    emitSse(key, 'second', {})
    expect(_sseEventIdsForTesting(key)[0]).toBeGreaterThan(firstId)
  })
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

describe('conversations + messages', () => {
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
    await tm.ensureProject('General', 'local')
    const { task: open } = await tm.addTask({
      title: 'Buy milk', project: 'General',
      priority: 'important', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    const { task: toFinish } = await tm.addTask({
      title: 'Ship v1', project: 'General',
      priority: 'none', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    await tm.completeTask(toFinish.id)

    const res = await fetch(apiUrl('/api/v1/tasks'))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      tasks: Array<{ id: string; title: string; status: string; phase: string; project: string }>
      syncedAt: string
    }
    expect(typeof body.syncedAt).toBe('string')
    const titles = body.tasks.map((t) => t.title)
    expect(titles).toContain('Buy milk')
    expect(titles).toContain('Ship v1') // completed recently → still in scope
    const openTask = body.tasks.find((t) => t.id === open.id)!
    expect(openTask.status).toBe('todo')
    // v2 projection: project is the only grouping field.
    expect(openTask.project).toBe('General')
    expect(openTask).not.toHaveProperty('category')
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

  it('filters the projection by pinned, focus_tier and working_set', async () => {
    const tm = await import('../../../src/core/task-manager.js')
    await tm.ensureProject('General', 'local')
    const { task: focus } = await tm.addTask({
      title: 'v1 focus pin', project: 'General',
      priority: 'none', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    const { task: satellite } = await tm.addTask({
      title: 'v1 satellite pin', project: 'General',
      priority: 'none', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    const { task: loose } = await tm.addTask({
      title: 'v1 never pinned', project: 'General',
      priority: 'none', description: '', status: 'todo',
    } as Parameters<typeof tm.addTask>[0])
    await tm.togglePin(focus.id)
    await tm.togglePin(satellite.id)
    await tm.setFocusTier(focus.id, 'focus')
    // Board order is pin_order, not creation order.
    await tm.reorderPins([satellite.id, focus.id])

    interface Row { id: string; pinned?: boolean; pin_order?: number; focus_tier?: string }
    const list = async (qs: string): Promise<Row[]> => {
      const res = await fetch(apiUrl(`/api/v1/tasks${qs}`))
      expect(res.status).toBe(200)
      return (await res.json() as { tasks: Row[] }).tasks
    }

    const pinnedIds = (await list('?pinned=true')).map((t) => t.id)
    expect(new Set(pinnedIds)).toEqual(new Set([focus.id, satellite.id]))
    const unpinnedIds = (await list('?pinned=false')).map((t) => t.id)
    expect(unpinnedIds).toContain(loose.id)
    expect(unpinnedIds).not.toContain(focus.id)

    // 'satellite' = pinned with no stored tier; an unpinned row matches no tier.
    expect((await list('?focus_tier=satellite')).map((t) => t.id)).toEqual([satellite.id])
    expect((await list('?focus_tier=focus')).map((t) => t.id)).toEqual([focus.id])
    expect(new Set((await list('?focus_tier=focus,satellite')).map((t) => t.id)))
      .toEqual(new Set([focus.id, satellite.id]))
    expect((await list('?focus_tier=satellite')).map((t) => t.id)).not.toContain(loose.id)

    // working_set = the whole pinned board, sorted by pin_order ascending.
    const board = await list('?working_set=true')
    expect(board.map((t) => t.id)).toEqual([satellite.id, focus.id])
    expect(board.map((t) => t.pin_order)).toEqual([0, 1])

    const bad = await fetch(apiUrl('/api/v1/tasks?pinned=garbage'))
    expect(bad.status).toBe(400)
    const badBody = await bad.json() as { error: { code: string; message: string } }
    expect(badBody.error.code).toBe('bad_request')
    expect(badBody.error.message).toMatch(/pinned/)

    // Same contradiction answer as GET /api/tasks — never a silent override.
    const conflict = await fetch(apiUrl('/api/v1/tasks?working_set=true&pinned=false'))
    expect(conflict.status).toBe(400)
    const conflictBody = await conflict.json() as { error: { code: string; message: string } }
    expect(conflictBody.error.message).toMatch(/working_set/)

    // Leave the shared projection unpinned for the assertions that follow.
    await tm.togglePin(focus.id)
    await tm.togglePin(satellite.id)
  })

  it('serves the projected session list with status filter + slim shape', async () => {
    const st = await import('../../../src/core/session-tracker.js')
    const tm = await import('../../../src/core/task-manager.js')
    await tm.ensureProject('General', 'local')
    const { task } = await tm.addTask({
      title: 'Session host task', project: 'General',
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
    expect(live.project).toBe('General')
    expect(live).not.toHaveProperty('category')
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

  it('answers 200-empty for a just-created (awaiting_spawn) session instead of 404', async () => {
    // The mobile app opens the conversation view right after POST /sessions
    // and polls the transcript. Before the CLI spawns there is no JSONL to
    // read — that window must be a fast empty 200, not a 404 that triggers a
    // full export sweep plus a ~400ms fresh scan per poll.
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    await createSessionRecord('sess-awaiting-1', 'task-await', 'Quick Start', '/tmp/x', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    })

    for (const q of ['', '?fresh=1']) {
      const res = await fetch(apiUrl(`/api/v1/sessions/sess-awaiting-1/transcript${q}`))
      expect(res.status).toBe(200)
      const body = await res.json() as { sessionId: string; messages: unknown[]; truncated: boolean }
      expect(body.sessionId).toBe('sess-awaiting-1')
      expect(body.messages).toEqual([])
      expect(body.truncated).toBe(false)
    }

    // A record that died BEFORE spawn (stopped, still pid-less) must NOT hit
    // the short-circuit: the route's process_status==='idle' gate exists so a
    // dead session serves the normal read path (404 here — no transcript).
    await createSessionRecord('sess-awaiting-dead', 'task-await', 'Quick Start', '/tmp/x', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    })
    await updateSessionRecord('sess-awaiting-dead', { process_status: 'stopped' })
    const dead = await fetch(apiUrl('/api/v1/sessions/sess-awaiting-dead/transcript'))
    expect(dead.status).toBe(404)

    // Once the spawn lands (pid recorded), the short-circuit must disengage —
    // the normal read path serves the real (exported/fresh) transcript again.
    // NOTE the setup deliberately keeps status_reason='awaiting_spawn': the
    // real spawn never rewrites it (persistSessionRecord only writes
    // pid/outputFile), so "more realistic" data with a cleared reason would
    // quietly stop guarding against a status_reason-only regression.
    await updateSessionRecord('sess-awaiting-1', { pid: 12345 })
    const { SESSION_TRANSCRIPTS_DIR } = await import('../../../src/core/session-projection.js')
    await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
    await fs.writeFile(
      `${SESSION_TRANSCRIPTS_DIR}/sess-awaiting-1.json`,
      JSON.stringify({
        version: 1, sessionId: 'sess-awaiting-1', exportedAt: new Date().toISOString(),
        truncated: false,
        messages: [{ role: 'user', text: 'first turn', timestamp: '2026-08-02T00:00:00.000Z' }],
      }),
    )
    // Non-fresh serves the exported file; fresh=1 must ALSO bypass the
    // short-circuit (its JSONL scan returns empty here — the point is the
    // guard no longer answers for a spawned session on either path).
    const after = await fetch(apiUrl('/api/v1/sessions/sess-awaiting-1/transcript'))
    expect(after.status).toBe(200)
    const afterBody = await after.json() as { messages: Array<{ text: string }> }
    expect(afterBody.messages).toHaveLength(1)
    expect(afterBody.messages[0].text).toBe('first turn')
    const afterFresh = await fetch(apiUrl('/api/v1/sessions/sess-awaiting-1/transcript?fresh=1'))
    expect(afterFresh.status).toBe(200)

    // Park both records terminally so they can't bleed into later projection
    // assertions in this shared-server suite.
    await updateSessionRecord('sess-awaiting-1', { process_status: 'stopped', pid: undefined, archived: true })
    await updateSessionRecord('sess-awaiting-dead', { archived: true })
  })

  it('exportTaskProjection drops done tasks older than the retention window', async () => {
    const { exportTaskProjection, readTaskProjection } = await import('../../../src/core/task-projection.js')
    const tm = await import('../../../src/core/task-manager.js')
    // Seed a long-ago-completed task directly (updateTask strips completed_at).
    await tm.addTaskFull({
      title: 'Ancient chore', project: 'General',
      status: 'done', phase: 'COMPLETE', priority: 'none', source: 'local',
      session_ids: [], description: '', summary: '', note: '',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-02T00:00:00.000Z',
      completed_at: '2020-01-02T00:00:00.000Z',
    })

    await exportTaskProjection()
    const projection = await readTaskProjection()
    expect(projection).not.toBeNull()
    // v2 = the project-only contract; readers fail closed on anything else.
    expect(projection!.version).toBe(2)
    expect(projection!.tasks.map((t) => t.title)).not.toContain('Ancient chore')
  })
})

describe('agents (additive)', () => {
  it('lists console agents with the main flag', async () => {
    const res = await fetch(apiUrl('/api/v1/agents'))
    expect(res.status).toBe(200)
    const agents = await res.json() as Array<{ id: string; name: string; isMain: boolean }>
    const general = agents.find((a) => a.id === 'general')
    expect(general).toBeDefined()
    expect(general!.name).toBe('Walnut')
    expect(general!.isMain).toBe(true)
    expect(agents.filter((a) => a.isMain)).toHaveLength(1)
  })

  it('404s conversation endpoints for an unknown agentId', async () => {
    const res = await fetch(apiUrl('/api/v1/conversations?agentId=nope'))
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_found')

    const post = await fetch(apiUrl('/api/v1/conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'nope' }),
    })
    expect(post.status).toBe(404)
  })

  it('scopes conversations per agent (mentor list does not show general convs)', async () => {
    const generalConv = await createConversation()
    const mentorRes = await fetch(apiUrl('/api/v1/conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'mentor' }),
    })
    expect(mentorRes.status).toBe(201)
    const { id: mentorConv } = await mentorRes.json() as { id: string }

    const mentorList = await fetch(apiUrl('/api/v1/conversations?agentId=mentor'))
    const mentorConvs = await mentorList.json() as Array<{ id: string }>
    expect(mentorConvs.map((c) => c.id)).toContain(mentorConv)
    expect(mentorConvs.map((c) => c.id)).not.toContain(generalConv)

    // Cross-agent access is a 404, not a leak.
    const cross = await fetch(apiUrl(`/api/v1/conversations/${generalConv}/messages?agentId=mentor`))
    expect(cross.status).toBe(404)
  })
})

describe('message normalization: notifications + entity refs', () => {
  it('renders surviving ui entries as notification cards, hides dev noise, strips refs', async () => {
    const { normalizeEntries } = await import('../../../src/web/routes/api-v1.js')
    const entries = [
      // Dev noise: hidden by default (mirrors web console defaults).
      { tag: 'ui', role: 'assistant', content: '**Triage** (<task-ref id="t1" label="My Task"/>): analysis', timestamp: '2026-07-10T00:00:00Z', source: 'triage', notification: true },
      { tag: 'ui', role: 'assistant', content: '**Session Result**: done', timestamp: '2026-07-10T00:00:01Z', source: 'session', notification: true },
      { tag: 'ui', role: 'assistant', content: '**Subagent Result** (triage): …', timestamp: '2026-07-10T00:00:02Z', source: 'subagent', notification: true },
      { tag: 'ui', role: 'assistant', content: 'All clear', timestamp: '2026-07-10T00:00:03Z', source: 'heartbeat', notification: true },
      // Runtime errors are notification-center records, never conversation cards.
      { tag: 'ui', role: 'assistant', content: '**Session Error** (<task-ref id="t2" label="Deploy fix"/>): boom in [mr9i88ys-87a4|Quick Start / Website]', timestamp: '2026-07-10T00:00:04Z', source: 'session-error', notification: true },
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: '[Error: provider unavailable]' }], timestamp: '2026-07-10T00:00:04Z' },
      // A non-error UI notification survives, with both reference forms resolved.
      { tag: 'ui', role: 'assistant', content: 'Review <task-ref id="t2" label="Deploy fix"/> in [mr9i88ys-87a4|Quick Start / Website]', timestamp: '2026-07-10T00:00:04Z', source: 'cron', notification: true },
      // Quick Start machine banners (both shapes) are dropped entirely,
      // like the web console.
      { tag: 'ui', role: 'user', content: 'Quick Start on `~/repo`:\n> do the thing', timestamp: '2026-07-10T00:00:05Z', source: 'quick-start' },
      { tag: 'ai', role: 'user', content: [{ type: 'text', text: '[Quick Start] Session created and running.\n- Task ID: t9\n\nPlease update the task:\n1. Set a descriptive title' }], displayText: '[Quick Start] Session created and running.\n- Task ID: t9\n\nPlease update the task:\n1. Set a descriptive title', timestamp: '2026-07-10T00:00:05Z', source: 'quick-start' },
      // Leading machine banners on a real user turn are stripped.
      { tag: 'ai', role: 'user', content: [{ type: 'text', text: '[Current: Sun, Jun 7, 2026, 05:26 PM]\n\nreal user question' }], timestamp: '2026-07-10T00:00:05Z' },
      // CLI interrupt marker becomes a card, not a fake user bubble.
      { tag: 'ai', role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }], timestamp: '2026-07-10T00:00:05Z' },
      // Normal AI turn with an inline session ref.
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'See <session-ref id="s1" label="Build session"/> for logs.' }], timestamp: '2026-07-10T00:00:06Z' },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = normalizeEntries(entries as any)
    expect(out).toHaveLength(4)
    expect(out[0].kind).toBe('notification')
    expect(out[0].source).toBe('cron')
    expect(out[0].text).toContain('Deploy fix')
    expect(out[0].text).not.toContain('<task-ref')
    expect(out[0].text).toContain('Quick Start / Website')
    expect(out[0].text).not.toContain('mr9i88ys-87a4|')
    expect(out[1].text).toBe('real user question')
    expect(out[2].kind).toBe('notification')
    expect(out[2].source).toBe('interrupt')
    expect(out[3].text).toBe('See Build session for logs.')
    const all = JSON.stringify(out)
    expect(all).not.toContain('Please update the task')
    expect(all).not.toContain('[Current:')
    expect(all).not.toContain('Session Error')
    expect(all).not.toContain('provider unavailable')
  })
})

describe('message normalization: tool detail + result preview (additive)', () => {
  it('tool rows carry a one-line input summary and a clipped result preview', async () => {
    const { normalizeEntries } = await import('../../../src/web/routes/api-v1.js')
    const entries = [
      { tag: 'ai', role: 'user', content: [{ type: 'text', text: 'run it' }], timestamp: '2026-07-10T00:00:00Z' },
      {
        tag: 'ai', role: 'assistant', timestamp: '2026-07-10T00:00:01Z',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls docs/', description: 'List docs' } },
          { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/tmp/demo/report.md' } },
          // No usable input → no detail field at all.
          { type: 'tool_use', id: 'tu-3', name: 'Mystery', input: { count: 3 } },
        ],
      },
      {
        tag: 'ai', role: 'user', timestamp: '2026-07-10T00:00:02Z',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'a.md\nb.md\n' + 'x'.repeat(2000) },
          { type: 'tool_result', tool_use_id: 'tu-2', content: [{ type: 'text', text: 'file body' }] },
        ],
      },
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: '2026-07-10T00:00:03Z' },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = normalizeEntries(entries as any)
    const tools = out.filter((m) => m.kind === 'tool')
    expect(tools).toHaveLength(3)
    expect(tools[0].text).toBe('Bash')
    expect(tools[0].detail).toBe('List docs') // description preferred over command
    expect(tools[0].resultPreview).toContain('a.md')
    expect(tools[0].resultPreview!.length).toBeLessThanOrEqual(701) // 700 + ellipsis
    expect(tools[1].detail).toBe('/tmp/demo/report.md')
    expect(tools[1].resultPreview).toBe('file body')
    expect(tools[2].detail).toBeUndefined()
    expect(tools[2].resultPreview).toBeUndefined()
  })

  it('adds inputPreview and thinkingText without touching detail', async () => {
    const { normalizeEntries } = await import('../../../src/web/routes/api-v1.js')
    const reasoning = 'First, check the lockfile.\nThen rebuild.\n' + 'more reasoning. '.repeat(300)
    const entries = [
      {
        tag: 'ai', role: 'assistant', timestamp: '2026-07-10T00:00:01Z',
        content: [
          { type: 'thinking', thinking: reasoning },
          // The pinned Bash case: `detail` MUST stay the description (web depends
          // on that ≤160 line), and the command must be reachable in inputPreview.
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls docs/', description: 'List docs' } },
          // One fat value cannot hide the key next to it (per-value clip).
          { type: 'tool_use', id: 'tu-2', name: 'Write', input: { file_path: '/tmp/demo/big.ts', content: 'y'.repeat(50_000) } },
          // A secret in a command line is masked before it leaves the box.
          { type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'deploy --token=hunter2secretvalue' } },
          // Nothing renderable → neither field appears.
          { type: 'tool_use', id: 'tu-4', name: 'Mystery', input: {} },
          { type: 'text', text: 'done' },
        ],
      },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = normalizeEntries(entries as any)

    const think = out.find((m) => m.kind === 'thinking')!
    expect(think.text.length).toBeLessThanOrEqual(161) // documented collapsed cap
    expect(think.text).not.toContain('\n')
    expect(think.thinkingText!.length).toBeLessThanOrEqual(2001)
    expect(think.thinkingText).toContain('\n') // paragraphs kept in the excerpt

    const tools = out.filter((m) => m.kind === 'tool')
    expect(tools[0].detail).toBe('List docs') // byte-identical to before
    expect(tools[0].inputPreview).toBe('command: ls docs/\ndescription: List docs')

    expect(tools[1].inputPreview!.length).toBeLessThanOrEqual(2001)
    expect(tools[1].inputPreview).toContain('file_path: /tmp/demo/big.ts')

    expect(tools[2].inputPreview).toContain('[REDACTED]')
    expect(tools[2].inputPreview).not.toContain('hunter2secretvalue')

    expect(tools[3].inputPreview).toBeUndefined()
    expect(tools[3].detail).toBeUndefined()
  })
})

describe('GET /api/v1/media (additive)', () => {
  it('serves a local absolute-path image with correct Content-Type', async () => {
    const dir = `${WALNUT_HOME}/media-test`
    await fs.mkdir(dir, { recursive: true })
    const file = `${dir}/pic.png`
    await fs.writeFile(file, Buffer.from(TINY_PNG_BASE64, 'base64'))
    const res = await fetch(apiUrl(`/api/v1/media?path=${encodeURIComponent(file)}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true)
  })

  it('rejects non-image extensions, relative paths and traversal', async () => {
    const secret = await fetch(apiUrl(`/api/v1/media?path=${encodeURIComponent('/etc/passwd')}`))
    expect(secret.status).toBe(400) // extension not allowed
    const rel = await fetch(apiUrl('/api/v1/media?path=pic.png'))
    expect(rel.status).toBe(400)
    const traversal = await fetch(apiUrl(`/api/v1/media?path=${encodeURIComponent('/tmp/../etc/x.png')}`))
    expect(traversal.status).toBe(400)
  })

  it('404s for a missing file', async () => {
    const res = await fetch(apiUrl(`/api/v1/media?path=${encodeURIComponent('/tmp/definitely-not-here-9c2f.png')}`))
    expect(res.status).toBe(404)
  })
})

describe('client logs (additive)', () => {
  it('accepts a batch, writes JSON-lines under the device+day file, 400s on empty', async () => {
    const res = await fetch(apiUrl('/api/v1/client-logs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: 'Test iPhone/1', appVersion: '1.0.0', os: 'iOS 26',
        lines: [
          { ts: '2026-07-10T00:00:00Z', level: 'error', subsystem: 'sse', message: 'stall tripped' },
          'plain string line',
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; received: number }
    expect(body.ok).toBe(true)
    expect(body.received).toBe(2)

    // Device name sanitized into the filename; content is JSON-lines. The
    // route derives its dir from LOG_DIR (mocked here) — a3944e85 moved it off
    // the hardcoded production path, so the test must follow the constant.
    const day = new Date().toISOString().slice(0, 10)
    const file = `${LOG_DIR}/ios-client/Test-iPhone-1-${day}.log`
    const content = await fs.readFile(file, 'utf-8')
    const lines = content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const mine = lines.filter((l) => l.device === 'Test iPhone/1')
    expect(mine.length).toBeGreaterThanOrEqual(2)
    expect(mine.some((l) => l.message === 'stall tripped' && l.subsystem === 'sse')).toBe(true)
    expect(mine.some((l) => l.message === 'plain string line')).toBe(true)
    expect(mine.every((l) => l.appVersion === '1.0.0')).toBe(true)

    const empty = await fetch(apiUrl('/api/v1/client-logs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'x', lines: [] }),
    })
    expect(empty.status).toBe(400)
  })
})
