/**
 * The Mac drain v2 against the real task store, ledger and conflict log of a temp home,
 * for the review findings of WP9 (docs/plan/walnut-replica-servers-impl.md sections 5
 * and 7): two hosts draining one task at once, a conflict log that fails to write, the
 * online PATCH's checks on a queued write, a re-minted create id after a stop, a create
 * whose second row write failed, a forward the Mac refused whose retry was journaled,
 * and per-field times on every write path.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-correctness'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, listTasks, updateTaskRaw, updateTasksBulk, ensureProject, deleteProject } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { ConflictLog, conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { recordApplied, lookupApplied } from '../../../src/core/offline-merge/ledger.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const SID = 'dddddddd-4444-4444-8444-444444444444'
let seqN = 500
let opN = 0
const op = (): string => `op-dc-${(++opN).toString(16).padStart(12, '0')}`

/** A fake daemon journal for one host: keeps every record until it is acked by seq. */
function daemon(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  const acked: number[] = []
  return {
    pending, acked,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) {
            acked.push(s)
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

async function drainUntilEmpty(d: ReturnType<typeof daemon>, max = 8): Promise<void> {
  for (let i = 0; i < max && d.pending.length; i++) {
    await runOfflineHandover(d.conn as never).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 15))
  }
}

function allEntries(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}

const fieldsRec = (taskId: string, fields: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'task-fields', opId: op(), rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields, ...over,
})

beforeEach(() => { _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1]); vi.restoreAllMocks() })
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('two hosts drain one task at once', () => {
  it('each adds a different line to the same description: both lines survive, no conflict', async () => {
    const base = 'one\ntwo\nthree\n'
    const id = (await addTask({ title: 'Shared doc', project: 'Acme', description: base } as never)).task.id
    const a = daemon('marina', [fieldsRec(id, { description: { base, value: 'one\nA line\ntwo\nthree\n' } }, { seq: 1 })])
    const b = daemon('acme-box', [fieldsRec(id, { description: { base, value: 'one\ntwo\nthree\nB line\n' } }, { seq: 1 })])
    await Promise.all([runOfflineHandover(a.conn as never), runOfflineHandover(b.conn as never)])
    const d = (await getTask(id)).description
    expect(d).toContain('A line')
    expect(d).toContain('B line')
    expect(a.pending).toHaveLength(0)
    expect(b.pending).toHaveLength(0)
  })

  it('each sets another scalar of one task: both land, and a redrain of both changes nothing', async () => {
    const id = (await addTask({ title: 'Two writers', project: 'Acme' } as never)).task.id
    const ra = fieldsRec(id, { title: { base: 'Two writers', value: 'Renamed by marina' } }, { seq: 1 })
    const rb = fieldsRec(id, { priority: { base: 'none', value: 'immediate' } }, { seq: 1 })
    await Promise.all([runOfflineHandover(daemon('marina', [ra]).conn as never), runOfflineHandover(daemon('acme-box', [rb]).conn as never)])
    const t = await getTask(id)
    expect([t.title, t.priority]).toEqual(['Renamed by marina', 'immediate'])
    const before = JSON.stringify(t)
    await Promise.all([runOfflineHandover(daemon('marina', [ra]).conn as never), runOfflineHandover(daemon('acme-box', [rb]).conn as never)])
    expect(JSON.stringify(await getTask(id))).toBe(before)
  })
})

describe('the conflict log is on disk before the ledger row and the ack', () => {
  it('a log write that fails once leaves the record unapplied; the redrain letters the away text', async () => {
    const id = (await addTask({ title: 'Doc', project: 'Acme', description: 'one\n' } as never)).task.id
    await updateTaskRaw(id, { description: 'mac line\n' })
    const rec = fieldsRec(id, { description: { base: 'one\n', value: 'away words only here\n' } }, { at: Date.now() - 600_000 })
    const d = daemon('marina', [rec])
    const flush = vi.spyOn(ConflictLog.prototype, 'flush').mockImplementationOnce(() => { throw new Error('ENOSPC (injected)') })
    await runOfflineHandover(d.conn as never).catch(() => undefined)
    expect(d.acked).toEqual([])
    expect(lookupApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: String(rec.opId), rev: 1 })).toBeNull()
    flush.mockRestore()
    await drainUntilEmpty(d)
    expect(d.pending).toHaveLength(0)
    const mine = allEntries().filter((e) => e.opId === rec.opId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ kind: 'task-field', field: 'description', kept: 'mac', replica: 'away words only here\n' })
    expect((await getTask(id)).description).toBe('mac line\n')
  })

  it('a refused write whose letter cannot be written is not acked; the retry letters it once', async () => {
    const id = (await addTask({ title: 'Refuse me', project: 'Acme' } as never)).task.id
    const rec = fieldsRec(id, { priority: { base: 'none', value: 'urgent-ish' } })
    const d = daemon('marina', [rec])
    const flush = vi.spyOn(ConflictLog.prototype, 'flush').mockImplementationOnce(() => { throw new Error('EIO (injected)') })
    await runOfflineHandover(d.conn as never).catch(() => undefined)
    expect(d.acked).toEqual([])
    flush.mockRestore()
    await drainUntilEmpty(d)
    expect(d.pending).toHaveLength(0)
    expect(allEntries().filter((e) => e.opId === rec.opId).map((e) => e.kind)).toEqual(['refused'])
  })
})

describe('a queued write gets the checks the online PATCH makes', () => {
  it('a park with wait_until "6h" stores the time six hours after the write, not the text', async () => {
    const id = (await addTask({ title: 'Park me', project: 'Acme' } as never)).task.id
    const at = Date.now() - 60_000
    const d = daemon('marina', [fieldsRec(id, { phase: { base: 'TODO', value: 'WAITING' }, wait_until: { base: '', value: '6h' } }, { at })])
    await drainUntilEmpty(d)
    const t = await getTask(id)
    expect(t.phase).toBe('WAITING')
    expect(t.wait_until).toBe(new Date(at + 6 * 3600_000).toISOString())
  })

  it('a phase the Mac does not know is refused whole and lettered; nothing of the write lands', async () => {
    const id = (await addTask({ title: 'Odd phase', project: 'Acme' } as never)).task.id
    const rec = fieldsRec(id, { phase: { base: 'TODO', value: 'BOGUS' }, title: { base: 'Odd phase', value: 'Should not land' } })
    const d = daemon('marina', [rec])
    await drainUntilEmpty(d)
    const t = await getTask(id)
    expect([t.phase, t.status, t.title]).toEqual(['TODO', 'todo', 'Odd phase'])
    expect(d.pending).toHaveLength(0)
    expect(allEntries().filter((e) => e.opId === rec.opId)).toMatchObject([{ kind: 'refused', reason: expect.stringContaining('phase must be one of') }])
  })

  it('a session that completes its worker while away is named on the phase event (its own notice is skipped)', async () => {
    const id = (await addTask({ title: 'Worker', project: 'Acme' } as never)).task.id
    const emit = vi.spyOn(bus, 'emit')
    await drainUntilEmpty(daemon('marina', [fieldsRec(id, { phase: { base: 'TODO', value: 'COMPLETE' } })]))
    expect((await getTask(id)).phase).toBe('COMPLETE')
    const phaseEvents = emit.mock.calls.filter((c) => c[0] === EventNames.TASK_PHASE_CHANGED).map((c) => c[1] as { actorSid?: string; newPhase?: string })
    expect(phaseEvents).toContainEqual(expect.objectContaining({ newPhase: 'COMPLETE', actorSid: SID }))
  })

  it('a move onto a project deleted on the Mac keeps the task where it is and is lettered; the rest lands', async () => {
    await ensureProject('Gone', 'local')
    await deleteProject('Gone')
    const id = (await addTask({ title: 'Stays', project: 'Acme' } as never)).task.id
    const rec = fieldsRec(id, { project: { base: 'Acme', value: 'Gone' }, priority: { base: 'none', value: 'important' } })
    await drainUntilEmpty(daemon('marina', [rec]))
    const t = await getTask(id)
    expect([t.project, t.priority]).toEqual(['Acme', 'important'])
    expect(allEntries().filter((e) => e.opId === rec.opId)).toMatchObject([{ kind: 'refused', field: 'project', replica: 'Gone' }])
  })

  it('a move to a project the Mac never heard of creates its registry row, as updateTask does', async () => {
    const id = (await addTask({ title: 'Mover', project: 'Acme' } as never)).task.id
    await drainUntilEmpty(daemon('marina', [fieldsRec(id, { project: { base: 'Acme', value: 'Marina Ops' } })]))
    expect((await getTask(id)).project).toBe('Marina Ops')
    expect(await ensureProject('Marina Ops', 'local')).toMatchObject({ created: false, name: 'Marina Ops' })
  })
})

describe('creates made away', () => {
  it('a re-minted id outlives a stop: a later record of the created task never writes the task that owned the id', async () => {
    const minted = 'mintdc00000aaaa00000001'
    const owner = (await addTask({ title: 'Owner', project: 'Acme', explicitId: minted } as never)).task.id
    const other = (await addTask({ title: 'Other', project: 'Acme' } as never)).task.id
    const now = Date.now()
    const create = { v: 2, seq: ++seqN, at: now, kind: 'task-create', opId: op(), rev: 1, actor: { kind: 'session', sid: SID }, taskId: minted, fields: { title: 'Away create' }, placement: {} }
    const blocker = fieldsRec(other, { title: { base: 'Other', value: 'Other renamed' } }, { at: now })
    const rename = fieldsRec(minted, { title: { base: 'Away create', value: 'Away renamed' } }, { at: now + 10 })
    const d = daemon('marina', [create, blocker, rename])
    // The second record throws once (its log write fails), so the batch stops after the create.
    const orig = ConflictLog.prototype.addDurable
    let calls = 0
    vi.spyOn(ConflictLog.prototype, 'addDurable').mockImplementation(function (this: ConflictLog, entries) {
      calls++
      if (calls === 2) throw new Error('EIO (injected)')
      return orig.call(this, entries)
    })
    await runOfflineHandover(d.conn as never)
    expect(d.acked).toEqual([create.seq])
    vi.restoreAllMocks()
    await drainUntilEmpty(d)
    expect(d.pending).toHaveLength(0)
    expect((await getTask(owner)).title).toBe('Owner')
    const away = (await listTasks({})).filter((t) => t.title.startsWith('Away'))
    expect(away.map((t) => t.title)).toEqual(['Away renamed'])
    expect(away[0].id).not.toBe(minted)
    expect(away[0].created_by_op).toBe(create.opId)
  })

  it('a create whose second row write failed lands its other fields on the retry, once', async () => {
    const minted = 'mintdc00000bbbb00000002'
    // Not a session: task_create takes no note or summary from a session.
    const create = { v: 2, seq: ++seqN, at: Date.now(), kind: 'task-create', opId: op(), rev: 1, actor: { kind: 'trigger', id: 'trg-dc' }, taskId: minted, fields: { title: 'Fresh', note: 'keep me', summary: 'and me' }, placement: {} }
    const d = daemon('marina', [create])
    vi.spyOn(ConflictLog.prototype, 'addDurable').mockImplementationOnce(() => { throw new Error('EIO (injected)') })
    await runOfflineHandover(d.conn as never)
    expect(d.acked).toEqual([])
    expect((await getTask(minted)).note ?? '').toBe('')
    vi.restoreAllMocks()
    await drainUntilEmpty(d)
    const t = await getTask(minted)
    expect([t.title, t.note, t.summary]).toEqual(['Fresh', 'keep me', 'and me'])
    expect((await listTasks({})).filter((x) => x.title === 'Fresh')).toHaveLength(1)
  })
})

describe('a forward the Mac refused, retried through the journal', () => {
  it('a ledger row the HTTP write recorded as refused letters the journaled retry with the Mac\'s answer', async () => {
    const id = (await addTask({ title: 'Refused once', project: 'Acme' } as never)).task.id
    const rec = fieldsRec(id, { title: { base: 'Refused once', value: 'Changed away' } })
    recordApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: String(rec.opId), rev: 1 }, { outcome: 'refused', status: 409, body: '{"error":{"code":"project_elsewhere"}}', source: 'http' })
    const d = daemon('marina', [rec])
    await drainUntilEmpty(d)
    expect(d.pending).toHaveLength(0)
    expect((await getTask(id)).title).toBe('Refused once')
    expect(allEntries().filter((e) => e.opId === rec.opId)).toMatchObject([{ kind: 'refused', reason: expect.stringContaining('HTTP 409') }])
  })

  it('a refusal the drain itself recorded (lettered then) is acked silently on a redrain', async () => {
    const id = (await addTask({ title: 'Drained once', project: 'Acme' } as never)).task.id
    const rec = fieldsRec(id, { title: { base: 'Drained once', value: 'x' } })
    recordApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: String(rec.opId), rev: 1 }, { outcome: 'refused', detail: 'earlier', source: 'drain' })
    await drainUntilEmpty(daemon('marina', [rec]))
    expect(allEntries().filter((e) => e.opId === rec.opId)).toEqual([])
  })
})

describe('per-field times on every write path', () => {
  it('updateTasksBulk stamps the fields it changes, so an older away write loses to it', async () => {
    const id = (await addTask({ title: 'Bulk', project: 'Acme' } as never)).task.id
    const awayAt = Date.now() - 1000
    await new Promise((r) => setTimeout(r, 5))
    await updateTasksBulk([{ id, patch: { priority: 'important' } }])
    const t = await getTask(id)
    expect(Date.parse(t.field_at?.priority ?? '')).toBeGreaterThan(awayAt)
    await drainUntilEmpty(daemon('marina', [fieldsRec(id, { priority: { base: 'none', value: 'backlog' } }, { at: awayAt })]))
    expect((await getTask(id)).priority).toBe('important')
  })
})

describe('an equal write still moves its field time when the record changes other fields', () => {
  it('Mac backlog at 09:00, host A writes backlog (equal) plus a title at 11:00, host B writes immediate at 10:00 drained after: backlog stays', async () => {
    const id = (await addTask({ title: 'Times', project: 'Acme' } as never)).task.id
    const t9 = Date.now() - 3 * 3600_000
    await updateTaskRaw(id, { priority: 'backlog' }, { fieldTimes: { at: new Date(t9).toISOString() } })
    await drainUntilEmpty(daemon('acme-box', [fieldsRec(id, { priority: { base: 'none', value: 'backlog' }, title: { base: 'Times', value: 'Times A' } }, { at: t9 + 2 * 3600_000 })]))
    expect(Date.parse((await getTask(id)).field_at?.priority ?? '')).toBe(t9 + 2 * 3600_000)
    await drainUntilEmpty(daemon('marina', [fieldsRec(id, { priority: { base: 'none', value: 'immediate' } }, { at: t9 + 3600_000 })]))
    const t = await getTask(id)
    expect([t.priority, t.title]).toEqual(['backlog', 'Times A'])
  })
})
