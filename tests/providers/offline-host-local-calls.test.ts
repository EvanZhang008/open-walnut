/**
 * The daemon core's side of a host replica's own `walnut` calls (offline-host-core.ts, both
 * twins): a plugin job is a journal actor only for a Mac that drains `plugin-job-actor`, and a
 * task's plain session started here (`run: 'task'`) only for one that drains `task-start`.
 * An older Mac gets `needs_leader {why: 'mac_too_old'}` and nothing is journaled.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { JHOME, journalTmpDir, cleanupJournalDirs, journalHost, jslice } from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'

const T0 = Date.parse('2026-11-18T12:00:00Z')
const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' }
const SID = '11111111-2222-4333-8444-555555555555'

afterEach(() => cleanupJournalDirs())

describe('offline host: a plugin job\'s write from the host replica', () => {
  it('journals with the job as its actor for a Mac that drains it', () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    h.host.configure(jslice())
    const r = h.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-job-0001', title: 'Made by a job', project: 'Acme' }, actor: JOB, opId: 'op-job-1' })
    expect(r).toMatchObject({ ok: true, result: { kind: 'task-create', opId: 'op-job-1' } })
    expect(h.journal.records(JHOME)).toEqual([expect.objectContaining({ kind: 'task-create', actor: { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' } })])
  })

  it('an older Mac that drains no plugin-job-actor: needs the Mac, nothing journaled', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: JOURNAL_V2_DRAINS.filter((k) => k !== 'plugin-job-actor') })
    h.host.configure(jslice())
    const r = h.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-job-0002', title: 'Made by a job' }, actor: JOB })
    expect(r).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    expect(h.journal.records(JHOME)).toEqual([])
  })

  it('a malformed job actor is refused as bad', () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    h.host.configure(jslice())
    expect(h.host.handleFollower(JHOME, { op: 'task_create', args: { id: 'mtask-job-0003', title: 'x' }, actor: { kind: 'plugin-job', plugin: 'a b', job: 'poll' } }))
      .toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })
})

describe('offline host: a task\'s session started on the host', () => {
  it('may start for a Mac that drains task-start, with a job or a session as who asked', () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    h.host.configure(jslice())
    expect(h.host.checkTaskStart(JHOME, SID, JOB)).toMatchObject({ ok: true })
    expect(h.host.checkTaskStart(JHOME, SID, { kind: 'session', sid: 'sess-caller' })).toMatchObject({ ok: true })
  })

  it('an older Mac (no task-start, or no plugin-job-actor for a job): needs the Mac', () => {
    const noStart = journalHost(journalTmpDir(), { now: T0 }, { drains: JOURNAL_V2_DRAINS.filter((k) => k !== 'task-start') })
    noStart.host.configure(jslice())
    expect(noStart.host.checkTaskStart(JHOME, SID, JOB)).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    const noJob = journalHost(journalTmpDir(), { now: T0 }, { drains: JOURNAL_V2_DRAINS.filter((k) => k !== 'plugin-job-actor') })
    noJob.host.configure(jslice())
    expect(noJob.host.checkTaskStart(JHOME, SID, JOB)).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
  })
})
