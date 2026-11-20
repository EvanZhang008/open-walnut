/**
 * A task whose session this host started alone while the Mac is away, as every reader of the
 * task sees it on the host (the overlay's fold: task-row-fold.ts foldAwayStart,
 * overlay.ts; the reads: away-reads.ts; the live state: ask-launch.ts fresh):
 *   - the task names its session the way the Mac links it (task-session-link.ts, the one rule
 *     linkSessionSlot and the drain's linkAdopted use): session_id, session_ids, the slot by mode;
 *     only while its create is still in this host's journal and the row names no session, and
 *     only for readers: a write's base is the journal's row (its phase TODO, no session field);
 *   - the phase stays the journal's (the Mac's drain does not replay a start's phase);
 *   - a row only the overlay holds gets the Mac's session enrichment where the Mac's route gives
 *     it (GET /tasks/:id, GET /tasks), so task_get's execution reads running / idle;
 *   - task_get_bulk projects a task made here instead of "not found".
 */
import fs from 'node:fs'
import path from 'node:path'
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
import { createWritePort } from '../../src/replica/write-port.js'
import type { ReplicaWrite } from '../../src/replica/dispatch.js'

const T0 = Date.parse('2026-11-19T09:00:00Z')
const TASK = 'mwo1jjmq-0011aa22bb33cc44'
const SID = 'eeeeeeee-5555-4555-8555-000000000005'
const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }

/** An overlay over the journal records given (a mutable list: the Mac may take some), with this host's started sessions. */
function overlayWith(records: Array<Record<string, unknown>>, starts: () => AwayStart[]): Overlay {
  return createOverlay({
    fetchPending: async () => ({ records: [...records], nextSeq: 100 }),
    now: () => T0 + 60_000,
    awayStarts: (id) => (id === TASK ? starts() : []),
  })
}

const create = { seq: 1, opId: 'op-create', kind: 'task-create', taskId: TASK, at: T0, actor: JOB, fields: { title: 'Import the venue rows' }, placement: { project: 'Acme' } }
const complete = (seq: number, at: number) => ({ seq, opId: `op-complete-${seq}`, kind: 'op', op: 'task_complete', args: { id: TASK }, at, actor: JOB })
const SESSION_KEYS = ['session_id', 'session_ids', 'exec_session_id', 'plan_session_id', 'session_status', 'exec_session_status']

describe('the overlay folds a session this host started alone into its task, for readers only', () => {
  it('links it as the Mac links it; the phase and the row\'s times stay the journal\'s', async () => {
    const o = overlayWith([create], () => [{ sid: SID, at: T0 + 1_000, mode: 'default', status: 'running' }])
    await o.refresh()
    const shown = o.taskForReaders(TASK, null)!
    // The Mac's link (linkSessionSlot then linkSession): one session, the exec slot.
    const mac: Record<string, unknown> = {}
    pointTaskAtSession(mac, SID, 'exec')
    expect(shown).toMatchObject({ ...mac, phase: 'TODO', status: 'todo', replica_sync: 'pending' })
    expect(shown).not.toHaveProperty('plan_session_id')
    expect(shown).not.toHaveProperty('last_session_update')
    expect(shown.updated_at).toBe(new Date(T0).toISOString())
    // The row a write reads has none of it.
    const base = o.task(TASK, null)!
    for (const k of SESSION_KEYS) expect(base, k).not.toHaveProperty(k)
    o.close()
  })

  it('a stopped or errored session keeps session_id and session_ids, and no slot, as the Mac\'s clearSessionSlot', async () => {
    for (const status of ['stopped', 'error']) {
      const o = overlayWith([create], () => [{ sid: SID, at: T0 + 1_000, mode: 'default', status }])
      await o.refresh()
      const row = o.taskForReaders(TASK, null)!
      expect(row, status).toMatchObject({ session_id: SID, session_ids: [SID] })
      expect(row, status).not.toHaveProperty('exec_session_id')
      expect(row, status).not.toHaveProperty('plan_session_id')
      o.close()
    }
    const idle = overlayWith([create], () => [{ sid: SID, at: T0 + 1_000, mode: 'plan', status: 'idle' }])
    await idle.refresh()
    expect(idle.taskForReaders(TASK, null)).toMatchObject({ session_id: SID, plan_session_id: SID })
    idle.close()
  })

  it('a completion after the start clears the slots as the Mac\'s drain does, in order, and keeps the list', async () => {
    const o = overlayWith([create, complete(2, T0 + 3_000)], () => [{ sid: SID, at: T0 + 1_000, status: 'idle' }])
    await o.refresh()
    const row = o.taskForReaders(TASK, null)!
    expect(row).toMatchObject({ phase: 'COMPLETE', session_ids: [SID] })
    expect(row.session_id).toBeUndefined()
    expect(row.exec_session_id).toBeUndefined()
    o.close()
  })

  it('once the Mac took the create, its row is its word: never folded over', async () => {
    const records: Array<Record<string, unknown>> = [create]
    const o = overlayWith(records, () => [{ sid: SID, at: T0 + 1_000, status: 'idle' }])
    await o.refresh()
    expect(o.taskForReaders(TASK, null)).toMatchObject({ session_id: SID })
    records.length = 0
    await o.refresh()
    // A task in the copy with another session (the Mac replaced it): that one stays.
    const other = { id: TASK, title: 'Import the venue rows', phase: 'TODO', session_id: 'other-sid', session_ids: ['other-sid'], exec_session_id: 'other-sid' }
    expect(o.taskForReaders(TASK, other)).toMatchObject({ session_id: 'other-sid', session_ids: ['other-sid'], exec_session_id: 'other-sid' })
    // The Mac refused the start: its row has no session, and none is put back.
    const refused = { id: TASK, title: 'Import the venue rows', phase: 'TODO', session_ids: [] }
    const shown = o.taskForReaders(TASK, refused)!
    for (const k of SESSION_KEYS.filter((k) => k !== 'session_ids')) expect(shown, k).not.toHaveProperty(k)
    expect(shown.session_ids).toEqual([])
    // A session row still in `started` after the drain, its row not in the sessions copy yet: no fold either.
    const drained = { id: TASK, title: 'Import the venue rows', phase: 'TODO' }
    expect(o.taskForReaders(TASK, drained)).toBe(drained)
    o.close()
  })

  it('a row that already names a session keeps it', async () => {
    const o = overlayWith([create, { seq: 2, opId: 'op-f', kind: 'task-fields', taskId: TASK, at: T0 + 500, actor: JOB, fields: { session_id: { value: 'named-sid' } } }], () => [{ sid: SID, at: T0 + 1_000, status: 'running' }])
    await o.refresh()
    expect(o.taskForReaders(TASK, null)).toMatchObject({ session_id: 'named-sid' })
    expect(o.taskForReaders(TASK, null)).not.toHaveProperty('exec_session_id')
    o.close()
  })

  it('a session row becomes the fold\'s start: its time, mode and live status', () => {
    expect(awayStartOf({
      claudeSessionId: SID, taskId: TASK, project: 'Acme', process_status: 'idle', mode: 'default',
      startedAt: new Date(T0).toISOString(), lastActiveAt: new Date(T0 + 4_000).toISOString(), messageCount: 1,
    } as never)).toEqual({ sid: SID, at: T0, mode: 'default', status: 'idle' })
  })
})

describe('the journal read behind the overlay', () => {
  it('a read that failed is asked again once per age, never once per read; a forced refresh always asks', async () => {
    let clock = T0
    let fail = true
    const fetchPending = vi.fn(async () => { if (fail) throw new Error('daemon busy'); return { records: [create], nextSeq: 100 } })
    const o = createOverlay({ fetchPending, now: () => clock, log: () => {} })
    for (let i = 0; i < 5; i++) await o.refresh(1_000)
    expect(fetchPending).toHaveBeenCalledTimes(1)
    await o.refresh()
    expect(fetchPending).toHaveBeenCalledTimes(2)
    clock += 1_500; fail = false
    await o.refresh(1_000)
    expect(fetchPending).toHaveBeenCalledTimes(3)
    expect(o.task(TASK, null)).toMatchObject({ id: TASK })
    o.close()
  })
})

describe('the session fold is for readers only', () => {
  // Enumerated from the source: a new caller of taskForReaders must be a read, and is named here.
  const READERS = ['away-reads.ts', 'away-wiring.ts', 'overlay.ts']
  const dir = path.join(__dirname, '../../src/replica')

  it('only the reads call taskForReaders', () => {
    const callers = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && /\btaskForReaders\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(callers.sort()).toEqual(READERS)
  })

  it('the row every write reads comes from overlay.task, in the real wiring', () => {
    const src = fs.readFileSync(path.join(dir, 'away-wiring.ts'), 'utf8')
    const body = /const shownTask = async[\s\S]*?\n  }\n/.exec(src)?.[0] ?? ''
    expect(body).toContain('overlay.task(')
    expect(body).not.toContain('taskForReaders(')
    // The one reader call of the wiring is the broadcast of a changed row.
    expect(src.match(/\btaskForReaders\(/g)).toHaveLength(1)
  })
})

describe('a write made on the host after a start alone', () => {
  it('journals the journal\'s own phase as its base, and no session field', async () => {
    const o = overlayWith([create], () => [{ sid: SID, at: T0 + 1_000, mode: 'default', status: 'idle' }])
    await o.refresh()
    expect(o.taskForReaders(TASK, null)).toMatchObject({ session_id: SID })
    const submitted: Array<{ op: string; base: Record<string, unknown> }> = []
    const port = createWritePort({
      task: async (id) => o.task(id, null) as never,
      createdHere: (id) => o.createPending(id),
      board: async () => null,
      noteWritten: () => {},
    })
    const w = {
      opId: 'op-w', away: 'host-write', raw: Buffer.from(''),
      submit: async (op: string, _args: unknown, base: Record<string, unknown>) => { submitted.push({ op, base }); return { kind: 'applied', reply: { seq: 5, kind: 'task-fields', opId: 'op-w' } } },
      call: async () => ({ kind: 'applied', reply: {} }),
    } as unknown as ReplicaWrite
    await port.taskUpdate(w, JOB as never, TASK, { phase: 'NEED_ACTION' })
    await port.taskComplete(w, JOB as never, TASK)
    expect(submitted.map((x) => x.op)).toEqual(['task_update', 'task_complete'])
    for (const x of submitted) {
      expect(x.base.phase, x.op).toBe('TODO')
      for (const k of SESSION_KEYS) expect(x.base, `${x.op} ${k}`).not.toHaveProperty(k)
    }
    o.close()
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

  it('a daemon that does not answer is asked at most once a second by readers, and warned about once per outage', async () => {
    let clock = T0
    const warns: string[] = []
    let fail = true
    const request = vi.fn(async () => { if (fail) throw new Error('follower link down'); return { sessions: [] } })
    const launch = createAskLaunch({
      port: {} as never, actorOf: () => null, hostKey: 'devbox', persona: async () => null, capabilities: () => [],
      request, broadcast: () => {}, sessionContext: async () => '', now: () => clock,
      log: (level, msg) => { if (level === 'warn') warns.push(msg) },
    })
    launch.noteStarted({ sid: SID, taskId: TASK, cwd: '/work/acme', mode: 'default', title: 'Import', project: 'Acme' })
    launch.stop()
    for (let i = 0; i < 10; i++) await launch.fresh()
    expect(request).toHaveBeenCalledTimes(1)
    expect(warns).toHaveLength(1)
    // A second later it asks again; the outage goes on, and is not warned about again.
    clock += 1_500
    for (let i = 0; i < 10; i++) await launch.fresh()
    expect(request).toHaveBeenCalledTimes(2)
    expect(warns).toHaveLength(1)
    // An answer ends the outage: the next failure is warned about again.
    clock += 1_500; fail = false
    await launch.fresh()
    clock += 1_500; fail = true
    await launch.fresh()
    expect(request).toHaveBeenCalledTimes(4)
    expect(warns).toHaveLength(2)
  })

  it('a reader that arrives while a look is under way waits for that look, never reads the state from before it', async () => {
    let answer: (v: { sessions: Array<Record<string, unknown>> }) => void = () => {}
    const request = vi.fn(() => new Promise<{ sessions: Array<Record<string, unknown>> }>((r) => { answer = r }))
    const launch = createAskLaunch({
      port: {} as never, actorOf: () => null, hostKey: 'devbox', persona: async () => null, capabilities: () => [],
      request, broadcast: () => {}, sessionContext: async () => '', now: () => T0, log: () => {},
    })
    launch.noteStarted({ sid: SID, taskId: TASK, cwd: '/work/acme', mode: 'default', title: 'Import', project: 'Acme' })
    launch.stop()
    const first = launch.fresh()
    let secondDone = false
    const second = launch.fresh().then(() => { secondDone = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(secondDone).toBe(false)
    answer({ sessions: [{ sid: SID, state: 'idle', lastActiveAt: '2026-11-19T09:00:09.000Z' }] })
    await Promise.all([first, second])
    expect(request).toHaveBeenCalledTimes(1)
    expect(launch.rows()[0]).toMatchObject({ process_status: 'idle' })
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
  const readerRow = (id: string, row: Record<string, unknown> | null) => (id === TASK ? { ...(row ?? {}), ...made } : row)
  const overlay = {
    refresh: async () => {},
    task: readerRow,
    taskForReaders: readerRow,
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

  it('only a session this replica started alone (or a task with one) waits for its live state; every other session read answers at once', async () => {
    const ours = (kind: 'session' | 'task', id: string) => (kind === 'session' ? id === SID : id === TASK)
    const run = async (path: string) => {
      const order: string[] = []
      const handler = awayReads({ overlay, answeredAway: () => true, awayHere: ours, fresh: async () => { order.push('fresh') } })
      await new Promise<void>((resolve) => handler({ method: 'GET', path, query: {} } as unknown as Request, {} as Response, () => { order.push('route'); resolve() }))
      return order
    }
    for (const path of [`/sessions/task/${TASK}`, `/sessions/${SID}`, `/v1/sessions/${SID}`]) expect(await run(path), path).toEqual(['fresh', 'route'])
    for (const path of ['/sessions/task/mtask-other', '/sessions/ffffffff-0000-4000-8000-000000000000', '/v1/sessions/recent', '/sessions/recent']) expect(await run(path), path).toEqual(['route'])
  })

  it('a live state that never answers lets a read answer within its deadline', async () => {
    const handler = awayReads({ overlay, answeredAway: () => true, refreshWaitMs: 100, awayHere: () => true, fresh: () => new Promise<void>(() => {}) })
    const t0 = Date.now()
    await new Promise<void>((resolve) => handler({ method: 'GET', path: `/sessions/${SID}`, query: {} } as unknown as Request, {} as Response, () => resolve()))
    expect(Date.now() - t0).toBeLessThan(2_000)
    const r = await read(`/tasks/${TASK}`, 404, { error: 'No task found matching' }, { refreshWaitMs: 100, fresh: () => new Promise<void>(() => {}) })
    expect(r).toMatchObject({ status: 200, body: { task: { id: TASK } } })
  })

  it('task_get_bulk projects a task made here with the Mac\'s projection, and folds a copy row\'s own fields', async () => {
    const project = (row: Record<string, unknown> & { id: string }, f: string[]) => bulkGetFromTasks([row.id], [row as never], f).items[0] as Record<string, unknown>
    const body = { count: 2, errors: 1, fields: ['title', 'phase'], tasks: [{ id: TASK, error: 'not found' }, { id: 'mtask-copy', title: 'From the Mac', phase: 'TODO' }] }
    const folding = { ...overlay, taskForReaders: (id: string, row: Record<string, unknown> | null) => (id === TASK ? made : row ? { ...row, phase: 'NEED_ACTION', status: 'in_progress', replica_sync: 'pending' } : null) } as unknown as Overlay
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
