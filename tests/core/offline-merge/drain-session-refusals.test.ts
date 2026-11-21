/**
 * A session record the Mac does not take never holds the host's drain, and a session a host
 * started alone that the Mac does not take is ended (apply-session.ts, offline-handover.ts),
 * against the real task store, session tracker, ledger and conflict log of a temp home:
 *   - a store's own refusal (one session per task: the Mac started its own meanwhile) is a
 *     refusal into the letter, never a retry, and the records after it land;
 *   - an error that may pass (the task store busy) is retried, never turned into a refusal;
 *   - a `run: 'task'` session refused, or given up after its retries, has its CLI ended through
 *     the daemon that owns it, and the letter names the session and the host;
 *   - a refused ask leaves its task as it was (no `walnut_agent` stamp);
 *   - a redrain of a session the Mac already linked looks at its CLI again (the rescue);
 *   - a refused run's start phase is taken back through the phase API (told and pushed like the
 *     forward write), also when an earlier drain wrote it and was cut before the record.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-session-refusals'))
const busy = vi.hoisted(() => ({ taskId: '', left: 0 }))
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/task-manager.js')>()
  return {
    ...real,
    // The task store busy for `left` more reads of one task: an error that may pass.
    getTask: async (id: string) => {
      if (id === busy.taskId && busy.left > 0) { busy.left--; throw new Error('SQLITE_BUSY: database is locked') }
      return real.getTask(id)
    },
  }
})

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { getTask, linkSession, updateTaskRaw } from '../../../src/core/task-manager.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { __setOwnerConnectionForTesting } from '../../../src/core/sessions/owner-stop.js'

const HOST = 'devbox'
const JOB = { kind: 'plugin-job', plugin: 'acme-worker', job: 'worker' }
let seqN = 11000
let opN = 0
const op = (): string => `op-refuse-${(++opN).toString(16).padStart(12, '0')}`
let sidN = 0
const sid = (): string => `abababab-7777-4777-8777-${(++sidN).toString(16).padStart(12, '0')}`
let idN = 0
const minted = (): string => `mtaskrefuse${(++idN).toString(16).padStart(10, '0')}`

const createRec = (taskId: string, title: string) => ({
  v: 2, seq: ++seqN, at: Date.now() - 120_000, kind: 'task-create', opId: op(), rev: 1, actor: JOB,
  taskId, fields: { title }, placement: { project: 'Quay' },
})
const runRec = (s: string, taskId: string, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now() - 100_000, kind: 'session', opId: `${op()}-session`, rev: 1, actor: JOB,
  sid: s, taskId, host: HOST, cwd: '/srv/quay', mode: 'default', title: 'Quay work',
  startedAt: Date.now() - 100_000, firstMessage: 'Quay work', run: 'task', ...over,
})
const askRec = (s: string, taskId: string) => {
  const { run: _run, ...rest } = runRec(s, taskId, { agentId: 'general' })
  return rest
}

/** A host journal that keeps a record until an ack reaches it, and records each rescue. */
function journal(records: Array<Record<string, unknown>>) {
  const pending = [...records]
  const rescued: string[][] = []
  return {
    pending, rescued,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        return { ok: true }
      },
      rescue: async (ids: string[]) => { rescued.push(ids) },
    },
  }
}

/** The stops the owning daemon was asked for (owner-stop.ts, through its test connection). */
const stops: Array<{ host: string; sid: unknown }> = []

function entriesOf(opId: string): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => (readConflictLog(n.slice(0, -5))?.entries ?? []).filter((e) => e.opId === opId))
}

/** A task its host's journal made, drained alone first. */
async function hostTask(title: string): Promise<string> {
  const id = minted()
  const j = journal([createRec(id, title)])
  await runOfflineHandover(j.conn as never)
  expect(j.pending).toHaveLength(0)
  return id
}

/** This Mac's own session of the task, running. */
async function macSession(taskId: string): Promise<string> {
  const s = sid()
  await createSessionRecord(s, taskId, 'Quay', '/Users/acme/quay', { initialProcessStatus: 'running' })
  await linkSession(taskId, s)
  return s
}

beforeAll(() => {
  __setOwnerConnectionForTesting(async (host) => ({
    connected: true,
    hasCapability: () => true,
    send: async (cmd, args) => { if (cmd === 'stop') stops.push({ host, sid: args.sid }); return { ok: true, stopped: true } },
  }))
})
beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
  busy.taskId = ''
  busy.left = 0
})
afterAll(() => { __setOwnerConnectionForTesting(null); _setHandoverBackoffForTesting(null); closeDb() })

describe('a session record this Mac does not take', () => {
  it('a store\'s own refusal (the task took this Mac\'s session meanwhile) is a refusal, the drain goes on, and the host\'s CLI is ended', async () => {
    const id = await hostTask('Quay roster')
    const mine = await macSession(id)
    const s = sid()
    const rec = runRec(s, id)
    // A record after it, of another task, lands in the same drain.
    const next = minted()
    const j = journal([rec, createRec(next, 'Quay tide table')])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect((await getTask(next)).title).toBe('Quay tide table')
    expect(await getSessionByClaudeId(s)).toBeNull()
    expect((await getTask(id)).session_id).toBe(mine)
    const [entry] = entriesOf(rec.opId)
    expect(entry).toMatchObject({ kind: 'refused' })
    expect(entry!.reason).toContain(`its session ${s} on ${HOST} is being ended`)
    await vi.waitFor(() => expect(stops).toContainEqual({ host: HOST, sid: s }))
    expect(stops.filter((x) => x.sid === mine)).toEqual([])
  })

  it('a refused run (its task never reached this Mac) has its CLI ended, and the letter says which and where', async () => {
    const s = sid()
    const rec = runRec(s, minted())
    const j = journal([rec])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(entriesOf(rec.opId)[0]!.reason).toContain(`its session ${s} on ${HOST} is being ended`)
    await vi.waitFor(() => expect(stops).toContainEqual({ host: HOST, sid: s }))
  })

  it('an error that may pass (the task store busy) is retried, never refused; given up after its retries, the CLI is ended', async () => {
    const id = await hostTask('Quay buoys')
    const s = sid()
    const rec = runRec(s, id)
    // Busy once: the record is retried after its backoff, and lands; nothing is lettered.
    busy.taskId = id
    busy.left = 1
    const j = journal([rec])
    for (let i = 0; i < 5 && j.pending.length; i++) await runOfflineHandover(j.conn as never).catch(() => {})
    expect(j.pending).toHaveLength(0)
    expect(busy.left).toBe(0)
    expect(entriesOf(rec.opId)).toEqual([])
    expect(await getSessionByClaudeId(s)).toMatchObject({ taskId: id, host: HOST })
    expect(stops.filter((x) => x.sid === s)).toEqual([])
    // Busy for good: given up after the retries, into the letter, and its CLI ended.
    const id2 = await hostTask('Quay cranes')
    const s2 = sid()
    const rec2 = runRec(s2, id2)
    busy.taskId = id2
    busy.left = 1_000
    const k = journal([rec2])
    for (let i = 0; i < 8 && k.pending.length; i++) await runOfflineHandover(k.conn as never).catch(() => {})
    expect(k.pending).toHaveLength(0)
    const [entry] = entriesOf(rec2.opId)
    expect(entry).toMatchObject({ kind: 'given-up' })
    expect(entry!.reason).toContain(`its session ${s2} on ${HOST} is being ended`)
    await vi.waitFor(() => expect(stops).toContainEqual({ host: HOST, sid: s2 }))
  })

  it('a refused ask leaves its task as it was: no ask stamp', async () => {
    const id = await hostTask('Quay ask')
    await macSession(id)
    const s = sid()
    const rec = askRec(s, id)
    const j = journal([rec])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(entriesOf(rec.opId).map((e) => e.kind)).toEqual(['refused'])
    expect((await getTask(id)).walnut_agent).toBeFalsy()
    // An ask is no run started alone: nothing is asked to end.
    expect(stops.filter((x) => x.sid === s)).toEqual([])
  })

  it('a refused run\'s start phase is taken back, told to the web as the forward write was', async () => {
    const id = await hostTask('Quay pilots')
    await macSession(id)
    expect((await getTask(id)).phase).toBe('TODO')
    const phases: string[] = []
    bus.subscribe('test-undo-phase', (e) => {
      const t = (e.data as { task?: { id?: string; phase?: string } } | undefined)?.task
      if (e.name === EventNames.TASK_UPDATED && t?.id === id && t.phase) phases.push(t.phase)
    }, { global: true })
    try {
      const rec = runRec(sid(), id)
      await runOfflineHandover(journal([rec]).conn as never)
      expect(entriesOf(rec.opId).map((e) => e.kind)).toEqual(['refused'])
      expect((await getTask(id)).phase).toBe('TODO')
      await vi.waitFor(() => expect(phases.at(-1)).toBe('TODO'))
      expect(phases).toContain('IN_PROGRESS')
    } finally {
      bus.unsubscribe('test-undo-phase')
    }
  })

  it('a start phase an earlier drain wrote before it was cut (no session record yet) is taken back when the retry is refused', async () => {
    const id = await hostTask('Quay moorings')
    const s = sid()
    const rec = runRec(s, id)
    // What the cut drain left: the start's phase, with the start's own field time (startPhase), and no record.
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { source: 'offline-handover' })
    await updateTaskRaw(id, (t) => ({ field_at: { ...(t.field_at ?? {}), phase: new Date(rec.at).toISOString() } }), { source: 'offline-handover' })
    expect((await getTask(id)).field_at?.phase).toBe(new Date(rec.at).toISOString())
    expect(await getSessionByClaudeId(s)).toBeNull()
    // Meanwhile this Mac started its own session of the task: the retry's record is refused.
    await macSession(id)
    await runOfflineHandover(journal([rec]).conn as never)
    expect(entriesOf(rec.opId).map((e) => e.kind)).toEqual(['refused'])
    expect((await getTask(id)).phase).toBe('TODO')
  })

  it('a phase someone else set is not taken back by a refused run', async () => {
    const id = await hostTask('Quay fenders')
    // A person's In Progress, long after the start: not the start's phase.
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await macSession(id)
    const rec = runRec(sid(), id, { at: Date.now() - 3_600_000, startedAt: Date.now() - 3_600_000 })
    await runOfflineHandover(journal([rec]).conn as never)
    expect(entriesOf(rec.opId).map((e) => e.kind)).toEqual(['refused'])
    expect((await getTask(id)).phase).toBe('IN_PROGRESS')
  })

  it('a redrain of a session already linked (the drain cut before its rescue) looks at its CLI again', async () => {
    const id = await hostTask('Quay lights')
    const s = sid()
    const rec = runRec(s, id)
    await runOfflineHandover(journal([rec]).conn as never)
    expect((await getTask(id)).session_id).toBe(s)
    // The ledger row never made it to disk (a restart right after the apply): the redrain reaches the apply again.
    const { _setLedgerFileForTesting } = await import('../../../src/core/offline-merge/ledger.js')
    _setLedgerFileForTesting(path.join(os.tmpdir(), `ledger-session-refusals-${process.pid}-${Date.now()}.json`))
    try {
      const again = journal([rec])
      await runOfflineHandover(again.conn as never)
      expect(again.pending).toHaveLength(0)
      expect(again.rescued.flat()).toContain(s)
    } finally {
      _setLedgerFileForTesting(null)
    }
  })
})
