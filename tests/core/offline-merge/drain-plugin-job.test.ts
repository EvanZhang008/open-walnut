/**
 * The Mac takes back what a plugin's job did on its host while the Mac was away
 * (actor `plugin-job`, drains `plugin-job-actor` and `task-start`),
 * against the real task store, session tracker, ledger and conflict log of a temp home:
 *   - the job's task_create and the session its host started for it (`session` with
 *     `run: 'task'`) are adopted under the SAME ids: the task as an outside caller's create
 *     (pinned by default, no caller parent), the session on that host linked to it, the
 *     task's folder set, never an ask, and the connection looks at it (the rescue);
 *   - its task_update / task_complete take exactly what the op takes online, with no
 *     session or device gate; a field the op does not take refuses the whole write into the
 *     letter, which names the plugin's job, and no session is told;
 *   - the same records drained again, an ack lost after the apply, and a ledger lost between
 *     the apply and its row each land once (one task, one session);
 *   - a task created away that the Mac changed after the create merges a later queued write
 *     by the base rules (a newer Mac setting wins, both texts' lines survive);
 *   - a `run: 'task'` session for a task the host's journal did not create, or a run this
 *     Mac does not know, is refused and never stamped as an ask.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-plugin-job'))
const told = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async (...a: unknown[]) => { told.calls.push(a); return { delivery: 'queued' } }),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, listTasks, updateTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { getSessionByClaudeId, getSessionsForTaskSync } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { buildConflictLetter } from '../../../src/core/offline-merge/letter.js'
import { MAC_DRAINS } from '../../../src/core/offline-merge/apply-v2.js'
import { JOURNAL_V2_DRAINS } from '../../../src/providers/offline-journal-core.js'

const HOST = 'devbox'
const JOB = { kind: 'plugin-job', plugin: 'acme-worker', job: 'worker' }
let seqN = 7000
let opN = 0
const op = (): string => `op-job-${(++opN).toString(16).padStart(12, '0')}`
let sidN = 0
const sid = (): string => `eeeeeeee-5555-4555-8555-${(++sidN).toString(16).padStart(12, '0')}`
let idN = 0
const mintedId = (): string => `mtaskjob${(++idN).toString(16).padStart(13, '0')}`

const createRec = (taskId: string, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now() - 120_000, kind: 'task-create', opId: op(), rev: 1, actor: JOB,
  taskId, fields: { title: 'Review marina pull 12', description: 'one\ntwo\n' }, placement: { project: 'Marina' }, ...over,
})
const sessionRec = (s: string, taskId: string, createOpId: string, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now() - 110_000, kind: 'session', opId: `${createOpId}-session`, rev: 1, actor: JOB,
  sid: s, taskId, host: HOST, cwd: '/srv/marina', mode: 'auto', effort: 'low', title: 'Review marina pull 12',
  startedAt: Date.now() - 110_000, firstMessage: 'Review the pull request', run: 'task', ...over,
})
const fieldsRec = (taskId: string, fields: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now() - 60_000, kind: 'task-fields', opId: op(), rev: 1, actor: JOB, op: 'task_update', taskId, fields, ...over,
})

/** A host journal that keeps a record until an ack reaches it; `failAcks` acks are lost (the link drops). */
function journal(records: Array<Record<string, unknown>>, opts: { failAcks?: number } = {}) {
  const pending = [...records]
  const rescued: string[][] = []
  let failAcks = opts.failAcks ?? 0
  return {
    pending, rescued,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') {
          if (failAcks > 0) { failAcks--; throw new Error('not connected') }
          for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        }
        return { ok: true }
      },
      rescue: async (ids: string[]) => { rescued.push(ids) },
    },
  }
}

function entriesOf(opId: string): Array<{ drainId: string; entry: ConflictEntry }> {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => (readConflictLog(n.slice(0, -5))?.entries ?? []).filter((e) => e.opId === opId).map((entry) => ({ drainId: n.slice(0, -5), entry })))
}

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
  told.calls.length = 0
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('the drains this Mac names', () => {
  it('lists plugin-job-actor and task-start, so a host writes such records for it', () => {
    expect(MAC_DRAINS).toEqual(expect.arrayContaining(['plugin-job-actor', 'task-start']))
    // Every capability the daemon may wait on, this Mac names (an older Mac never gets one).
    for (const d of JOURNAL_V2_DRAINS) expect(MAC_DRAINS, d).toContain(d)
  })
})

describe('a task a plugin job created on its host, and the session the host started for it', () => {
  it('is adopted under the same ids: the session on that host linked to the task, never an ask', async () => {
    const id = mintedId()
    const s = sid()
    const create = createRec(id)
    const j = journal([create, sessionRec(s, id, create.opId)])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const task = await getTask(id)
    expect(task.id).toBe(id)
    expect(task).toMatchObject({ title: 'Review marina pull 12', project: 'Marina', cwd: '/srv/marina', created_by_op: create.opId })
    // An outside caller's create: pinned by default (newTaskPinDefault), no caller parent, no ask.
    expect(task.pinned).toBe(true)
    expect(task.parent_task_id).toBeFalsy()
    expect(task.walnut_agent).toBeFalsy()
    expect(task).toMatchObject({ session_id: s, exec_session_id: s })
    expect(task.session_ids).toContain(s)
    const rec = await getSessionByClaudeId(s)
    expect(rec).toMatchObject({ claudeSessionId: s, taskId: id, host: HOST, cwd: '/srv/marina', mode: 'auto', effort: 'low', process_status: 'stopped' })
    // No persona: a plain session of a task, not an ask of an agent.
    expect(rec!.profile).toBeUndefined()
    expect(j.rescued.flat()).toContain(s)
    // The board reads it as any task with its session.
    expect((await listTasks()).filter((t) => t.title === 'Review marina pull 12' && t.id === id)).toHaveLength(1)
    expect(getSessionsForTaskSync(id).map((x) => x.claudeSessionId)).toEqual([s])
    // A plain session's text goes nowhere: nobody is told anything.
    expect(told.calls).toHaveLength(0)
  })

  it('the same records drained again, and an ack lost after the apply, land once', async () => {
    const id = mintedId()
    const s = sid()
    const create = createRec(id, { fields: { title: 'Nightly marina triage' } })
    const session = sessionRec(s, id, create.opId, { title: 'Nightly marina triage' })
    // The first drain applies both, then its ack never reaches the host.
    const lost = journal([create, session], { failAcks: 1 })
    await expect(runOfflineHandover(lost.conn as never)).rejects.toThrow()
    expect(lost.pending).toHaveLength(2)
    // The host hands the same records over again: taken from the ledger, acked, nothing new.
    await runOfflineHandover(lost.conn as never)
    expect(lost.pending).toHaveLength(0)
    // And once more from another drain of the same journal (a restart of the host's link).
    const again = journal([create, session])
    await runOfflineHandover(again.conn as never)
    expect(again.pending).toHaveLength(0)
    expect((await listTasks()).filter((t) => t.title === 'Nightly marina triage')).toHaveLength(1)
    expect(getSessionsForTaskSync(id).filter((x) => x.claudeSessionId === s)).toHaveLength(1)
  })

  it('a drain stopped between the apply and its ledger row (a restart) lands once on the redrain', async () => {
    const id = mintedId()
    const s = sid()
    const create = createRec(id, { fields: { title: 'Weekly marina digest' } })
    const session = sessionRec(s, id, create.opId, { title: 'Weekly marina digest' })
    await runOfflineHandover(journal([create, session]).conn as never)
    // The ledger rows never made it to disk: the redrain reaches both applies again.
    const { _setLedgerFileForTesting } = await import('../../../src/core/offline-merge/ledger.js')
    _setLedgerFileForTesting(path.join(os.tmpdir(), `ledger-plugin-job-${process.pid}-${Date.now()}.json`))
    try {
      const again = journal([create, session])
      await runOfflineHandover(again.conn as never)
      expect(again.pending).toHaveLength(0)
    } finally {
      _setLedgerFileForTesting(null)
    }
    // The create finds its own task (created_by_op), the session its own record: no re-mint, no second session.
    expect((await listTasks()).filter((t) => t.title === 'Weekly marina digest').map((t) => t.id)).toEqual([id])
    expect(getSessionsForTaskSync(id).filter((x) => x.claudeSessionId === s)).toHaveLength(1)
  })

  it('a run:\'task\' session for a task the host\'s journal did not create, or an unknown run, is refused and never an ask', async () => {
    const mine = (await addTask({ title: 'A Mac task', project: 'Marina' } as never)).task
    const s1 = sid()
    const s2 = sid()
    const id = mintedId()
    const create = createRec(id, { fields: { title: 'Odd run' } })
    const j = journal([sessionRec(s1, mine.id, op()), create, sessionRec(s2, id, create.opId, { run: 'something-new' })])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(await getSessionByClaudeId(s1)).toBeNull()
    expect(await getSessionByClaudeId(s2)).toBeNull()
    const after = await getTask(mine.id)
    expect(after.walnut_agent).toBeFalsy()
    expect(after.session_ids ?? []).not.toContain(s1)
    expect((await getTask(id)).walnut_agent).toBeFalsy()
  })
})

describe('a plugin job\'s queued writes', () => {
  it('task_update and task_complete land with the op\'s own fields and no session or device gate', async () => {
    const id = mintedId()
    const create = createRec(id, { fields: { title: 'Job-owned marina task' } })
    const update = fieldsRec(id, { priority: { base: 'none', value: 'important' }, description: { base: '', value: 'Found two flaky tests.' } })
    const complete = fieldsRec(id, { phase: { base: 'TODO', value: 'COMPLETE' } }, { op: 'task_complete', at: Date.now() - 30_000 })
    const j = journal([create, update, complete])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const t = await getTask(id)
    expect(t).toMatchObject({ priority: 'important', description: 'Found two flaky tests.', phase: 'COMPLETE' })
    expect(told.calls).toHaveLength(0)
  })

  it('a field the op does not take refuses the whole write into the letter, which names the plugin\'s job', async () => {
    const id = mintedId()
    const create = createRec(id, { fields: { title: 'Strict marina task' } })
    // task_update takes no `unread` and no `note`: online the same call is refused.
    const bad = fieldsRec(id, { unread: { base: false, value: true }, priority: { base: 'none', value: 'low' } })
    // task_create takes no `summary` either.
    const badCreate = createRec(mintedId(), { fields: { title: 'Never made', summary: 'x' } })
    const j = journal([create, bad, badCreate])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const t = await getTask(id)
    expect(t.priority).not.toBe('low')
    expect(t.unread).not.toBe(true)
    expect((await listTasks()).some((x) => x.title === 'Never made')).toBe(false)
    const refusals = [...entriesOf(bad.opId), ...entriesOf(badCreate.opId)]
    expect(refusals.map((r) => r.entry.kind)).toEqual(['refused', 'refused'])
    expect(refusals[0].entry.reason).toContain('task_update does not take unread')
    // The letter lists them for the user (no session made them to tell), naming who did.
    const letter = buildConflictLetter(readConflictLog(refusals[0].drainId)!)
    expect(letter?.markdown).toContain("It was made by the acme-worker plugin's job worker.")
    expect(told.calls).toHaveLength(0)
  })

  it('a task created away and changed on the Mac since merges a later queued write by the base rules', async () => {
    const id = mintedId()
    const create = createRec(id, { fields: { title: 'Shared marina notes', description: 'one\ntwo\n' }, at: Date.now() - 300_000 })
    await runOfflineHandover(journal([create]).conn as never)
    // The person edits it on the Mac now, after the job's later write was queued on the host.
    await updateTask(id, { priority: 'important' } as never)
    await updateTaskRaw(id, { description: 'one\ntwo\nMac line\n' })
    const later = fieldsRec(id, {
      priority: { base: 'none', value: 'backlog' },
      description: { base: 'one\ntwo\n', value: 'Job line\none\ntwo\n' },
    }, { at: Date.now() - 60_000 })
    const j = journal([later])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const t = await getTask(id)
    // A setting both sides changed: the newer change (the Mac's) is kept.
    expect(t.priority).toBe('important')
    // Words both sides wrote: both lines survive.
    expect(t.description).toContain('Job line')
    expect(t.description).toContain('Mac line')
  })
})
