/**
 * The write port of a host replica (src/replica/write-port.ts, plan sections 5 and 7,
 * WP10) over the REAL offline host and journal v2 (offline-host-core.ts,
 * offline-journal-core.ts): what the daemon's follower.op journals for each away
 * write, read back from the journal file. The link in between is ws-writes.ts
 * linkWrite (the same retry rules as the dispatcher's), with the twin's gates
 * standing in as a direct call of handleFollower.
 *
 * Pinned: bases from what the replica shows ('unknown' when the copy lacks the
 * field, the overlay's value after an earlier away write), ids minted here, the
 * client's op id kept, the device as actor, the budget per device, one
 * non-queueable field refusing the whole write, and a lost answer asked again
 * under the same op id appending once.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { JHOME, TASK_A, journalTmpDir, cleanupJournalDirs, journalHost, jslice, journalLines } from '../helpers/offline-journal-harness.js'
import { createWritePort, createdRow, madeByHuman, mintTaskId, refusalAnswer, type TaskRow, type WriteActor } from '../../src/replica/write-port.js'
import { createOverlay } from '../../src/replica/overlay.js'
import { linkWrite } from '../../src/replica/ws-writes.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const PHONE: WriteActor = { kind: 'device', deviceId: 'dev-marina-phone', name: 'Marina phone' }
const TABLET: WriteActor = { kind: 'device', deviceId: 'dev-acme-tablet', name: 'Acme tablet' }
/** A task of the Mac's copy that is NOT in this host's slice (no session of it runs here). */
const COPY_ONLY: TaskRow = { id: 'mtaskccc-0003', title: 'Release plan', phase: 'TODO', project: 'Acme', description: 'Ship on Friday.' }

afterEach(() => cleanupJournalDirs())

function rig(opts: { lose?: (n: number) => boolean } = {}) {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const { host } = journalHost(dir, clock, { boards: true })
  host.configure(jslice({ boards: [{ taskId: TASK_A, html: '<p>Build: green</p>', version: 3, threads: {} }] }))
  const copy = new Map<string, TaskRow>([
    [TASK_A, { id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', description: 'first line' }],
    [COPY_ONLY.id, COPY_ONLY],
  ])
  let calls = 0
  const requests: Array<{ cmd: string; params: Record<string, unknown> }> = []
  // The twin's gates passed: follower.op lands in handleFollower (daemon-standalone.ts cmdFollowerOp).
  const request = async (cmd: string, params: Record<string, unknown>) => {
    requests.push({ cmd, params: JSON.parse(JSON.stringify(params)) })
    const r = host.handleFollower(JHOME, params as never)
    calls++
    if (opts.lose?.(calls)) throw new Error('follower.op: timed out')
    return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code, ...(r.error.detail !== undefined ? { detail: r.error.detail } : {}), ...(r.error.retryAfterMs !== undefined ? { retryAfterMs: r.error.retryAfterMs } : {}) }
  }
  const overlay = createOverlay({ fetchPending: async () => host.pendingFor(JHOME, 0) as never, now: () => clock.now })
  let hexN = 0
  const written: Array<Parameters<Parameters<typeof createWritePort>[0]['noteWritten']>[0]> = []
  const port = createWritePort({
    task: async (id) => { await overlay.refresh(); return overlay.task(id, copy.get(id) ?? null) as TaskRow | null },
    board: async () => null,
    noteWritten: (e) => { written.push(e); overlay.noteWritten(e) },
    now: () => clock.now,
    randomHex: (n) => (++hexN).toString(16).padStart(n * 2, '0'),
  })
  const write = (opId?: string) => linkWrite({ request, linked: () => true, log: () => {} }, opId)
  const records = () => journalLines(dir).map((l) => JSON.parse(l)).filter((r) => typeof r.seq === 'number')
  return { dir, clock, host, port, write, records, requests, overlay, copy, written }
}

describe('write port: what follower.op journals', () => {
  it('records each field with the base the replica showed, and the copy-only task with the replica\'s base', async () => {
    const r = rig()
    const a = await r.port.taskUpdate(r.write(), PHONE, TASK_A, { title: 'Leader work, renamed', description: 'second line' })
    expect(a).toMatchObject({ answered: false, status: 200, body: { queued: true, offline: true } })
    const b = await r.port.taskUpdate(r.write(), PHONE, COPY_ONLY.id, { phase: 'IN_PROGRESS' })
    expect(b).toMatchObject({ answered: false, status: 200 })
    const recs = r.records()
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ kind: 'task-fields', op: 'task_update', taskId: TASK_A, fields: {
      title: { base: 'Leader work', value: 'Leader work, renamed' }, description: { base: 'first line', value: 'second line' },
    } })
    expect(recs[1]).toMatchObject({ kind: 'task-fields', taskId: COPY_ONLY.id, fields: { phase: { base: 'TODO', value: 'IN_PROGRESS' } } })
  })

  it('a field the copy lacks has the base \'unknown\'; a later write\'s base is the earlier away value (copy plus overlay)', async () => {
    const r = rig()
    await r.port.taskUpdate(r.write(), PHONE, TASK_A, { due_date: '2026-10-20' })
    await r.port.taskUpdate(r.write(), TABLET, TASK_A, { due_date: '2026-10-21' })
    const recs = r.records()
    expect(recs[0].fields.due_date).toEqual({ base: 'unknown', value: '2026-10-20' })
    expect(recs[1].fields.due_date).toEqual({ base: '2026-10-20', value: '2026-10-21' })
  })

  it('mints a new task\'s id (time, then 8 random bytes) and a Board post\'s id', async () => {
    const r = rig()
    const made = await r.port.taskCreate(r.write(), PHONE, { title: 'Call the venue', project: 'Acme', focus_tier: 'today' })
    expect(made).toMatchObject({ answered: false, status: 201 })
    const id = (made as { body: { task: { id: string } } }).body.task.id
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{16}$/)
    expect(id.startsWith(T0.toString(36))).toBe(true)
    expect(mintTaskId(T0, () => 'ab'.repeat(8))).toBe(`${T0.toString(36)}-${'ab'.repeat(8)}`)
    const rec = r.records()[0]
    expect(rec).toMatchObject({ kind: 'task-create', taskId: id, fields: { title: 'Call the venue' }, placement: { project: 'Acme', tier: 'today' } })
    // The new task reads back from the overlay at once, with its mark.
    expect(r.overlay.task(id, null)).toMatchObject({ id, title: 'Call the venue', replica_sync: 'pending' })
  })

  it('a task a device makes away lands where the Mac puts it: pinned unless it said pinned:false, always with a tier', async () => {
    const r = rig()
    const plain = await r.port.taskCreate(r.write(), PHONE, { title: 'Book the hall', project: 'Acme' })
    const unpinned = await r.port.taskCreate(r.write(), PHONE, { title: 'Someday', project: 'Acme', pinned: false })
    const tiered = await r.port.taskCreate(r.write(), PHONE, { title: 'Today thing', focus_tier: 'focus' })
    const task = (a: unknown) => (a as { body: { task: Record<string, unknown> } }).body.task
    expect(task(plain)).toMatchObject({ pinned: true })
    expect(task(unpinned)).toMatchObject({ pinned: false })
    expect(task(tiered)).toMatchObject({ pinned: true, focus_tier: 'focus' })
    // The overlay's row reads the same.
    expect(r.overlay.task(String(task(plain).id), null)).toMatchObject({ pinned: true, replica_sync: 'pending' })
    // A session's create (the gateway) keeps what it said: no human default.
    expect(createdRow('mtask-s-1', { title: 'From a session' }, {}, T0, madeByHuman({ kind: 'session', sid: 's' }))).not.toHaveProperty('pinned')
  })

  it('a create\'s client_request_id is the page\'s correlation id: checked as the Mac checks it, never a field, handed on for task:created', async () => {
    const r = rig()
    const made = await r.port.taskCreate(r.write(), PHONE, { title: 'Order the banners', project: 'Acme', client_request_id: 'tmp-acme-0001' })
    expect(made).toMatchObject({ answered: false, status: 201 })
    const id = (made as { body: { task: { id: string } } }).body.task.id
    const rec = r.records()[0]
    expect(rec.fields).toEqual({ title: 'Order the banners' })
    expect(JSON.stringify(rec)).not.toContain('tmp-acme-0001')
    expect(r.written).toEqual([expect.objectContaining({ kind: 'task-create', clientRequestId: 'tmp-acme-0001', record: expect.objectContaining({ taskId: id }) })])
    // A bad one is refused before anything is sent, as POST /api/tasks refuses it.
    const bad = await r.port.taskCreate(r.write(), PHONE, { title: 'Too long', client_request_id: 'x'.repeat(65) })
    expect(bad).toMatchObject({ answered: false, status: 400, body: { error: { code: 'bad_request' } } })
    expect(r.records()).toHaveLength(1)
    // An edit has no correlation id to hand on.
    await r.port.taskUpdate(r.write(), PHONE, TASK_A, { title: 'Leader work, again' })
    expect(r.written[1]).not.toHaveProperty('clientRequestId')
  })

  it('keeps the client\'s op id and sets the device as actor', async () => {
    const r = rig()
    await r.port.taskComplete(r.write('op-client-acme-0001'), PHONE, TASK_A)
    const rec = r.records()[0]
    expect(rec).toMatchObject({ opId: 'op-client-acme-0001', actor: { kind: 'device', deviceId: PHONE.deviceId, name: PHONE.name } })
    expect(rec.fields.phase).toEqual({ base: 'IN_PROGRESS', value: 'COMPLETE' })
    expect(r.requests[0]!.params).toMatchObject({ op: 'task_complete', opId: 'op-client-acme-0001', actor: PHONE, base: { phase: 'IN_PROGRESS' } })
  })
})

describe('write port: refusals and retries', () => {
  it('one non-queueable field refuses the whole write: needs_leader {fields}, nothing sent, nothing journaled', async () => {
    const r = rig()
    const a = await r.port.taskUpdate(r.write(), PHONE, TASK_A, { title: 'Renamed', session_id: 'x', walnut_agent: true })
    expect(a).toMatchObject({ answered: false, status: 503, body: { error: { code: 'needs_leader', why: 'fields', fields: ['session_id', 'walnut_agent'] } } })
    expect(r.requests).toHaveLength(0)
    expect(r.records()).toHaveLength(0)
    // The daemon refuses the same whole, for a writer that skipped the port's check.
    const direct = await r.write().submit('task_update', { id: TASK_A, title: 'Renamed', session_id: 'x' }, undefined, PHONE)
    expect(direct).toMatchObject({ kind: 'refused', code: 'needs_leader', detail: { why: 'fields', fields: ['session_id'] } })
    expect(r.records()).toHaveLength(0)
    // A create the same way.
    const c = await r.port.taskCreate(r.write(), PHONE, { title: 'A', session_ids: ['x'] })
    expect(c).toMatchObject({ status: 503, body: { error: { why: 'fields', fields: ['session_ids'] } } })
    expect(r.records()).toHaveLength(0)
  })

  it('the write budget is per device, and a coalesced save is exempt: the throttled device\'s next save of the same note still lands, its plain write does not', async () => {
    const r = rig()
    // The phone's first save of the note: a record of its own, charged (1 of 30).
    expect(await r.port.taskUpdate(r.write(), PHONE, TASK_A, { note: 'draft 1' })).toMatchObject({ status: 200 })
    // 29 creates use up the rest of its budget.
    for (let i = 0; i < 29; i++) {
      const a = await r.port.taskCreate(r.write(), PHONE, { title: `Errand ${i}` })
      expect(a, `write ${i}`).toMatchObject({ status: 201 })
    }
    // The phone is throttled now: a plain write (a new record) is refused.
    const over = await r.port.taskCreate(r.write(), PHONE, { title: 'one too many' })
    expect(over).toMatchObject({ status: 429, body: { error: { code: 'throttled' } } })
    const otherField = await r.port.taskUpdate(r.write(), PHONE, COPY_ONLY.id, { note: 'another task' })
    expect(otherField).toMatchObject({ status: 429, body: { error: { code: 'throttled' } } })
    // The SAME phone's next save of the same note folds into its pending record: not charged, it lands.
    const save2 = await r.port.taskUpdate(r.write(), PHONE, TASK_A, { note: 'draft 2' })
    expect(save2).toMatchObject({ status: 200 })
    const notes = r.records().filter((x) => x.kind === 'task-fields' && x.taskId === TASK_A)
    expect(notes[notes.length - 1]).toMatchObject({ rev: 2, fields: { note: { value: 'draft 2' } } })
    expect(r.overlay.task(TASK_A, r.copy.get(TASK_A)!)).toMatchObject({ note: 'draft 2', replica_sync: 'pending' })
    // Another device is not slowed by the phone's budget.
    expect(await r.port.taskCreate(r.write(), TABLET, { title: 'from the tablet' })).toMatchObject({ status: 201 })
    expect(r.records().filter((x) => x.kind === 'task-create')).toHaveLength(30)
    expect(r.records().some((x) => x.taskId === COPY_ONLY.id)).toBe(false)
  })

  it('a host failure (internal) is transient: 503 with retryAfter, never a 409 conflict', () => {
    expect(refusalAnswer('internal', 'delivery failed: busy')).toMatchObject({ answered: false, status: 503, body: { error: { code: 'internal', retryAfter: 5 } } })
    expect(refusalAnswer('board_version_conflict', 'stale')).toMatchObject({ status: 409 })
  })

  it('two edits of one task in a row (folded into one record by the daemon) both show, before and after the next ask', async () => {
    const r = rig()
    expect(await r.port.taskUpdate(r.write(), PHONE, TASK_A, { title: 'New title' })).toMatchObject({ status: 200 })
    expect(await r.port.taskUpdate(r.write(), PHONE, TASK_A, { note: 'A note' })).toMatchObject({ status: 200 })
    const recs = r.records()
    expect(recs[recs.length - 1]).toMatchObject({ rev: 2, fields: { title: { value: 'New title' }, note: { value: 'A note' } } })
    expect(r.overlay.task(TASK_A, r.copy.get(TASK_A)!)).toMatchObject({ title: 'New title', note: 'A note', replica_sync: 'pending' })
    await r.overlay.refresh()
    expect(r.overlay.task(TASK_A, r.copy.get(TASK_A)!)).toMatchObject({ title: 'New title', note: 'A note', replica_sync: 'pending' })
    // A later write's base is read off the folded row: the away title, not the copy's.
    await r.port.taskUpdate(r.write(), PHONE, TASK_A, { title: 'Third title' })
    expect(r.requests[r.requests.length - 1]!.params.base).toEqual({ title: 'New title' })
  })

  it('a lost answer is asked again under the same op id and appends once', async () => {
    const r = rig({ lose: (n) => n === 1 })
    const a = await r.port.taskUpdate(r.write('op-client-lost-0001'), PHONE, TASK_A, { title: 'Saved once' })
    expect(a).toMatchObject({ answered: false, status: 200 })
    expect(r.requests.map((q) => q.params.opId)).toEqual(['op-client-lost-0001', 'op-client-lost-0001'])
    const recs = r.records()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ opId: 'op-client-lost-0001', fields: { title: { value: 'Saved once' } } })
  })

  it('a create asked again under its op id (its answer lost): the answer names the task the first attempt made, one record', async () => {
    const r = rig()
    const first = await r.port.taskCreate(r.write('op-client-made-0001'), PHONE, { title: 'Book the rollback room', project: 'Acme' })
    expect(first).toMatchObject({ status: 201 })
    const madeId = (first as { body: { task: { id: string } } }).body.task.id
    // The client's retry: a new request, so the port mints another id; the daemon answers the saved record.
    const again = await r.port.taskCreate(r.write('op-client-made-0001'), PHONE, { title: 'Book the rollback room', project: 'Acme' })
    expect(again).toMatchObject({ status: 201, body: { task: { id: madeId, title: 'Book the rollback room', replica_sync: 'pending' } } })
    expect(r.records().filter((x) => x.kind === 'task-create')).toEqual([expect.objectContaining({ taskId: madeId, opId: 'op-client-made-0001' })])
    // The overlay is told about the retry under the first attempt's task, never the retry's minted id.
    expect(r.written.map((e) => e.record.taskId)).toEqual([madeId, madeId])
    // The overlay shows the one task, never a second made only by the retry's minted id.
    await r.overlay.refresh()
    expect(r.overlay.createdTaskIds()).toEqual([madeId])
  })

  it('a create whose first answer was lost keeps the page\'s correlation id: the retry\'s answer hands it on with the task the first attempt made', async () => {
    const r = rig({ lose: (n) => n === 1 })
    const made = await r.port.taskCreate(r.write('op-client-lost-made-01'), PHONE, { title: 'Order the chairs', project: 'Acme', client_request_id: 'tmp-acme-0002' })
    expect(made).toMatchObject({ answered: false, status: 201 })
    const id = (made as { body: { task: { id: string } } }).body.task.id
    // The daemon took the first try (its answer lost) and answered the second as a duplicate.
    expect(r.requests.map((q) => q.params.opId)).toEqual(['op-client-lost-made-01', 'op-client-lost-made-01'])
    expect(r.records().filter((x) => x.kind === 'task-create')).toEqual([expect.objectContaining({ taskId: id })])
    // Nobody heard of the first try: the duplicate is what tells the overlay and the page.
    expect(r.written).toEqual([expect.objectContaining({ kind: 'task-create', clientRequestId: 'tmp-acme-0002', record: expect.objectContaining({ taskId: id }) })])
    expect(r.overlay.task(id, null)).toMatchObject({ id, title: 'Order the chairs', replica_sync: 'pending' })
  })

  it('an op id the daemon holds for another kind of change answers 409 op_id_reused: nothing journaled, no row shown', async () => {
    const r = rig()
    expect(await r.port.taskUpdate(r.write('op-client-reused-001'), PHONE, TASK_A, { title: 'Renamed once' })).toMatchObject({ status: 200 })
    const create = await r.port.taskCreate(r.write('op-client-reused-001'), PHONE, { title: 'A phantom task' })
    expect(create).toMatchObject({ answered: false, status: 409, body: { error: { code: 'op_id_reused' } } })
    expect(r.records().map((x) => x.kind)).toEqual(['task-fields'])
    expect(r.overlay.createdTaskIds()).toEqual([])
    // The same change asked again under its op id is still the first one's answer.
    expect(await r.port.taskUpdate(r.write('op-client-reused-001'), PHONE, TASK_A, { title: 'Renamed once' })).toMatchObject({ status: 200, body: { task: { title: 'Renamed once' } } })
    expect(r.records()).toHaveLength(1)
  })

  it('a write is checked as the Mac checks it before anything is sent; a bare status shows the phase the Mac derives from it', async () => {
    const r = rig()
    for (const [patch, words] of [
      [{ priority: 'whenever' }, /priority must be one of/],
      [{ phase: 'SOMEDAY' }, /phase must be one of/],
      [{ status: 'finished' }, /status must be one of/],
      [{ title: '   ' }, /title must be a non-empty string/],
      [{ due_date: '2030-02-30' }, /due_date must be an ISO-8601 date/],
      [{ pinned: 'yes' }, /pinned must be a boolean/],
      [{ tags: 'one,two' }, /tags must be an array of strings/],
      [{ end_date: '2030-01-02' }, /end_date requires a start_date/],
    ] as const) {
      const a = await r.port.taskUpdate(r.write(), PHONE, TASK_A, patch as Record<string, unknown>)
      expect(a, JSON.stringify(patch)).toMatchObject({ answered: false, status: 400, body: { error: { code: 'bad_request', message: expect.stringMatching(words) } } })
    }
    const badCreate = await r.port.taskCreate(r.write(), PHONE, { title: 'Book it', priority: 'whenever' })
    expect(badCreate).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
    expect(r.requests).toHaveLength(0)
    expect(r.records()).toHaveLength(0)
    // A status alone is the phase it names, as the Mac stores it: done is COMPLETE, with its completion time.
    const done = await r.port.taskUpdate(r.write(), PHONE, TASK_A, { status: 'done' })
    expect(done).toMatchObject({ status: 200, body: { task: { status: 'done', phase: 'COMPLETE', completed_at: new Date(T0).toISOString() } } })
    expect(r.overlay.task(TASK_A, r.copy.get(TASK_A)!)).toMatchObject({ status: 'done', phase: 'COMPLETE', replica_sync: 'pending' })
    // A status the phase already shows moves nothing (IN_PROGRESS is in_progress).
    const same = await r.port.taskUpdate(r.write(), TABLET, COPY_ONLY.id, { status: 'todo' })
    expect(same).toMatchObject({ status: 200, body: { task: { status: 'todo', phase: 'TODO' } } })
    const moved = await r.port.taskUpdate(r.write(), TABLET, COPY_ONLY.id, { status: 'in_progress' })
    expect(moved).toMatchObject({ status: 200, body: { task: { status: 'in_progress', phase: 'IN_PROGRESS' } } })
    // The record is what the person asked: the status, with the status it was shown over.
    expect(r.records()[0]).toMatchObject({ fields: { status: { base: 'unknown', value: 'done' } } })
  })

  it('every answer lost: journal_unwritable (it may have been kept), never a second record', async () => {
    const r = rig({ lose: () => true })
    const a = await r.port.taskUpdate(r.write('op-client-lost-0002'), PHONE, TASK_A, { title: 'Maybe saved' })
    expect(a).toMatchObject({ answered: false, status: 503, body: { error: { code: 'journal_unwritable', why: 'no_answer' } } })
    expect(r.records()).toHaveLength(1)
  })

  it('a device revoke while away is that device\'s own sign-out only (removing another needs the owner\'s rights, which only the Mac can check: plan WP10); a Board post on a Board this host keeps has a minted post id', async () => {
    const r = rig()
    const other = await r.port.deviceRevoke(r.write(), PHONE, TABLET.deviceId, TABLET.name!)
    expect(other).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'device_changes_need_mac' } } })
    const self = await r.port.deviceRevoke(r.write(), PHONE, PHONE.deviceId, PHONE.name!)
    expect(self).toMatchObject({ status: 200 })
    const post = await r.port.board(r.write(), PHONE, 'board_post', TASK_A, { thread: 'build', text: 'Looks good from the phone' })
    expect(post).toMatchObject({ status: 201 })
    const recs = r.records()
    expect(recs.map((x) => x.kind)).toEqual(['device-revoke', 'board'])
    expect(recs[0]).toMatchObject({ deviceId: PHONE.deviceId, actor: { deviceId: PHONE.deviceId } })
    expect(recs[1]).toMatchObject({ op: 'board_post', args: { task: TASK_A, thread: 'build', text: 'Looks good from the phone' } })
    expect(String(recs[1].postId)).toMatch(/^bm-host-[0-9a-f]{16}$/)
  })

  it('a Board this host does not keep is checked against the replica\'s copy (its base)', async () => {
    const r = rig()
    const base = { html: '<h1>Release</h1><p id="build">Build: green</p>', version: 1, threads: {} }
    const port = createWritePort({
      task: async () => null, board: async () => base, noteWritten: () => {}, now: () => r.clock.now,
    })
    const edit = await port.board(r.write(), PHONE, 'board_edit', COPY_ONLY.id, { edits: [{ old: 'Build: green', new: 'Build: red' }], version: 1 })
    expect(edit).toMatchObject({ status: 200 })
    const stale = await port.board(r.write(), PHONE, 'board_edit', COPY_ONLY.id, { edits: [{ old: 'Build: green', new: 'x' }], version: 0 })
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'board_version_conflict' } } })
    expect(r.records().map((x) => [x.kind, x.op, x.args.task])).toEqual([['board', 'board_edit', COPY_ONLY.id]])
  })
})
