/**
 * Stage 3a of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: a task write the companion takes while the Mac is away goes into its
 * journal v2 (core/companion-journal.ts), and the Mac drains it through
 * `POST /bridge/journal` (web/routes/bridge-journal.ts) with the real client
 * (cloud-ingest.ts postToCloudJournal: machine token, gzip).
 *
 * Pinned:
 *   - the door: only the Mac's machine credential passes; the three commands answer
 *     a host daemon's shapes; a bad call is refused, not thrown;
 *   - before the Mac ever drained (no `drains.json`), an away write is queued as
 *     before: a Mac that never drained the journal gets nothing in it;
 *   - after a drain named `task-fields`: an away field write is a journal record
 *     (base and value by field), not a queue file; a second one coalesces;
 *   - order per task: a task with a queued op keeps to the queue; a task with a
 *     record keeps to the journal, and an op the journal cannot take (an appended
 *     note) waits in the queue until the Mac acked the record, then flushes;
 *   - a copy round from the Mac does not undo a journaled write (the row is held);
 *   - slice 3b: a session metadata patch the Mac did not answer is a `session-meta`
 *     record by the same rules (its session's queued patches first; a patch queued
 *     behind its records waits for the ack);
 *   - the trigger asks the Mac (`server.journal.due`) only while records wait,
 *     unless asked to always;
 *   - the journal and the kinds the Mac drains survive a restart of the module.
 *
 * The relay to the Mac (v1-control-relay.ts callPrimaryControl) is the real one,
 * with no bridge connected, except where a case swaps in an answering Mac.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-journal-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

// The relay to the Mac: the real one unless a case answers for the Mac.
type Relay = typeof import('../../../src/web/routes/v1-control-relay.js')['callPrimaryControl']
let relayOverride: Relay | null = null
const relayCalls: Array<{ action: string; params: Record<string, unknown> | undefined }> = []
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => {
  const real = await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()
  return {
    ...real,
    callPrimaryControl: ((action, sid, params, timeoutMs) => {
      relayCalls.push({ action, params })
      return relayOverride ? relayOverride(action, sid, params, timeoutMs) : real.callPrimaryControl(action, sid, params, timeoutMs)
    }) as Relay,
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { syncTaskReplica } from '../../../src/core/replication/task-replica.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import {
  _resetCompanionJournalForTesting, companionJournalRecords, companionJournalTaskIds, macDrains, tellMacJournalDue,
} from '../../../src/core/companion-journal.js'
import { flushTaskQueue, listQueuedOps } from '../../../src/core/task-queue.js'
import { enqueueSessionPatch, flushControlQueue } from '../../../src/core/control-queue.js'
import { CONTROL_QUEUE_DIR } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok(), otherMachine: tok() }
const NOW = '2026-10-21T08:00:00.000Z'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const A = 'mjrn01-aaaa'
const B = 'mjrn02-bbbb'
function task(id: string, title: string): Task {
  return { id, title, status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW } as Task
}
let macRows: Task[] = [task(A, 'Acme alpha'), task(B, 'Acme beta')]
const round = () => syncTaskReplica({
  view: async () => ({ tasks: macRows, registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } }),
  post: postToCloudReplica,
})

async function call(p: string, init: RequestInit = {}, token = T.phone): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}
const door = (cmd: string, params: Record<string, unknown>, token = T.local) =>
  call('/bridge/journal', { method: 'POST', body: JSON.stringify({ cmd, params }) }, token)

async function waitFor<V>(fn: () => Promise<V | null | undefined | false> | V | null | undefined | false, what: string, ms = 10_000): Promise<V> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as V
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const queuedFor = async (id: string) => (await listQueuedOps()).filter((o) => (o.type === 'update' || o.type === 'create') && o.task.id === id)
const recordsFor = (id: string) => companionJournalRecords().filter((r) => r.taskId === id)
const patch = (id: string, body: Record<string, unknown>) => call(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
// Slice 3b: session metadata.
const S1 = 'sess-acme-one'
const S2 = 'sess-acme-two'
const patchSession = (sid: string, body: Record<string, unknown>) => call(`/api/v1/sessions/${sid}`, { method: 'PATCH', body: JSON.stringify(body) })
async function queuedPatches(sid: string): Promise<Array<{ opId: string; patch: Record<string, unknown> }>> {
  let names: string[] = []
  try { names = (await fs.readdir(CONTROL_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const n of names) {
    const op = JSON.parse(await fs.readFile(path.join(CONTROL_QUEUE_DIR, n), 'utf8'))
    if (op.sessionId === sid) out.push(op)
  }
  return out
}
const sessionRecords = (sid: string) => companionJournalRecords().filter((r) => r.kind === 'session-meta' && r.sid === sid)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.otherMachine), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  await round()
}, 60_000)

afterAll(async () => {
  relayOverride = null
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the door', () => {
  it('only the Mac\'s machine credential passes', async () => {
    expect((await door('offline.drain', { kinds: ['task-fields'] }, '')).status).toBe(401)
    expect((await door('offline.drain', { kinds: ['task-fields'] }, tok())).status).toBe(401)
    expect((await door('offline.drain', { kinds: ['task-fields'] }, T.phone)).status).toBe(403)
    expect((await door('offline.drain', { kinds: ['task-fields'] }, T.otherMachine)).status).toBe(403)
    // None of those taught the box a kind.
    expect(macDrains('task-fields')).toBe(false)
    await expect(fs.stat(path.join(WALNUT_HOME, 'cache', 'journal', 'drains.json'))).rejects.toThrow()
  })

  it('a bad call is refused with a code, never thrown', async () => {
    expect(await door('offline.nope', {})).toEqual({ status: 400, body: { ok: false, error: 'unknown command', code: 'bad_request' } })
    expect(await door('offline.ack', {})).toEqual({ status: 400, body: { ok: false, error: 'offline.ack: missing seqs', code: 'bad_request' } })
    const blob = await door('offline.blob', { sha: 'not-a-sha', offset: 0 })
    expect(blob.status).toBe(200)
    expect(blob.body).toMatchObject({ ok: false })
    expect(typeof blob.body.code).toBe('string')
  })
})

describe('the Mac away, before it ever drained the journal', () => {
  it('a field write is queued as before, not journaled', async () => {
    const r = await patch(A, { title: 'Acme alpha, edited away' })
    expect(r.status).toBe(200)
    const [op] = await waitFor(async () => { const q = await queuedFor(A); return q.length ? q : null }, 'the edit of A to be queued')
    expect(op).toMatchObject({ type: 'update', fields: { title: { base: 'Acme alpha', value: 'Acme alpha, edited away' } } })
    expect(companionJournalRecords()).toEqual([])
  })

  it('a session change is queued as before, not journaled', async () => {
    const r = await patchSession(S1, { title: 'Acme one, renamed away' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ queued: true, session: { title: 'Acme one, renamed away' } })
    expect((await queuedPatches(S1)).map((o) => o.patch)).toEqual([{ title: 'Acme one, renamed away' }])
    expect(sessionRecords(S1)).toEqual([])
  })
})

describe('the Mac drained once: away writes go into the journal', () => {
  it('a drain answers a daemon\'s shape and keeps the kinds the Mac named', async () => {
    const r = await postToCloudJournal('offline.drain', { home: '/Users/someone/.open-walnut', kinds: [...APPLIED_V2_KINDS] })
    expect(r).toMatchObject({ ok: true, records: [], more: false })
    expect(typeof r.now).toBe('number')
    expect(macDrains('task-fields')).toBe(true)
    const saved = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'cache', 'journal', 'drains.json'), 'utf8'))
    expect(saved.kinds).toEqual([...APPLIED_V2_KINDS].sort())
  })

  it('a field write of a task with nothing queued is a journal record, by field', async () => {
    const r = await patch(B, { title: 'Acme beta, edited away' })
    expect(r.status).toBe(200)
    const [rec] = await waitFor(() => { const x = recordsFor(B); return x.length ? x : null }, 'the edit of B in the journal')
    expect(rec).toMatchObject({ kind: 'task-fields', op: 'task_update', taskId: B, fields: { title: { base: 'Acme beta', value: 'Acme beta, edited away' } } })
    expect(typeof rec.opId).toBe('string')
    expect(rec.actor).toBeUndefined()
    expect(await queuedFor(B)).toEqual([])
  })

  it('a second write of the same task joins its record', async () => {
    expect((await patch(B, { priority: 'important' })).status).toBe(200)
    const recs = await waitFor(() => { const x = recordsFor(B); return x.some((r) => (r.fields as Record<string, unknown>).priority) ? x : null }, 'the second edit of B in the journal')
    expect(recs).toHaveLength(1)
    expect(recs[0].fields).toMatchObject({ title: { value: 'Acme beta, edited away' }, priority: { value: 'important' } })
    expect(await queuedFor(B)).toEqual([])
  })

  it('a task with a queued op keeps to the queue (the Mac applies its writes in order)', async () => {
    expect((await patch(A, { priority: 'important' })).status).toBe(200)
    await waitFor(async () => (await queuedFor(A)).length === 2, 'the second edit of A to be queued')
    expect(recordsFor(A)).toEqual([])
  })

  it('an appended note of a journaled task waits in the queue behind its record', async () => {
    const r = await call(`/api/v1/tasks/${B}/notes`, { method: 'POST', body: JSON.stringify({ content: 'Called the vendor' }) })
    expect(r.status).toBeLessThan(300)
    const [op] = await waitFor(async () => { const q = await queuedFor(B); return q.length ? q : null }, 'the note of B to be queued')
    expect(op).toMatchObject({ type: 'update', append: { note: expect.stringContaining('Called the vendor') } })
    expect(recordsFor(B)).toHaveLength(1)
  })

  it('a session change (slice 3b) is a session-meta record; a session with a queued patch keeps to the queue', async () => {
    const r = await patchSession(S2, { title: 'Acme two, renamed away', human_note: 'Ask about the invoice' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ queued: true, session: { title: 'Acme two, renamed away' } })
    expect(sessionRecords(S2).map((x) => x.patch)).toEqual([{ title: 'Acme two, renamed away', human_note: 'Ask about the invoice' }])
    expect(await queuedPatches(S2)).toEqual([])
    expect((await patchSession(S1, { human_note: 'Second note' })).status).toBe(200)
    expect((await queuedPatches(S1)).map((o) => o.patch)).toEqual([{ title: 'Acme one, renamed away' }, { human_note: 'Second note' }])
    expect(sessionRecords(S1)).toEqual([])
    // A second change of a journaled session joins the journal.
    expect((await patchSession(S2, { output_mode: 'compact' })).status).toBeLessThan(500)
  })

  it('a copy round from the Mac does not undo the journaled write', async () => {
    await round()
    const b = await call(`/api/tasks/${B}`)
    expect(b.body.task).toMatchObject({ title: 'Acme beta, edited away', priority: 'important' })
    expect([...companionJournalTaskIds()]).toEqual([B])
  })
})

describe('the trigger', () => {
  it('asks the Mac only while records wait (or when told to always); no bridge is no answer', async () => {
    relayCalls.length = 0
    expect(await tellMacJournalDue('test')).toBe(false)
    expect(relayCalls.map((c) => c.action)).toEqual(['server.journal.due'])
    expect(relayCalls[0].params).toEqual({ records: companionJournalRecords().length })
    expect(companionJournalRecords().length).toBeGreaterThan(1)
  })
})

describe('the Mac comes back', () => {
  it('the queue sends what it holds, except the op behind a record; the ack lets it go', async () => {
    const applied: string[] = []
    relayOverride = (async (action, _sid, params) => {
      if (action === 'server.tasks.apply') {
        const op = (params as { op: { opId: string; type: string; task?: { id: string } } }).op
        applied.push(`${op.task?.id}:${op.opId}`)
        return { ok: true, result: { applied: true, reason: 'updated' } }
      }
      return { ok: true, result: { started: true } }
    }) as Relay
    try {
      await flushTaskQueue()
      expect(applied.map((a) => a.split(':')[0])).toEqual([A, A])
      expect(await queuedFor(A)).toEqual([])
      expect(await queuedFor(B)).toHaveLength(1)

      // The session queue: S1's patches go, in order; a patch of S2 left behind its records waits.
      const sentPatches: Array<{ sid: string; patch: unknown }> = []
      const inner = relayOverride!
      relayOverride = (async (action, sid, params, t) => {
        if (action === 'patch') { sentPatches.push({ sid, patch: params }); return { ok: true, result: { session: {} } } }
        return inner(action, sid, params, t)
      }) as Relay
      await enqueueSessionPatch(S2, { title: 'Acme two, queued behind' })
      await flushControlQueue()
      expect(sentPatches).toEqual([
        { sid: S1, patch: { title: 'Acme one, renamed away' } },
        { sid: S1, patch: { human_note: 'Second note' } },
      ])
      expect(await queuedPatches(S1)).toEqual([])
      expect(await queuedPatches(S2)).toHaveLength(1)

      // The Mac drains the journal (the handover's two calls).
      const drained = await postToCloudJournal('offline.drain', { home: '/Users/someone/.open-walnut', kinds: [...APPLIED_V2_KINDS] })
      const kinds = drained.records.map((r: { kind: string; taskId?: string; sid?: string }) => `${r.kind}:${r.taskId ?? r.sid}`)
      expect(kinds).toEqual([`task-fields:${B}`, `session-meta:${S2}`, `session-meta:${S2}`])
      // A redrain before the ack hands the same records (frozen, as on a host).
      const seqs = drained.records.map((r: { seq: number }) => r.seq)
      const again = await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
      expect(again.records.map((r: { seq: number }) => r.seq)).toEqual(seqs)
      expect(await postToCloudJournal('offline.ack', { home: '/x', seqs, now: Date.now() })).toMatchObject({ ok: true, remaining: 0 })
      expect(companionJournalRecords()).toEqual([])
      await waitFor(async () => (await queuedPatches(S2)).length === 0, 'the patch of S2 to leave the queue')
      expect(sentPatches.at(-1)).toEqual({ sid: S2, patch: { title: 'Acme two, queued behind' } })

      // The note held behind it goes now.
      await waitFor(async () => (await queuedFor(B)).length === 0, 'the note of B to leave the queue')
      expect(applied.filter((a) => a.startsWith(`${B}:`))).toHaveLength(1)
    } finally {
      relayOverride = null
    }
  })

  it('with nothing waiting the trigger does not ask, unless told to always', async () => {
    relayCalls.length = 0
    relayOverride = (async () => ({ ok: true, result: { started: true } })) as Relay
    try {
      expect(await tellMacJournalDue('sweep')).toBe(false)
      expect(relayCalls).toEqual([])
      expect(await tellMacJournalDue('bridge-connected', true)).toBe(true)
      expect(relayCalls.map((c) => c.action)).toEqual(['server.journal.due'])
    } finally {
      relayOverride = null
    }
  })
})

describe('a restart', () => {
  it('the journal and the kinds the Mac drains are read back from disk', async () => {
    expect((await patch(B, { title: 'Acme beta, edited again' })).status).toBe(200)
    await waitFor(() => recordsFor(B).length === 1, 'the third edit of B in the journal')
    _resetCompanionJournalForTesting()
    expect(macDrains('task-fields')).toBe(true)
    expect(recordsFor(B)).toHaveLength(1)
    expect(recordsFor(B)[0].fields).toMatchObject({ title: { base: 'Acme beta, edited away', value: 'Acme beta, edited again' } })
  })
})
