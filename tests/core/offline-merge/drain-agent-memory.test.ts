/**
 * A MEMORY.md write a host saved while this Mac was away (a task-fields record of op
 * `agent_memory_write`, offline-host-core.ts) meets the Mac at wake (offline-merge/apply-agent-memory.ts),
 * through the real drain (offline-handover.ts) and the real task store of a temp home:
 *   - an append lands after what the file holds then: what the owner wrote meanwhile is kept;
 *   - a replace lands only over the text it was made on; any other is a conflict, the Mac's file kept;
 *   - the writer is recorded as online (another task's session as that task, its own session unstamped);
 *   - a complete task, a result past the limit and a deleted task are refusals the log keeps;
 *   - a redrain writes nothing twice, and one call is one entry whichever reaches the Mac first:
 *     its drained record or its retry through the Mac's route (the op-id middleware's ledger).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-agent-memory'))
const sessions = vi.hoisted(() => new Map<string, string>())
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/session-tracker.js')>()
  return {
    ...orig,
    getSessionByClaudeId: async (sid: string) => sessions.has(sid) ? { claudeSessionId: sid, taskId: sessions.get(sid) } as never : orig.getSessionByClaudeId(sid),
  }
})

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { agentMemoryHash } from '../../../src/core/offline-merge/apply-agent-memory.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { opIdMiddleware, stampArrival, OP_ID_HEADER } from '../../../src/web/middleware/op-id.js'
import { agentMemoryV1Router } from '../../../src/web/routes/agent-memory-v1.js'
import { writeOpId } from '../../../src/lib/op-call-id.js'

const RUN_SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OWN_SID = 'bbbbbbbb-2222-4222-8222-222222222222'
let seqN = 100
let opN = 0
const op = (): string => `op-am-${(++opN).toString(16).padStart(12, '0')}`

function daemon(records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey: 'cloudbox', journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
          return { ok: true }
        }
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        return { ok: true }
      },
    },
  }
}

async function drain(records: Array<Record<string, unknown>>): Promise<void> {
  const d = daemon(records)
  // Each pass is awaited to its end (drain, apply, ack); a record a pass left (a retry) gets the next one.
  for (let i = 0; i < 6 && d.pending.length; i++) await runOfflineHandover(d.conn as never).catch(() => undefined)
  expect(d.pending).toEqual([])
}

function allEntries(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}

const memRec = (taskId: string, memory: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'agent-memory', opId: op(), rev: 1, actor: { kind: 'session', sid: RUN_SID },
  taskId, ...memory, ...over,
})

async function owner(memory?: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await addTask({ title: 'Platform', project: 'Platform', ...extra } as never)).task.id
  if (memory !== undefined) await updateTaskRaw(id, { agent_memory: { text: memory, at: '2026-11-12T00:00:00.000Z' } } as never)
  return id
}

beforeEach(async () => {
  _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1])
  sessions.clear()
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('the Mac drains agent-memory', () => {
  it('asks for the kind in its drains', () => {
    expect(APPLIED_V2_KINDS).toContain('agent-memory')
  })
})

describe('one call, one entry: the drain and a retry straight at the Mac share the op id (the real op-id middleware and route)', () => {
  const CALL = 'oc-ReTrYcAl_00000001'
  let server: Server | null = null
  let base = ''
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null })

  async function listen(): Promise<void> {
    const a = express()
    a.use(stampArrival())
    a.use(express.json())
    a.use('/api', opIdMiddleware())
    a.use('/api/v1', agentMemoryV1Router)
    server = a.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server!.once('listening', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  /** The same call as the Mac's op executor sends it: its first PUT to that route, under the call's op id. */
  const online = (id: string, content: string, opId: string) => fetch(`${base}/api/v1/tasks/${id}/agent-memory`, {
    method: 'PUT', headers: { 'content-type': 'application/json', [OP_ID_HEADER]: opId }, body: JSON.stringify({ content, mode: 'append' }),
  })

  it('the retry reached the Mac first: the drained record adds nothing', async () => {
    await listen()
    const id = await owner('- 2026-11-12: first line')
    const opId = writeOpId(CALL, 'PUT', `/tasks/${encodeURIComponent(id)}/agent-memory`, 0)
    const r = await online(id, 'once only', opId)
    expect(r.status).toBe(200)
    await drain([memRec(id, { mode: 'append', content: 'once only' }, { opId })])
    expect((await getTask(id)).agent_memory!.text.match(/once only/g)).toHaveLength(1)
  })

  it('the record drained first: the retry at the Mac answers the first write and adds nothing', async () => {
    await listen()
    const id = await owner('- 2026-11-12: first line')
    const opId = writeOpId('oc-ReTrYcAl_00000002', 'PUT', `/tasks/${encodeURIComponent(id)}/agent-memory`, 0)
    await drain([memRec(id, { mode: 'append', content: 'drained first' }, { opId })])
    expect((await getTask(id)).agent_memory!.text.match(/drained first/g)).toHaveLength(1)
    const r = await online(id, 'drained first', opId)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ duplicate: true, opId })
    expect((await getTask(id)).agent_memory!.text.match(/drained first/g)).toHaveLength(1)
  })

  it('another call with the same words is another entry', async () => {
    await listen()
    const id = await owner('- 2026-11-12: first line')
    await drain([memRec(id, { mode: 'append', content: 'same words' }, { opId: writeOpId('oc-ReTrYcAl_00000003', 'PUT', `/tasks/${id}/agent-memory`, 0) })])
    await online(id, 'same words', writeOpId('oc-ReTrYcAl_00000004', 'PUT', `/tasks/${id}/agent-memory`, 0))
    expect((await getTask(id)).agent_memory!.text.match(/same words/g)).toHaveLength(2)
  })
})

describe('an away MEMORY.md append at wake', () => {
  it('lands after what the file holds now, the owner\'s own write meanwhile kept, the run recorded as its writer', async () => {
    const id = await owner('- 2026-11-12: first line')
    const run = (await addTask({ title: 'Routine: Platform VP daily reflection', project: 'Routines' } as never)).task.id
    sessions.set(RUN_SID, run)
    const rec = memRec(id, { mode: 'append', content: 'reflection: CR 2 still waits \u4f60\u597d' })
    // The owner wrote its own line after the host saved the entry, before the Mac drained it.
    await updateTaskRaw(id, (cur) => ({ agent_memory: { text: `${cur.agent_memory!.text}\n- 2026-11-13: owner line`, at: new Date().toISOString() } }) as never)
    await drain([rec])
    const t = await getTask(id)
    expect(t.agent_memory!.text.split('\n')).toEqual([
      '- 2026-11-12: first line',
      '- 2026-11-13: owner line',
      `- ${new Date(rec.at).toISOString().slice(0, 10)}: reflection: CR 2 still waits \u4f60\u597d`,
    ])
    expect(t.agent_memory).toMatchObject({ by: `task:${run}`, by_name: expect.any(String) })
    expect(allEntries().filter((e) => e.taskId === id)).toEqual([])
  })

  it('a redrain of the same record writes nothing twice', async () => {
    const id = await owner('- 2026-11-12: first line')
    const rec = memRec(id, { mode: 'append', content: 'once' })
    await drain([rec])
    await drain([{ ...rec }])
    expect((await getTask(id)).agent_memory!.text.match(/once/g)).toHaveLength(1)
  })

  it('the task\'s own session writes unstamped (its earlier writer record kept, as online)', async () => {
    const id = await owner('- 2026-11-12: first line')
    sessions.set(OWN_SID, id)
    await drain([memRec(id, { mode: 'append', content: 'mine' }, { actor: { kind: 'session', sid: OWN_SID } })])
    const t = await getTask(id)
    expect(t.agent_memory!.text).toMatch(/mine$/)
    expect(t.agent_memory!.by).toBeUndefined()
  })

  it('a file with no memory yet gets the entry as its first line', async () => {
    const id = await owner()
    await drain([memRec(id, { mode: 'append', content: 'first ever' })])
    expect((await getTask(id)).agent_memory!.text).toMatch(/^- \d{4}-\d{2}-\d{2}: first ever$/)
  })
})

describe('an away MEMORY.md replace at wake', () => {
  it('over the very text it was made on: it lands', async () => {
    const id = await owner('old text')
    await drain([memRec(id, { mode: 'replace', content: 'new whole file', baseHash: agentMemoryHash('old text') })])
    expect((await getTask(id)).agent_memory!.text).toBe('new whole file')
  })

  it('over a text the Mac changed since, or with no base named: a conflict, the Mac\'s file kept, the replacement logged whole', async () => {
    const id = await owner('old text')
    await updateTaskRaw(id, { agent_memory: { text: 'old text\n- owner wrote more', at: new Date().toISOString() } } as never)
    await drain([
      memRec(id, { mode: 'replace', content: 'stale replace', baseHash: agentMemoryHash('old text') }),
      memRec(id, { mode: 'replace', content: 'blind replace' }),
    ])
    expect((await getTask(id)).agent_memory!.text).toBe('old text\n- owner wrote more')
    const entries = allEntries().filter((e) => e.taskId === id)
    expect(entries.map((e) => [e.kind, e.field, e.kept, e.replica])).toEqual([
      ['task-field', 'agent_memory', 'mac', 'stale replace'],
      ['task-field', 'agent_memory', 'mac', 'blind replace'],
    ])
    expect(entries[0].mac).toBe('old text\n- owner wrote more')
  })
})

describe('refusals the log keeps', () => {
  it('a complete task keeps its file; a result past the limit is not written at all; a deleted task is listed', async () => {
    const done = await owner('kept')
    await updateTask(done, { phase: 'COMPLETE' })
    expect((await getTask(done)).phase).toBe('COMPLETE')
    const full = await owner('x'.repeat(19_990))
    await drain([
      memRec(done, { mode: 'append', content: 'late' }),
      memRec(full, { mode: 'append', content: 'one entry too many' }),
      memRec('mgonezzz-0000', { mode: 'append', content: 'for nobody' }),
    ])
    expect((await getTask(done)).agent_memory!.text).toBe('kept')
    expect((await getTask(full)).agent_memory!.text).toBe('x'.repeat(19_990))
    const entries = allEntries()
    expect(entries.find((e) => e.taskId === done || (e.record as { taskId?: string } | undefined)?.taskId === done)?.kind).toBe('refused')
    expect(entries.find((e) => e.taskId === full || (e.record as { taskId?: string } | undefined)?.taskId === full)?.kind).toBe('refused')
    expect(entries.find((e) => e.taskId === 'mgonezzz-0000')).toMatchObject({ kind: 'task-deleted', field: 'agent_memory', replica: 'for nobody' })
  })
})
