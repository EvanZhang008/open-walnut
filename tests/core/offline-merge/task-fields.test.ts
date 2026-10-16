/**
 * The Mac's per-field merge of a queued task write (docs/plan/walnut-replica-servers-impl.md
 * section 7), first as the pure rule table, then applied by the real drain
 * (runOfflineHandover over a journal-v2 connection) into the real task store of a
 * temp home: one patch per record, delete wins, parent links validated, creates
 * replayed once, a taken id re-minted with later records following it, moves by
 * anchor, an unpaired device dropped and lettered.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-fields'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { resolveTaskFields, UNKNOWN_BASE, type MacTask } from '../../../src/core/offline-merge/task-fields.js'
import { mergeText } from '../../../src/core/offline-merge/text-merge.js'

const T0 = Date.parse('2026-10-10T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function mac(over: Partial<MacTask> = {}, fieldAt: Record<string, number> = {}): MacTask {
  const field_at: Record<string, string> = {}
  for (const [k, v] of Object.entries(fieldAt)) field_at[k] = iso(v)
  return { id: 't1', title: 'Base', priority: 'none', project: 'Acme', group_id: '', description: 'a\nb\nc\n', updated_at: iso(T0), created_at: iso(T0 - 1000), field_at, ...over }
}

describe('section 7 rule table (pure)', () => {
  it('Mac value == value: nothing (a second drain changes nothing)', () => {
    const r = resolveTaskFields({ mac: mac({ title: 'New' }), fields: { title: { base: 'Base', value: 'New' } }, at: T0 + 10 })
    expect(r.patch).toEqual({})
    expect(r.conflicts).toEqual([])
  })

  it('Mac value == base: the replica value is taken, stamped at the record time (even when the Mac stamp is later)', () => {
    const r = resolveTaskFields({ mac: mac({}, { title: T0 }), fields: { title: { base: 'Base', value: 'Away' } }, at: T0 + 10 })
    expect(r.patch).toEqual({ title: 'Away' })
    expect(r.fieldTimes.title).toBe(T0 + 10)
    expect(r.conflicts).toEqual([])
    // The Mac set it back to the base later: still "unchanged", and the write keeps its own time.
    const back = resolveTaskFields({ mac: mac({}, { title: T0 + 99 }), fields: { title: { base: 'Base', value: 'Away' } }, at: T0 + 10 })
    expect(back.fieldTimes.title).toBe(T0 + 10)
  })

  it('scalar both changed: the newer by time wins, both listed (replica newer)', () => {
    const r = resolveTaskFields({ mac: mac({ priority: 'immediate' }, { priority: T0 + 5 }), fields: { priority: { base: 'none', value: 'backlog' } }, at: T0 + 10 })
    expect(r.patch).toEqual({ priority: 'backlog' })
    expect(r.conflicts).toMatchObject([{ field: 'priority', mac: 'immediate', replica: 'backlog', kept: 'replica', why: 'both-changed' }])
  })

  it('scalar both changed: the Mac newer keeps its value, listed', () => {
    const r = resolveTaskFields({ mac: mac({ priority: 'immediate' }, { priority: T0 + 50 }), fields: { priority: { base: 'none', value: 'backlog' } }, at: T0 + 10 })
    expect(r.patch).toEqual({})
    expect(r.conflicts).toMatchObject([{ field: 'priority', kept: 'mac', macAt: T0 + 50, replicaAt: T0 + 10 }])
  })

  it('field_at falls back to updated_at when the field was never stamped', () => {
    const r = resolveTaskFields({ mac: mac({ priority: 'immediate', updated_at: iso(T0 + 100) }), fields: { priority: { base: 'none', value: 'backlog' } }, at: T0 + 10 })
    expect(r.patch).toEqual({})
    expect(r.conflicts[0]).toMatchObject({ kept: 'mac', macAt: T0 + 100 })
  })

  it("base 'unknown': the replica value only when field_at(Mac) < shifted at; listed only when the Mac's is kept; never a merge3", () => {
    const newer = resolveTaskFields({ mac: mac({ description: 'mac text' }, { description: T0 }), fields: { description: { base: UNKNOWN_BASE, value: 'away text' } }, at: T0 + 10 })
    expect(newer.patch).toEqual({ description: 'away text' })
    expect(newer.conflicts).toEqual([])
    const older = resolveTaskFields({ mac: mac({ description: 'mac text' }, { description: T0 + 20 }), fields: { description: { base: UNKNOWN_BASE, value: 'away text' } }, at: T0 + 10 })
    expect(older.patch).toEqual({})
    expect(older.conflicts).toMatchObject([{ kept: 'mac', why: 'base-unknown' }])
  })

  it('text both changed in different lines: merge3 applies cleanly with every line either side added', () => {
    const r = resolveTaskFields({
      mac: mac({ description: 'a\nMAC\nb\nc\n' }, { description: T0 + 50 }),
      fields: { description: { base: 'a\nb\nc\n', value: 'a\nb\nc\nAWAY\n' } }, at: T0 + 10,
    })
    expect(r.patch).toEqual({ description: 'a\nMAC\nb\nc\nAWAY\n' })
    expect(r.conflicts).toEqual([])
    expect(r.fieldTimes.description).toBe(T0 + 50)
  })

  it('text conflicting in one line: the newer side wins and the other is listed in full', () => {
    const r = resolveTaskFields({
      mac: mac({ description: 'a\nMAC\nc\n' }, { description: T0 + 5 }),
      fields: { description: { base: 'a\nb\nc\n', value: 'a\nAWAY\nc\n' } }, at: T0 + 10,
    })
    expect(r.patch).toEqual({ description: 'a\nAWAY\nc\n' })
    expect(r.conflicts).toMatchObject([{ field: 'description', why: 'text-conflict', kept: 'replica', mac: 'a\nMAC\nc\n', replica: 'a\nAWAY\nc\n', base: 'a\nb\nc\n' }])
  })

  it('(project, group_id) is one compound field; an invalid pair keeps the Mac pair and is listed', () => {
    const pairValid = (p: string, g: string): boolean => !g || (g === 'g_marina' && p === 'Marina')
    const ok = resolveTaskFields({ mac: mac(), fields: { project: { base: 'Acme', value: 'Marina' }, group_id: { base: '', value: 'g_marina' } }, at: T0 + 10, pairValid })
    expect(ok.patch).toEqual({ project: 'Marina', group_id: 'g_marina' })
    const bad = resolveTaskFields({ mac: mac(), fields: { group_id: { base: '', value: 'g_marina' } }, at: T0 + 10, pairValid })
    expect(bad.patch).toEqual({})
    expect(bad.conflicts).toMatchObject([{ field: 'project+group_id', why: 'invalid-pair', kept: 'mac', mac: { project: 'Acme', group_id: '' }, replica: { project: 'Acme', group_id: 'g_marina' } }])
  })

  it('a project-only move drops a folder that does not belong to the new project', () => {
    const pairValid = (p: string, g: string): boolean => !g || (g === 'g_acme' && p === 'Acme')
    const r = resolveTaskFields({ mac: mac({ group_id: 'g_acme' }), fields: { project: { base: 'Acme', value: 'Marina' } }, at: T0 + 10, pairValid })
    expect(r.patch).toEqual({ project: 'Marina', group_id: '' })
  })
})

describe('mergeText', () => {
  it('is deterministic and keeps CRLF and the missing final newline', () => {
    expect(mergeText('a\r\nb\r\nc', 'X\r\nb\r\nc', 'a\r\nb\r\nY')).toEqual({ clean: true, text: 'X\r\nb\r\nY' })
  })
  it('two equal edits of the same line merge cleanly', () => {
    expect(mergeText('a\nb\n', 'a\nZ\n', 'a\nZ\n')).toEqual({ clean: true, text: 'a\nZ\n' })
  })
  it('two different insertions at one point conflict', () => {
    expect(mergeText('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n')).toMatchObject({ clean: false, conflicts: 1 })
  })
})

// -- Applied by the real drain into the real task store --

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, deleteTask, createFolder, getProjectRecord, togglePin, listTasks } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { _setLedgerFileForTesting } from '../../../src/core/offline-merge/ledger.js'
import fs from 'node:fs'
import { WALNUT_HOME } from '../../../src/constants.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'

const SID = 'cccccccc-3333-4333-8333-333333333333'
let seq = 0
let opN = 0
const nextOp = (): string => `op-${(++opN).toString(16).padStart(16, '0')}`

type Rec = Record<string, unknown> & { seq: number; at: number; kind: string }
function fieldsRec(taskId: string, fields: Record<string, { base: unknown; value: unknown }>, over: Partial<Rec> = {}): Rec {
  return { v: 2, seq: ++seq, at: Date.now(), kind: 'task-fields', opId: nextOp(), rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields, ...over }
}

/** One drain of `records` from host `host` over a journal-v2 connection; the host clock equals ours. */
async function drain(records: Rec[], host = 'marina'): Promise<{ result: Awaited<ReturnType<typeof runOfflineHandover>>; acked: number[]; drainIds: string[] }> {
  const acked: number[] = []
  let handed = false
  const before = new Set(logFiles())
  const result = await runOfflineHandover({
    hostKey: host,
    journalV2: true,
    send: async (cmd, params) => {
      if (cmd === 'offline.ack') { acked.push(...((params?.seqs as number[]) ?? [])); return { ok: true, remaining: 0 } }
      if (cmd === 'offline.drain') {
        if (handed) return { ok: true, records: [], more: false, now: Date.now() }
        handed = true
        return { ok: true, records, more: false, now: Date.now() }
      }
      return { ok: true }
    },
  })
  const drainIds = logFiles().filter((f) => !before.has(f)).map((f) => f.replace(/\.json$/, ''))
  return { result, acked, drainIds }
}

function logFiles(): string[] {
  try { return fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
}

function entriesOf(drainIds: string[]): ConflictEntry[] {
  return drainIds.flatMap((id) => readConflictLog(id)?.entries ?? [])
}

async function newTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await addTask({ title, project: 'Acme', ...extra } as Parameters<typeof addTask>[0])).task.id
}

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _setHandoverBackoffForTesting([])
  _resetHostClocksForTesting()
})

afterAll(() => {
  _setHandoverBackoffForTesting(null)
  _setLedgerFileForTesting(null)
  closeDb()
})

describe('the drain applies task-fields', () => {
  it('one patch per record, field_at stamped with the record time; a second drain changes nothing and sends no letter', async () => {
    const id = await newTask('Before')
    const at = Date.now() + 5_000
    const rec = fieldsRec(id, { title: { base: 'Before', value: 'After' }, priority: { base: 'none', value: 'immediate' } }, { at })
    const first = await drain([rec])
    expect(first.acked).toEqual([rec.seq])
    const t = await getTask(id)
    expect(t).toMatchObject({ title: 'After', priority: 'immediate' })
    expect(t.field_at?.title).toBe(new Date(at).toISOString())
    expect(t.field_at?.priority).toBe(new Date(at).toISOString())
    expect(first.drainIds).toEqual([])
    const again = await drain([{ ...rec, seq: ++seq, opId: nextOp() }])
    expect(again.result.replayed).toBe(0)
    expect(again.drainIds).toEqual([])
    expect((await getTask(id)).updated_at).toBe(t.updated_at)
  })

  it('a record replayed after a crash between its row write and its ledger row is a no-op (the merge is kept on the task)', async () => {
    const id = await newTask('Merge once', { description: 'same\nsame\nend\n' })
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js')
    await updateTaskRaw(id, { description: 'same\nsame\nMAC\nend\n' })
    const rec = fieldsRec(id, { description: { base: 'same\nsame\nend\n', value: 'same\nAWAY\nsame\nend\n' } })
    await drain([rec])
    const merged = await getTask(id)
    expect(merged.applied_ops).toContain(`marina|${rec.opId}|1`)
    _setLedgerFileForTesting(`${WALNUT_HOME}/cache/ledger-crash-${Date.now()}.sqlite`)
    const again = await drain([{ ...rec, seq: ++seq }])
    expect(again.result.replayed).toBe(0)
    expect((await getTask(id)).description).toBe(merged.description)
    _setLedgerFileForTesting(null)
  })

  it('a field edit made on the Mac stamps field_at, so a replica write made before it loses and is lettered', async () => {
    const id = await newTask('Shared')
    const queuedAt = Date.now() - 60_000
    await new Promise((r) => setTimeout(r, 5))
    const { updateTask } = await import('../../../src/core/task-manager.js')
    await updateTask(id, { priority: 'backlog' })
    const stampedAt = Date.parse((await getTask(id)).field_at?.priority ?? '')
    expect(stampedAt).toBeGreaterThan(queuedAt)
    const out = await drain([fieldsRec(id, { priority: { base: 'none', value: 'immediate' } }, { at: queuedAt })])
    expect((await getTask(id)).priority).toBe('backlog')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'task-field', taskId: id, field: 'priority', kept: 'mac', mac: 'backlog', replica: 'immediate' }])
  })

  it('delete wins: a write for a task deleted on the Mac is dropped and listed in one letter', async () => {
    const id = await newTask('Doomed')
    await deleteTask(id)
    const out = await drain([fieldsRec(id, { title: { base: 'Doomed', value: 'Saved?' } })])
    expect(out.acked).toHaveLength(1)
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'task-deleted', taskId: id, field: 'title', replica: 'Saved?' }])
  })

  it('a parent link to a task that is gone is refused and listed; the rest of the record applies', async () => {
    const id = await newTask('Orphan')
    const out = await drain([fieldsRec(id, { parent_task_id: { base: '', value: 'gone-parent-1' }, title: { base: 'Orphan', value: 'Orphan 2' } })])
    const t = await getTask(id)
    expect(t.title).toBe('Orphan 2')
    expect(t.parent_task_id ?? '').toBe('')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'parent-refused', taskId: id, field: 'parent_task_id' }])
  })

  it('a parent link that would make a cycle is refused', async () => {
    const parent = await newTask('Parent')
    const child = await newTask('Child', { parent_task_id: parent })
    const out = await drain([fieldsRec(parent, { parent_task_id: { base: '', value: child } })])
    expect((await getTask(parent)).parent_task_id ?? '').toBe('')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'parent-refused', reason: expect.stringContaining('subtasks') }])
  })

  it("a session's parent link that would push the task's own subtasks past the depth cap is refused, as the online PATCH answers subtask_too_deep", async () => {
    const root = await newTask('Root')
    const a = await newTask('Level one', { parent_task_id: root })
    const b = await newTask('Level two', { parent_task_id: a })
    const t = await newTask('Adopted')
    const c = await newTask('Its own subtask', { parent_task_id: t })
    const out = await drain([fieldsRec(t, { parent_task_id: { base: '', value: b }, title: { base: 'Adopted', value: 'Adopted, renamed' } })])
    const after = await getTask(t)
    expect(after.parent_task_id ?? '').toBe('')
    expect(after.title).toBe('Adopted, renamed')
    expect((await getTask(c)).parent_task_id).toBe(t)
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'parent-refused', taskId: t, reason: expect.stringContaining('levels') }])
    // Without its own subtask the same link fits (depth 3) and lands.
    const leaf = await newTask('Leaf')
    await drain([fieldsRec(leaf, { parent_task_id: { base: '', value: b } })])
    expect((await getTask(leaf)).parent_task_id).toBe(b)
  })

  it('a write with one non-queueable field is refused whole and lettered', async () => {
    const id = await newTask('Whole')
    const out = await drain([fieldsRec(id, { title: { base: 'Whole', value: 'Half' }, cwd: { base: '', value: '/srv/acme' } })])
    expect(out.acked).toHaveLength(1)
    expect((await getTask(id)).title).toBe('Whole')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'refused', reason: expect.stringContaining('cwd') }])
  })

  it("an invalid (project, group_id) pair keeps the Mac's pair and is lettered", async () => {
    const folder = await createFolder('Docks', 'Marina')
    const id = await newTask('Pair')
    const out = await drain([fieldsRec(id, { group_id: { base: '', value: folder.group_id } }, { actor: { kind: 'trigger', id: 'trg-1' } })])
    const t = await getTask(id)
    expect(t.project).toBe('Acme')
    expect(t.group_id ?? '').toBe('')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'task-field', field: 'project+group_id', why: 'invalid-pair' }])
    // The whole pair together is valid and applies in one write.
    await drain([fieldsRec(id, { project: { base: 'Acme', value: 'Marina' }, group_id: { base: '', value: folder.group_id } }, { actor: { kind: 'trigger', id: 'trg-1' } })])
    expect(await getTask(id)).toMatchObject({ project: 'Marina', group_id: folder.group_id })
  })

  it("base 'unknown' applies only when the Mac field is older than the record", async () => {
    const id = await newTask('Unknown base', { description: 'mac words' })
    const out = await drain([fieldsRec(id, { description: { base: 'unknown', value: 'away words' } }, { at: Date.now() + 1000 })])
    expect((await getTask(id)).description).toBe('away words')
    // The away write won over an older Mac value: nothing to tell the user.
    expect(entriesOf(out.drainIds)).toEqual([])
  })
})

function createRec(taskId: string, fields: Record<string, unknown>, placement: Record<string, unknown> = {}, over: Partial<Rec> = {}): Rec {
  return { v: 2, seq: ++seq, at: Date.now(), kind: 'task-create', opId: nextOp(), rev: 1, actor: { kind: 'session', sid: SID }, taskId, fields, placement, ...over }
}

describe('the drain applies task-create and task-move', () => {
  it('a create replayed after a crash between apply and ledger is a no-op (created_by_op)', async () => {
    const rec = createRec('mint0000aaaabbbbcccc01', { title: 'Made away' }, { project: 'Acme' })
    await drain([rec])
    const t = await getTask('mint0000aaaabbbbcccc01')
    expect(t).toMatchObject({ title: 'Made away', created_by_op: rec.opId })
    // The crash: the ledger row never landed.
    _setLedgerFileForTesting(`${WALNUT_HOME}/cache/ledger-lost-${Date.now()}.sqlite`)
    const again = await drain([{ ...rec, seq: ++seq }])
    expect(again.result.replayed).toBe(0)
    expect((await listTasks({})).filter((x) => x.title === 'Made away')).toHaveLength(1)
    _setLedgerFileForTesting(null)
  })

  it('a create whose id is taken here gets a new id; later records of the batch follow it; listed', async () => {
    await addTask({ title: 'Owner of the id', project: 'Acme', explicitId: 'mint0000aaaabbbbcccc02' })
    const create = createRec('mint0000aaaabbbbcccc02', { title: 'Collider' })
    const edit = fieldsRec('mint0000aaaabbbbcccc02', { priority: { base: 'none', value: 'immediate' } })
    const out = await drain([create, edit])
    expect(out.acked).toEqual([create.seq, edit.seq])
    expect(await getTask('mint0000aaaabbbbcccc02')).toMatchObject({ title: 'Owner of the id', priority: expect.not.stringMatching(/^high$/) })
    const moved = (await listTasks({})).find((x) => x.title === 'Collider')!
    expect(moved.id).not.toBe('mint0000aaaabbbbcccc02')
    expect(moved.priority).toBe('immediate')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'create-collision', taskId: moved.id }])
  })

  it("a create under an `Ask <agent>` project makes that project's registry row", async () => {
    await drain([createRec('mint0000aaaabbbbcccc03', { title: 'Ask on the host' }, { project: 'Ask Mentor' }, { actor: { kind: 'trigger', id: 'trg-1' } })])
    expect((await getTask('mint0000aaaabbbbcccc03')).project).toBe('Ask Mentor')
    expect(await getProjectRecord('Ask Mentor')).not.toBeNull()
  })

  it('a create whose parent is gone lands top level and is listed', async () => {
    const out = await drain([createRec('mint0000aaaabbbbcccc04', { title: 'Lost child' }, { project: 'Acme', parentTaskId: 'gone-parent-2' }, { actor: { kind: 'trigger', id: 'trg-1' } })])
    expect((await getTask('mint0000aaaabbbbcccc04')).parent_task_id ?? '').toBe('')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'parent-refused', taskId: 'mint0000aaaabbbbcccc04' }])
  })

  it('a move with a missing anchor appends at the end of the pinned order; never lettered', async () => {
    const a = await newTask('Pin A')
    const b = await newTask('Pin B')
    const c = await newTask('Pin C')
    for (const id of [a, b, c]) if (!(await getTask(id)).pinned) await togglePin(id)
    const order = async (): Promise<string[]> => (await listTasks({})).filter((t) => t.pinned && [a, b, c].includes(t.id)).sort((x, y) => (x.pin_order ?? 0) - (y.pin_order ?? 0)).map((t) => t.id)
    await drain([{ v: 2, seq: ++seq, at: Date.now(), kind: 'task-move', opId: nextOp(), rev: 1, actor: { kind: 'session', sid: SID }, taskId: c, anchor: { before: a } }])
    expect(await order()).toEqual([c, a, b])
    const out = await drain([{ v: 2, seq: ++seq, at: Date.now(), kind: 'task-move', opId: nextOp(), rev: 1, actor: { kind: 'session', sid: SID }, taskId: c, anchor: { after: 'gone-anchor' } }])
    expect(await order()).toEqual([a, b, c])
    expect(out.drainIds).toEqual([])
  })
})

describe('actor check', () => {
  it('a record from a device no longer paired with this Mac is dropped, acked and lettered', async () => {
    const id = await newTask('Phone edit')
    const out = await drain([fieldsRec(id, { title: { base: 'Phone edit', value: 'From a lost phone' } }, { actor: { kind: 'device', deviceId: 'dev-unpaired-1', name: 'Old phone' } })])
    expect(out.acked).toHaveLength(1)
    expect((await getTask(id)).title).toBe('Phone edit')
    expect(entriesOf(out.drainIds)).toMatchObject([{ kind: 'actor-dropped', actor: { deviceId: 'dev-unpaired-1' } }])
  })
})
