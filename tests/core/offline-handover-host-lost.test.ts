/**
 * A host comes back with the journal of what its sessions did while the Mac could not reach it
 * (offline-handover.ts). A session Walnut stopped as lost in that time (sessions/host-lost.ts)
 * had its task go on elsewhere: what it did after the stop is not applied (kept in the drain's
 * conflict log, no letter: a session's refused write is that session's to hear, and this one is
 * gone); what it did before the stop goes through as any session's write.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-host-lost'))
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../src/core/offline-handover.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { listLetters } from '../../src/core/human-inbox/store.js'

const SID = 'cdcdcdcd-8888-4888-8888-888888888888'
let seq = 0
type Rec = Record<string, unknown> & { seq: number }
const rec = (taskId: string, fields: Record<string, { base: unknown; value: unknown }>, at: number): Rec =>
  ({ v: 2, seq: ++seq, at, kind: 'task-fields', opId: `op-lost-${seq}`, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields })

async function drain(records: Rec[]): Promise<void> {
  let handed = false
  await runOfflineHandover({
    hostKey: 'laptop', journalV2: true,
    send: async (cmd) => {
      if (cmd === 'offline.ack') return { ok: true }
      if (cmd === 'offline.drain') { const r = handed ? [] : records; handed = true; return { ok: true, records: r, now: Date.now() } }
      return { ok: true }
    },
  })
}

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _setHandoverBackoffForTesting([])
})
afterAll(() => {
  _setHandoverBackoffForTesting(null)
  closeDb()
})

describe('offline handover from a host whose session was stopped as lost', () => {
  it('applies what the session did before its stop and drops what it did after', async () => {
    const id = (await addTask({ title: 'Parser', project: 'Marina', description: 'one\n' })).task.id
    const lostAt = Date.now() - 60_000
    await createSessionRecord(SID, id, 'Marina', '/work/marina')
    await updateSessionRecord(SID, { host: 'laptop', process_status: 'stopped', hostLost: { at: new Date(lostAt).toISOString(), host: 'laptop', why: 'timed out', by: 'human' } } as never)
    const before = (await listLetters()).letters.length
    await drain([
      rec(id, { title: { base: 'Parser', value: 'Parser (before the stop)' } }, lostAt - 30_000),
      rec(id, { description: { base: 'one\n', value: 'one\nwritten after the stop\n' } }, lostAt + 30_000),
    ])
    const task = await getTask(id)
    expect(task.title).toBe('Parser (before the stop)')
    expect(task.description).toBe('one\n')
    expect((await listLetters()).letters.length).toBe(before)
  })

  it('once its host ended it, the session is an ordinary one again: its later writes apply', async () => {
    const id = (await addTask({ title: 'Lexer', project: 'Marina' })).task.id
    const sid = 'efefefef-9999-4999-8999-999999999999'
    const lostAt = Date.now() - 120_000
    await createSessionRecord(sid, id, 'Marina', '/work/marina')
    await updateSessionRecord(sid, { host: 'laptop', process_status: 'stopped', stopRequest: { id: 's1', requestedAt: new Date(lostAt).toISOString(), state: 'confirmed' },
      hostLost: { at: new Date(lostAt).toISOString(), host: 'laptop', why: 'timed out', endedAt: new Date(lostAt + 60_000).toISOString() } } as never)
    const r = (title: string, at: number): Rec => ({ v: 2, seq: ++seq, at, kind: 'task-fields', opId: `op-lost-${seq}`, rev: 1, actor: { kind: 'session', sid }, op: 'task_update', taskId: id, fields: { title: { base: 'Lexer', value: title } } })
    await drain([r('Lexer (after its host ended it)', lostAt + 90_000)])
    expect((await getTask(id)).title).toBe('Lexer (after its host ended it)')
  })
})
