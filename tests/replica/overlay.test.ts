/**
 * The overlay of a host replica (src/replica/overlay.ts, plan section 4 "Hold after
 * ack", WP10) over the REAL offline host and journal v2: records written by the
 * daemon's follower.op (and a session's gateway write), acked by the Mac's exact
 * seqs (offline.ack {seqs}), read back through follower.pending.
 *
 * Pinned: a row is held and marked `pending` while its record is in the journal; after
 * the ack it keeps its overlay and its mark as `awaiting` until a manifest whose asOf
 * is later than the ack stored the key (an earlier manifest does not release it), the
 * copy already shows every value the record wrote, or 10 minutes pass; a coalesced
 * save is no ack; a record written after an ask began is not taken for acked; the
 * awaiting marks survive a restart of the replica.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { JHOME, TASK_A, TASK_B, DEVICE, journalTmpDir, cleanupJournalDirs, journalHost, jslice } from '../helpers/offline-journal-harness.js'
import { AWAIT_COPY_MS, SLOW_WATCH_MS, createOverlay, watchMaxAgeMs } from '../../src/replica/overlay.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')

afterEach(() => cleanupJournalDirs())

function rig(file?: string) {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const { host } = journalHost(dir, clock, { boards: true })
  host.configure(jslice())
  const changes: string[] = []
  const make = () => createOverlay({
    fetchPending: async () => host.pendingFor(JHOME, 0) as never,
    now: () => clock.now,
    ...(file ? { file } : {}),
    changed: (keys) => { for (const k of keys) changes.push(`${k.kind}:${k.id}`) },
  })
  const write = (args: Record<string, unknown>, opId?: string, op = 'task_update') => {
    const r = host.handleFollower(JHOME, { op, args, actor: DEVICE, ...(opId ? { opId } : {}) })
    if (!r.ok) throw new Error(r.error.message)
    return r.result as { seq: number; opId: string; rev: number; kind: string }
  }
  // The Mac's drain hands the records out (freezing them), then acks exactly the seqs it applied.
  // `leaderNow`: the Mac's clock as it acks (offline-handover.ts sends its Date.now()).
  const ack = (seqs: number[], leaderNow?: number) => {
    const d = host.drain(JHOME, ['task-fields', 'task-create', 'task-move', 'board', 'device-revoke'])
    expect(d.error).toBeUndefined()
    const r = host.ack(JHOME, { seqs, ...(leaderNow !== undefined ? { leaderNow } : {}) })
    if (r.error) throw new Error(r.error)
    expect(r.ignored ?? []).toEqual([])
  }
  return { dir, clock, host, make, write, ack, changes }
}

const COPY_ROW = { id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme' }

describe('overlay: pending, awaiting copy, released', () => {
  it('holds a row while pending, keeps it after the ack until a LATER manifest stored the key', async () => {
    const r = rig()
    const o = r.make()
    const w = r.write({ id: TASK_A, title: 'Renamed away' })
    await o.refresh()
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', replica_sync: 'pending' })
    expect([...o.heldKeys('tasks')]).toEqual([TASK_A])
    expect(o.watching('tasks')).toEqual([])
    // The Mac drains and acks it.
    r.clock.now += 1_000
    const ackAt = r.clock.now
    r.ack([w.seq])
    await o.refresh()
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', replica_sync: 'awaiting' })
    // No longer held: the copy takes the Mac's row from now on; the overlay watches the key.
    expect(o.heldKeys('tasks').size).toBe(0)
    expect(o.watching('tasks')).toEqual([TASK_A])
    // A manifest from before the ack stores the key: still awaiting (the Mac's row may predate the drain).
    o.stored('tasks', [TASK_A], ackAt - 1)
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    o.stored('tasks', [TASK_B], ackAt + 5)
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    // A later manifest stored it: released, the copy's row reads alone.
    o.stored('tasks', [TASK_A], ackAt + 5)
    expect(o.markOf('tasks', TASK_A)).toBeNull()
    expect(o.task(TASK_A, COPY_ROW)).toEqual(COPY_ROW)
    expect(r.changes).toContain(`tasks:${TASK_A}`)
  })

  it.each([
    ['ahead', 10 * 60_000],
    ['behind', -10 * 60_000],
  ])('compares a manifest\'s asOf with the ack on the Mac\'s clock (the Mac %s by 10 minutes)', async (_name, skew) => {
    const r = rig()
    const o = r.make()
    const w = r.write({ id: TASK_A, title: 'Renamed away' })
    await o.refresh()
    r.clock.now += 1_000
    const macAck = r.clock.now + skew
    r.ack([w.seq], macAck)
    r.clock.now += 500
    await o.refresh()
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    // Built by the Mac before its drain applied the write (2 s before its ack, on its clock).
    o.stored('tasks', [TASK_A], macAck - 2_000)
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', replica_sync: 'awaiting' })
    // Built after it (5 s after the ack, on the Mac's clock): released.
    o.stored('tasks', [TASK_A], macAck + 5_000)
    expect(o.markOf('tasks', TASK_A)).toBeNull()
    expect(o.task(TASK_A, COPY_ROW)).toEqual(COPY_ROW)
  })

  it('releases an awaiting row after 10 minutes with no copy round, and at once when the copy shows its values', async () => {
    const r = rig()
    const o = r.make()
    const a = r.write({ id: TASK_A, title: 'Renamed away' })
    const b = r.write({ id: TASK_B, phase: 'COMPLETE' }, undefined, 'task_update')
    await o.refresh()
    r.ack([a.seq, b.seq])
    await o.refresh()
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    // TASK_B: the copy already has the Mac's row with the value written: released on read.
    expect(o.task(TASK_B, { id: TASK_B, title: 'Worker', phase: 'COMPLETE' })).toEqual({ id: TASK_B, title: 'Worker', phase: 'COMPLETE' })
    expect(o.markOf('tasks', TASK_B)).toBeNull()
    // TASK_A: the copy still shows the old title: it waits, then the clock lets it go.
    r.clock.now += AWAIT_COPY_MS - 1
    await o.refresh()
    expect(o.markOf('tasks', TASK_A)).toBe('awaiting')
    r.clock.now += 2
    await o.refresh()
    expect(o.markOf('tasks', TASK_A)).toBeNull()
    expect(o.entries()).toEqual([])
  })

  it('a coalesced save is no ack, and a record written after the ask began is not taken for acked', async () => {
    const r = rig()
    const o = r.make()
    const first = r.write({ id: TASK_A, note: 'draft 1' })
    await o.refresh()
    const second = r.write({ id: TASK_A, note: 'draft 2' })
    expect(second.opId).toBe(first.opId)
    await o.refresh()
    expect(o.entries()).toHaveLength(1)
    expect(o.entries()[0]).toMatchObject({ state: 'pending', rev: 2 })
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ note: 'draft 2', replica_sync: 'pending' })
    // A write the port saw answered before the next follower.pending (its seq past the last ask).
    const third = r.write({ id: TASK_B, title: 'New worker title' })
    o.noteWritten({ opId: third.opId, seq: third.seq, rev: 1, kind: third.kind, at: r.clock.now, record: { taskId: TASK_B, op: 'task_update', fields: { title: { base: 'Worker: build the page', value: 'New worker title' } } } })
    expect(o.markOf('tasks', TASK_B)).toBe('pending')
  })

  it('two edits of one task folded into one record show both fields, from the port\'s note and from the next ask', async () => {
    const r = rig()
    const o = r.make()
    const first = r.write({ id: TASK_A, title: 'Renamed away' })
    o.noteWritten({ opId: first.opId, seq: first.seq, rev: first.rev, kind: first.kind, at: r.clock.now, record: { taskId: TASK_A, op: 'task_update', fields: { title: { base: 'Leader work', value: 'Renamed away' } } } })
    const second = r.write({ id: TASK_A, note: 'A note' })
    expect(second).toMatchObject({ opId: first.opId, rev: 2 })
    // The port notes only the second write's field (write-port.ts settle): the first stays shown.
    o.noteWritten({ opId: second.opId, seq: second.seq, rev: second.rev, kind: second.kind, at: r.clock.now, record: { taskId: TASK_A, op: 'task_update', fields: { note: { base: 'unknown', value: 'A note' } } } })
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', note: 'A note', replica_sync: 'pending' })
    // The daemon's record replaces the note even at the same seq and rev.
    await o.refresh()
    expect(o.entries()).toHaveLength(1)
    expect(Object.keys(o.entries()[0]!.record.fields as object).sort()).toEqual(['note', 'title'])
    expect(o.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', note: 'A note', replica_sync: 'pending' })
    // A port note that knows only part of the record, taken over by the ask (no note merge path).
    const o2 = r.make()
    o2.noteWritten({ opId: second.opId, seq: second.seq, rev: second.rev, kind: second.kind, at: r.clock.now, record: { taskId: TASK_A, op: 'task_update', fields: { note: { base: 'unknown', value: 'A note' } } } })
    await o2.refresh()
    expect(o2.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away', note: 'A note' })
  })
})

describe('overlay: an op id journaled again after its ack (W11)', () => {
  it('keeps the first create waiting for its copy beside the retry\'s new record', async () => {
    const r = rig()
    const o = r.make()
    const first = r.write({ id: 'mtask-w11-first', title: 'Release notes' }, 'op-create-w11-0001', 'task_create')
    await o.refresh()
    r.ack([first.seq])
    await o.refresh()
    expect(o.markOf('tasks', 'mtask-w11-first')).toBe('awaiting')
    // The client asks again under the same op id after the ack: the daemon journals a new record.
    const again = r.write({ id: 'mtask-w11-second', title: 'Release notes' }, 'op-create-w11-0001', 'task_create')
    expect(again.seq).not.toBe(first.seq)
    o.noteWritten({ opId: again.opId, seq: again.seq, rev: again.rev, kind: again.kind, at: r.clock.now, record: { taskId: 'mtask-w11-second', fields: { title: 'Release notes' }, placement: {} } })
    expect(o.markOf('tasks', 'mtask-w11-first')).toBe('awaiting')
    await o.refresh()
    expect(o.createdTaskIds().sort()).toEqual(['mtask-w11-first', 'mtask-w11-second'])
    expect(o.markOf('tasks', 'mtask-w11-first')).toBe('awaiting')
    expect(o.markOf('tasks', 'mtask-w11-second')).toBe('pending')
    expect(o.task('mtask-w11-first', null)).toMatchObject({ title: 'Release notes', replica_sync: 'awaiting' })
    // The copy brings the first task: released by its values, the retry still pending.
    expect(o.task('mtask-w11-first', { id: 'mtask-w11-first', title: 'Release notes', phase: 'TODO' })).toEqual({ id: 'mtask-w11-first', title: 'Release notes', phase: 'TODO' })
    expect(o.markOf('tasks', 'mtask-w11-first')).toBeNull()
    expect(o.markOf('tasks', 'mtask-w11-second')).toBe('pending')
  })
})

describe('overlay: creates, boards, restarts', () => {
  it('shows a task made here until the copy holds it; folds Board records in seq order', async () => {
    const r = rig()
    const o = r.make()
    const made = r.write({ id: 'mtnew-0000000000000001', title: 'Call the venue', project: 'Acme' }, undefined, 'task_create')
    expect(made.kind).toBe('task-create')
    await o.refresh()
    expect(o.createdTaskIds()).toEqual(['mtnew-0000000000000001'])
    expect(o.task('mtnew-0000000000000001', null)).toMatchObject({ title: 'Call the venue', project: 'Acme', phase: 'TODO', replica_sync: 'pending' })
    expect(o.boardRecords(TASK_A)).toEqual([])
  })

  it('keeps awaiting marks across a restart, and only those', async () => {
    const base = journalTmpDir('overlay-file-')
    const file = path.join(base, 'cache', 'replica-overlay.json')
    const r = rig(file)
    const o = r.make()
    const a = r.write({ id: TASK_A, title: 'Renamed away' })
    r.write({ id: TASK_B, title: 'Still pending' })
    await o.refresh()
    r.ack([a.seq])
    await o.refresh()
    await new Promise((res) => setTimeout(res, 300))
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    o.close()
    const again = r.make()
    expect(again.markOf('tasks', TASK_A)).toBe('awaiting')
    expect(again.task(TASK_A, COPY_ROW)).toMatchObject({ title: 'Renamed away' })
    await again.refresh()
    expect(again.markOf('tasks', TASK_B)).toBe('pending')
    again.close()
  })
})

describe('overlay: the watch (away-wiring.ts)', () => {
  it('the watch asks each second only while the Mac answers or a write awaits its copy, else every 20 s', () => {
    expect(watchMaxAgeMs([], true)).toBeNull()
    expect(watchMaxAgeMs([{ state: 'pending' }], false)).toBe(SLOW_WATCH_MS)
    expect(SLOW_WATCH_MS).toBeGreaterThanOrEqual(15_000)
    expect(watchMaxAgeMs([{ state: 'pending' }], true)).toBe(0)
    expect(watchMaxAgeMs([{ state: 'pending' }, { state: 'awaiting' }], false)).toBe(0)
  })
})
