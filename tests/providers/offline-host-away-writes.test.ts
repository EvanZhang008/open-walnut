/**
 * The offline host's part of WP10 (docs/plan/walnut-replica-servers-impl.md): the
 * replica's writes while the Mac is away, as the daemon core answers them
 * (src/providers/offline-host-core.ts, shared by both daemon twins). Real journal
 * files in temp dirs (tests/helpers/offline-journal-harness.ts).
 *
 *   - device_revoke: a device removes itself only; anything else needs the Mac
 *   - a create asked again under its op id names the task the first attempt made
 *   - a Board outside this host's copy is checked against the base the replica sent
 *   - a person's message asked again under its message id is delivered once
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  JHOME, SID_A, TASK_A, DEVICE, journalTmpDir, cleanupJournalDirs, journalHost, jslice,
} from '../helpers/offline-journal-harness.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')

afterEach(() => cleanupJournalDirs())

describe('offline host: device_revoke while the Mac is away', () => {
  it('a device removing itself is journaled as device-revoke; another device or a session needs the Mac', () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    h.host.configure(jslice())
    const self = h.host.handleFollower(JHOME, { op: 'device_revoke', args: { deviceId: DEVICE.deviceId, name: DEVICE.name }, actor: DEVICE, opId: 'op-revoke-self' })
    expect(self).toMatchObject({ ok: true, result: { queued: true, kind: 'device-revoke', opId: 'op-revoke-self' } })
    expect(h.journal.records(JHOME)).toEqual([expect.objectContaining({ kind: 'device-revoke', deviceId: DEVICE.deviceId, name: DEVICE.name })])
    const other = h.host.handleFollower(JHOME, { op: 'device_revoke', args: { deviceId: 'dev-acme-tablet' }, actor: DEVICE })
    expect(other).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'device_changes_need_mac' } } })
    const bySession = h.host.handleFollower(JHOME, { op: 'device_revoke', args: { deviceId: DEVICE.deviceId }, actor: { kind: 'session', sid: SID_A } })
    expect(bySession).toMatchObject({ ok: false, error: { code: 'needs_leader' } })
    const noId = h.host.handleFollower(JHOME, { op: 'device_revoke', args: {}, actor: DEVICE })
    expect(noId).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    // Only the first record was written; a retry of it answers the saved one.
    expect(h.host.handleFollower(JHOME, { op: 'device_revoke', args: { deviceId: DEVICE.deviceId }, actor: DEVICE, opId: 'op-revoke-self' }))
      .toMatchObject({ ok: true, result: { duplicate: true, kind: 'device-revoke' } })
    expect(h.journal.records(JHOME)).toHaveLength(1)
  })

  it('an old Mac that drains no device-revoke is never handed one: the write needs the Mac', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: ['task-fields', 'task-create', 'task-move', 'board', 'device-actor'] })
    h.host.configure(jslice())
    const r = h.host.handleFollower(JHOME, { op: 'device_revoke', args: { deviceId: DEVICE.deviceId }, actor: DEVICE })
    expect(r).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    expect(h.journal.records(JHOME)).toEqual([])
  })
})

describe('offline host: retries after a lost answer', () => {
  it('a create asked again under its op id answers the task id the first attempt made', () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    h.host.configure(jslice())
    const first = h.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-first-0001', title: 'Made away', project: 'Acme' }, actor: DEVICE, opId: 'op-create-1' })
    expect(first).toMatchObject({ ok: true, result: { kind: 'task-create' } })
    // The retry minted a new id (the replica lost its answer): the first one is named.
    const again = h.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-again-0002', title: 'Made away', project: 'Acme' }, actor: DEVICE, opId: 'op-create-1' })
    expect(again).toMatchObject({ ok: true, result: { duplicate: true, taskId: 'mtask-first-0001' } })
    expect(h.journal.records(JHOME).filter((r) => r.kind === 'task-create')).toHaveLength(1)
  })

  it('a person\'s message asked again under its message id reaches the session once', async () => {
    const got: string[] = []
    const h = journalHost(journalTmpDir(), { now: T0 }, { deliver: async (_sid, body) => { got.push(body); return { ok: true } } })
    h.host.configure(jslice())
    const first = await h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0001')
    expect(first).toMatchObject({ ok: true, result: { delivered: true, messageId: 'qm-away-0001' } })
    const again = await h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0001')
    expect(again).toMatchObject({ ok: true, result: { delivered: true, duplicate: true, messageId: 'qm-away-0001' } })
    expect(got).toEqual(['Ship it'])
    // A new message id is a new message.
    expect(await h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0002')).toMatchObject({ ok: true })
    expect(got).toEqual(['Ship it', 'Ship it'])
  })

  it('a person\'s message asked again while the first is still delivering reaches the session once', async () => {
    const got: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = journalHost(journalTmpDir(), { now: T0 }, { deliver: async (_sid, body) => { got.push(body); await gate; return { ok: true } } })
    h.host.configure(jslice())
    const first = h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0001')
    await new Promise((r) => setTimeout(r, 10))
    // The replica's timeout fired: the same message id again, the first not answered yet.
    const second = h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0001')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['Ship it'])
    release()
    expect(await first).toMatchObject({ ok: true, result: { delivered: true, messageId: 'qm-away-0001' } })
    expect(await second).toMatchObject({ ok: true, result: { delivered: true, duplicate: true, messageId: 'qm-away-0001' } })
    expect(got).toEqual(['Ship it'])
    expect(h.journal.records(JHOME).filter((r) => r.kind === 'delivery')).toHaveLength(1)
  })

  it('a retry after a failed first delivery tries again', async () => {
    const got: string[] = []
    let fails = 1
    const h = journalHost(journalTmpDir(), { now: T0 }, { deliver: async (_sid, body) => { got.push(body); return fails-- > 0 ? { ok: false, reason: 'busy' } : { ok: true } } })
    h.host.configure(jslice())
    expect(await h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0003')).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(await h.host.deliverHuman(JHOME, SID_A, 'Ship it', 'qm-away-0003')).toMatchObject({ ok: true, result: { delivered: true } })
    expect(got).toEqual(['Ship it', 'Ship it'])
  })
})

describe('offline host: a Board outside this host\'s copy', () => {
  const BASE = { html: '<p id="build">Build: green</p>', version: 4, threads: {}, marks: {}, projects: {}, choices: {} }

  it('is checked against the Board the replica showed (its base), and refused with no base', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { boards: true })
    h.host.configure(jslice())
    const elsewhere = 'mtask-board-elsewhere'
    const edit = { op: 'board_edit', args: { task: elsewhere, version: 4, edits: [{ old: 'green', new: 'red' }] }, actor: DEVICE }
    expect(h.host.handleFollower(JHOME, { ...edit, base: BASE, opId: 'op-board-1' })).toMatchObject({ ok: true, result: { queued: true, kind: 'board' } })
    expect(h.journal.records(JHOME)).toEqual([expect.objectContaining({ kind: 'board', op: 'board_edit' })])
    // A stale base is the same conflict the Board in the copy answers.
    const stale = h.host.handleFollower(JHOME, { ...edit, args: { ...edit.args, version: 2 }, base: BASE, opId: 'op-board-2' })
    expect(stale).toMatchObject({ ok: false, error: { code: 'board_version_conflict' } })
    // No base and no copy: the Mac is needed.
    expect(h.host.handleFollower(JHOME, { ...edit, opId: 'op-board-3' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'board_not_here' } } })
  })
})
