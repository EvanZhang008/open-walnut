/**
 * One source for the user status (docs/plan/one-service-every-host.md, phase 2, the plan's section
 * 6): the leader derives it from the task's phase and facts and stores it as `user_status`; a host
 * stores none; a reader on a replica gets the same function's answer, never a second stored copy;
 * and the leader derives once more, for a whole backlog of late facts, when it is back.
 *
 *   the late lane     a host's fact read back late is derived in one pass for its backlog, never in
 *                     the fast lane a fresh one takes
 *   one writer        on a replica syncUserStatuses writes nothing; deriveUserStatuses answers the
 *                     status the leader's pass then writes, the same function
 *   every writer      each place in src that sets a task's user_status is listed with why it is
 *                     the leader's: a new one fails here until it is
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-status-one-source'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { deriveUserStatuses, settleUserStatusSync, startUserStatusSync, stopUserStatusSync, syncUserStatuses } from '../../src/core/user-status-sync.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  stopUserStatusSync()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
})

afterAll(async () => {
  stopUserStatusSync()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** A task that read Working, whose session ended in an error since (not yet derived). */
async function erroredSince(title: string): Promise<string> {
  const t = (await addTask({ title, project: 'Acme' })).task
  await updateTask(t.id, { phase: 'IN_PROGRESS' })
  const sid = `sess-${t.id}`
  await createSessionRecord(sid, t.id, 'Acme')
  await updateSessionRecord(sid, { process_status: 'running', pid: process.pid })
  await updateTaskRaw(t.id, { session_id: sid } as never)
  await syncUserStatuses(new Set([t.id]))
  expect((await getTask(t.id)).user_status?.state).toBe('working')
  // Not a turn's hand-back (that one is held for its settle, user-status-sync.ts handBackSettlesAt).
  await updateSessionRecord(sid, { process_status: 'error', errorMessage: 'The process ended unexpectedly' })
  return t.id
}

describe('the late lane', () => {
  /** A task with no session whose phase moved to Needs action silently (no event): derived only when marked. */
  async function movedSilently(title: string): Promise<string> {
    const t = (await addTask({ title, project: 'Acme' })).task
    return t.id
  }

  it('a fresh session fact takes the fast lane; a late one waits for its backlog, then derives once', async () => {
    const fresh = await movedSilently('Fresh fact')
    const late = await movedSilently('Late fact')
    startUserStatusSync()
    await settleUserStatusSync()
    const before = (await getTask(late)).user_status?.state
    expect(before).not.toBe('needs')
    await updateTaskRaw(fresh, { phase: 'NEED_ACTION' })
    await updateTaskRaw(late, { phase: 'NEED_ACTION' })
    const writes: string[] = []
    bus.subscribe('test-one-source', (e) => {
      const id = (e.data as { task?: { id?: string } }).task?.id
      if (e.source === 'user-status' && id) writes.push(id)
    }, { global: true, interest: [EventNames.TASK_UPDATED] })

    // session:started is a fast-lane event (sessionMovesNow): derived in a few ms when fresh.
    bus.emit(EventNames.SESSION_STARTED, { sessionId: 'sess-fresh', taskId: fresh }, ['web-ui'], { source: 'host-channel' })
    for (let i = 0; i < 3; i++) bus.emit(EventNames.SESSION_STARTED, { sessionId: 'sess-late', taskId: late }, ['web-ui'], { source: 'host-channel', late: true })
    await sleep(800)
    expect((await getTask(fresh)).user_status?.state).toBe('needs')
    // The late ones gather (late-gather.ts), then take the ordinary lane: not derived yet.
    expect((await getTask(late)).user_status?.state).toBe(before)
    await settleUserStatusSync()
    expect((await getTask(late)).user_status?.state).toBe('needs')
    // One write for the late task's backlog of three facts.
    expect(writes.filter((id) => id === late)).toHaveLength(1)
    bus.unsubscribe('test-one-source')
  })
})

describe('one writer', () => {
  it('a replica writes no status; it derives the one the leader then writes', async () => {
    const id = await erroredSince('Derived on a replica')
    // This server as a host replica (WALNUT_HOST_SERVER=1): the boot policy writes no statuses here.
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    expect(await syncUserStatuses(null)).toBe(0)
    expect((await getTask(id)).user_status?.state).toBe('working')
    const shown = (await deriveUserStatuses(new Set([id]))).get(id)
    expect(shown?.state).toBeDefined()
    expect(shown?.state).not.toBe('working')
    // Back on the leader: its pass writes exactly what the replica showed.
    delete process.env.WALNUT_HOST_SERVER
    _resetServerRoleForTesting()
    expect(await syncUserStatuses(new Set([id]))).toBe(1)
    const stored = (await getTask(id)).user_status!
    expect({ state: stored.state, source: stored.source, ask: stored.ask }).toEqual({ state: shown!.state, source: shown!.source, ask: shown!.ask })
  })

  it('a finished task is not derived for a reader: it reads Done', async () => {
    const t = (await addTask({ title: 'Done already', project: 'Acme' })).task
    await updateTask(t.id, { phase: 'COMPLETE' })
    expect((await deriveUserStatuses(new Set([t.id]))).has(t.id)).toBe(false)
  })
})

/**
 * Every place in src that sets a task's user_status (an object key or an assignment), with what
 * it is. A writer must be the leader's: the boot policy's one pass, or a stamp inside a task
 * write (which runs where tasks are written: the leader; a host replica's copy reads only,
 * replica/copy-guard.ts, and its away writes go to the Mac's journal). A view builds an answer or
 * a copy for a reader and stores nothing.
 */
const USER_STATUS_SITES: Record<string, { n: number; kind: 'writer' | 'view'; why: string }> = {
  'src/core/user-status-sync.ts': { n: 3, kind: 'writer', why: 'the one pass, behind bootPolicy(user-status) in syncUserStatuses; and a pass-local copy' },
  'src/core/phase.ts': { n: 1, kind: 'writer', why: 'the Done stamp of a completion, inside the task write' },
  'src/core/task-manager.ts': { n: 2, kind: 'writer', why: 'the Done stamp and its clear on reopen, inside the task write' },
  'src/replica/away-status.ts': { n: 1, kind: 'view', why: "a host replica's reader: the status derived now, never stored" },
  'src/core/task-projection.ts': { n: 1, kind: 'view', why: "the phone's projection row" },
  'src/core/task-bulk-get.ts': { n: 1, kind: 'view', why: "task_get_bulk's row" },
  'src/core/org/team-note.ts': { n: 1, kind: 'view', why: "a team note's view of a task" },
  'src/core/sessions/related-open-tasks.ts': { n: 3, kind: 'view', why: 'related task rows in an answer' },
  'src/ops/tasks.ts': { n: 1, kind: 'view', why: "task_get's answer" },
  'src/ops/task-execution.ts': { n: 1, kind: 'view', why: "an answer's fields" },
  'src/ops/task-answers.ts': { n: 3, kind: 'view', why: 'answer rows' },
  'src/web/routes/tasks.ts': { n: 2, kind: 'view', why: 'response rows' },
  'src/web/routes/task-actions-v1.ts': { n: 1, kind: 'view', why: "the action's answer" },
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...filesUnder(rel))
    else if (e.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

describe('every writer of user_status', () => {
  it('each place that sets it is listed, and each listed writer is the leader\'s', () => {
    const found: Record<string, number> = {}
    for (const f of filesUnder('src')) {
      if (f === 'src/core/types.ts') continue
      const n = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/\.user_status\s*=(?!=)|\buser_status\s*:/g) ?? []).length
      if (n) found[f] = n
    }
    const listed = Object.fromEntries(Object.entries(USER_STATUS_SITES).map(([f, s]) => [f, s.n]))
    expect(found, 'a new place sets user_status: list it in USER_STATUS_SITES (a writer must be the leader\'s)').toEqual(listed)
  })

  it("the pass writes only where the boot policy says statuses are written", () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/user-status-sync.ts'), 'utf8')
    const body = text.slice(text.indexOf('export async function syncUserStatuses('))
    expect(body.slice(0, body.indexOf('const pass = ++passSeq'))).toContain("if (!bootPolicy('user-status')) return 0;")
  })
})
