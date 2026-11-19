/**
 * A task whose session this host started alone while the Mac is away, as every reader of the
 * task sees it on the host (the overlay's fold: task-row-fold.ts foldAwayStart / foldAwayTurn,
 * overlay.ts; the reads: away-reads.ts; the live state: ask-launch.ts fresh):
 *   - the task names its session the way the Mac links it (task-session-link.ts, the one rule
 *     linkSessionSlot and the drain's linkAdopted use): session_id, session_ids, the slot by mode;
 *   - its phase follows the Mac's session rules (phase.ts) at the session's place in time among
 *     the journal's records: a start or a running turn IN_PROGRESS, a turn that ended or a
 *     prompt NEED_ACTION, and a later phase write of its own (a task_update, a completion) stays;
 *   - a row only the overlay holds gets the Mac's session enrichment where the Mac's route gives
 *     it (GET /tasks/:id, GET /tasks), so task_get's execution reads running / idle;
 *   - task_get_bulk projects a task made here instead of "not found".
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createOverlay, type Overlay } from '../../src/replica/overlay.js'
import { awayReads, overlayBulk } from '../../src/replica/away-reads.js'
import { awayStartOf } from '../../src/replica/away-wiring.js'
import type { AwayStart } from '../../src/core/offline-merge/task-row-fold.js'
import { pointTaskAtSession } from '../../src/core/sessions/task-session-link.js'
import { taskExecution } from '../../src/ops/task-execution.js'
import { createAskLaunch, hostSessionStatus, type AskLaunchDeps } from '../../src/replica/ask-launch.js'
import { bulkGetFromTasks } from '../../src/core/task-bulk-get.js'

const T0 = Date.parse('2026-11-19T09:00:00Z')
const TASK = 'mwo1jjmq-0011aa22bb33cc44'
const SID = 'eeeeeeee-5555-4555-8555-000000000005'
const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }

/** An overlay over the journal records given, with this host's started sessions. */
function overlayWith(records: Array<Record<string, unknown>>, starts: () => AwayStart[]): Overlay {
  const o = createOverlay({
    fetchPending: async () => ({ records, nextSeq: records.length + 1 }),
    now: () => T0 + 60_000,
    awayStarts: (id) => (id === TASK ? starts() : []),
  })
  return o
}

const create = { seq: 1, opId: 'op-create', kind: 'task-create', taskId: TASK, at: T0, actor: JOB, fields: { title: 'Import the venue rows' }, placement: { project: 'Acme' } }
const fields = (seq: number, at: number, values: Record<string, unknown>) => ({
  seq, opId: `op-fields-${seq}`, kind: 'task-fields', taskId: TASK, at, actor: JOB,
  fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])),
})
const complete = (seq: number, at: number) => ({ seq, opId: `op-complete-${seq}`, kind: 'op', op: 'task_complete', args: { id: TASK }, at, actor: JOB })

describe('the overlay folds a session this host started alone into its task', () => {
  it('links it as the Mac links it, and its phase follows the turn', async () => {
    let live: AwayStart = { sid: SID, at: T0 + 1_000, mode: 'default', status: 'running', activeAt: T0 + 1_000 }
    const o = overlayWith([create], () => [live])
    await o.refresh()
    const started = o.task(TASK, null)!
    // The Mac's link (linkSessionSlot then linkSession): one session, the exec slot.
    const mac: Record<string, unknown> = {}
    pointTaskAtSession(mac, SID, 'exec')
    expect(started).toMatchObject({ ...mac, phase: 'IN_PROGRESS', status: 'in_progress', replica_sync: 'pending', last_session_update: new Date(T0 + 1_000).toISOString() })
    expect(started).toMatchObject({ session_id: SID, session_ids: [SID], exec_session_id: SID })
    expect(started).not.toHaveProperty('plan_session_id')
    // The turn ended: handed back, as the Mac's session:result.
    live = { ...live, status: 'idle', activeAt: T0 + 8_000 }
    expect(o.task(TASK, null)).toMatchObject({ phase: 'NEED_ACTION', unread: true, session_id: SID })
    // A prompt waiting for a person hands it back even while the turn runs.
    live = { ...live, status: 'running', prompt: true, activeAt: T0 + 9_000 }
    expect(o.task(TASK, null)).toMatchObject({ phase: 'NEED_ACTION' })
    o.close()
  })

  it('a phase write after the turn stays; a new turn after it pulls the task back to work', async () => {
    let live: AwayStart = { sid: SID, at: T0 + 1_000, status: 'idle', activeAt: T0 + 5_000 }
    const o = overlayWith([create, fields(2, T0 + 10_000, { phase: 'TODO', tags: ['source:acme'] })], () => [live])
    await o.refresh()
    expect(o.task(TASK, null)).toMatchObject({ phase: 'TODO', tags: ['source:acme'], session_id: SID })
    live = { ...live, status: 'running', activeAt: T0 + 20_000 }
    expect(o.task(TASK, null)).toMatchObject({ phase: 'IN_PROGRESS' })
    o.close()
  })

  it('a completion after the start clears the slots as the Mac\'s does, keeps the list, and a later idle never reopens it', async () => {
    const o = overlayWith([create, complete(2, T0 + 3_000)], () => [{ sid: SID, at: T0 + 1_000, status: 'idle', activeAt: T0 + 6_000 }])
    await o.refresh()
    const row = o.task(TASK, null)!
    expect(row).toMatchObject({ phase: 'COMPLETE', session_ids: [SID] })
    expect(row.session_id).toBeUndefined()
    expect(row.exec_session_id).toBeUndefined()
    o.close()
  })

  it('a plan-mode session takes the plan slot; a task with no session of this host is left as it was', async () => {
    const o = overlayWith([create], () => [{ sid: SID, at: T0 + 1_000, mode: 'plan', status: 'running' }])
    await o.refresh()
    expect(o.task(TASK, null)).toMatchObject({ session_id: SID, plan_session_id: SID })
    expect(o.task(TASK, null)).not.toHaveProperty('exec_session_id')
    const copy = { id: 'mtask-other', title: 'On the Mac', phase: 'TODO' }
    expect(o.task('mtask-other', copy)).toBe(copy)
    o.close()
  })

  it('a copy row (the Mac took the create) still shows the session until the sessions copy holds it', async () => {
    const o = overlayWith([], () => [{ sid: SID, at: T0 + 1_000, status: 'running', activeAt: T0 + 2_000 }])
    await o.refresh()
    const copy = { id: TASK, title: 'Import the venue rows', phase: 'TODO', phase_changed_at: new Date(T0).toISOString() }
    expect(o.task(TASK, copy)).toMatchObject({ session_id: SID, session_ids: [SID], phase: 'IN_PROGRESS' })
    expect(o.task(TASK, copy)).not.toHaveProperty('replica_sync')
    o.close()
  })

  it('a session row becomes the fold\'s start: its times, mode, live status and prompt', () => {
    expect(awayStartOf({
      claudeSessionId: SID, taskId: TASK, project: 'Acme', process_status: 'idle', mode: 'default',
      startedAt: new Date(T0).toISOString(), lastActiveAt: new Date(T0 + 4_000).toISOString(), messageCount: 1,
      pendingPermission: { requestId: 'rq-1', toolName: 'Bash' },
    } as never)).toEqual({ sid: SID, at: T0, mode: 'default', status: 'idle', activeAt: T0 + 4_000, prompt: true })
  })
})

describe('the live state of a session started here', () => {
  function asks(sessions: Array<Record<string, unknown>>) {
    const request = vi.fn(async () => ({ sessions }))
    const deps: AskLaunchDeps = {
      port: {} as never, actorOf: () => null, hostKey: 'devbox', persona: async () => null, capabilities: () => [],
      request, broadcast: () => {}, sessionContext: async () => '', now: () => T0, log: () => {},
    }
    return { launch: createAskLaunch(deps), request }
  }

  it('one mapping from the daemon\'s words to the Mac\'s', () => {
    expect([hostSessionStatus('working'), hostSessionStatus('idle'), hostSessionStatus('stopped'), hostSessionStatus(undefined)]).toEqual(['running', 'idle', 'stopped', 'stopped'])
  })

  it('a reader\'s look updates every row this replica started, watched or not, with its prompt; looks in flight are shared', async () => {
    const sessions: Array<Record<string, unknown>> = [{ sid: SID, state: 'working', lastActiveAt: '2026-11-19T09:00:05.000Z', prompt: { requestId: 'rq-7', toolName: 'Bash' } }]
    const { launch, request } = asks(sessions)
    launch.noteStarted({ sid: SID, taskId: TASK, cwd: '/work/acme', mode: 'default', title: 'Import', project: 'Acme' })
    launch.stop()
    await Promise.all([launch.fresh(0), launch.fresh(0)])
    expect(request).toHaveBeenCalledTimes(1)
    expect(launch.rows()[0]).toMatchObject({ process_status: 'running', lastActiveAt: '2026-11-19T09:00:05.000Z', pendingPermission: { requestId: 'rq-7', toolName: 'Bash', receivedAt: new Date(T0).toISOString() } })
    sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-11-19T09:00:09.000Z' }
    // Within its max age a reader reads what is known; after it, the daemon again.
    await launch.fresh(60_000)
    expect(request).toHaveBeenCalledTimes(1)
    await launch.fresh(0)
    expect(launch.rows()[0]).toMatchObject({ process_status: 'idle', lastActiveAt: '2026-11-19T09:00:09.000Z' })
    expect(launch.rows()[0]).not.toHaveProperty('pendingPermission')
  })

  it('nothing started here: a reader asks the daemon nothing', async () => {
    const { launch, request } = asks([])
    await launch.fresh(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('task_get\'s execution reads the Mac\'s words off the enriched row', () => {
    expect(taskExecution({ session_id: SID, session_ids: [SID], session_status: { process_status: 'running' } }).state).toBe('running')
    expect(taskExecution({ session_id: SID, session_ids: [SID], session_status: { process_status: 'idle' } }).state).toBe('idle')
    expect(taskExecution({ session_id: SID, session_ids: [SID], session_status: { process_status: 'running', pendingPermissionTool: 'Bash' } }).state).toBe('waiting')
  })
})

describe('the reads of a task made here', () => {
  const made = { id: TASK, title: 'Import the venue rows', phase: 'IN_PROGRESS', session_id: SID, session_ids: [SID], exec_session_id: SID, replica_sync: 'pending' }
  const overlay = {
    refresh: async () => {},
    task: (id: string, row: Record<string, unknown> | null) => (id === TASK ? { ...(row ?? {}), ...made } : row),
    createdTaskIds: () => [TASK],
  } as unknown as Overlay

  /** One GET through the reads, with the route answering `status` and `body`. */
  async function read(path: string, status: number, body: unknown, deps: Partial<Parameters<typeof awayReads>[0]> = {}): Promise<{ status: number; body: any }> {
    const handler = awayReads({ overlay, answeredAway: () => true, refreshWaitMs: 1_000, ...deps })
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: status, headersSent: false,
        status(s: number) { this.statusCode = s; return this },
        json(b: unknown) { resolve({ status: this.statusCode, body: b }); return this },
      } as unknown as Response
      const req = { method: 'GET', path, query: {} } as unknown as Request
      handler(req, res, () => {
        try { (res as unknown as { json(b: unknown): unknown }).json(body) } catch (e) { reject(e) }
      })
    })
  }

  it('GET /tasks/:id answers the folded row with the Mac\'s enrichment, after the live state was read', async () => {
    const order: string[] = []
    const fresh = vi.fn(async () => { order.push('fresh') })
    const enrich = vi.fn(async (rows: Array<Record<string, unknown>>) => { order.push('enrich'); return rows.map((r) => ({ ...r, session_status: { process_status: 'running' } })) as never })
    const r = await read(`/tasks/${TASK}`, 404, { error: 'No task found matching' }, { fresh, enrich })
    expect(r.status).toBe(200)
    expect(r.body.task).toMatchObject({ id: TASK, session_id: SID, session_status: { process_status: 'running' } })
    expect(order).toEqual(['fresh', 'enrich'])
  })

  it('the phone\'s detail carries the link but no enrichment, as the Mac\'s v1 route; a failed enrichment answers the folded row', async () => {
    const enrich = vi.fn(async () => { throw new Error('store busy') })
    const v1 = await read(`/v1/tasks/${TASK}`, 404, { error: { code: 'not_found' } }, { enrich })
    expect(v1.body.task).toMatchObject({ session_id: SID })
    expect(enrich).not.toHaveBeenCalled()
    const failed = await read(`/tasks/${TASK}`, 404, { error: 'No task found matching' }, { enrich })
    expect(failed).toMatchObject({ status: 200, body: { task: { id: TASK, session_id: SID } } })
  })

  it('a list enriches only the rows the overlay added (the route enriched its own)', async () => {
    const enrich = vi.fn(async (rows: Array<Record<string, unknown>>) => rows.map((r) => ({ ...r, session_status: { process_status: 'idle' } })) as never)
    const r = await read('/tasks', 200, { tasks: [{ id: 'mtask-copy', title: 'From the Mac', session_status: { process_status: 'stopped' } }] }, { enrich })
    expect(enrich).toHaveBeenCalledWith([expect.objectContaining({ id: TASK })])
    expect(r.body.tasks).toEqual([
      expect.objectContaining({ id: TASK, session_status: { process_status: 'idle' } }),
      { id: 'mtask-copy', title: 'From the Mac', session_status: { process_status: 'stopped' } },
    ])
  })

  it('the sessions a task made here held answer from this host; its other reads need the Mac, never "not found"', async () => {
    const taskSessions = vi.fn(async (row: Record<string, unknown>) => ({ taskId: row.id, activeSessionId: SID, sessions: [{ session_id: SID, active: true }] }))
    const listed = await read(`/v1/tasks/${TASK}/sessions`, 404, { error: 'Task not found', code: 'not_found' }, { taskSessions })
    expect(listed).toEqual({ status: 200, body: { taskId: TASK, activeSessionId: SID, sessions: [{ session_id: SID, active: true }] } })
    const headers: Record<string, string> = {}
    const handler = awayReads({ overlay, answeredAway: () => true })
    const watched = await new Promise<{ status: number; body: any }>((resolve) => {
      const res = {
        statusCode: 404, headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v },
        status(x: number) { this.statusCode = x; return this },
        json(b: unknown) { resolve({ status: this.statusCode, body: b }); return this },
      } as unknown as Response
      handler({ method: 'GET', path: `/v1/tasks/${TASK}/watch`, query: {} } as unknown as Request, res, () => { (res as unknown as { json(b: unknown): unknown }).json({ error: 'Task not found' }) })
    })
    expect(watched).toEqual({ status: 503, body: { error: expect.objectContaining({ code: 'needs_leader', why: 'task_made_here_needs_mac', retryAfter: 5 }) } })
    expect(headers['retry-after']).toBe('5')
    // A task this host does not hold keeps its route's own answer.
    const other = await read('/v1/tasks/mtask-unknown/watch', 404, { error: 'Task not found' })
    expect(other).toEqual({ status: 404, body: { error: 'Task not found' } })
  })

  it('a session\'s record and a task\'s sessions read the live state first, then the route answers as it does', async () => {
    for (const path of [`/sessions/task/${TASK}`, `/sessions/${SID}`, `/v1/sessions/${SID}`]) {
      const order: string[] = []
      const handler = awayReads({ overlay, answeredAway: () => true, fresh: async () => { order.push('fresh') } })
      await new Promise<void>((resolve) => handler({ method: 'GET', path, query: {} } as unknown as Request, {} as Response, () => { order.push('route'); resolve() }))
      expect(order, path).toEqual(['fresh', 'route'])
    }
  })

  it('task_get_bulk projects a task made here with the Mac\'s projection, and folds a copy row\'s own fields', async () => {
    const project = (row: Record<string, unknown> & { id: string }, f: string[]) => bulkGetFromTasks([row.id], [row as never], f).items[0] as Record<string, unknown>
    const body = { count: 2, errors: 1, fields: ['title', 'phase'], tasks: [{ id: TASK, error: 'not found' }, { id: 'mtask-copy', title: 'From the Mac', phase: 'TODO' }] }
    const folding = { ...overlay, task: (id: string, row: Record<string, unknown> | null) => (id === TASK ? made : row ? { ...row, phase: 'NEED_ACTION', status: 'in_progress', replica_sync: 'pending' } : null) } as unknown as Overlay
    expect(overlayBulk(body, folding, project)).toEqual({
      count: 2, errors: 0, fields: ['title', 'phase'],
      tasks: [
        // The Mac's projection, its user_status included.
        { id: TASK, title: 'Import the venue rows', phase: 'IN_PROGRESS', user_status: { state: 'working' }, replica_sync: 'pending' },
        { id: 'mtask-copy', title: 'From the Mac', phase: 'NEED_ACTION', replica_sync: 'pending' },
      ],
    })
    // Through the reads: the route's answer is folded.
    const r = await read('/tasks/bulk', 200, body)
    expect(r.body.tasks[0]).toMatchObject({ id: TASK, title: 'Import the venue rows', phase: 'IN_PROGRESS' })
  })
})
