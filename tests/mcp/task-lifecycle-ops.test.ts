/**
 * The ops that manage a task's run the way a person does from its panel
 * (src/ops/task-lifecycle.ts) and task_start's notes about launch choices it
 * could not apply (src/ops/task-execution.ts). Each handler runs against a
 * recording `call`, so the test pins which server routes it reaches and in
 * what order: the same routes the panel's controls reach.
 */
import { describe, expect, it } from 'vitest'
import { getOp } from '../../src/ops/index.js'

type Route = { method: string; path: string; body?: unknown }

/** A `call` that answers by route, records every request, and throws like the executor on an error answer. */
function fakeCall(answers: Record<string, unknown | Error>) {
  const calls: Route[] = []
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) })
    const answer = answers[`${method} ${path}`]
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw new Error(`Walnut API error (404): no route ${method} ${path}`)
    return answer
  }
  return { call, calls }
}

const run = (op: string, args: Record<string, unknown>, call: ReturnType<typeof fakeCall>['call']) =>
  getOp(op)!.handler!(args, call as never) as Promise<Record<string, unknown>>

const TASK = {
  'GET /tasks/t-1': { task: { id: 't-1', title: 'Worker', session_id: 's-1' } },
  'GET /me': { kind: 'worker', session: { id: 'lead-s' } },
}

describe('task_stop', () => {
  it('resolves the task\'s session and asks the panel\'s graceful stop', async () => {
    const f = fakeCall({ ...TASK, 'POST /sessions/s-1/terminate': { status: 'terminated', sessionId: 's-1' } })
    const out = await run('task_stop', { id: 't-1' }, f.call)
    expect(f.calls).toEqual([
      { method: 'GET', path: '/tasks/t-1' },
      { method: 'GET', path: '/me' },
      { method: 'POST', path: '/sessions/s-1/terminate', body: { force: false } },
    ])
    expect(out).toMatchObject({ taskId: 't-1', sessionId: 's-1', status: 'terminated' })
    expect(String(out.outcome)).toContain('conversation is kept')
  })

  it('force rides along; an unconfirmed stop is reported as pending, not as a failure', async () => {
    const f = fakeCall({ ...TASK, 'POST /sessions/s-1/terminate': new Error('Walnut API error (stop_pending): Stop request saved') })
    const out = await run('task_stop', { id: 't-1', force: true }, f.call)
    expect(f.calls[2].body).toEqual({ force: true })
    expect(out.status).toBe('pending')
    expect(String(out.outcome)).toContain('has not confirmed')
  })

  it('a refusal (own session, scheduled jobs) is the op\'s error', async () => {
    const f = fakeCall({ ...TASK, 'POST /sessions/s-1/terminate': new Error('Walnut API error (own_session): A session cannot stop itself') })
    await expect(run('task_stop', { id: 't-1' }, f.call)).rejects.toThrow('own_session')
  })

  it('refuses its own session even when the server is too old to (never reaches terminate or restart)', async () => {
    const f = fakeCall({ ...TASK, 'GET /me': { kind: 'worker', session: { id: 's-1' } } })
    await expect(run('task_stop', { id: 't-1' }, f.call)).rejects.toThrow('own_session')
    await expect(run('task_restart', { id: 't-1' }, f.call)).rejects.toThrow('own_session')
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a task with no session says so and stops nothing', async () => {
    const f = fakeCall({ 'GET /tasks/t-2': { task: { id: 't-2', title: 'Placeholder', session_ids: [] } } })
    await expect(run('task_stop', { id: 't-2' }, f.call)).rejects.toThrow('has no session')
    expect(f.calls).toHaveLength(1)
  })
})

describe('task_restart', () => {
  it('runs the panel\'s Restart on the task\'s session', async () => {
    const f = fakeCall({ ...TASK, 'POST /sessions/s-1/restart': { status: 'restarted', sessionId: 's-1', pendingMessages: 2 } })
    const out = await run('task_restart', { id: 't-1' }, f.call)
    expect(f.calls[2]).toEqual({ method: 'POST', path: '/sessions/s-1/restart', body: {} })
    expect(String(out.outcome)).toContain('2 waiting message(s)')
  })
})

describe('task_session_set', () => {
  it('refuses a session raising its own permission mode, before any write', async () => {
    const f = fakeCall({ ...TASK, 'GET /me': { kind: 'worker', session: { id: 's-1' } } })
    await expect(run('task_session_set', { id: 't-1', mode: 'bypass' }, f.call)).rejects.toThrow('own_session')
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it('applies model before effort, then mode and reply style in one patch', async () => {
    const f = fakeCall({
      ...TASK,
      'POST /sessions/s-1/model': { model: 'claude-opus-5-5' },
      'POST /sessions/s-1/effort': { effort: 'max', effectiveEffort: 'max' },
      'PATCH /sessions/s-1': { session: {} },
    })
    const out = await run('task_session_set', { id: 't-1', effort: 'max', model: 'opus', mode: 'plan', reply_style: 'markdown' }, f.call)
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /tasks/t-1', 'GET /me', 'POST /sessions/s-1/model', 'POST /sessions/s-1/effort', 'PATCH /sessions/s-1',
    ])
    expect(f.calls[4].body).toEqual({ mode: 'plan', output_mode: 'markdown' })
    expect(out.applied).toEqual({ model: 'claude-opus-5-5', effort: 'max', mode: 'plan', reply_style: 'markdown' })
  })

  it('a later refusal names what was already applied', async () => {
    const f = fakeCall({
      ...TASK,
      'POST /sessions/s-1/model': { model: 'claude-haiku' },
      'POST /sessions/s-1/effort': new Error('Walnut API error (400): this model takes no effort'),
    })
    await expect(run('task_session_set', { id: 't-1', model: 'haiku', effort: 'high' }, f.call))
      .rejects.toThrow('(already applied: model)')
  })

  it('needs at least one setting', async () => {
    const f = fakeCall(TASK)
    await expect(run('task_session_set', { id: 't-1' }, f.call)).rejects.toThrow('at least one')
    expect(f.calls).toEqual([])
  })
})

describe('task_start notes what it could not apply', () => {
  const START = 'POST /tasks/t-1/start'

  it('an older server (no applied list) is said to have ignored the newer choices', async () => {
    const f = fakeCall({ [START]: { taskId: 't-1', sessionId: 's-9', started: true } })
    const out = await run('task_start', { id: 't-1', effort: 'high', create_cwd: true }, f.call)
    expect(String(out.outcome)).toContain('older and ignored effort, create_cwd')
  })

  it('a current server that applied them adds no note; one it did not apply is named', async () => {
    const f = fakeCall({ [START]: { taskId: 't-1', sessionId: 's-9', started: true, applied: ['effort'] } })
    const out = await run('task_start', { id: 't-1', effort: 'high' }, f.call)
    expect(String(out.outcome)).toBe('Task t-1 started.')
    const g = fakeCall({ [START]: { taskId: 't-1', sessionId: 's-9', started: true, applied: ['effort'] } })
    const missed = await run('task_start', { id: 't-1', effort: 'high', workspace: { provider: 'git-worktree' }, cwd: '/elsewhere' }, g.call)
    expect(String(missed.outcome)).toContain('Not applied: workspace')
  })

  it('a continued conversation keeps its own settings and points at task_session_set', async () => {
    const f = fakeCall({ [START]: { taskId: 't-1', sessionId: 's-1', started: true, continued: true, applied: [] } })
    const out = await run('task_start', { id: 't-1', model: 'opus', effort: 'high' }, f.call)
    expect(String(out.outcome)).toContain('keeps its own model, effort; change them with task_session_set')
  })

  it('a workspace start says it is being prepared', async () => {
    const f = fakeCall({ [START]: { taskId: 't-1', started: false, preparing: true, applied: ['workspace'] } })
    const out = await run('task_start', { id: 't-1', workspace: { provider: 'git-worktree' } }, f.call)
    expect(String(out.outcome)).toContain('isolated workspace is being made')
  })
})
