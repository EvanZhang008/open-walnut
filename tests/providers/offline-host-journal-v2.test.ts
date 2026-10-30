/**
 * Journal v2 (src/providers/offline-journal-core.ts, plan section 5) and the offline
 * host's writes over it (src/providers/offline-host-core.ts). Real files in temp dirs;
 * a second store on the same dir stands in for a daemon restart or a second process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  JHOME, SID_A, TASK_A, TASK_B, DEVICE, journalTmpDir, cleanupJournalDirs, journalStore, journalHost, jslice,
  gatewayCall, journalLines, keyOf,
} from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { QUEUEABLE_TASK_FIELDS } from '../../src/providers/offline-host-core.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const fields = (f: Record<string, [unknown, unknown]>) => ({ kind: 'task-fields', op: 'task_update', taskId: TASK_A, fields: Object.fromEntries(Object.entries(f).map(([k, [base, value]]) => [k, { base, value }])) })

afterEach(() => cleanupJournalDirs())

describe('journal v2: append, reload, compaction', () => {
  it('appends NDJSON lines with seq, opId, rev and actor, and a second store reads them back', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    const a = j.append(JHOME, fields({ title: ['Leader work', 'Renamed'] }), { actor: DEVICE })
    const b = j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' })
    expect(a).toMatchObject({ ok: true, seq: 1, rev: 1 })
    expect(b).toMatchObject({ ok: true, seq: 2 })
    const lines = journalLines(dir).map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ v: 2, h: 1, home: JHOME })
    expect(lines[1]).toMatchObject({ v: 2, seq: 1, kind: 'task-fields', actor: DEVICE, at: T0 })
    expect(String(lines[1].opId)).toMatch(/^op-[0-9a-f]{16}$/)
    const again = journalStore(dir, clock)
    expect(again.records(JHOME).map((r) => [r.seq, r.kind])).toEqual([[1, 'task-fields'], [2, 'settings']])
    expect(again.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'low' })).toMatchObject({ ok: true, seq: 3 })
  })

  it('compaction keeps exactly the unacked tail, and a later append continues the seqs', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    for (let i = 0; i < 10; i++) j.append(JHOME, { kind: 'settings', sid: SID_A, effort: `e${i}` })
    const d = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS })
    expect(d.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const before = fs.statSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`)).ino
    j.ack(JHOME, { seqs: [1, 2, 3, 4, 5, 6, 7] })
    const lines = journalLines(dir).map((l) => JSON.parse(l))
    expect(lines.filter((l) => typeof l.seq === 'number').map((l) => l.seq)).toEqual([8, 9, 10])
    expect(fs.statSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`)).ino).not.toBe(before)
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'x' })).toMatchObject({ ok: true, seq: 11 })
    const again = journalStore(dir, clock)
    expect(again.records(JHOME).map((r) => r.seq)).toEqual([8, 9, 10, 11])
    // The frozen records are still frozen after the rewrite: an ack of them still lands.
    expect(again.ack(JHOME, { seqs: [8, 9, 10] }).acked.map((r) => r.seq)).toEqual([8, 9, 10])
    expect(journalStore(dir, clock).records(JHOME).map((r) => r.seq)).toEqual([11])
  })

  it('nextSeq comes from disk when state.json is stale, and never goes back after a compaction', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    for (let i = 0; i < 6; i++) j.append(JHOME, { kind: 'settings', sid: SID_A, effort: `e${i}` })
    const stateFile = path.join(dir, `journal-${keyOf(JHOME)}.state.json`)
    fs.writeFileSync(stateFile, JSON.stringify({ v: 2, home: JHOME, journalId: 'aaaaaaaaaaaaaaaa', nextSeq: 3, frozen: [] }))
    expect(journalStore(dir, clock).append(JHOME, { kind: 'settings', sid: SID_A })).toMatchObject({ ok: true, seq: 7 })
    const k = journalStore(dir, clock)
    k.drain(JHOME, { kinds: [] })
    k.ack(JHOME, { seqs: [1, 2, 3, 4, 5, 6, 7] })
    expect(k.records(JHOME)).toEqual([])
    expect(journalStore(dir, clock).append(JHOME, { kind: 'settings', sid: SID_A })).toMatchObject({ ok: true, seq: 8 })
  })

  it('a journal with no slice beside it still loads and drains', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    journalStore(dir, clock).append(JHOME, { kind: 'stop', sid: SID_A, stopRequestId: 'stop-1', requestedAt: '2026-10-14T11:00:00Z' })
    expect(fs.readdirSync(dir).some((n) => n.startsWith('slice-'))).toBe(false)
    const { host } = journalHost(dir, clock)
    expect(host.hasRecords(JHOME)).toBe(true)
    expect(host.drain(JHOME, JOURNAL_V2_DRAINS).records.map((r) => r.kind)).toEqual(['stop'])
  })

  it('opIds are unique across stores and processes on one dir; journal ids are 16 hex', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const a = journalStore(dir, clock)
    const b = journalStore(dir, clock)
    const ids = new Set<string>()
    const seqs = new Set<number>()
    for (let i = 0; i < 300; i++) {
      const r = (i % 2 ? a : b).append(JHOME, { kind: 'settings', sid: SID_A, effort: `e${i}` })
      if (!r.ok) throw new Error(r.message)
      ids.add(r.opId)
      seqs.add(r.seq)
    }
    expect(ids.size).toBe(300)
    expect(seqs.size).toBe(300)
    expect(a.journalIdOf(JHOME)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('journal v2: coalescing, frozen records, duplicates', () => {
  it('a later save of the same task fields by the same actor folds into one record with the FIRST base', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    const first = j.append(JHOME, fields({ title: ['Leader work', 'One'] }), { actor: DEVICE })
    const second = j.append(JHOME, fields({ title: ['One', 'Two'], description: ['first line', 'more'] }), { actor: DEVICE })
    expect(second).toMatchObject({ ok: true, coalesced: true, rev: 2 })
    expect(first.ok && second.ok && second.opId === first.opId).toBe(true)
    const recs = j.records(JHOME)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ rev: 2, supersedes: 1, fields: { title: { base: 'Leader work', value: 'Two' }, description: { base: 'first line', value: 'more' } } })
    // Another actor's save is its own record.
    expect(j.append(JHOME, fields({ title: ['Two', 'Three'] }), { actor: { kind: 'session', sid: SID_A } })).toMatchObject({ ok: true, rev: 1 })
    expect(j.records(JHOME)).toHaveLength(2)
  })

  it('a save onto a FROZEN record appends a new record whose base is the frozen value', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    j.append(JHOME, fields({ title: ['Leader work', 'One'] }), { actor: DEVICE })
    const handed = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records
    const later = j.append(JHOME, fields({ title: ['One', 'Two'] }), { actor: DEVICE })
    expect(later).toMatchObject({ ok: true, seq: 2, rev: 1 })
    expect(later.ok && later.opId).not.toBe(handed[0].opId)
    const recs = j.records(JHOME)
    expect(recs.map((r) => r.seq)).toEqual([1, 2])
    expect(recs[0]).toEqual(handed[0])
    expect(recs[1]).toMatchObject({ fields: { title: { base: 'One', value: 'Two' } } })
    // Pinned case: drain, coalesce into the drained record, ack, drain again = the later save.
    j.ack(JHOME, { seqs: [1] })
    expect(j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records.map((r) => [r.seq, (r.fields as Record<string, { value: unknown }>).title.value])).toEqual([[2, 'Two']])
  })

  it('a duplicate opId append answers the first record and writes nothing', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    const first = j.append(JHOME, { kind: 'task-move', taskId: TASK_A, anchor: null, tier: 'focus' }, { actor: DEVICE, opId: 'op-0123456789abcdef' })
    const lines = journalLines(dir).length
    const again = j.append(JHOME, { kind: 'task-move', taskId: TASK_A, anchor: null, tier: 'focus' }, { actor: DEVICE, opId: 'op-0123456789abcdef' })
    expect(again).toEqual({ ok: true, seq: first.ok ? first.seq : -1, opId: 'op-0123456789abcdef', rev: 1, duplicate: true })
    expect(journalLines(dir)).toHaveLength(lines)
    // After a restart too.
    expect(journalStore(dir, { now: T0 }).append(JHOME, { kind: 'task-move', taskId: TASK_A, anchor: null }, { opId: 'op-0123456789abcdef' })).toMatchObject({ duplicate: true })
  })

  it('a retry of a save that was folded into an older record is a duplicate too', () => {
    const j = journalStore(journalTmpDir(), { now: T0 })
    j.append(JHOME, fields({ title: ['a', 'b'] }), { actor: DEVICE, opId: 'op-save-1' })
    j.append(JHOME, fields({ title: ['b', 'c'] }), { actor: DEVICE, opId: 'op-save-2' })
    expect(j.append(JHOME, fields({ title: ['b', 'c'] }), { actor: DEVICE, opId: 'op-save-2' })).toMatchObject({ duplicate: true, rev: 2 })
    expect(j.records(JHOME)).toHaveLength(1)
  })

  it('120 saves in 60 s on one task by one device fold into one record and are never throttled', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const { host } = journalHost(dir, clock)
    host.configure(jslice())
    for (let i = 0; i < 120; i++) {
      clock.now = T0 + i * 500
      const r = host.handleFollower(JHOME, { op: 'task_update', args: { id: TASK_A, description: `draft ${i}` }, actor: DEVICE, base: { description: 'first line' } })
      expect(r.ok, JSON.stringify(r)).toBe(true)
    }
    const recs = host.journal.records(JHOME)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'task-fields', rev: 120, fields: { description: { base: 'first line', value: 'draft 119' } } })
  })

  it('120 note saves in 60 s on one path fold into one record; the budget is asked once', () => {
    const j = journalStore(journalTmpDir(), { now: T0 })
    let asked = 0
    for (let i = 0; i < 120; i++) {
      const r = j.appendNote(JHOME, { path: 'notes/marina.md', mode: 'put', baseHash: 'h0', base: Buffer.from('base'), ours: Buffer.from(`body ${i}`) }, { actor: DEVICE, admit: () => { asked++; return null } })
      expect(r.ok).toBe(true)
    }
    expect(asked).toBe(1)
    expect(j.records(JHOME)).toHaveLength(1)
  })

  it('distinct writes of one device are throttled at the write budget', () => {
    const { host } = journalHost(journalTmpDir(), { now: T0 })
    host.configure(jslice())
    const out = Array.from({ length: 31 }, (_, i) => host.handleFollower(JHOME, { op: 'task_move', args: { id: i % 2 ? TASK_A : TASK_B, anchor: null, tier: `t${i}` }, actor: DEVICE }))
    expect(out.slice(0, 30).every((r) => r.ok)).toBe(true)
    expect(out[30]).toMatchObject({ ok: false, error: { code: 'throttled' } })
  })
})

describe('journal v2: the kinds gate (old Mac) and the gateway', () => {
  it('refuses task-create for an old Mac (no drains), and writes it for a new one', () => {
    const clock = { now: T0 }
    const old = journalHost(journalTmpDir(), clock, { drains: null })
    old.host.configure(jslice())
    const create = { op: 'task_create', args: { id: 'mtask-new-0001', title: 'From the phone', project: 'Acme' }, actor: DEVICE }
    expect(old.host.handleFollower(JHOME, create)).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    expect(old.journal.records(JHOME)).toEqual([])
    const fresh = journalHost(journalTmpDir(), clock)
    fresh.host.configure(jslice())
    expect(fresh.host.handleFollower(JHOME, create)).toMatchObject({ ok: true, result: { kind: 'task-create' } })
    // A device actor needs a Mac that knows device actors.
    const noDevices = journalHost(journalTmpDir(), clock, { drains: ['task-create'] })
    noDevices.host.configure(jslice())
    expect(noDevices.host.handleFollower(JHOME, create)).toMatchObject({ ok: false, error: { detail: { why: 'mac_too_old' } } })
  })

  it('a session task_update is a v1 op for an old Mac and a task-fields record with bases for a new one', async () => {
    const clock = { now: T0 }
    const old = journalHost(journalTmpDir(), clock, { drains: null })
    old.host.configure(jslice())
    expect((await gatewayCall(old.host, SID_A, 'task_update', { id: TASK_A, title: 'Renamed' })).ok).toBe(true)
    expect(old.journal.records(JHOME)[0]).toMatchObject({ kind: 'op', op: 'task_update', args: { id: TASK_A, title: 'Renamed' }, callerSid: SID_A, base: '2026-10-14T09:00:00Z' })
    const fresh = journalHost(journalTmpDir(), clock)
    fresh.host.configure(jslice())
    expect((await gatewayCall(fresh.host, SID_A, 'task_update', { id: TASK_A, title: 'Renamed', priority: 'high' })).ok).toBe(true)
    expect(fresh.journal.records(JHOME)[0]).toMatchObject({
      kind: 'task-fields', op: 'task_update', taskId: TASK_A, actor: { kind: 'session', sid: SID_A },
      fields: { title: { base: 'Leader work', value: 'Renamed' }, priority: { base: 'unknown', value: 'high' } },
    })
    // The overlay shows the queued value, and a second write's base is what the overlay shows.
    expect(await gatewayCall(fresh.host, SID_A, 'task_get', { id: TASK_A })).toMatchObject({ ok: true, result: { task: { title: 'Renamed' } } })
    await gatewayCall(fresh.host, SID_A, 'task_complete', { id: TASK_A })
    expect(fresh.journal.records(JHOME)[1]).toMatchObject({ kind: 'task-fields', op: 'task_complete', fields: { phase: { base: 'IN_PROGRESS', value: 'COMPLETE' } } })
  })

  it('one field outside the queueable set refuses the whole write (needs_leader, nothing journaled)', async () => {
    const fresh = journalHost(journalTmpDir(), { now: T0 })
    fresh.host.configure(jslice())
    const r = await gatewayCall(fresh.host, SID_A, 'task_update', { id: TASK_A, title: 'ok', archived: true })
    expect(r).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { fields: ['archived'] } } })
    expect(fresh.journal.records(JHOME)).toEqual([])
    expect(fresh.host.QUEUEABLE).toEqual(QUEUEABLE_TASK_FIELDS)
  })

  it('a task outside the copy is taken from the replica with its base; a created task is found by its session', async () => {
    const fresh = journalHost(journalTmpDir(), { now: T0 })
    fresh.host.configure(jslice())
    expect(fresh.host.handleFollower(JHOME, { op: 'task_update', args: { id: 'mtask-elsewhere-9', title: 'x' }, actor: DEVICE, base: { title: 'w' } }))
      .toMatchObject({ ok: true })
    expect(fresh.journal.records(JHOME)[0]).toMatchObject({ taskId: 'mtask-elsewhere-9', fields: { title: { base: 'w', value: 'x' } } })
    fresh.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-ask-0007', title: 'Ask on the host', parent_task_id: TASK_A }, actor: DEVICE })
    fresh.host.handleFollower(JHOME, { op: 'task_update', args: { id: 'mtask-ask-0007', phase: 'IN_PROGRESS' }, actor: DEVICE })
    const got = await gatewayCall(fresh.host, SID_A, 'task_get', { id: 'mtask-ask-0007' })
    expect(got).toMatchObject({ ok: true, result: { task: { id: 'mtask-ask-0007', title: 'Ask on the host', phase: 'IN_PROGRESS', parent_task_id: TASK_A } } })
  })

  it('pendingHandover and hasRecords count only what the leading Mac can drain', () => {
    const clock = { now: T0 }
    const h = journalHost(journalTmpDir(), clock)
    h.host.configure(jslice())
    h.host.handleFollower(JHOME, { op: 'task_move', args: { id: TASK_A, anchor: null, tier: 'focus' }, actor: DEVICE })
    expect(h.host.pendingHandover(JHOME)).toBe(true)
    h.drains.kinds = null
    // An old Mac (a rollback): the parked v2 record never pins the host away.
    expect(h.host.pendingHandover(JHOME)).toBe(false)
    expect(h.host.hasRecords(JHOME)).toBe(false)
    expect(h.host.journalStats(JHOME)).toMatchObject({ records: 1, drainable: 0 })
  })
})

describe('journal v2: failures answer journal_unwritable and keep earlier records', () => {
  it('EACCES on append: journal_unwritable {why: permission}; earlier records kept', async () => {
    const dir = journalTmpDir()
    const h = journalHost(dir, { now: T0 })
    h.host.configure(jslice())
    expect((await gatewayCall(h.host, SID_A, 'task_update', { id: TASK_A, title: 'one' })).ok).toBe(true)
    const file = path.join(dir, `journal-${keyOf(JHOME)}.ndjson`)
    fs.chmodSync(file, 0o400)
    try {
      const r = await gatewayCall(h.host, SID_A, 'task_update', { id: TASK_B, title: 'two' })
      expect(r).toMatchObject({ ok: false, error: { code: 'journal_unwritable', detail: { why: 'permission' } } })
      const f = h.host.handleFollower(JHOME, { op: 'task_move', args: { id: TASK_A, anchor: null }, actor: DEVICE })
      expect(f).toMatchObject({ ok: false, error: { code: 'journal_unwritable' } })
    } finally { fs.chmodSync(file, 0o600) }
    expect(journalStore(dir, { now: T0 }).records(JHOME).map((r) => (r.fields as Record<string, { value: unknown }>).title.value)).toEqual(['one'])
  })

  it('ENOSPC mid-line: journal_unwritable {why: disk_full}; the torn tail is cut and later appends continue', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    let fail = false
    const flaky = {
      ...fs,
      writeSync: (fd: number, buf: any, off?: any, len?: any, pos?: any) => {
        if (fail && Buffer.isBuffer(buf) && buf.toString('utf8').includes('"seq":2')) {
          fs.writeSync(fd, buf, 0, 9)
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        }
        return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, off, len, pos)
      },
    } as unknown as typeof fs
    const j = journalStore(dir, clock, { fs: flaky })
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'a' })).toMatchObject({ ok: true, seq: 1 })
    fail = true
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'b' })).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'disk_full' })
    fail = false
    expect(j.records(JHOME).map((r) => r.seq)).toEqual([1])
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'c' })).toMatchObject({ ok: true, seq: 2 })
    const again = journalStore(dir, clock)
    expect(again.records(JHOME).map((r) => [r.seq, r.effort])).toEqual([[1, 'a'], [2, 'c']])
    expect(again.stats(JHOME, null).unreadableLines).toBe(0)
  })

  it('a daemon that no longer owns its dir refuses with journal_unwritable {why: not_owner}', async () => {
    const owner = { mine: true }
    const h = journalHost(journalTmpDir(), { now: T0 }, { journal: { isOwner: () => owner.mine } })
    h.host.configure(jslice())
    owner.mine = false
    expect(await gatewayCall(h.host, SID_A, 'task_update', { id: TASK_A, title: 'z' })).toMatchObject({ ok: false, error: { code: 'journal_unwritable', detail: { why: 'not_owner' } } })
    expect(h.journal.records(JHOME)).toEqual([])
  })

  it('the blob budget answers queue_full {why: blobs}', () => {
    const j = journalStore(journalTmpDir(), { now: T0 }, { blobBudget: 1000 })
    expect(j.appendNote(JHOME, { path: 'a.md', mode: 'create', ours: Buffer.alloc(600, 1) }, { actor: DEVICE })).toMatchObject({ ok: true })
    expect(j.appendNote(JHOME, { path: 'b.md', mode: 'create', ours: Buffer.alloc(600, 2) }, { actor: DEVICE })).toMatchObject({ ok: false, code: 'queue_full', why: 'blobs' })
    expect(j.records(JHOME)).toHaveLength(1)
  })

  it('the record limit answers queue_full and keeps everything already queued', () => {
    const j = journalStore(journalTmpDir(), { now: T0 }, { maxRecords: 3 })
    for (let i = 0; i < 3; i++) expect(j.append(JHOME, { kind: 'task-move', taskId: `t${i}`, anchor: null }, { limit: true }).ok).toBe(true)
    expect(j.append(JHOME, { kind: 'task-move', taskId: 't9', anchor: null }, { limit: true })).toMatchObject({ ok: false, code: 'queue_full' })
    expect(j.records(JHOME)).toHaveLength(3)
  })
})

describe('journal v2: the note mode table', () => {
  const note = (j: ReturnType<typeof journalStore>, mode: 'put' | 'create' | 'delete', body: string | null, baseHash: string | null = 'h-base') =>
    j.appendNote(JHOME, { path: 'notes/acme.md', mode, baseHash, base: baseHash ? Buffer.from('base body') : null, ours: body === null ? null : Buffer.from(body) }, { actor: DEVICE })
  const blobs = (dir: string) => { try { return fs.readdirSync(path.join(dir, 'blobs')).filter((n) => !n.endsWith('.tmp')).length } catch { return 0 } }

  it.each([
    ['create', 'put', 'create'],
    ['put', 'delete', 'delete'],
    ['delete', 'create', 'put'],
    ['put', 'put', 'put'],
  ] as const)('pending %s then %s folds into %s with the first base', (first, later, folded) => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    note(j, first, first === 'delete' ? null : 'one', first === 'create' ? null : 'h-base')
    note(j, later, later === 'delete' ? null : 'two', 'h-later')
    const recs = j.records(JHOME)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'note', mode: folded, baseHash: first === 'create' ? null : 'h-base', rev: 2 })
    if (folded === 'delete') expect(recs[0].oursBlob).toBeNull()
    else expect(fs.readFileSync(path.join(dir, 'blobs', String(recs[0].oursBlob)), 'utf8')).toBe('two')
  })

  it('pending create then delete drops the record (both folded away)', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    note(j, 'create', 'one', null)
    expect(note(j, 'delete', null)).toMatchObject({ ok: true, dropped: true, coalesced: true })
    expect(j.records(JHOME)).toEqual([])
    expect(journalStore(dir, { now: T0 }).records(JHOME)).toEqual([])
    expect(j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records).toEqual([])
    // No record names the bodies any more: freed at once (under the blob lock).
    expect(blobs(dir)).toBe(0)
  })

  it('an acked note frees its unreferenced body; offline.blob answers in chunks', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    const big = Buffer.alloc(5 * 1024 * 1024, 7)
    expect(j.appendNote(JHOME, { path: 'big.md', mode: 'create', ours: big }, { actor: DEVICE }).ok).toBe(true)
    const rec = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records[0]
    const sha = String(rec.oursBlob)
    const parts: Buffer[] = []
    for (let offset = 0; ;) {
      const r = j.readBlob(sha, offset)
      if (!r.ok) throw new Error(r.message)
      expect(Buffer.from(r.data, 'base64').length).toBeLessThanOrEqual(2 * 1024 * 1024)
      parts.push(Buffer.from(r.data, 'base64'))
      offset += Buffer.from(r.data, 'base64').length
      if (r.done) break
    }
    expect(Buffer.concat(parts).equals(big)).toBe(true)
    const old = Date.now() / 1000 - 120
    fs.utimesSync(path.join(dir, 'blobs', sha), old, old)
    j.ack(JHOME, { seqs: [rec.seq] })
    expect(fs.existsSync(path.join(dir, 'blobs', sha))).toBe(false)
    expect(j.readBlob('nope', 0)).toMatchObject({ ok: false, code: 'bad_request' })
  })
})

describe('journal v2: drain and ack for new and old Macs', () => {
  it('kinds filter before the batch cut: 250 parked records at the head never starve the rest', () => {
    const j = journalStore(journalTmpDir(), { now: T0 })
    for (let i = 0; i < 250; i++) j.append(JHOME, { kind: 'session', sid: `s${i}`, taskId: `t${i}` })
    for (let i = 0; i < 5; i++) j.append(JHOME, { kind: 'task-move', taskId: `t${i}`, anchor: null })
    const d = j.drain(JHOME, { kinds: ['task-move'], batch: 200 })
    expect(d.records.map((r) => r.kind)).toEqual(Array(5).fill('task-move'))
    expect(d.more).toBe(false)
    expect(typeof d.now).toBe('number')
  })

  it('an old Mac is handed only the v1 prefix, and its upTo ack drops only what it was handed', () => {
    const j = journalStore(journalTmpDir(), { now: T0 })
    j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'a' })
    j.append(JHOME, { kind: 'task-move', taskId: TASK_A, anchor: null })
    j.append(JHOME, { kind: 'stop', sid: SID_A, stopRequestId: 's1', requestedAt: 'x' })
    const d = j.drain(JHOME, { kinds: null })
    expect(d.records.map((r) => r.seq)).toEqual([1])
    j.ack(JHOME, { upTo: 3 })
    expect(j.records(JHOME).map((r) => r.seq)).toEqual([2, 3])
    // A new Mac then drains the rest.
    expect(j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records.map((r) => r.seq)).toEqual([2, 3])
  })

  it('an explicit ack keeps every seq it does not name, and never drops a seq not handed out', () => {
    const j = journalStore(journalTmpDir(), { now: T0 })
    for (let i = 0; i < 4; i++) j.append(JHOME, { kind: 'settings', sid: SID_A, effort: `e${i}` })
    j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS, batch: 3 })
    const r = j.ack(JHOME, { seqs: [1, 3, 4] })
    expect(r.acked.map((x) => x.seq)).toEqual([1, 3])
    expect(r.ignored).toEqual([4])
    expect(j.records(JHOME).map((x) => x.seq)).toEqual([2, 4])
  })

  it('a torn last line is dropped and reported at the next locked write', () => {
    const dir = journalTmpDir()
    const j = journalStore(dir, { now: T0 })
    j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'a' })
    fs.appendFileSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`), '{"v":2,"seq":2,"kind":"sett')
    const again = journalStore(dir, { now: T0 })
    expect(again.records(JHOME).map((r) => r.seq)).toEqual([1])
    expect(again.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'b' })).toMatchObject({ ok: true, seq: 2 })
    expect(again.stats(JHOME, null).tornDropped).toBe(1)
    expect(journalLines(dir).every((l) => { try { JSON.parse(l); return true } catch { return false } })).toBe(true)
  })
})

describe('journal v2: v1 journals written by the 1fe1fd194 daemon migrate at every boot', () => {
  async function oldDaemonWrites(dir: string, clock: { now: number }, what: (h: Record<string, any>) => Promise<void>) {
    const { oldOfflineHost } = await import('../helpers/v1-daemon-sources.js')
    const create = await oldOfflineHost()
    const { createEnvelopeKit } = await import('../../src/core/peers/envelope-kit.js')
    const { randomBytes } = await import('node:crypto')
    const old = create({
      fs, path, dir, now: () => clock.now, randomHex: (n: number) => randomBytes(n).toString('hex'), keyOf, kit: createEnvelopeKit(),
      log: () => {}, isLive: () => true, turnActive: () => false, streamOffset: () => undefined, deliver: async () => ({ ok: true }),
    })
    old.configure(jslice())
    await what(old)
    return old
  }
  const v1File = (dir: string) => path.join(dir, `journal-${keyOf(JHOME)}.json`)

  afterEach(async () => { (await import('../helpers/v1-daemon-sources.js')).cleanupOldSources() })

  it('appends every v1 record as v2 in order, keeps its time, merges its rows, renames the file', async () => {
    const legacy = journalTmpDir()
    const clock = { now: T0 }
    await oldDaemonWrites(legacy, clock, async (old) => {
      await old.handle(JHOME, SID_A, 'tools.call', { name: 'task_update', args: { id: TASK_A, title: 'Old title' } })
      clock.now += 1000
      old.noteSettings(JHOME, SID_A, { effort: 'high' })
      await old.handle(JHOME, SID_A, 'tools.call', { name: 'task_send', args: { to: TASK_B, text: 'please answer', expect_reply: true } })
    })
    const v1 = JSON.parse(fs.readFileSync(v1File(legacy), 'utf8'))
    expect(v1.records.map((r: { kind: string }) => r.kind)).toEqual(['op', 'settings', 'row', 'delivery'])
    const dir = journalTmpDir()
    const j = journalStore(dir, clock)
    expect(j.migrateSlices([legacy])).toBe(1)
    const r = j.migrateV1([legacy])
    expect(r).toMatchObject({ files: 1, records: 4, unconverted: 0, kept: 0 })
    const recs = j.records(JHOME)
    expect(recs.map((x) => [x.kind, x.v1Seq, x.at])).toEqual(v1.records.map((x: { kind: string; seq: number; at: number }) => [x.kind, x.seq, x.at]))
    // The op id comes from the record itself (not the file), so a file rewritten later keeps it.
    expect(recs.every((x) => /^v1-[0-9a-f]{16}$/.test(String(x.opId)))).toBe(true)
    expect(new Set(recs.map((x) => x.opId)).size).toBe(4)
    expect(recs[0]).toMatchObject({ kind: 'op', op: 'task_update', args: { id: TASK_A, title: 'Old title' }, actor: { kind: 'session', sid: SID_A } })
    expect(Object.keys(j.state(JHOME).rows)).toEqual(Object.keys(v1.rows))
    expect(fs.existsSync(v1File(legacy))).toBe(false)
    expect(fs.existsSync(`${v1File(legacy)}.migrated`)).toBe(true)
    expect(fs.readFileSync(`${v1File(legacy)}.migrated`, 'utf8')).toBe(JSON.stringify(v1))
    // The offline host over the new dir drains them, slice and all.
    const h = journalHost(dir, clock, { drains: null })
    expect(h.host.hasHome(JHOME)).toBe(true)
    expect(h.host.drain(JHOME, null).records.map((x) => x.kind)).toEqual(['op', 'settings', 'row', 'delivery'])
  })

  it('a crash before the rename, or a failed rename, never imports a record twice', async () => {
    const legacy = journalTmpDir()
    const clock = { now: T0 }
    await oldDaemonWrites(legacy, clock, async (old) => { old.noteSettings(JHOME, SID_A, { effort: 'low' }); old.noteStop(JHOME, SID_A, { id: 'stop-1', requestedAt: 'x' }) })
    const raw = fs.readFileSync(v1File(legacy), 'utf8')
    const dir = journalTmpDir()
    const j = journalStore(dir, clock)
    j.migrateSlices([legacy])
    j.migrateV1([legacy])
    fs.writeFileSync(v1File(legacy), raw)
    expect(journalStore(dir, clock).migrateV1([legacy])).toMatchObject({ files: 1, records: 0 })
    // Even after the Mac took them (acked): the file id is remembered.
    const k = journalStore(dir, clock)
    k.drain(JHOME, { kinds: null })
    k.ack(JHOME, { upTo: 99 })
    fs.writeFileSync(v1File(legacy), raw)
    expect(journalStore(dir, clock).migrateV1([legacy])).toMatchObject({ records: 0 })
    expect(journalStore(dir, clock).records(JHOME)).toEqual([])
  })

  it('downgrade then upgrade: the v1 records the old daemon wrote meanwhile are taken too (R30)', async () => {
    const legacy = journalTmpDir()
    const clock = { now: T0 }
    const dir = journalTmpDir()
    await oldDaemonWrites(legacy, clock, async (old) => { old.noteSettings(JHOME, SID_A, { effort: 'low' }) })
    journalStore(dir, clock).migrateSlices([legacy])
    journalStore(dir, clock).migrateV1([legacy])
    journalStore(dir, clock).append(JHOME, { kind: 'task-move', taskId: TASK_A, anchor: null })
    clock.now += 60_000
    await oldDaemonWrites(legacy, clock, async (old) => { old.noteSettings(JHOME, SID_A, { effort: 'max' }) })
    const r = journalStore(dir, clock).migrateV1([legacy])
    expect(r).toMatchObject({ files: 1, records: 1 })
    expect(journalStore(dir, clock).records(JHOME).map((x) => [x.kind, x.effort ?? null])).toEqual([['settings', 'low'], ['task-move', null], ['settings', 'max']])
  })

  it('v1 files of one Walnut in two legacy dirs go in by the time of their records, not dir order', async () => {
    // A home fallback daemon (its own dir, listed first) and /tmp/open-walnut (listed second):
    // the server used /tmp first, then the fallback.
    const fallback = journalTmpDir()
    const tmpDir = journalTmpDir()
    const dir = journalTmpDir()
    const clock = { now: T0 }
    await oldDaemonWrites(tmpDir, clock, async (o) => { o.noteSettings(JHOME, SID_A, { effort: 'low' }); clock.now += 10; o.noteStop(JHOME, SID_A, { id: 'stop-1', requestedAt: 'x' }) })
    clock.now += 3_600_000
    await oldDaemonWrites(fallback, clock, async (o) => { o.noteSettings(JHOME, SID_A, { effort: 'max' }) })
    const j = journalStore(dir, clock)
    j.migrateSlices([fallback, tmpDir])
    expect(j.migrateV1([fallback, tmpDir])).toMatchObject({ files: 2, records: 3 })
    expect(j.records(JHOME).map((r) => [r.kind, r.effort ?? null])).toEqual([['settings', 'low'], ['stop', null], ['settings', 'max']])
  })

  it('a v1 file an older instance writes again later (all its records) brings back none the Mac acked', async () => {
    const legacy = journalTmpDir()
    const dir = journalTmpDir()
    const clock = { now: T0 }
    // The 1fe1fd194 instance keeps running after daemon.pid moved (until its heartbeat check).
    const old = await oldDaemonWrites(legacy, clock, async (o) => { o.noteSettings(JHOME, SID_A, { effort: 'low' }) })
    const j = journalStore(dir, clock)
    j.migrateSlices([legacy])
    expect(j.migrateV1([legacy])).toMatchObject({ files: 1, records: 1 })
    j.drain(JHOME, { kinds: null })
    expect(j.ack(JHOME, { upTo: 99 }).acked.map((r) => r.effort)).toEqual(['low'])
    clock.now += 5000
    old.noteSettings(JHOME, SID_A, { effort: 'max' })
    expect(JSON.parse(fs.readFileSync(v1File(legacy), 'utf8')).records.map((r: { effort: string }) => r.effort)).toEqual(['low', 'max'])
    const k = journalStore(dir, clock)
    expect(k.migrateV1([legacy])).toMatchObject({ files: 1, records: 1 })
    expect(k.records(JHOME).map((r) => r.effort)).toEqual(['max'])
    // And the same again (its next write): still only what the Mac never took.
    k.drain(JHOME, { kinds: null })
    k.ack(JHOME, { upTo: 99 })
    clock.now += 5000
    old.noteStop(JHOME, SID_A, { id: 'stop-9', requestedAt: 'x' })
    const m = journalStore(dir, clock)
    expect(m.migrateV1([legacy])).toMatchObject({ records: 1 })
    expect(m.records(JHOME).map((r) => r.kind)).toEqual(['stop'])
  })

  it('a v1 file an older instance writes again later never brings back a request row the Mac took', async () => {
    const legacy = journalTmpDir()
    const dir = journalTmpDir()
    const clock = { now: T0 }
    // The 1fe1fd194 instance asks task B for a reply while the Mac is away (a row and its record).
    const old = await oldDaemonWrites(legacy, clock, async (o) => {
      await o.handle(JHOME, SID_A, 'tools.call', { name: 'task_send', args: { to: TASK_B, text: 'please answer', expect_reply: true } })
    })
    const rowIds = Object.keys(JSON.parse(fs.readFileSync(v1File(legacy), 'utf8')).rows)
    expect(rowIds).toHaveLength(1)
    const j = journalStore(dir, clock)
    j.migrateSlices([legacy])
    expect(j.migrateV1([legacy])).toMatchObject({ files: 1, records: 2 })
    // The Mac takes the row: the offline host's ack drops it.
    const h = journalHost(dir, clock, { drains: null })
    const d = h.host.drain(JHOME, null)
    expect(d.records.map((x) => x.kind)).toEqual(['row', 'delivery'])
    h.host.ack(JHOME, Math.max(...d.records.map((x) => x.seq)))
    expect(Object.keys(journalStore(dir, clock).state(JHOME).rows)).toEqual([])
    // The old instance writes again from its memory (row, record and a new stop).
    clock.now += 5000
    old.noteStop(JHOME, SID_A, { id: 'stop-9', requestedAt: 'x' })
    expect(Object.keys(JSON.parse(fs.readFileSync(v1File(legacy), 'utf8')).rows)).toEqual(rowIds)
    const k = journalStore(dir, clock)
    expect(k.migrateV1([legacy])).toMatchObject({ files: 1, records: 1 })
    expect(k.records(JHOME).map((r) => r.kind)).toEqual(['stop'])
    expect(Object.keys(k.state(JHOME).rows)).toEqual([])
  })

  it('an append that fails mid-migration keeps the file; the records the Mac acked meanwhile are not imported again', async () => {
    const legacy = journalTmpDir()
    const dir = journalTmpDir()
    const clock = { now: T0 }
    await oldDaemonWrites(legacy, clock, async (o) => { o.noteSettings(JHOME, SID_A, { effort: 'low' }); o.noteStop(JHOME, SID_A, { id: 'stop-1', requestedAt: 'x' }) })
    let migrated = 0
    const full = new Proxy(fs, {
      get(t, k) {
        if (k !== 'writeSync') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (fd: number, buf: unknown, ...rest: unknown[]) => {
          const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
          if (text.includes('"v1Seq"') && ++migrated === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
          return (t.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest)
        }
      },
    })
    const j = journalStore(dir, clock, { fs: full as typeof fs })
    j.migrateSlices([legacy])
    expect(j.migrateV1([legacy])).toMatchObject({ files: 0, kept: 1 })
    expect(fs.existsSync(v1File(legacy))).toBe(true)
    const mac = journalStore(dir, clock)
    const d = mac.drain(JHOME, { kinds: null })
    expect(d.records.map((r) => r.kind)).toEqual(['settings'])
    expect(mac.ack(JHOME, { upTo: d.records[0].seq }).acked).toHaveLength(1)
    const boot2 = journalStore(dir, clock)
    expect(boot2.migrateV1([legacy])).toMatchObject({ files: 1, records: 1 })
    expect(boot2.records(JHOME).map((r) => r.kind)).toEqual(['stop'])
  })

  it('a migration left part way refuses new writes for that Walnut until the file is finished, so nothing lands ahead of its records', async () => {
    const legacy = journalTmpDir()
    const dir = journalTmpDir()
    const clock = { now: T0 }
    await oldDaemonWrites(legacy, clock, async (o) => {
      o.noteSettings(JHOME, SID_A, { effort: 'low' })
      clock.now += 10
      o.noteSettings(JHOME, SID_A, { cliModel: 'acme-model-1' })
    })
    let migrated = 0
    const full = new Proxy(fs, {
      get(t, k) {
        if (k !== 'writeSync') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (fd: number, buf: unknown, ...rest: unknown[]) => {
          const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
          if (text.includes('"v1Seq"') && ++migrated === 2) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
          return (t.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest)
        }
      },
    })
    // The daemon's one store: the migration and every later write share it.
    const j = journalStore(dir, clock, { fs: full as typeof fs })
    j.migrateSlices([legacy])
    expect(j.migrateV1([legacy])).toMatchObject({ files: 0, kept: 1, records: 1 })
    // A newer change (a session sets the model again) is refused, not queued ahead of the rest.
    const refused = j.append(JHOME, { kind: 'settings', sid: SID_A, cliModel: 'acme-model-2' })
    expect(refused).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'migrating' })
    // Another Walnut on this host writes as usual.
    expect(j.append('/fixture/acme-other-home', { kind: 'stop', sid: SID_A })).toMatchObject({ ok: true })
    // Later the file can be finished: the next write moves the rest in first, then lands after it.
    clock.now += 2000
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, cliModel: 'acme-model-2' })).toMatchObject({ ok: true })
    expect(fs.existsSync(`${v1File(legacy)}.migrated`)).toBe(true)
    const recs = j.drain(JHOME, { kinds: null }).records as unknown as Array<{ effort?: string; cliModel?: string; v1Seq?: number }>
    expect(recs.map((r) => r.effort ?? r.cliModel)).toEqual(['low', 'acme-model-1', 'acme-model-2'])
    expect(recs.map((r) => r.v1Seq !== undefined)).toEqual([true, true, false])
  })

  it('a record that cannot be converted is never dropped: the file is set aside untouched', () => {
    const legacy = journalTmpDir()
    const dir = journalTmpDir()
    fs.writeFileSync(path.join(legacy, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice()))
    const body = JSON.stringify({ nextSeq: 3, records: [{ seq: 1, at: T0, kind: 'settings', sid: SID_A, effort: 'low' }, { at: T0, junk: true }], rows: {}, settledCopies: [] })
    fs.writeFileSync(v1File(legacy), body)
    const j = journalStore(dir, { now: T0 })
    expect(j.migrateV1([legacy])).toMatchObject({ files: 1, records: 1, unconverted: 1 })
    expect(fs.readFileSync(`${v1File(legacy)}.unconverted`, 'utf8')).toBe(body)
    // A v1 journal whose Walnut nothing names stays where it is.
    const orphan = path.join(legacy, 'journal-0123456789abcdef.json')
    fs.writeFileSync(orphan, JSON.stringify({ nextSeq: 2, records: [{ seq: 1, at: T0, kind: 'stop', sid: SID_A }] }))
    expect(j.migrateV1([legacy])).toMatchObject({ kept: 1 })
    expect(fs.existsSync(orphan)).toBe(true)
  })

  it('a v1 file without a records list (null, an object, a top level that is not an object) is set aside unconverted, never labelled migrated', () => {
    const shapes = [
      { nextSeq: 2, records: null, rows: { 'req-acme': { id: 'req-acme', state: 'pending' } } },
      { nextSeq: 2, records: { 1: { seq: 1, at: T0, kind: 'stop', sid: SID_A } } },
      null,
      [{ seq: 1, at: T0, kind: 'stop', sid: SID_A }],
      'marina',
    ]
    for (const shape of shapes) {
      const legacy = journalTmpDir()
      const dir = journalTmpDir()
      fs.writeFileSync(path.join(legacy, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice()))
      const body = JSON.stringify(shape)
      fs.writeFileSync(v1File(legacy), body)
      const j = journalStore(dir, { now: T0 })
      expect(j.migrateV1([legacy]), body).toMatchObject({ records: 0, unconverted: 1 })
      expect(fs.existsSync(`${v1File(legacy)}.migrated`), body).toBe(false)
      expect(fs.readFileSync(`${v1File(legacy)}.unconverted`, 'utf8')).toBe(body)
      expect(j.records(JHOME)).toEqual([])
      // Nothing of it was taken: no rows, no remembered file id.
      const st = j.state(JHOME) as unknown as { rows: Record<string, unknown>; migratedV1?: string[] }
      expect(st.rows).toEqual({})
      expect(st.migratedV1 ?? []).toEqual([])
    }
  })
})

describe('journal v2: rebuilt from its text (the source twin inlines both cores)', () => {
  it('createOfflineJournal and createOfflineHostCore behave the same when reconstructed with new Function', async () => {
    const { createOfflineJournal } = await import('../../src/providers/offline-journal-core.js')
    const { createOfflineHostCore } = await import('../../src/providers/offline-host-core.js')
    const { createEnvelopeKit } = await import('../../src/core/peers/envelope-kit.js')
    const { randomBytes, createHash } = await import('node:crypto')
    const rebuiltJournal = new Function('"use strict"; return ' + createOfflineJournal.toString())() as typeof createOfflineJournal
    const rebuiltHost = new Function('"use strict"; return ' + createOfflineHostCore.toString())() as typeof createOfflineHostCore
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const journal = rebuiltJournal({
      fs, path, dir, now: () => clock.now, randomHex: (n) => randomBytes(n).toString('hex'), keyOf,
      sha256: (b) => createHash('sha256').update(b).digest('hex'), log: () => {},
    })
    const host = rebuiltHost({
      fs, path, dir, now: () => clock.now, randomHex: (n) => randomBytes(n).toString('hex'), keyOf, kit: createEnvelopeKit(), log: () => {},
      isLive: () => true, turnActive: () => false, streamOffset: () => undefined, deliver: async () => ({ ok: true }),
      journal, drainsOf: () => JOURNAL_V2_DRAINS.slice(),
    })
    host.configure(jslice())
    expect(host.handleFollower(JHOME, { op: 'task_update', args: { id: TASK_A, title: 'x' }, actor: DEVICE })).toMatchObject({ ok: true })
    expect(host.handleFollower(JHOME, { op: 'task_update', args: { id: TASK_A, title: 'y' }, actor: DEVICE })).toMatchObject({ ok: true, result: { coalesced: true, rev: 2 } })
    const d = host.drain(JHOME, JOURNAL_V2_DRAINS)
    expect(d.records).toHaveLength(1)
    expect(host.ack(JHOME, { seqs: [d.records[0].seq] })).toMatchObject({ remaining: 0 })
  })

  it('the generated source twin carries the journal core once and passes its build-time smoke', async () => {
    const { getDaemonSource } = await import('../../src/providers/daemon-source.js')
    const src = getDaemonSource()
    expect(src).not.toContain('__CREATE_OFFLINE_JOURNAL__')
    expect(src.split('function createOfflineJournal(').length - 1).toBe(1)
    expect(src).toContain("case 'follower.op':")
    expect(src).toContain("case 'offline.blob':")
  })
})

describe('journal v2: the daemon keeps its append fd open (keepOpen)', () => {
  const move = (taskId: string, tier: string) => ({ kind: 'task-move', taskId, anchor: null, tier })

  it('follows a compaction and a journal a person moved aside, and never writes into a replaced file', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const daemon = journalStore(dir, clock, { keepOpen: true })
    const other = journalStore(dir, clock)
    for (let i = 0; i < 6; i++) expect(daemon.append(JHOME, move(TASK_A, `k${i}`)).ok).toBe(true)
    // Another process drains, acks most of it and compacts: the file is a new inode now.
    const handed = other.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records
    other.ack(JHOME, { seqs: handed.slice(0, 5).map((r) => r.seq) })
    expect(other.compact(JHOME)).toBe(true)
    expect(daemon.append(JHOME, move(TASK_B, 'after-compact')).ok).toBe(true)
    const fresh = journalStore(dir, clock)
    expect(fresh.records(JHOME).map((r) => r.tier)).toEqual(['k5', 'after-compact'])
    // A person moves the journal aside: the next append starts a new file, never the old inode.
    setAside(dir)
    expect(daemon.append(JHOME, move(TASK_A, 'after-retire')).ok).toBe(true)
    const file = path.join(dir, `journal-${keyOf(JHOME)}.ndjson`)
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.filter((l) => l.kind).map((l) => l.tier)).toEqual(['after-retire'])
    expect(lines[0]).toMatchObject({ v: 2, h: 1, home: JHOME })
    expect(fs.readdirSync(dir).some((n) => /\.ndjson\.moved-\d+$/.test(n))).toBe(true)
    daemon.close()
    // close() releases the fd; the store reopens on the next append.
    expect(daemon.append(JHOME, move(TASK_B, 'after-close')).ok).toBe(true)
    expect(journalStore(dir, clock).records(JHOME).map((r) => r.tier)).toEqual(['after-retire', 'after-close'])
    daemon.close()
  })

  it('a lock removed as stale while held is not removed again at release (the next holder keeps it)', () => {
    const dir = journalTmpDir()
    const lockFile = path.join(dir, `journal-${keyOf(JHOME)}.lock`)
    // While the line is written (the lock held), another writer judges the lock stale and takes it.
    const thief = {
      ...fs,
      writeSync: (fd: number, buf: any, ...rest: any[]) => {
        if (Buffer.isBuffer(buf) && buf.toString('utf8').includes('"tier":"steal"')) {
          fs.unlinkSync(lockFile)
          fs.writeFileSync(lockFile, '1 another-writer')
        }
        return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest)
      },
    } as unknown as typeof fs
    const s = journalStore(dir, { now: T0 }, { keepOpen: true, fs: thief })
    expect(s.append(JHOME, move(TASK_A, 'one')).ok).toBe(true)
    // A released lock leaves no file behind.
    expect(fs.existsSync(lockFile)).toBe(false)
    expect(s.append(JHOME, move(TASK_A, 'steal')).ok).toBe(true)
    // The release saw its own file unlinked (no link left) and left the new holder's lock alone.
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('1 another-writer')
    s.close()
  })
})

describe('journal v2: a replica retry, coalesced growth, retired inputs (review fixes)', () => {
  const BOARD = { taskId: TASK_A, html: '<p>alpha</p><p>omega</p>', version: 3 }
  const boardHost = () => {
    const dir = journalTmpDir()
    const h = journalHost(dir, { now: T0 }, { boards: true })
    h.host.configure(jslice({ boards: [BOARD] } as never))
    return { ...h, dir }
  }

  it('a retry with the same opId answers the saved record for board_edit, board_set and board_post, before any gate', () => {
    const { host, journal, drains } = boardHost()
    const writes = [
      { op: 'board_edit', args: { task: TASK_A, version: 3, edits: [{ old: 'alpha', new: 'beta' }] }, actor: DEVICE, opId: 'op-edit-version' },
      { op: 'board_edit', args: { task: TASK_A, edits: [{ old: 'omega', new: 'psi' }] }, actor: DEVICE, opId: 'op-edit-text' },
      { op: 'board_set', args: { task: TASK_A, version: 5, html: '<p>fresh</p>' }, actor: DEVICE, opId: 'op-set-version' },
      { op: 'board_post', args: { task: TASK_A, thread: 'api', text: 'On it.' }, actor: DEVICE, opId: 'op-post' },
    ]
    const firsts = writes.map((w) => host.handleFollower(JHOME, w) as { ok: boolean; result: Record<string, unknown> })
    for (const f of firsts) expect(f, JSON.stringify(f)).toMatchObject({ ok: true, result: { queued: true, kind: 'board' } })
    // Each first attempt moved the overlay: the same write, checked again, would now fail.
    expect(host.handleFollower(JHOME, { ...writes[0], opId: 'op-edit-version-2' })).toMatchObject({ ok: false, error: { code: 'board_version_conflict' } })
    // The lost answer is asked again: the saved record answers, nothing is written.
    writes.forEach((w, i) => {
      expect(host.handleFollower(JHOME, w)).toMatchObject({ ok: true, result: { duplicate: true, seq: firsts[i].result.seq, opId: w.opId, kind: 'board' } })
    })
    // Even when the gates would now refuse it (the leading Mac rolled back to an older build).
    drains.kinds = null
    expect(host.handleFollower(JHOME, writes[3])).toMatchObject({ ok: true, result: { duplicate: true, seq: firsts[3].result.seq } })
    expect(journal.records(JHOME).filter((r) => r.kind === 'board')).toHaveLength(4)
  })

  it('coalesced saves compact the file as they fold: 300 saves of a 20 KB description stay one record in a small file', async () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const { host, journal } = journalHost(dir, clock)
    host.configure(jslice())
    const big = (i: number) => `${i} `.padEnd(20 * 1024, 'x')
    for (let i = 0; i < 300; i++) {
      clock.now += 100
      const r = await gatewayCall(host, SID_A, 'task_update', { id: TASK_A, description: big(i) })
      expect(r, JSON.stringify(r).slice(0, 300)).toMatchObject({ ok: true })
    }
    const recs = journal.records(JHOME)
    expect(recs).toHaveLength(1)
    // A folded field carries its own write time (WP9 review: each field is judged by when it was written).
    expect((recs[0].fields as Record<string, { base: unknown; value: unknown }>).description).toEqual({ base: 'first line', value: big(299), at: expect.any(Number) })
    const size = fs.statSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`)).size
    // Live: one 20 KB line. A fold leaves at most about as many dead bytes before it compacts.
    expect(size).toBeLessThan(3 * 21 * 1024)
    expect(journalStore(dir, clock).records(JHOME).map((r) => r.rev)).toEqual([300])
  })

  it('a task_update carrying the retired wait_report input queues without it (a v2 Mac and a v1 Mac)', async () => {
    const dir = journalTmpDir()
    const { host, journal, drains } = journalHost(dir, { now: T0 })
    host.configure(jslice())
    const park = { id: TASK_A, phase: 'WAITING', wait_report: 'Parked until the review lands.' }
    expect(await gatewayCall(host, SID_A, 'task_update', park)).toMatchObject({ ok: true, result: { queued: true } })
    expect(journal.records(JHOME)[0]).toMatchObject({ kind: 'task-fields', fields: { phase: { value: 'WAITING' } } })
    expect(Object.keys(journal.records(JHOME)[0].fields as object)).toEqual(['phase'])
    expect(host.handleFollower(JHOME, { op: 'task_update', args: { ...park, id: TASK_B }, actor: DEVICE })).toMatchObject({ ok: true })
    drains.kinds = null
    expect(await gatewayCall(host, SID_A, 'task_update', { ...park, id: TASK_B })).toMatchObject({ ok: true, result: { queued: true } })
    // A park's waiting_on (the park gate's words, no task field) is dropped too, never a refusal.
    expect(await gatewayCall(host, SID_A, 'task_update', { id: TASK_A, phase: 'WAITING', waiting_on: 'the CI run on main' })).toMatchObject({ ok: true, result: { queued: true } })
    // The host's list is the op's own retiredInput, plus waiting_on.
    const src = fs.readFileSync(path.join(__dirname, '../../src/ops/tasks.ts'), 'utf8')
    const declared = /name: 'task_update',[\s\S]*?retiredInput: \[([^\]]*)\]/.exec(src)?.[1]
    expect(declared && [...declared.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean), 'waiting_on']).toEqual(host.RETIRED_TASK_INPUTS)
  })
})

describe('journal v2: a held lock, a zombie, the replica overlay, leaked bodies (review fixes)', () => {
  const lockFile = (dir: string) => path.join(dir, `journal-${keyOf(JHOME)}.lock`)

  it('a live foreign lock holder costs one short wait, then answers at once; a drain hands out nothing it could not freeze', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'low' })).toMatchObject({ ok: true, seq: 1 })
    // Another live process (this test's parent) holds the lock and does not let go.
    fs.writeFileSync(lockFile(dir), `${process.ppid} -`)
    let t = Date.now()
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' })).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'locked' })
    const first = Date.now() - t
    expect(first).toBeGreaterThanOrEqual(200)
    expect(first).toBeLessThan(1500)
    t = Date.now()
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'max' })).toMatchObject({ ok: false, why: 'locked' })
    const d = j.drain(JHOME, { kinds: null })
    expect(Date.now() - t).toBeLessThan(150)
    expect(d).toMatchObject({ records: [], more: false, why: 'locked' })
    expect(j.ack(JHOME, { upTo: 1 }).error).toBeTruthy()
    // The holder lets go: the record was never frozen, so it drains and acks normally.
    fs.unlinkSync(lockFile(dir))
    const again = j.drain(JHOME, { kinds: null })
    expect(again.records.map((r) => r.seq)).toEqual([1])
    expect(j.ack(JHOME, { upTo: 1 })).toMatchObject({ remaining: 0 })
  })

  it('a daemon that no longer owns its dir drains, acks and persists nothing (its stale rows never reach state.json)', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const owner = { now: true }
    const zombie = journalStore(dir, clock, { isOwner: () => owner.now })
    zombie.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'low' })
    zombie.persist(JHOME)
    const stateFile = path.join(dir, `journal-${keyOf(JHOME)}.state.json`)
    const before = fs.readFileSync(stateFile, 'utf8')
    owner.now = false
    zombie.state(JHOME).rows['row-stale'] = { id: 'row-stale' }
    zombie.persist(JHOME)
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before)
    expect(zombie.drain(JHOME, { kinds: null })).toMatchObject({ records: [], why: 'not_owner' })
    expect(zombie.ack(JHOME, { upTo: 1 }).error).toMatch(/no longer owns/)
    // The owner still has it all.
    const live = journalStore(dir, clock)
    expect(live.drain(JHOME, { kinds: null }).records).toHaveLength(1)
  })

  it('follower.pending names the journal and every live seq, so an overlay drops acked and folded records and sees a reset', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    j.appendNote(JHOME, { path: 'notes/a.md', mode: 'create', ours: Buffer.from('a') })
    j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'low' })
    const first = j.pending(JHOME, 0)
    expect(first.journalId).toMatch(/^[0-9a-f]{16}$/)
    expect(first.liveSeqs).toEqual([1, 2])
    // The note is deleted (its create folds away) and the settings record is acked.
    j.appendNote(JHOME, { path: 'notes/a.md', mode: 'delete' })
    const d = j.drain(JHOME, { kinds: null })
    j.ack(JHOME, { seqs: d.records.filter((r) => r.kind === 'settings').map((r) => r.seq) })
    const later = j.pending(JHOME, 2)
    expect(later.records).toEqual([])
    expect(later.liveSeqs).toEqual([])
    expect(later.journalId).toBe(first.journalId)
    // The journal is set aside (by a person): a new id, seqs from 1 again.
    setAside(dir)
    const k = journalStore(dir, clock)
    k.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'max' })
    const reset = k.pending(JHOME, 2)
    expect(reset.journalId).not.toBe(first.journalId)
    expect(reset.liveSeqs).toEqual([1])
  })
})

describe('journal v2: leaked note bodies (review fixes)', () => {
  it('a body whose record was refused is removed once an hour passed; a body a record names stays', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock, { maxRecords: 1 })
    expect(j.appendNote(JHOME, { path: 'notes/kept.md', mode: 'create', ours: Buffer.from('kept body') })).toMatchObject({ ok: true })
    // The record limit refuses the next save after its body was written.
    expect(j.appendNote(JHOME, { path: 'notes/lost.md', mode: 'create', ours: Buffer.from('lost body') })).toMatchObject({ ok: false, code: 'queue_full' })
    const blobs = path.join(dir, 'blobs')
    const lost = path.join(blobs, sha256Hex('lost body'))
    const kept = path.join(blobs, sha256Hex('kept body'))
    // The refused save freed its own body before it answered (no record names it).
    expect(fs.existsSync(lost)).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)
    // What a crash between a body and its record leaves: within the hour nothing is taken.
    fs.writeFileSync(lost, 'lost body')
    expect(journalStore(dir, clock).sweepBlobs(true)).toBe(0)
    const old = new Date(Date.now() - 2 * 3600_000)
    const live = journalStore(dir, clock)
    for (const f of [lost, kept]) fs.utimesSync(f, old, old)
    expect(live.sweepBlobs(true)).toBe(1)
    expect(fs.existsSync(lost)).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)
    // Building a store sweeps nothing (every run of the daemon binary builds one); the
    // boot migration does (offline-journal-migration.test.ts).
    fs.writeFileSync(lost, 'lost body')
    fs.utimesSync(lost, old, old)
    journalStore(dir, clock).records(JHOME)
    expect(fs.existsSync(lost)).toBe(true)
    // A store that does not own its dir never sweeps.
    expect(journalStore(dir, clock, { isOwner: () => false }).sweepBlobs(true)).toBe(0)
    expect(fs.existsSync(lost)).toBe(true)
    expect(journalStore(dir, clock).sweepBlobs(true)).toBe(1)
    // A journal here whose Walnut nothing names could name a body: then nothing is swept.
    fs.writeFileSync(path.join(dir, 'journal-0123456789abcdef.ndjson'), '{"v":2,"seq":1,"kind":"note"}\n')
    fs.writeFileSync(path.join(blobs, sha256Hex('orphan')), 'orphan')
    fs.utimesSync(path.join(blobs, sha256Hex('orphan')), old, old)
    expect(journalStore(dir, clock).sweepBlobs(true)).toBe(0)
    expect(fs.existsSync(path.join(blobs, sha256Hex('orphan')))).toBe(true)
  })
})

/** Rename a home's journal and state aside, as a person would (never deleted). */
function setAside(dir: string): void {
  const stamp = Date.now()
  for (const ext of ['ndjson', 'state.json']) {
    const f = path.join(dir, `journal-${keyOf(JHOME)}.${ext}`)
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.moved-${stamp}`)
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

describe('journal v2: a fold keeps each field\'s own write time (WP9 review)', () => {
  it('title written at 09:00 and priority at 11:00 fold into one record whose title still says 09:00', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    j.append(JHOME, fields({ title: ['Leader work', 'Away title'] }), { actor: DEVICE })
    clock.now = T0 + 2 * 3600_000
    const folded = j.append(JHOME, fields({ priority: ['none', 'immediate'] }), { actor: DEVICE })
    expect(folded).toMatchObject({ ok: true, coalesced: true, rev: 2 })
    const [rec] = j.records(JHOME)
    // The record's own time is the latest write; each field keeps when IT was written.
    expect(rec.at).toBe(T0 + 2 * 3600_000)
    expect(rec.fields).toMatchObject({ title: { value: 'Away title', at: T0 }, priority: { value: 'immediate', at: T0 + 2 * 3600_000 } })
    // A third save of the title moves only the title's time.
    clock.now = T0 + 3 * 3600_000
    j.append(JHOME, fields({ title: ['Away title', 'Away title 2'] }), { actor: DEVICE })
    expect(j.records(JHOME)[0].fields).toMatchObject({ title: { base: 'Leader work', value: 'Away title 2', at: T0 + 3 * 3600_000 }, priority: { at: T0 + 2 * 3600_000 } })
  })
})
