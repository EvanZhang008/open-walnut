/**
 * The companion's queued task writes merged by field on the Mac (replica plan WP13,
 * section 7, row R6b), against the real task store, the real drain v2 of a host
 * journal (offline-handover.ts) and the real apply of a companion op (task-outbox.ts
 * applyTaskOp, and once through the `server.tasks.apply` relay handler) of a temp home.
 *
 * A companion queue record now carries `{base, value, at}` per field
 * (task-queue.ts companionFieldWrites); the Mac merges it with the same rules as a
 * host journal record, so the two end the same in either drain order. The host-first
 * order is the one the old whole-row gate got wrong: a drained host record moves
 * `updated_at` to the drain's clock, and the gate then dropped a phone edit queued
 * away for the same task. An old queue file (no bases) still replays as before.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-queue-merge'))
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../src/core/offline-handover.js'
import { addTask, getTask, updateTaskRaw, deleteTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../src/core/offline-merge/host-clock.js'
import { applyTaskOp, _resetAppliedOpIdsForTesting, type TaskOp } from '../../src/core/task-outbox.js'
import { buildTaskOp, companionFieldWrites, noteKnownTaskRows, _resetKnownTaskRowsForTesting } from '../../src/core/task-queue.js'
import { parseCompanionFields, closeCompanionDrains, _setCompanionClockForTesting, _openCompanionDrainsForTesting } from '../../src/core/offline-merge/companion-op.js'
import { _closeCompanionBasesForTesting } from '../../src/core/companion-bases.js'
import { listLetters } from '../../src/core/human-inbox/store.js'
import type { Task } from '../../src/core/types.js'

const SID = 'eeeeeeee-5555-4555-8555-555555555555'
let seqN = 900
let opN = 0
const op = (): string => `op-tqm-${(++opN).toString(16).padStart(12, '0')}`
const iso = (ms: number): string => new Date(ms).toISOString()

/** A fake daemon journal for one host: keeps every record until it is acked by seq. */
function daemon(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) {
            const i = pending.findIndex((r) => r.seq === s)
            if (i !== -1) pending.splice(i, 1)
          }
          return { ok: true }
        }
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        return { ok: true }
      },
    },
  }
}

async function drainHost(records: Array<Record<string, unknown>>): Promise<void> {
  const d = daemon('marina', records)
  for (let i = 0; i < 8 && d.pending.length; i++) {
    await runOfflineHandover(d.conn as never).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 15))
  }
  expect(d.pending).toHaveLength(0)
}

/** A host journal record: the session on the host set `fields` at host time `at`. */
const hostRecord = (taskId: string, fields: Record<string, { base: unknown; value: unknown }>, at: number, actor: Record<string, unknown> = { kind: 'session', sid: SID }) => ({
  v: 2, seq: ++seqN, at, kind: 'task-fields', opId: op(), rev: 1, actor, op: 'task_update', taskId, fields,
})

/**
 * The companion's write: its copy held `seen` (the Mac's row as copied), a phone set
 * `change` at `at`; the subscriber builds the op exactly as server.ts does.
 */
function companionOp(seen: Task, change: Partial<Task>, at: number): Extract<TaskOp, { type: 'update' }> {
  noteKnownTaskRows([seen])
  const after = {
    ...seen, ...change, updated_at: iso(at),
    field_at: { ...(seen.field_at ?? {}), ...Object.fromEntries(Object.keys(change).map((f) => [f, iso(at)])) },
  } as Task
  const touched = Object.keys(change)
  const fields = companionFieldWrites(after, touched)
  return buildTaskOp({ type: 'update', task: after, touched, ...(fields ? { fields } : {}) }) as Extract<TaskOp, { type: 'update' }>
}

async function newTask(title: string, extra: Partial<Task> = {}): Promise<Task> {
  return (await addTask({ title, project: 'Acme', ...extra } as never)).task
}

beforeEach(() => {
  _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1])
  _resetAppliedOpIdsForTesting(); _resetKnownTaskRowsForTesting(); _setCompanionClockForTesting(null); vi.restoreAllMocks()
})
afterAll(async () => { await closeCompanionDrains(); _setHandoverBackoffForTesting(null); _closeCompanionBasesForTesting(); closeDb() })

type Order = 'host-first' | 'companion-first'
interface Scenario {
  start: Partial<Task> & { title: string }
  companion: Partial<Task>
  /** The phone's write, this many ms after the task was made. */
  companionDt: number
  host: Record<string, { base: unknown; value: unknown }>
  /** The host session's write, this many ms after the task was made. */
  hostDt: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * One task per run, the same start and the same two writes; the order is the only
 * difference. Both writes are timed AFTER the task was made (a write before its own
 * task never happens, and the old whole-row gate then called the companion's stale).
 */
async function run(order: Order, s: Scenario): Promise<{ task: Task; reason: string | undefined; t0: number }> {
  const t = await newTask(s.start.title, s.start)
  const t0 = Date.parse(t.created_at)
  await sleep(Math.max(s.companionDt, s.hostDt) + 30)
  const seen = await getTask(t.id)
  const cop = companionOp(seen, s.companion, t0 + s.companionDt)
  const rec = hostRecord(t.id, s.host, t0 + s.hostDt)
  let reason: string | undefined
  if (order === 'host-first') {
    await drainHost([rec])
    reason = (await applyTaskOp(cop)).reason
  } else {
    reason = (await applyTaskOp(cop)).reason
    await drainHost([rec])
  }
  return { task: await getTask(t.id), reason, t0 }
}

const pick = (t: Task, fields: string[]) => Object.fromEntries(fields.map((f) => [f, (t as unknown as Record<string, unknown>)[f] ?? null]))

describe('a companion queue record and a host journal record on the same field (R6b)', () => {
  it('the newer write wins in either drain order (the host wrote later)', async () => {
    const s: Scenario = {
      start: { title: 'Plan' }, companion: { title: 'Plan from the phone' }, companionDt: 20,
      host: { title: { base: 'Plan', value: 'Plan from the host' } }, hostDt: 60,
    }
    const a = await run('host-first', s)
    const b = await run('companion-first', s)
    expect(a.task.title).toBe('Plan from the host')
    expect(b.task.title).toBe('Plan from the host')
    // The companion's op is merged, never 'stale': first it lands, then the newer host write wins.
    expect(b.reason).toBe('updated')
    expect(a.reason).toBe('unchanged')
  })

  it('the newer write wins in either drain order (the phone wrote later), stamped with its own time', async () => {
    const s: Scenario = {
      start: { title: 'Release' }, companion: { title: 'Release from the phone' }, companionDt: 70,
      host: { title: { base: 'Release', value: 'Release from the host' } }, hostDt: 20,
    }
    const a = await run('host-first', s)
    const b = await run('companion-first', s)
    expect(a.task.title).toBe('Release from the phone')
    expect(b.task.title).toBe('Release from the phone')
    expect(a.reason).toBe('updated')
    expect(b.reason).toBe('updated')
    // The replay stamps field_at with the write's original time, never the drain's.
    expect(a.task.field_at?.title).toBe(iso(a.t0 + 70))
    expect(b.task.field_at?.title).toBe(iso(b.t0 + 70))
  })

  it('two lines added to one description by the two writers: both kept, in either order', async () => {
    const base = 'one\ntwo\nthree\n'
    const s: Scenario = {
      start: { title: 'Doc', description: base }, companion: { description: 'one\nphone line\ntwo\nthree\n' }, companionDt: 20,
      host: { description: { base, value: 'one\ntwo\nthree\nhost line\n' } }, hostDt: 60,
    }
    const a = await run('host-first', s)
    const b = await run('companion-first', s)
    expect(a.task.description).toContain('phone line')
    expect(a.task.description).toContain('host line')
    expect(b.task.description).toBe(a.task.description)
  })

  it('different fields: both land, and both orders give the same task', async () => {
    const s: Scenario = {
      start: { title: 'Ship', priority: 'none' } as never, companion: { priority: 'immediate' } as never, companionDt: 20,
      host: { title: { base: 'Ship', value: 'Ship it' } }, hostDt: 60,
    }
    const a = await run('host-first', s)
    const b = await run('companion-first', s)
    expect(pick(a.task, ['title', 'priority'])).toEqual({ title: 'Ship it', priority: 'immediate' })
    expect(pick(b.task, ['title', 'priority'])).toEqual(pick(a.task, ['title', 'priority']))
  })
})

describe('the host-first order (the old whole-row gate dropped this)', () => {
  it('a drained host record moves updated_at to the drain clock; a phone edit queued away before it still lands', async () => {
    const t = await newTask('Budget')
    const t0 = Date.parse(t.created_at)
    await sleep(100)
    const seen = await getTask(t.id)
    // The phone edited the priority through the companion while the Mac was away...
    const cop = companionOp(seen, { priority: 'important' } as never, t0 + 20)
    // ...and a host session renamed the task later; the host drains first.
    await drainHost([hostRecord(t.id, { title: { base: 'Budget', value: 'Budget review' } }, t0 + 60)])
    const drained = await getTask(t.id)
    expect(Date.parse(drained.updated_at)).toBeGreaterThan(Date.parse(cop.task.updated_at))
    // The same edit without bases is what the old gate saw: stale, dropped.
    const legacy: TaskOp = { ...cop, opId: op() }
    delete (legacy as { fields?: unknown }).fields
    expect((await applyTaskOp(legacy)).reason).toBe('stale')
    expect((await getTask(t.id)).priority).not.toBe('important')
    // With bases: merged by field, applied.
    expect((await applyTaskOp(cop)).reason).toBe('updated')
    const after = await getTask(t.id)
    expect(after.priority).toBe('important')
    expect(after.title).toBe('Budget review')
    expect(after.field_at?.priority).toBe(iso(t0 + 20))
  })

  it('over the wire: the op as the queue sends it (JSON, server.tasks.apply) merges by field on the Mac', async () => {
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js')
    const t = await newTask('Wire')
    const t0 = Date.parse(t.created_at)
    await sleep(100)
    const cop = companionOp(await getTask(t.id), { priority: 'important' } as never, t0 + 20)
    await drainHost([hostRecord(t.id, { title: { base: 'Wire', value: 'Wire check' } }, t0 + 60)])
    const r = await handleSessionControlRelay('server.tasks.apply', '__server__', JSON.parse(JSON.stringify({ op: cop }))) as { ok: boolean; result?: Record<string, unknown> }
    expect(r).toMatchObject({ ok: true, result: { applied: true, reason: 'updated', opId: cop.opId } })
    const after = await getTask(t.id)
    expect(after).toMatchObject({ priority: 'important', title: 'Wire check' })
    expect(after.field_at?.priority).toBe(iso(t0 + 20))
  })

  it('a replay of the same companion op applies once', async () => {
    const t = await newTask('Replay')
    const cop = companionOp(await getTask(t.id), { title: 'Replay once' }, Date.now() - 1_000)
    expect((await applyTaskOp(cop)).applied).toBe(true)
    _resetAppliedOpIdsForTesting() // the bounded opId set forgot it: the task's own op key still holds
    expect((await applyTaskOp(cop)).applied).toBe(false)
    expect((await getTask(t.id)).title).toBe('Replay once')
  })
})

describe('an old queue file without bases replays as today', () => {
  it('a newer snapshot applies through the old path; an older one is stale', async () => {
    const t = await newTask('Legacy')
    const cur = await getTask(t.id)
    const newer: TaskOp = { opId: op(), type: 'update', at: iso(Date.now()), task: { ...cur, title: 'Legacy newer', updated_at: iso(Date.parse(cur.updated_at) + 5_000) }, touched: ['title'] }
    expect(await applyTaskOp(newer)).toEqual({ applied: true, reason: 'updated' })
    expect((await getTask(t.id)).title).toBe('Legacy newer')
    const older: TaskOp = { opId: op(), type: 'update', at: iso(Date.now()), task: { ...cur, title: 'Legacy older', updated_at: iso(Date.parse(cur.updated_at) - 5_000) }, touched: ['title'] }
    expect(await applyTaskOp(older)).toEqual({ applied: false, reason: 'stale' })
    expect((await getTask(t.id)).title).toBe('Legacy newer')
  })

  it('an append-style note from an older companion (no bases) keeps its own rule', async () => {
    const t = await newTask('Notes')
    await updateTaskRaw(t.id, { note: 'first' } as never)
    const cur = await getTask(t.id)
    const after = { ...cur, note: 'second', updated_at: iso(Date.parse(cur.updated_at) + 5_000) } as Task
    const o = buildTaskOp({ type: 'update', task: after, touched: ['note'], append: { note: 'second' } }) as Extract<TaskOp, { type: 'update' }>
    expect(o.fields).toBeUndefined()
    expect((await applyTaskOp(o)).reason).toBe('updated')
    expect((await getTask(t.id)).note).toBe('first\n\nsecond')
  })

  it('a legacy outbox file with a malformed `fields` map (raw JSON, unparsed) takes the old path whole', async () => {
    const t = await newTask('Outbox')
    const cur = await getTask(t.id)
    // No `at` on the field: never half-applied by field, the whole-row gate decides.
    const older = { opId: op(), type: 'update', at: iso(Date.now()), touched: ['title'],
      task: { ...cur, title: 'Outbox older', updated_at: iso(Date.parse(cur.updated_at) - 5_000) },
      fields: { title: { base: 'Outbox', value: 'Outbox older' } } } as unknown as TaskOp
    expect(await applyTaskOp(older)).toEqual({ applied: false, reason: 'stale' })
    const newer = { opId: op(), type: 'update', at: iso(Date.now()), touched: ['title'],
      task: { ...cur, title: 'Outbox newer', updated_at: iso(Date.parse(cur.updated_at) + 5_000) },
      fields: ['title'] } as unknown as TaskOp
    expect(await applyTaskOp(newer)).toEqual({ applied: true, reason: 'updated' })
    expect((await getTask(t.id)).title).toBe('Outbox newer')
  })
})

describe('the companion\'s bases (task-queue.ts)', () => {
  const row = (over: Partial<Task>): Task => ({ id: 't-bases', title: 'A', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', created_at: iso(1), updated_at: iso(2), ...over } as Task)

  it('the base is the Mac\'s row as copied, then each write made here; unknown before any', () => {
    const first = companionFieldWrites(row({ title: 'B', field_at: { title: iso(10) } }), ['title'])
    expect(first).toEqual({ title: { base: 'unknown', value: 'B', at: 10 } })
    noteKnownTaskRows([row({ title: 'Mac title' })])
    expect(companionFieldWrites(row({ title: 'C', updated_at: iso(20) }), ['title'])).toEqual({ title: { base: 'Mac title', value: 'C', at: 20 } })
    expect(companionFieldWrites(row({ title: 'D', updated_at: iso(30) }), ['title', 'updated_at'])).toEqual({ title: { base: 'C', value: 'D', at: 30 } })
    // A held row the copy did not replace is no base.
    noteKnownTaskRows([row({ title: 'ignored' })], ['t-bases'])
    expect(companionFieldWrites(row({ title: 'E', updated_at: iso(40) }), ['title'])!.title!.base).toBe('D')
  })

  it('a field the Mac does not merge sends the op as before (no bases); a cleared field is null', () => {
    expect(companionFieldWrites(row({}), ['source'])).toBeUndefined()
    expect(companionFieldWrites(row({}), [])).toBeUndefined()
    expect(companionFieldWrites(row({ due_date: undefined, updated_at: iso(50) }), ['due_date'])!.due_date!.value).toBeNull()
  })

  it('the Mac reads `fields` whole: a malformed map takes the old path', () => {
    expect(parseCompanionFields({ title: { base: 'a', value: 'b', at: 5 } })).toEqual({ title: { base: 'a', value: 'b', at: 5 } })
    expect(parseCompanionFields({ title: { base: 'a', value: 'b' } })).toBeUndefined()
    expect(parseCompanionFields({ title: { value: 'b', at: 5 } })).toBeUndefined()
    expect(parseCompanionFields({ 'Bad-Name': { base: 'a', value: 'b', at: 5 } })).toBeUndefined()
    expect(parseCompanionFields([])).toBeUndefined()
    expect(parseCompanionFields({})).toBeUndefined()
  })
})

/** Letters a companion drain sent (their host is the companion). */
async function companionLetters(): Promise<number> {
  const { letters } = await listLetters()
  return letters.filter((l) => (l as unknown as { sender?: { host?: string } }).sender?.host === 'companion').length
}

describe('the bases survive a companion restart (companion-bases.ts)', () => {
  it('the base of a write after a restart is the row the copy took before it', () => {
    const row = { id: 't-restart', title: 'Mac title', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', created_at: iso(1), updated_at: iso(2) } as Task
    noteKnownTaskRows([row])
    _closeCompanionBasesForTesting() // the companion restarted: nothing of it in memory
    expect(companionFieldWrites({ ...row, title: 'Phone title', updated_at: iso(30) }, ['title'])).toEqual({ title: { base: 'Mac title', value: 'Phone title', at: 30 } })
    _closeCompanionBasesForTesting()
    // And the write made here is the next base, across another restart.
    expect(companionFieldWrites({ ...row, title: 'Again', updated_at: iso(40) }, ['title'])!.title!.base).toBe('Phone title')
  })

  it('a companion restarted between the copy and the phone\'s write: both drain orders give the same text', async () => {
    const base = 'one\ntwo\nthree\n'
    const res: Task[] = []
    for (const order of ['host-first', 'companion-first'] as const) {
      const t = await newTask(`Restart ${order}`, { description: base })
      const t0 = Date.parse(t.created_at)
      await sleep(120)
      const seen = await getTask(t.id)
      noteKnownTaskRows([seen])
      _closeCompanionBasesForTesting()
      const after = { ...seen, description: 'one\nphone line\ntwo\nthree\n', updated_at: iso(t0 + 80), field_at: { ...(seen.field_at ?? {}), description: iso(t0 + 80) } } as Task
      const fields = companionFieldWrites(after, ['description'])
      expect(fields!.description!.base).toBe(base)
      const cop = buildTaskOp({ type: 'update', task: after, touched: ['description'], fields: fields! }) as Extract<TaskOp, { type: 'update' }>
      const rec = hostRecord(t.id, { description: { base, value: 'one\ntwo\nthree\nhost line\n' } }, t0 + 40)
      if (order === 'host-first') { await drainHost([rec]); await applyTaskOp(cop) } else { await applyTaskOp(cop); await drainHost([rec]) }
      res.push(await getTask(t.id))
    }
    expect(res[0].description).toContain('phone line')
    expect(res[0].description).toContain('host line')
    expect(res[1].description).toBe(res[0].description)
  })
})

describe('an append-style note (POST /tasks/:id/notes on the companion)', () => {
  /** The phone appended `entry` through the companion at `at`, as server.ts builds the op. */
  function appendOp(seen: Task, entry: string, at: number): Extract<TaskOp, { type: 'update' }> {
    noteKnownTaskRows([seen])
    const after = { ...seen, note: seen.note ? `${seen.note}\n\n${entry}` : entry, updated_at: iso(at), field_at: { ...(seen.field_at ?? {}), note: iso(at) } } as Task
    const fields = companionFieldWrites(after, ['note'])
    return buildTaskOp({ type: 'update', task: after, touched: ['note'], append: { note: entry }, ...(fields ? { fields } : {}) }) as Extract<TaskOp, { type: 'update' }>
  }

  it('a host record that drained first never drops it (no row gate), and a replay adds it once', async () => {
    const t = await newTask('Notes away')
    await updateTaskRaw(t.id, { note: 'from the Mac' } as never)
    const t0 = Date.now()
    await sleep(100)
    const o = appendOp(await getTask(t.id), 'from the phone', t0 + 20)
    expect(o.fields?.note).toBeDefined()
    await drainHost([hostRecord(t.id, { title: { base: 'Notes away', value: 'Notes renamed' } }, t0 + 60)])
    expect(Date.parse((await getTask(t.id)).updated_at)).toBeGreaterThan(Date.parse(o.task.updated_at))
    expect(await applyTaskOp(o)).toEqual({ applied: true, reason: 'updated' })
    const after = await getTask(t.id)
    expect(after.note).toBe('from the Mac\n\nfrom the phone')
    expect(after.title).toBe('Notes renamed')
    // The opId set forgot it (a restart): the task's own op key still holds.
    _resetAppliedOpIdsForTesting()
    expect((await applyTaskOp(o)).applied).toBe(false)
    expect((await getTask(t.id)).note).toBe('from the Mac\n\nfrom the phone')
  })

  it('a host note edit and the append end the same in either drain order', async () => {
    const res: string[] = []
    for (const order of ['host-first', 'companion-first'] as const) {
      const t = await newTask(`Append ${order}`)
      await updateTaskRaw(t.id, { note: 'line a\nline b' } as never)
      const t0 = Date.now()
      await sleep(100)
      const o = appendOp(await getTask(t.id), 'phone entry', t0 + 20)
      // A trigger on the host (a session's task_update takes no note) rewrote the note's first line.
      const rec = hostRecord(t.id, { note: { base: 'line a\nline b', value: 'line a host\nline b' } }, t0 + 60, { kind: 'trigger', id: 'trg-acme' })
      if (order === 'host-first') { await drainHost([rec]); await applyTaskOp(o) } else { await applyTaskOp(o); await drainHost([rec]) }
      res.push((await getTask(t.id)).note ?? '')
    }
    expect(res[0]).toBe('line a host\nline b\n\nphone entry')
    expect(res[1]).toBe(res[0])
  })
})

describe('delete wins (section 7): a companion write to a task the Mac deleted', () => {
  it('a field write is dropped and listed, never a re-created task', async () => {
    const t = await newTask('Gone soon')
    const t0 = Date.parse(t.created_at)
    await sleep(60)
    const cop = companionOp(await getTask(t.id), { title: 'edited on the phone' }, t0 + 20)
    await deleteTask(t.id)
    const before = await companionLetters()
    expect(await applyTaskOp(cop)).toEqual({ applied: false, reason: 'missing' })
    expect(await getTask(t.id).catch(() => null)).toBeNull()
    await closeCompanionDrains()
    expect(await companionLetters()).toBe(before + 1)
  })

  it('an append to a deleted task is dropped too; an op without bases still creates as before', async () => {
    const t = await newTask('Gone with a note')
    const seen = await getTask(t.id)
    noteKnownTaskRows([seen])
    const after = { ...seen, note: 'late entry', updated_at: iso(Date.now()) } as Task
    const fields = companionFieldWrites(after, ['note'])
    const o = buildTaskOp({ type: 'update', task: after, touched: ['note'], append: { note: 'late entry' }, fields: fields! }) as Extract<TaskOp, { type: 'update' }>
    await deleteTask(t.id)
    expect((await applyTaskOp(o)).reason).toBe('missing')
    expect(await getTask(t.id).catch(() => null)).toBeNull()
    // An older companion's op (no `fields`) keeps the old rule: the row is born from it.
    const legacy = buildTaskOp({ type: 'update', task: after, touched: ['note'] })
    expect((await applyTaskOp(legacy)).reason).toBe('created')
  })
})

describe('one letter per drain (section 7)', () => {
  it('the conflicting ops of one queue flush send ONE letter, after the flush goes quiet', async () => {
    const ops: Array<Extract<TaskOp, { type: 'update' }>> = []
    for (let i = 0; i < 3; i++) {
      const t = await newTask(`Letter ${i}`)
      const t0 = Date.parse(t.created_at)
      await sleep(80)
      ops.push({ ...companionOp(await getTask(t.id), { title: `phone ${i}` }, t0 + 20), flush: 'f-acme-1' })
      await drainHost([hostRecord(t.id, { title: { base: `Letter ${i}`, value: `host ${i}` } }, t0 + 60)])
    }
    await closeCompanionDrains()
    const before = await companionLetters()
    for (const o of ops) expect((await applyTaskOp(o)).reason).toBe('unchanged')
    expect(_openCompanionDrainsForTesting()).toBe(1)
    expect(await companionLetters()).toBe(before) // not one per op while the flush runs
    await closeCompanionDrains()
    expect(await companionLetters()).toBe(before + 1)
    const { letters } = await listLetters()
    const letter = letters.find((l) => (l as unknown as { sender?: { host?: string } }).sender?.host === 'companion') as unknown as { subject: string; taskRefs?: string[] }
    expect(letter.subject).toMatch(/^3 changes /)
    expect([...(letter.taskRefs ?? [])].sort()).toEqual(ops.map((o) => o.task.id).sort())
  })
})

describe('the companion\'s field times on this server\'s clock', () => {
  it('a time no clock could hold is refused and consumed, never retried forever', async () => {
    const t = await newTask('Poison')
    const cop = companionOp(await getTask(t.id), { title: 'from far away' }, Date.now())
    const bad = { ...cop, fields: { title: { ...cop.fields!.title!, at: 1e17 } } }
    expect(await applyTaskOp(bad)).toEqual({ applied: false, reason: 'refused' })
    // A time that fits a Date but is days past its own op: refused, it would win every later write.
    const ahead = { ...cop, opId: op(), fields: { title: { ...cop.fields!.title!, at: Date.parse(cop.at) + 3 * 86_400_000 } } }
    expect((await applyTaskOp(ahead)).reason).toBe('refused')
    expect((await getTask(t.id)).title).toBe('Poison')
  })

  it('a time a little ahead of now is held at now: the field stays beatable', async () => {
    const t = await newTask('Ahead')
    const cop = companionOp(await getTask(t.id), { title: 'Ahead edit' }, Date.now())
    const soon = { ...cop, fields: { title: { ...cop.fields!.title!, at: Date.now() + 3_600_000 } } }
    expect((await applyTaskOp(soon)).reason).toBe('updated')
    const after = await getTask(t.id)
    expect(after.title).toBe('Ahead edit')
    expect(Date.parse(after.field_at!.title!)).toBeLessThanOrEqual(Date.now())
  })

  it('a companion clock an hour behind is shifted by its measured offset (stamped on this clock)', async () => {
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js')
    const skew = 3_600_000
    const write = async (title: string, sentAt?: number): Promise<Task> => {
      const t = await newTask(title)
      const at = Date.now() - skew
      const cop = { ...companionOp(await getTask(t.id), { title: `${title} edit` }, at), at: iso(at), ...(sentAt !== undefined ? { sentAt } : {}) }
      const r = await handleSessionControlRelay('server.tasks.apply', '__server__', JSON.parse(JSON.stringify({ op: cop }))) as { ok: boolean; result?: Record<string, unknown> }
      expect(r).toMatchObject({ ok: true, result: { applied: true, reason: 'updated' } })
      return getTask(t.id)
    }
    // Unmeasured, the write is stamped an hour in the past: it would lose to every Mac edit since.
    const raw = await write('Unmeasured')
    expect(Date.now() - Date.parse(raw.field_at!.title!)).toBeGreaterThan(skew - 5_000)
    // The op says when the companion sent it; the Mac measures the offset from it.
    const shifted = await write('Measured', Date.now() - skew)
    expect(Math.abs(Date.now() - Date.parse(shifted.field_at!.title!))).toBeLessThan(5_000)
  })
})
