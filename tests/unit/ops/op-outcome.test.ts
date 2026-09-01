/**
 * Unit test: every task/session WRITE tells the caller what changed and what to
 * do next (src/ops/outcome.ts + the ops that use it).
 *
 * The bug this pins: an agent created a task, pinned it to Focus, and reported
 * the work as dispatched. Both calls succeeded and neither result said "nothing
 * is running", so the model's wrong picture of Walnut was never corrected.
 * A result that omits the consequence is the defect, so it is tested like one.
 */
import { describe, it, expect } from 'vitest'
import { listOps } from '../../../src/ops/index.js'
import { TASK_IS_INERT, dispatchHint, withOutcome, REPLY_ARRIVES_HINT } from '../../../src/ops/outcome.js'

/** Ops that mutate a task or a session — the set that must speak. */
const WRITE_OPS = [
  'task_create', 'task_update', 'task_complete', 'task_merge', 'task_delete',
  'task_pin_set', 'task_focus_tier_set', 'session_start', 'session_send',
]

describe('outcome vocabulary', () => {
  it('dispatchHint prints a runnable session_start line carrying the id', () => {
    const hint = dispatchHint('t_7d41c0a9')
    expect(hint).toContain('walnut tools call session_start')
    expect(hint).toContain('t_7d41c0a9')
    expect(hint).toContain('Nothing is running yet')
  })

  it('the anti-polling line names walnut wait as the only escape', () => {
    expect(REPLY_ARRIVES_HINT).toContain('do not poll')
    expect(REPLY_ARRIVES_HINT).toContain('walnut wait')
  })

  it('withOutcome adds the two fields without disturbing the payload', () => {
    const r = withOutcome({ task: { id: 't_1' }, ref: '<task-ref/>' }, 'did a thing', 'do the next thing')
    expect(r).toEqual({
      task: { id: 't_1' }, ref: '<task-ref/>', outcome: 'did a thing', next: 'do the next thing',
    })
  })
})

describe('op descriptions state the model', () => {
  it('task_create says creating starts nothing, and offers start_session', () => {
    const op = listOps().find((o) => o.name === 'task_create')
    expect(op?.description).toMatch(/starts NOTHING|inert record/)
    expect(op?.description).toContain('start_session')
    expect(Object.keys(op?.input ?? {})).toContain('start_session')
    expect(Object.keys(op?.input ?? {})).toContain('start_message')
  })

  it('pin and tier ops say they are attention, not dispatch', () => {
    for (const name of ['task_pin_set', 'task_focus_tier_set']) {
      const op = listOps().find((o) => o.name === name)
      expect(op?.description, name).toMatch(/does not dispatch|never dispatch|does not start|not a dispatch/i)
    }
  })

  it('every task/session write op is a handler or carries mapResult, so it CAN speak', () => {
    // A bound op with no mapResult returns the raw server body — no outcome, no
    // next. This guard fails when a new write op forgets to say what it did.
    for (const name of WRITE_OPS) {
      const op = listOps().find((o) => o.name === name)
      expect(op, name).toBeTruthy()
      expect(!!op?.handler || !!op?.mapResult, `${name} must shape its result`).toBe(true)
    }
  })
})

describe('mapResult-based writes render outcome + next from a server body', () => {
  it('task_complete warns that completing does not stop a running session', () => {
    const op = listOps().find((o) => o.name === 'task_complete')!
    const withSession = op.mapResult!({
      body: { task: { id: 't_1', title: 'Fix it', session_ids: ['s_1'] } },
      args: { id: 't_1' },
    }) as { outcome: string; next: string }
    expect(withSession.outcome).toContain('does not stop anything')
    expect(withSession.outcome).toContain('still alive')

    const noSession = op.mapResult!({
      body: { task: { id: 't_2', title: 'Note to self', session_ids: [] } },
      args: { id: 't_2' },
    }) as { outcome: string; next: string }
    expect(noSession.outcome).toContain('no session was attached')
    expect(noSession.next).toContain('Nothing else is required')
  })

  it('session_send distinguishes a delivered message from a deferred one', () => {
    const op = listOps().find((o) => o.name === 'session_send')!
    const deferred = op.mapResult!({
      body: { delivery: 'deferred', sessionId: 's_9' },
      args: { to: 's_9', text: 'hi' },
    }) as { outcome: string }
    expect(deferred.outcome).toContain('parked on a human permission prompt')
    expect(deferred.outcome).toContain('Do NOT resend')

    const delivered = op.mapResult!({
      body: { delivery: 'queued', sessionId: 's_9', requestId: 'rq-abc123' },
      args: { to: 's_9', text: 'hi' },
    }) as { outcome: string; next: string }
    expect(delivered.outcome).toContain('delivered to s_9')
    expect(delivered.next).toContain('rq-abc123')
    expect(delivered.next).toContain('do not poll')
  })

  it('request_get says pending means "not settled", and refuses to invite polling', () => {
    const op = listOps().find((o) => o.name === 'request_get')!
    const pending = op.mapResult!({ body: { request: { status: 'pending' } }, args: { id: 'rq-a1b2c3' } }) as
      { outcome: string; next: string }
    expect(pending.outcome).toContain('never "failed"')
    expect(pending.next).toContain('Do not poll')

    const replied = op.mapResult!({ body: { request: { status: 'replied' } }, args: { id: 'rq-a1b2c3' } }) as
      { outcome: string }
    expect(replied.outcome).toContain('replied')
  })

  it('task_get says whether a session is attached, not just the phase word', () => {
    const op = listOps().find((o) => o.name === 'task_get')!
    const idle = op.mapResult!({
      body: { task: { id: 't_1', phase: 'TODO', session_ids: [] } }, args: { id: 't_1' },
    }) as { outcome: string; next: string }
    expect(idle.outcome).toContain('NO session is attached')
    expect(idle.outcome).toContain(TASK_IS_INERT)
    expect(idle.next).toContain('session_start')

    const busy = op.mapResult!({
      body: { task: { id: 't_1', phase: 'IN_PROGRESS', session_ids: ['s_1'] } }, args: { id: 't_1' },
    }) as { outcome: string; next: string }
    expect(busy.outcome).toContain('with a session attached')
    expect(busy.next).toContain('session_transcript')
  })

  it('a body with NO session fields never claims "no session is attached"', () => {
    // The PATCH and complete responses return a slim projection with no session
    // fields at all. Reading a missing field as "none" made task_update tell a
    // task being updated from inside its own live session that nothing was
    // working on it — the exact class of confident wrong answer this work is
    // about (caught live, 2026-09-01).
    const slim = { id: 't_1', title: 'Fix it', phase: 'AGENT_COMPLETE', status: 'in_progress' }

    const get = listOps().find((o) => o.name === 'task_get')!
      .mapResult!({ body: { task: slim }, args: { id: 't_1' } }) as { outcome: string; next: string }
    expect(get.outcome).not.toContain('NO session')
    expect(get.next).toContain('If no session is on it yet')

    const complete = listOps().find((o) => o.name === 'task_complete')!
      .mapResult!({ body: { task: slim }, args: { id: 't_1' } }) as { outcome: string }
    expect(complete.outcome).not.toContain('no session was attached')
    expect(complete.outcome).toContain('keeps running until it is stopped')
  })

  it('dispatchHint drops the "nothing is running" claim when attachment is unknown', () => {
    expect(dispatchHint('t_1', false)).not.toContain('Nothing is running')
    expect(dispatchHint('t_1', false)).toContain('session_start')
  })

  it('session_list teaches which noun does the work', () => {
    const op = listOps().find((o) => o.name === 'session_list')!
    const r = op.mapResult!({
      body: { sessions: [{ process_status: 'running' }, { process_status: 'idle' }] },
      args: {},
    }) as { outcome: string }
    expect(r.outcome).toContain('2 session(s) listed, 1 of them working')
    expect(r.outcome).toContain('live process doing work')
  })
})

describe('task_create + start_session — create and dispatch in one call', () => {
  const op = () => listOps().find((o) => o.name === 'task_create')!
  const task = { id: 't_7d41c0a9', title: 'Fix the flaky auth test' }

  /** Stub transport: records the calls, answers create, and lets a test decide the start. */
  function stub(startResult: () => Promise<unknown>) {
    const seen: Array<{ method: string; path: string; body?: unknown }> = []
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      seen.push({ method, path, body })
      if (path === '/tasks') return { task }
      return startResult()
    }
    return { seen, call: call as never }
  }

  it('without start_session it creates ONLY the task and says so', async () => {
    const { seen, call } = stub(async () => { throw new Error('must not start') })
    const r = await op().handler!({ title: task.title }, call) as
      { task: unknown; outcome: string; next: string }
    expect(seen.map((c) => c.path)).toEqual(['/tasks'])
    expect(r.task).toEqual(task)
    expect(r.outcome).toContain('No session is working on it')
    expect(r.outcome).toContain(TASK_IS_INERT)
    expect(r.next).toContain('session_start')
    expect(r.next).toContain(task.id)
  })

  it('with start_session it dispatches too, and reports the running session', async () => {
    const { seen, call } = stub(async () => ({ sessionId: 's_abc123', ok: true }))
    const r = await op().handler!(
      { title: task.title, start_session: true, start_message: 'Reproduce, then fix.' },
      call,
    ) as { session: { sessionId: string }; outcome: string; next: string }
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /tasks', `POST /tasks/${task.id}/start`,
    ])
    expect(seen[1].body).toEqual({ message: 'Reproduce, then fix.' })
    expect(seen[0].body).toEqual({ title: task.title })   // the two extra args never reach the server
    expect(r.session.sessionId).toBe('s_abc123')
    expect(r.outcome).toContain('a session was started')
    expect(r.outcome).toContain('s_abc123')
    expect(r.next).toContain('do not poll')
  })

  it('a failed start is a PARTIAL SUCCESS: the task exists, and the result says the truth', async () => {
    // Failing the whole call would tell the agent the opposite of what happened
    // (the task is really there), so the op must not throw here.
    const { call } = stub(async () => { throw new Error('Walnut API error (409): session_exists') })
    const r = await op().handler!({ title: task.title, start_session: true }, call) as
      { task: unknown; session_error: string; outcome: string; next: string }
    expect(r.task).toEqual(task)
    expect(r.session_error).toContain('session_exists')
    expect(r.outcome).toContain('did NOT start')
    expect(r.outcome).toContain('The task exists')
    expect(r.next).toContain('Retry the dispatch alone')
    expect(r.next).toContain(task.id)
  })
})

describe('task_update on the slim PATCH projection', () => {
  it('says the phase write started and stopped nothing, and invents no attachment state', async () => {
    const op = listOps().find((o) => o.name === 'task_update')!
    const call = (async () => ({ task: { id: 't_1', phase: 'AGENT_COMPLETE' } })) as never
    const r = await op.handler!({ id: 't_1', phase: 'AGENT_COMPLETE' }, call) as
      { outcome: string; next: string }
    expect(r.outcome).toContain('No session was started or stopped by this')
    expect(r.outcome).not.toContain('No session is attached')
    expect(r.outcome).toContain(TASK_IS_INERT)
    expect(r.next).toContain('ready for the human')
  })
})

describe('the model line is one string, not a paraphrase per op', () => {
  it('TASK_IS_INERT is the single sentence reused everywhere', () => {
    expect(TASK_IS_INERT).toBe('A task is an inert record; only a session does work.')
  })
})
