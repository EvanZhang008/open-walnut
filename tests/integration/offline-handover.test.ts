/**
 * The server half of the offline host (docs/plan/daemon-first-hosts.md) against
 * a REAL server (startServer({ port: 0, dev: true }) over a temp home):
 *   1. buildHostSlice: a host's copy lists this Walnut's sessions there, their
 *      tasks with parents and children, and only the pending requests whose two
 *      parties both run there;
 *   2. runOfflineHandover: request rows are imported, settles applied, queued
 *      writes replayed through the op registry (a second write for the same task
 *      is not lost to the first one's own timestamp), a write the task outlived is
 *      skipped, a peer message into a COMPLETE task reopens it, and the journal is
 *      acked up to the last record.
 * The daemon side is a recorder standing in for the drain/ack RPCs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

const prevDisableSearch = process.env.WALNUT_DISABLE_SEARCH
process.env.WALNUT_DISABLE_SEARCH = '1'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-offline-handover'))
// The unapplied-write notice is a real delivery; record it instead of letting it
// resume a CLI in the test home.
const delivered = vi.hoisted(() => [] as Array<{ sid: string; text: string }>)
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: async (target: { claudeSessionId: string }, opts: { enqueueText: string }) => {
    delivered.push({ sid: target.claudeSessionId, text: opts.enqueueText })
    return { delivery: 'queued' as const }
  },
}))

import { startServer, stopServer } from '../../src/web/server.js'
import { closeDb } from '../../src/core/task-db.js'
import { buildHostSlice } from '../../src/core/host-slice.js'
import { runOfflineHandover, waitForOfflineHandovers } from '../../src/core/offline-handover.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { createSessionRequest, getSessionRequest } from '../../src/core/session-requests.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'
import { WALNUT_HOME } from '../../src/constants.js'

let server: HttpServer
let port = 0
const root = (): string => `http://127.0.0.1:${port}`

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${root()}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  expect(res.ok, `${method} ${path} → ${res.status} ${await res.clone().text()}`).toBe(true)
  return res.json() as Promise<Record<string, unknown>>
}

async function newTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const body = await api('POST', '/api/tasks', { title, project: 'Acme', source: 'local', ...extra })
  return (body.task as { id: string }).id
}

async function task(id: string): Promise<Record<string, unknown>> {
  return (await api('GET', `/api/tasks/${id}`)).task as Record<string, unknown>
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const X = 'cccccccc-3333-4333-8333-333333333333'
const L = 'dddddddd-4444-4444-8444-444444444444'

let parent = ''
let child = ''
let grandchild = ''
let elsewhere = ''
let localTask = ''

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  parent = await newTask('Parent work')
  child = await newTask('Child: build the page', { parent_task_id: parent })
  grandchild = await newTask('Grandchild: write the tests', { parent_task_id: child })
  elsewhere = await newTask('Work on another box')
  localTask = await newTask('Work on this Mac')
  await createSessionRecord(A, parent, 'Acme', '/work', { host: 'devbox', title: 'Parent work' })
  await createSessionRecord(B, child, 'Acme', '/work', { host: 'devbox', title: 'Child: build the page' })
  await createSessionRecord(X, elsewhere, 'Acme', '/work', { host: 'otherbox', title: 'Work on another box' })
  await createSessionRecord(L, localTask, 'Acme', '/work', { title: 'Work on this Mac' })
}, 60_000)

afterAll(async () => {
  await stopServer().catch(() => {})
  closeDb()
  if (prevDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = prevDisableSearch
})

describe('buildHostSlice', () => {
  it('holds this host\'s sessions, their tasks with parents and children, and same-host requests only', async () => {
    const sameHost = await createSessionRequest({ fromSessionId: A, toSessionId: B, toTaskId: child, text: 'status?' })
    const crossHost = await createSessionRequest({ fromSessionId: A, toSessionId: X, toTaskId: elsewhere, text: 'and you?' })
    const slice = await buildHostSlice('devbox')
    expect(slice.home).toBe(WALNUT_HOME)
    expect(slice.host).toBe('devbox')
    expect(slice.sessions.map((s) => s.sid).sort()).toEqual([A, B])
    expect(slice.sessions.find((s) => s.sid === B)).toMatchObject({ taskId: child, title: 'Child: build the page' })
    const ids = slice.tasks.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining([parent, child, grandchild]))
    expect(ids).not.toContain(elsewhere)
    expect(slice.tasks.find((t) => t.id === child)).toMatchObject({ parent_task_id: parent, project: 'Acme' })
    expect(slice.requests.map((r) => r.id)).toEqual([sameHost.id])
    expect(slice.requests.map((r) => r.id)).not.toContain(crossHost.id)

    const local = await buildHostSlice('__local__')
    expect(local.host).toBe('local')
    expect(local.sessions.map((s) => s.sid)).toEqual([L])
    // Same content, same hash: an unchanged copy is never re-sent.
    expect((await buildHostSlice('devbox')).hash).toBe(slice.hash)
  })
})

describe('runOfflineHandover', () => {
  it('imports rows, applies settles, replays writes, skips an outlived write, reopens on a peer message, and acks', async () => {
    const serverRow = await createSessionRequest({ fromSessionId: A, toSessionId: B, toTaskId: child, text: 'server asked this' })
    const now = Date.now()
    const leafBefore = await task(grandchild)
    const blocked = await newTask('Parent with open work')
    await newTask('Still open', { parent_task_id: blocked })
    const blockedBefore = await task(blocked)
    const done = await newTask('Already finished')
    await api('POST', `/api/v1/tasks/${done}/complete`)
    expect((await task(done)).phase).toBe('COMPLETE')
    // The parent changes AFTER the host queued its write for it.
    const staleAt = now - 60_000
    await api('PUT', `/api/tasks/${parent}/description`, { content: 'edited on the phone meanwhile' })

    const records: OfflineRecord[] = [
      { seq: 1, at: now, kind: 'row', row: {
        id: 'rq-0000000000aa', fromSessionId: A, toSessionId: B, toTaskId: child, preview: 'offline ask',
        status: 'replied', createdAt: new Date(now).toISOString(), deadlineAt: now + 3_600_000, settledAt: new Date(now).toISOString(),
      } },
      { seq: 2, at: now, kind: 'settle', requestId: serverRow.id, status: 'replied' },
      { seq: 3, at: now, kind: 'op', op: 'task_update', args: { id: grandchild, title: 'Grandchild: tests written' }, callerSid: B, base: String(leafBefore.updated_at) },
      { seq: 4, at: now + 1, kind: 'op', op: 'task_complete', args: { id: grandchild }, callerSid: B, base: String(leafBefore.updated_at) },
      { seq: 5, at: staleAt, kind: 'op', op: 'task_update', args: { id: parent, description: 'stale offline edit' }, callerSid: A, base: new Date(staleAt - 1000).toISOString() },
      { seq: 6, at: now, kind: 'delivery', fromSessionId: A, toSessionId: B, toTaskId: done, messageId: 'qm-offline-1' },
      { seq: 7, at: Date.now(), kind: 'op', op: 'task_complete', args: { id: blocked }, callerSid: B, base: String(blockedBefore.updated_at) },
    ]
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
    let drained = false
    const result = await runOfflineHandover({
      hostKey: 'devbox',
      send: async (cmd, params = {}) => {
        calls.push({ cmd, params })
        if (cmd === 'offline.drain') {
          if (drained) return { ok: true, records: [] }
          drained = true
          return { ok: true, records, more: false }
        }
        return { ok: true, remaining: 0 }
      },
    })

    expect(result).toMatchObject({ records: 7, imported: 1, settled: 1, replayed: 2, skipped: 1, failed: 1 })
    expect(calls.filter((c) => c.cmd === 'offline.ack').map((c) => c.params)).toEqual([{ home: WALNUT_HOME, upTo: 7 }])
    expect(calls.every((c) => c.cmd === 'offline.ack' || c.params.home === WALNUT_HOME)).toBe(true)

    expect(await getSessionRequest('rq-0000000000aa')).toMatchObject({ status: 'replied', fromSessionId: A })
    expect(await getSessionRequest(serverRow.id)).toMatchObject({ status: 'replied' })
    expect(await task(grandchild)).toMatchObject({ title: 'Grandchild: tests written', phase: 'COMPLETE' })
    expect((await task(parent)).description).toBe('edited on the phone meanwhile')
    expect((await task(done)).phase).toBe('IN_PROGRESS')
    expect((await task(blocked)).phase).not.toBe('COMPLETE')
    // Each session that was told "saved" hears which of its changes did not land.
    const bySid = new Map(delivered.map((d) => [d.sid, d.text]))
    expect(bySid.get(A)).toContain(`task_update ${parent}: the task changed after this change was queued`)
    expect(bySid.get(B)).toContain(`task_complete ${blocked}: `)
    expect(bySid.get(B)).toContain('child task(s) are still active')
    expect(bySid.get(B)).toMatch(/^<walnut-message kind="notification" from="Walnut"/)
  })

  it('a row this server already settled is never reopened by an import', async () => {
    const row = await createSessionRequest({ fromSessionId: A, toSessionId: B, toTaskId: child, text: 'q' })
    const { settleNotified } = await import('../../src/core/session-requests.js')
    await settleNotified(row.id, 'completed')
    const r = await runOfflineHandover({
      hostKey: 'devbox',
      send: (() => {
        let n = 0
        return async (cmd: string) => cmd === 'offline.drain' && n++ === 0
          ? { ok: true, records: [{ seq: 1, at: Date.now(), kind: 'row', row: { ...row, toSessionId: B, status: 'pending' } }] }
          : { ok: true, records: [] }
      })(),
    })
    expect(r.imported).toBe(0)
    expect(await getSessionRequest(row.id)).toMatchObject({ status: 'notified' })
  })

  it('a notice waits for a running handover, and never longer than its bound', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const job = runOfflineHandover({
      hostKey: 'slowbox',
      send: async (cmd) => { if (cmd === 'offline.drain') await gate; return { ok: true, records: [] } },
    })
    let waited = false
    const waiting = waitForOfflineHandovers(5_000).then(() => { waited = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(waited).toBe(false)
    release()
    await waiting
    await job
    expect(waited).toBe(true)
    const start = Date.now()
    const stuck = runOfflineHandover({ hostKey: 'stuckbox', send: () => new Promise(() => {}) })
    await waitForOfflineHandovers(200)
    expect(Date.now() - start).toBeLessThan(2_000)
    void stuck
  })
})
