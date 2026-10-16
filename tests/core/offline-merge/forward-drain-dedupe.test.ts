/**
 * A forwarded write and its journaled retry apply once (docs/plan/walnut-replica-servers-impl.md
 * section 3, "Op ids"), end to end: a real HTTP server with the op-id middleware, a handler
 * that creates the task the replica minted, and then a drain of the host journal holding
 * the retry of the same user action (same op id). The forward answered too late, the
 * client retried, the replica journaled the retry: without one key for both, the drain
 * finds the id taken by a task with no op and re-mints a duplicate.
 *   - a socket tagged the way the forward lane tags it (`tagForwardedSocket(socket,
 *     conn.hostKey)`, exactly the daemon connection's hostKey): one task;
 *   - a socket nobody tagged (recorded under LOCAL_HOST): still one task.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-forward-drain-dedupe'))
const inbox = vi.hoisted(() => ({ letters: [] as Array<{ subject: string; markdown: string }> }))
vi.mock('../../../src/core/human-inbox/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/human-inbox/store.js')>()),
  sendLetter: vi.fn(async (l: { subject: string; markdown: string }) => { inbox.letters.push(l); return { id: `letter-${inbox.letters.length}` } }),
}))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, listTasks } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { opIdMiddleware, stampArrival, tagForwardedSocket, OP_ID_HEADER } from '../../../src/web/middleware/op-id.js'
import { recordApplied } from '../../../src/core/offline-merge/ledger.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SID = 'cdcdcdcd-7777-4777-8777-777777777777'
let server: Server | null = null
let base = ''
let n = 0

/** The Mac's create route as a forward reaches it; `tag`: the forward lane's socket tag. */
async function listen(tag: string | null): Promise<void> {
  const a = express()
  a.use(stampArrival())
  a.use(express.json())
  a.use('/api', opIdMiddleware())
  // Like the real create routes: the Mac mints its own id (no route takes the replica's),
  // and answers `{ task: { id } }`.
  a.post('/api/tasks', async (req, res) => {
    const { task } = await addTask({ title: String(req.body.title), project: 'Acme' } as never)
    res.status(201).json({ task: { id: task.id } })
  })
  server = a.listen(0, '127.0.0.1')
  if (tag) server.on('connection', (s) => tagForwardedSocket(s, tag))
  await new Promise<void>((r) => server!.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function hostJournal(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        return { ok: true }
      },
    },
  }
}

async function forwardThenDrain(tag: string | null): Promise<{ title: string; matches: number; pending: number; macId: string; renamed: string; letters: number }> {
  await listen(tag)
  const k = ++n
  const id = `mint${Date.now().toString(36)}${k.toString(16).padStart(8, '0')}`
  const opId = `op-fdd-${k.toString(16).padStart(10, '0')}`
  const title = `Filed while the answer was lost ${k}`
  const res = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', [OP_ID_HEADER]: opId }, body: JSON.stringify({ id, title }) })
  expect(res.status).toBe(201)
  const macId = ((await res.json()) as { task: { id: string } }).task.id
  expect(macId).not.toBe(id)
  // The client got the replica's journaled answer (the minted id) and renamed the task away.
  const record = { v: 2, seq: 10 + 2 * k, at: Date.now(), kind: 'task-create', opId, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_create', taskId: id, fields: { title, project: 'Acme' } }
  const rename = { v: 2, seq: 11 + 2 * k, at: Date.now(), kind: 'task-fields', opId: `${opId}-r`, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId: id, fields: { title: { base: title, value: `${title} renamed away` } } }
  const j = hostJournal('marina', [record, rename])
  const before = inbox.letters.length
  await runOfflineHandover(j.conn as never)
  const matches = (await listTasks({})).filter((t) => t.title.startsWith(title)).length
  return { title, matches, pending: j.pending.length, macId, renamed: (await getTask(macId)).title, letters: inbox.letters.length - before }
}

beforeEach(() => { _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1]) })
afterEach(async () => {
  const s = server
  server = null
  if (s) { s.closeAllConnections?.(); await new Promise<void>((r) => s.close(() => r())) }
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a forward and its journaled retry apply once', () => {
  it('through a socket tagged with the daemon connection\'s hostKey: one task, the record acked', async () => {
    const r = await forwardThenDrain('marina')
    expect(r).toMatchObject({ matches: 1, pending: 0, letters: 0 })
    // The later away edit names the minted id and lands on the task the Mac made.
    expect(r.renamed).toBe(`${r.title} renamed away`)
  })

  it('through a socket nobody tagged (recorded under the local host): still one task', async () => {
    const r = await forwardThenDrain(null)
    expect(r).toMatchObject({ matches: 1, pending: 0, letters: 0 })
    expect(r.renamed).toBe(`${r.title} renamed away`)
  })

  it('a create the Mac applied whose answer was not kept (too large) is lettered, never acked in silence', async () => {
    const opId = 'op-fdd-nobody-0001'
    recordApplied({ hostKey: 'marina', home: WALNUT_HOME, opId, rev: 1 }, { outcome: 'applied', status: 201, source: 'http', route: 'POST /api/tasks' })
    const record = { v: 2, seq: 500, at: Date.now(), kind: 'task-create', opId, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_create', taskId: 'mintnobody00000001', fields: { title: 'Answer not kept', project: 'Acme' } }
    const j = hostJournal('marina', [record])
    const before = inbox.letters.length
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(inbox.letters.length - before).toBe(1)
    expect(inbox.letters.at(-1)!.markdown).toContain('mintnobody00000001')
    expect((await listTasks({})).filter((t) => t.title === 'Answer not kept')).toHaveLength(0)
  })
})
