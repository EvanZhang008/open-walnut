/**
 * A create made on this host while the leader is away is filed by the leader's own rules
 * (replica/away-create-placement.ts: caller-placement.ts decidePlacement, create-rules.ts
 * applyCreateRules, the drain's journal-actor.ts createCaller reading the caller's task through
 * the replica's copy), over the REAL offline host and journal (offline-host-core.ts):
 *   - a session's create with no project: the caller's project, as its subtask, in its board tier;
 *     the record holds that parent and tier and the project as `inheritedProject` (this host's readers
 *     show it, every drain ignores it, so a caller moved meanwhile takes its subtask along), never the
 *     caller's folder (the leader files it beside its caller under its own lock), and the answer's
 *     `placement` says so in the leader's shape; a daemon without follower-create-inherited-v1 gets no
 *     project in the record at all;
 *   - naming the caller's own project: the same; another project without the user's words:
 *     refused, nothing kept;
 *   - a caller with no task (a plugin job, a device, a session no copy knows): as before;
 *   - the start of such a task proceeds to follower.start when the placed project's default host
 *     is this host (2026-11-22: the create landed in the Inbox, and the start was refused for the
 *     Inbox's host).
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-away-create-placement'))

import { WALNUT_HOME } from '../../src/constants.js'
import { JHOME, journalTmpDir, cleanupJournalDirs, journalHost, jslice, journalLines } from '../helpers/offline-journal-harness.js'
import { createWritePort, type TaskRow, type WriteActor } from '../../src/replica/write-port.js'
import { INHERITED_PROJECT_CAP } from '../../src/replica/away-create-placement.js'
import { createOverlay } from '../../src/replica/overlay.js'
import { linkWrite } from '../../src/replica/ws-writes.js'
import { createCaller } from '../../src/core/offline-merge/journal-actor.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { awayStarts, type AwayStartsDeps } from '../../src/replica/away-starts.js'
import type { ReplicaWrite } from '../../src/replica/dispatch.js'
import type { CallerTaskRow } from '../../src/core/sessions/caller-placement.js'

const HOST = 'devbox'
const T0 = Date.parse('2026-11-22T12:00:00Z')
const CALLER_SID = '9b57ab65-1111-4111-8111-000000000001'
const LOOSE_SID = '9b57ab65-1111-4111-8111-000000000002'
const UNPINNED_SID = '9b57ab65-1111-4111-8111-000000000003'
/** The caller's task as this host's copy holds it: in a project, a folder and a tier. */
const CALLER: TaskRow = { id: 'mcaller-0001', title: 'Host service work', phase: 'IN_PROGRESS', project: 'Marina', group_id: 'g_marina0070', pinned: true, focus_tier: 'focus' }
const UNPINNED: TaskRow = { id: 'mcaller-0002', title: 'Quiet work', phase: 'IN_PROGRESS', project: 'Marina', pinned: false }
const PHONE: WriteActor = { kind: 'device', deviceId: 'dev-marina-phone', name: 'Marina phone' }
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await createSessionRecord(CALLER_SID, CALLER.id, 'Marina', '/work/marina', { title: CALLER.title as string, host: HOST })
  await createSessionRecord(UNPINNED_SID, UNPINNED.id, 'Marina', '/work/marina', { title: UNPINNED.title as string, host: HOST })
  // A session the tracker knows with no task of the copy behind it.
  await createSessionRecord(LOOSE_SID, 'mgone-0009', 'Marina', '/work/marina', { title: 'Gone', host: HOST })
})

afterEach(() => cleanupJournalDirs())

function rig(caps: readonly string[] | null = [INHERITED_PROJECT_CAP]) {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const { host } = journalHost(dir, clock)
  host.configure(jslice())
  const copy = new Map<string, TaskRow>([[CALLER.id, CALLER], [UNPINNED.id, UNPINNED]])
  const request = async (_cmd: string, params: Record<string, unknown>) => {
    const r = host.handleFollower(JHOME, params as never)
    return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code }
  }
  const overlay = createOverlay({ fetchPending: async () => host.pendingFor(JHOME, 0) as never, now: () => clock.now })
  const shown = async (id: string) => { await overlay.refresh(); return overlay.task(id, copy.get(id) ?? null) as TaskRow | null }
  let hexN = 0
  const port = createWritePort({
    task: shown,
    createdHere: (id) => overlay.createPending(id),
    board: async () => null,
    noteWritten: (e) => overlay.noteWritten(e),
    // As away-wiring.ts wires it: the drain's caller, its task read as this replica shows it.
    createCaller: async (actor) => (await createCaller(actor, { readTask: async (id) => (await shown(id)) as CallerTaskRow | null })).caller,
    capabilities: () => caps,
    now: () => clock.now,
    randomHex: (n) => (++hexN).toString(16).padStart(n * 2, '0'),
  })
  const write = (opId?: string) => linkWrite({ request, linked: () => true, log: () => {} }, opId)
  const records = () => journalLines(dir).map((l) => JSON.parse(l)).filter((r) => typeof r.seq === 'number')
  return { port, write, records, overlay, shown }
}

const session = (sid: string): WriteActor => ({ kind: 'session', sid })
const bodyOf = (a: unknown) => (a as { body: Record<string, any> }).body

describe('an away create is placed by the leader\'s caller rule', () => {
  it('a session inside a task, naming no project: the caller\'s project, as its subtask, in its tier; no folder in the record', async () => {
    const r = rig()
    const made = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Fix the follower create' })
    expect(made).toMatchObject({ answered: false, status: 201 })
    const body = bodyOf(made)
    expect(body.placement).toEqual({ project: 'Marina', folder_created: false, inherited_from: CALLER.id, parent_task_id: CALLER.id, tier: 'focus' })
    expect(body.task).toMatchObject({ project: 'Marina', parent_task_id: CALLER.id, pinned: true, focus_tier: 'focus' })
    const [rec] = r.records()
    expect(rec).toMatchObject({ kind: 'task-create', actor: session(CALLER_SID), fields: { title: 'Fix the follower create', pinned: true } })
    expect(rec.placement).toEqual({ parentTaskId: CALLER.id, inheritedProject: 'Marina', tier: 'focus' })
    // What this host shows of it until the leader's row comes back: the same place.
    expect(await r.shown(rec.taskId)).toMatchObject({ project: 'Marina', parent_task_id: CALLER.id, pinned: true, focus_tier: 'focus' })
  })

  it('naming the caller\'s own project: the same place; another project without the user\'s words: refused, nothing kept', async () => {
    const r = rig()
    const own = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Beside mine', project: 'Marina' })
    expect(bodyOf(own).placement).toEqual({ project: 'Marina', folder_created: false, inherited_from: CALLER.id, parent_task_id: CALLER.id, tier: 'focus' })
    expect(r.records()[0].placement).toEqual({ parentTaskId: CALLER.id, project: 'Marina', tier: 'focus' })
    const far = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Elsewhere work', project: 'Elsewhere' })
    expect(far).toMatchObject({ status: 409, body: { error: { code: 'project_elsewhere' } } })
    expect(bodyOf(far).error.message).toContain('Host service work')
    expect(r.records()).toHaveLength(1)
    // A tier the create names wins over the caller's, as online.
    const named = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Parked work', focus_tier: 'wait' })
    expect(bodyOf(named).placement).not.toHaveProperty('tier')
    expect(r.records()[1].placement).toEqual({ parentTaskId: CALLER.id, inheritedProject: 'Marina', tier: 'wait' })
    expect(r.records()[1].fields).not.toHaveProperty('pinned')
  })

  it('a daemon that keeps no inherited project: none in the record (the drain files it under the caller), the answer still says where', async () => {
    for (const caps of [[], null]) {
      const r = rig(caps)
      const made = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Fix it on an older daemon' })
      expect(made).toMatchObject({ answered: false, status: 201 })
      expect(bodyOf(made).placement).toMatchObject({ project: 'Marina', parent_task_id: CALLER.id })
      expect(bodyOf(made).task).toMatchObject({ project: 'Marina', parent_task_id: CALLER.id })
      expect(r.records()[0].placement).toEqual({ parentTaskId: CALLER.id, tier: 'focus' })
      // A project the create names rides as before.
      await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Named on an older daemon', project: 'Marina' })
      expect(r.records()[1].placement).toEqual({ parentTaskId: CALLER.id, project: 'Marina', tier: 'focus' })
    }
  })

  it('an unpinned caller\'s subtask stays off the board, as online', async () => {
    const r = rig()
    const made = await r.port.taskCreate(r.write(), session(UNPINNED_SID), { title: 'Quiet subtask' })
    expect(bodyOf(made).placement).toMatchObject({ project: 'Marina', parent_task_id: UNPINNED.id, tier: 'unpinned' })
    expect(r.records()[0]).toMatchObject({ fields: { pinned: false }, placement: { parentTaskId: UNPINNED.id, inheritedProject: 'Marina' } })
    expect(bodyOf(made).task.pinned).toBe(false)
  })

  it('a caller with no task (a plugin job, a device, a session no copy knows): as before, nothing inherited', async () => {
    const r = rig()
    await r.port.taskCreate(r.write(), JOB, { title: 'Imported row' })
    await r.port.taskCreate(r.write(), PHONE, { title: 'From the phone', project: 'Acme', parent_task_id: CALLER.id })
    await r.port.taskCreate(r.write(), session(LOOSE_SID), { title: 'Loose work' })
    await r.port.taskCreate(r.write(), session('9b57ab65-ffff-4fff-8fff-00000000000f'), { title: 'Unknown caller', project: 'Elsewhere' })
    const recs = r.records()
    expect(recs.map((x) => x.placement)).toEqual([{}, { parentTaskId: CALLER.id, project: 'Acme' }, {}, { project: 'Elsewhere' }])
    expect(recs.map((x) => x.fields.pinned)).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('the start of a task placed in its caller\'s project', () => {
  it('proceeds to follower.start when that project\'s default host is this host', async () => {
    const r = rig()
    const made = await r.port.taskCreate(r.write(), session(CALLER_SID), { title: 'Start me here' })
    const id = String(bodyOf(made).task.id)
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
    const deps: AwayStartsDeps = {
      port: r.port, actorOf: () => session(CALLER_SID), hostKey: HOST,
      task: r.shown,
      capabilities: () => ['replica-ops-v1', 'follower-gateway-v1'],
      request: async () => ({ ok: true, sessions: [] }),
      sessionsOfTask: async () => [],
      // The Inbox runs on another machine; the caller's project on this one.
      projectMeta: async (p) => (p === 'Marina' ? { default_host: HOST, default_cwd: '/work/marina' } : { default_host: 'the-mac' }),
      madeHere: (tid) => r.overlay.createPending(tid),
      sessionExists: () => 'already started',
      liveLimit: () => 4,
      freshStart: async () => ({ mode: 'default', modeNamed: false, context: 'ctx' }),
      frame: async (text) => text,
      startCaller: { sessionMode: async () => 'bypass', vouchedJob: () => null },
      started: vi.fn(),
      log: () => {},
    }
    const w: ReplicaWrite = {
      opId: 'op-start-1', away: 'host-write', raw: Buffer.from(''), submit: vi.fn(),
      call: async (cmd, params) => { calls.push({ cmd, params }); return { kind: 'applied', reply: { sid: params.sid } } },
    } as unknown as ReplicaWrite
    const answer = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 0
      const req = { method: 'POST', path: `/v1/tasks/${id}/start`, body: { message: 'go', host: HOST, cwd: '/work/marina' }, replicaWrite: w, headers: {} } as unknown as Request
      const res = { headersSent: false, setHeader: () => {}, status(s: number) { status = s; return this }, json(b: unknown) { resolve({ status, body: b }); return this } } as unknown as Response
      awayStarts(deps)(req, res, () => reject(new Error('passed on')))
    })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200, body: { taskId: id, started: true, offline: true } })
    expect(calls.map((c) => c.cmd)).toEqual(['follower.start'])
    expect(calls[0]!.params).toMatchObject({ taskId: id, cwd: '/work/marina', host: HOST })
  })
})
