/**
 * Unit test: every task op tells the caller WHAT HAPPENED and WHAT COMES NEXT
 * (src/ops/outcome.ts + tasks.ts + work.ts + task-execution.ts).
 *
 * The contract this pins, after "creating a task starts the work":
 *   - task_create creates AND starts by default. record_only=true is the only way
 *     to save a placeholder, and the legacy start_session=false still means that.
 *   - flags that contradict each other are refused BEFORE anything is written, so
 *     a rejected call never leaves a half-made task behind.
 *   - an accepted launch is "starting", not "running": only the server saying
 *     started=true earns that word, because a preassigned session id proves a
 *     request was accepted, not that a process exists.
 *   - a failed launch is a PARTIAL SUCCESS — the task is real, the retry uses the
 *     SAME id, and a second task is never suggested.
 *   - reads answer a DERIVED execution state instead of raw session bookkeeping,
 *     and a body that cannot say whether a session is attached answers "unknown",
 *     never "nothing is running".
 *
 * Everything below drives a handler or mapResult with a recording stub: no
 * network, no disk, no processes.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'
import { dispatchHint, withOutcome, REPLY_ARRIVES_HINT } from '../../../src/ops/outcome.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Reply = (method: Method, path: string, body?: unknown) => Promise<unknown>
interface SeenCall { method: Method; path: string; body?: unknown }
/** Every op result carries the two sentences; the rest of the payload varies. */
interface Spoken { outcome: string; next: string; [key: string]: unknown }

function rec(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

/** Drive one op's handler against a stub transport that records every call. */
function runner(name: string, reply: Reply): {
  seen: SeenCall[]
  paths: () => string[]
  invoke: (args: Record<string, unknown>) => Promise<unknown>
  speak: (args: Record<string, unknown>) => Promise<Spoken>
} {
  const op = getOp(name)
  if (!op?.handler) throw new Error(`${name} must declare a handler`)
  const seen: SeenCall[] = []
  const call: Reply = async (method, path, body) => {
    seen.push({ method, path, body })
    return reply(method, path, body)
  }
  const invoke = (args: Record<string, unknown>): Promise<unknown> => op.handler!(args, call)
  return {
    seen,
    paths: () => seen.map((c) => `${c.method} ${c.path}`),
    invoke,
    speak: async (args) => await invoke(args) as Spoken,
  }
}

/** Render one op's mapResult over a server body. */
function mapped(name: string, body: unknown, args: Record<string, unknown> = {}): Spoken {
  const op = getOp(name)
  if (!op?.mapResult) throw new Error(`${name} must declare mapResult`)
  return op.mapResult({ body, args }) as Spoken
}

const TASK = { id: 't_9f2a41', title: 'Fix the flaky auth test' }
/** What POST /tasks/:id/start really answers (202 + a preassigned session id). */
const ACCEPTED = { taskId: TASK.id, title: TASK.title, sessionId: '7f0aa681-4b7e-4c1a-9d2e-0f1a2b3c4d5e', started: false }
const RUNNING = { ...ACCEPTED, started: true }

/** task_create against a stub that answers the create, then whatever the test wants. */
function createRunner(options: { created?: unknown; start?: () => Promise<unknown> } = {}): ReturnType<typeof runner> {
  const reply: Reply = async (method, path) => {
    if (path === '/tasks') return 'created' in options ? options.created : { task: TASK }
    if (path.endsWith('/start')) return options.start ? await options.start() : RUNNING
    throw new Error(`unexpected call: ${method} ${path}`)
  }
  return runner('task_create', reply)
}

describe('outcome vocabulary', () => {
  it('dispatchHint prints a runnable task_start line carrying the id', () => {
    const hint = dispatchHint(TASK.id)
    expect(hint).toContain('walnut tools call task_start')
    expect(hint).toContain(TASK.id)
    // The known form is allowed to state the negative: nothing is running.
    expect(hint).toContain('Not started')
  })

  it('claims nothing about attachment when the body could not answer it', () => {
    // known=false means the server sent no session fields. Saying "not started"
    // from a field nobody sent is a confident wrong answer, so the hint offers
    // BOTH doors instead.
    const hint = dispatchHint(TASK.id, false)
    expect(hint).not.toContain('Not started')
    expect(hint).toContain('walnut tools call task_start')
    expect(hint).toContain('task_send')
  })

  it('the anti-polling line names walnut wait as the only escape', () => {
    expect(REPLY_ARRIVES_HINT).toContain('do not poll')
    expect(REPLY_ARRIVES_HINT).toContain('walnut wait')
  })

  it('withOutcome adds the two fields without disturbing the payload', () => {
    const r = withOutcome({ task: { id: TASK.id }, ref: '<task-ref/>' }, 'did a thing', 'do the next thing')
    expect(r).toEqual({
      task: { id: TASK.id }, ref: '<task-ref/>', outcome: 'did a thing', next: 'do the next thing',
    })
  })
})

describe('the catalogue teaches the default', () => {
  it('task_create advertises create-and-start, with record_only as the opt-out', () => {
    const op = getOp('task_create')!
    expect(op.description).toContain('START WORK by default')
    expect(op.description).toContain('record_only=true')
    // The failure door must name the SAME-id retry, never a second create.
    expect(op.description).toContain('task_start')
    const input = op.input
    expect(Object.keys(input)).toEqual(expect.arrayContaining(['record_only', 'message', 'cwd', 'host', 'engine']))
    // record_only must document its default, or a reader assumes the old
    // create-only behavior and never starts anything.
    expect(input.record_only?.description).toContain('Default false')
    // The old spellings stay callable, and say they are the old spellings.
    expect(input.start_session?.description).toContain('Legacy')
    expect(input.start_message?.description).toContain('Legacy')
  })

  it('task_start tells an already-started caller to continue, not to duplicate', () => {
    const op = getOp('task_start')!
    expect(op.description).toContain('task_send')
    expect(op.description).toContain('do not create a duplicate')
    // Accepted is not done: the reader is pointed at the execution field.
    expect(op.description).toContain('execution')
  })

  it('every task/session write op shapes its result, so it CAN speak', () => {
    // A bound op with no mapResult returns the raw server body — no outcome, no
    // next. This guard fails when a new write op forgets to say what it did.
    // The legacy session_* names are reached with getOp: they are hidden from the
    // default catalogue but still executable.
    for (const name of [
      'task_create', 'task_update', 'task_complete', 'task_merge', 'task_delete',
      'task_pin_set', 'task_focus_tier_set', 'task_start', 'task_send',
      'session_start', 'session_send',
    ]) {
      const op = getOp(name)
      expect(op, name).toBeTruthy()
      expect(!!op?.handler || !!op?.mapResult, `${name} must shape its result`).toBe(true)
    }
  })
})

describe('board writes say execution is unchanged', () => {
  it('task_pin_set pins through the focus route and starts nothing', async () => {
    const r = runner('task_pin_set', async () => ({ pinned: true }))
    const pinned = await r.speak({ id: TASK.id, pinned: true })
    expect(r.paths()).toEqual([`POST /focus/tasks/${TASK.id}`])
    expect(pinned.outcome).toContain('Execution is unchanged')
    expect(pinned.next).toContain('No further action')

    const off = runner('task_pin_set', async () => ({ pinned: false }))
    const unpinned = await off.speak({ id: TASK.id, pinned: false })
    expect(off.paths()).toEqual([`DELETE /focus/tasks/${TASK.id}`])
    expect(unpinned.outcome).toContain('Execution is unchanged')
  })

  it('task_focus_tier_set moves a board position, not a queue position', async () => {
    const r = runner('task_focus_tier_set', async () => ({ tier: 'focus' }))
    const moved = await r.speak({ id: TASK.id, tier: 'focus' })
    expect(r.seen).toEqual([{ method: 'PUT', path: `/focus/tasks/${TASK.id}/tier`, body: { tier: 'focus' } }])
    expect(moved.outcome).toContain('focus tier')
    expect(moved.outcome).toContain('Execution is unchanged')
    // Both board ops must refuse to read as a dispatch in their own words too.
    for (const name of ['task_pin_set', 'task_focus_tier_set']) {
      expect(getOp(name)!.description, name).toMatch(/no session|not a dispatch|does not dispatch/i)
    }
  })
})

describe('task_create starts the work by default', () => {
  it('creates the task, then starts it, with execution args only on the launch', async () => {
    const r = createRunner()
    const created = await r.speak({
      title: TASK.title, project: 'marina', focus_tier: 'focus',
      cwd: '/srv/marina', host: 'build-box', engine: 'claude', mode: 'default',
    })
    expect(r.paths()).toEqual(['POST /tasks', `POST /tasks/${TASK.id}/start`])
    // The create body is task FIELDS, plus where the first start runs as
    // launch_* HINTS: the task stores a cwd but no host, so the create must know
    // the launch place to record a cwd that belongs to the right machine. The
    // execution options themselves ride the launch only.
    expect(r.seen[0].body).toEqual({
      title: TASK.title, project: 'marina', focus_tier: 'focus', launch_cwd: '/srv/marina', launch_host: 'build-box',
    })
    expect(r.seen[1].body).toEqual({ cwd: '/srv/marina', host: 'build-box', engine: 'claude', mode: 'default' })
    expect(rec(created.execution).state).toBe('running')
    expect(rec(rec(created.task).execution).state).toBe('running')
    expect(created.outcome).toContain(`Task ${TASK.id} started`)
  })

  it('message is the instruction AND survives in the persisted description', async () => {
    const r = createRunner()
    const created = await r.speak({ title: TASK.title, message: 'Reproduce, then fix.' })
    // Written once as the task body, sent once as the launch instruction: a
    // message that only rode the launch would vanish from the task record.
    expect(r.seen[0].body).toEqual({ title: TASK.title, description: 'Reproduce, then fix.' })
    expect(r.seen[1].body).toEqual({ message: 'Reproduce, then fix.' })
    expect(created.outcome).toContain(TASK.id)
  })

  it('an explicit description is never overwritten by the message', async () => {
    const r = createRunner()
    await r.speak({ title: TASK.title, description: 'Context the user wrote.', message: 'Reproduce, then fix.' })
    expect(r.seen[0].body).toEqual({ title: TASK.title, description: 'Context the user wrote.' })
    expect(r.seen[1].body).toEqual({ message: 'Reproduce, then fix.' })
  })

  it('a description with no message becomes the instruction', async () => {
    const r = createRunner()
    await r.speak({ title: TASK.title, description: 'Reproduce, then fix.' })
    expect(r.seen[0].body).toEqual({ title: TASK.title, description: 'Reproduce, then fix.' })
    expect(r.seen[1].body).toEqual({ message: 'Reproduce, then fix.' })
  })

  it('invents no instruction when the caller gave none', async () => {
    // The server resolves the default (description, else title). Inventing one
    // here would send a launch message the user never wrote.
    const r = createRunner()
    await r.speak({ title: TASK.title })
    expect(r.seen[0].body).toEqual({ title: TASK.title })
    expect(r.seen[1].body).toEqual({})
  })

  it('record_only=false is the default spelling and still starts', async () => {
    const r = createRunner()
    const created = await r.speak({ title: TASK.title, record_only: false })
    expect(r.paths()).toEqual(['POST /tasks', `POST /tasks/${TASK.id}/start`])
    expect(rec(created.execution).state).toBe('running')
  })

  it('an accepted start is "starting", never "running"', async () => {
    // A preassigned session id means the request was accepted. Only started=true
    // proves a process exists.
    const r = createRunner({ start: async () => ACCEPTED })
    const created = await r.speak({ title: TASK.title })
    expect(rec(created.execution).state).toBe('starting')
    expect(created.outcome).toContain('Start accepted')
    expect(created.outcome).toContain('not yet confirmed')
    expect(created.next).toContain('task_get')
    expect(created.next).toContain(TASK.id)
  })

  it('a reply request id rides into next with the anti-polling line', async () => {
    const r = createRunner({ start: async () => ({ ...RUNNING, requestId: 'rq-a1b2c3' }) })
    const created = await r.speak({ title: TASK.title, message: 'Reproduce, then fix.', expect_reply: true })
    expect(created.next).toContain('rq-a1b2c3')
    expect(created.next).toContain('do not poll')
    expect(rec(created.execution).state).toBe('running')
  })

  it('carries the clickable ref, non-ASCII title and all', async () => {
    // Escapes only: the fixture keeps the repo ASCII while still covering a
    // non-ASCII label reaching the ref tag verbatim.
    const title = 'Fix the \u00e9v\u00e9nement parser'
    const r = createRunner({ created: { task: { id: TASK.id, title } } })
    const created = await r.speak({ title })
    expect(created.ref).toBe(`<task-ref id="${TASK.id}" label="${title}"/>`)
    expect(created.instruction).toContain('verbatim')
  })
})

describe('task_create says where the task landed', () => {
  const PLACED = {
    project: 'marina', group_id: 'g_f1', group_label: 'Fixture work', folder_created: true, inherited_from: 't_caller',
  }

  it('group_id is a task FIELD: it rides the create, never the launch', async () => {
    const r = createRunner({ created: { task: TASK, placement: { project: 'marina', group_id: 'g_x', folder_created: false } } })
    await r.speak({ title: TASK.title, group_id: 'g_x', cwd: '/srv/marina' })
    expect(r.seen[0].body).toEqual({ title: TASK.title, group_id: 'g_x', launch_cwd: '/srv/marina' })
    expect(r.seen[1].body).toEqual({ cwd: '/srv/marina' })
  })

  it('names the project and the NEW folder, and carries placement + the folder on the task', async () => {
    const r = createRunner({ created: { task: TASK, placement: PLACED } })
    const created = await r.speak({ title: TASK.title, record_only: true })
    expect(created.outcome).toBe('Filed in project marina, folder "Fixture work" (new, holding your task and this one), '
      + 'beside your task. Placeholder saved. Work was explicitly not started.')
    expect(created.placement).toEqual(PLACED)
    expect(rec(created.task).group_id).toBe('g_f1')
  })

  it('prefixes a started create too, and a failed start keeps the placement', async () => {
    const started = await createRunner({ created: { task: TASK, placement: { project: '', folder_created: false } } })
      .speak({ title: TASK.title })
    expect(started.outcome).toBe(`Filed in the Inbox. Task ${TASK.id} started.`)
    const failed = await createRunner({
      created: { task: TASK, placement: PLACED },
      start: async () => { throw new Error('daemon unreachable') },
    }).speak({ title: TASK.title })
    expect(failed.outcome).toMatch(/^Filed in project marina, folder "Fixture work".*Task t_9f2a41 was created, but starting/)
    expect(failed.placement).toEqual(PLACED)
  })

  it('passes a grouping warning through, and says nothing for a server too old to report placement', async () => {
    const warned = await createRunner({
      created: { task: TASK, placement: { project: 'marina', folder_created: false, inherited_from: 't_caller', warning: 'The task was created but could not be put in a folder: gone' } },
    }).speak({ title: TASK.title, record_only: true })
    expect(warned.outcome).toMatch(/^Filed in project marina, beside your task\. The task was created but could not be put in a folder: gone\. Placeholder saved/)
    const old = await createRunner().speak({ title: TASK.title, record_only: true })
    expect(old.outcome).toBe('Placeholder saved. Work was explicitly not started.')
    expect(old.placement).toBeUndefined()
  })
})

describe('task_create record_only and the legacy spelling', () => {
  it('record_only=true saves a placeholder and starts nothing', async () => {
    const r = createRunner({ start: async () => { throw new Error('must not start') } })
    const created = await r.speak({ title: TASK.title, record_only: true })
    expect(r.paths()).toEqual(['POST /tasks'])
    expect(rec(created.execution).state).toBe('not_started')
    expect(rec(rec(created.task).execution).state).toBe('not_started')
    expect(created.outcome).toContain('Placeholder saved')
    expect(created.outcome).toContain('explicitly not started')
    expect(created.next).toContain('task_start')
    expect(created.next).toContain(TASK.id)
  })

  it('legacy start_session=false is honored as record_only', async () => {
    const r = createRunner({ start: async () => { throw new Error('must not start') } })
    const created = await r.speak({ title: TASK.title, start_session: false })
    expect(r.paths()).toEqual(['POST /tasks'])
    expect(rec(created.execution).state).toBe('not_started')
    expect(created.outcome).toContain('Placeholder saved')
  })

  it('legacy start_session=true starts, exactly like the default', async () => {
    const r = createRunner()
    const created = await r.speak({ title: TASK.title, start_session: true })
    expect(r.paths()).toEqual(['POST /tasks', `POST /tasks/${TASK.id}/start`])
    expect(rec(created.execution).state).toBe('running')
  })

  it('legacy start_message is accepted as the instruction', async () => {
    const r = createRunner()
    await r.speak({ title: TASK.title, start_message: 'Reproduce, then fix.' })
    expect(r.seen[0].body).toEqual({ title: TASK.title, description: 'Reproduce, then fix.' })
    expect(r.seen[1].body).toEqual({ message: 'Reproduce, then fix.' })
  })

  it('record_only + a description is fine, and the placeholder keeps the text', async () => {
    // A description is a task FIELD, not an execution option: refusing it would
    // make "save a note for later" impossible.
    const r = createRunner({ start: async () => { throw new Error('must not start') } })
    const created = await r.speak({ title: TASK.title, record_only: true, description: 'Look at this next week.' })
    expect(r.seen).toEqual([{
      method: 'POST', path: '/tasks', body: { title: TASK.title, description: 'Look at this next week.' },
    }])
    expect(rec(created.execution).state).toBe('not_started')
  })
})

describe('contradictory flags are refused BEFORE the write', () => {
  /** Assert one arg set is rejected without touching the server. */
  async function refuses(args: Record<string, unknown>, message: RegExp): Promise<void> {
    const r = createRunner({ start: async () => { throw new Error('must not start') } })
    await expect(r.invoke(args)).rejects.toThrow(message)
    // The point of "before the write": a refused call leaves nothing behind.
    expect(r.seen, `${JSON.stringify(args)} must write nothing`).toEqual([])
  }

  it('record_only=true with start_session=true is a conflict', async () => {
    await refuses({ title: TASK.title, record_only: true, start_session: true }, /conflict/i)
  })

  it('record_only=false with start_session=false is a conflict', async () => {
    // Both spellings present and both saying the opposite thing: guessing which
    // one the caller meant is how work silently does not start.
    await refuses({ title: TASK.title, record_only: false, start_session: false }, /conflict/i)
  })

  it('message and start_message together are refused', async () => {
    await refuses(
      { title: TASK.title, message: 'Reproduce, then fix.', start_message: 'Something else.' },
      /not both message and start_message/i,
    )
  })

  it('record_only with an instruction is refused', async () => {
    await refuses({ title: TASK.title, record_only: true, message: 'Reproduce, then fix.' }, /does not accept execution options/i)
    await refuses({ title: TASK.title, start_session: false, start_message: 'Reproduce, then fix.' }, /does not accept execution options/i)
  })

  it('record_only with any execution option is refused', async () => {
    for (const option of [{ cwd: '/srv/marina' }, { host: 'build-box' }, { engine: 'claude' }, { expect_reply: true }]) {
      await refuses({ title: TASK.title, record_only: true, ...option }, /does not accept execution options/i)
    }
  })

  it('record_only=true with start_session=false agree, and nothing starts', async () => {
    // Both spellings saying the SAME thing is not a conflict.
    const r = createRunner({ start: async () => { throw new Error('must not start') } })
    const created = await r.speak({ title: TASK.title, record_only: true, start_session: false })
    expect(r.paths()).toEqual(['POST /tasks'])
    expect(rec(created.execution).state).toBe('not_started')
  })
})

describe('a failed launch keeps the task and the id', () => {
  // Handler contract only: the handler RETURNS the payload (task + start_error)
  // instead of throwing, so the created task is never hidden from the caller.
  // Turning that payload into a failed call ({ ok: false, message, result }) for
  // the CLI / MCP / gateway is the executor's job, tested with the executor.
  it('reports the task, an unconfirmed execution, and a SAME-id retry', async () => {
    // Failing the whole call would tell the agent the opposite of what happened
    // (the task is really there), so the op must not throw here.
    const r = createRunner({ start: async () => { throw new Error('Walnut API error (409): session_exists') } })
    const created = await r.speak({ title: TASK.title, message: 'Reproduce, then fix.' })
    expect(rec(created.task).id).toBe(TASK.id)
    expect(String(created.start_error)).toContain('session_exists')
    const execution = rec(created.execution)
    expect(execution.state).toBe('unconfirmed')
    expect(String(execution.error)).toContain('session_exists')
    expect(created.outcome).toContain(`Task ${TASK.id} was created`)
    expect(created.outcome).toContain('not confirmed')
    expect(created.next).toContain('Do not create another task')
    expect(created.next).toContain(`task_start '{"id":"${TASK.id}"}'`)
  })

  it('an incomplete start response is a failed launch, not a silent success', async () => {
    // A 200 with no taskId cannot prove a launch. Reading it as success is how a
    // task ends up reported as running while nothing runs.
    const r = createRunner({ start: async () => ({ ok: true }) })
    const created = await r.speak({ title: TASK.title })
    const execution = rec(created.execution)
    expect(execution.state).toBe('unconfirmed')
    expect(String(execution.error)).toContain('incomplete')
    expect(created.next).toContain(TASK.id)
    expect(r.paths()).toEqual(['POST /tasks', `POST /tasks/${TASK.id}/start`])
  })

  it('an incomplete create response throws and never starts /tasks//start', async () => {
    for (const created of [{}, { task: { title: TASK.title } }, undefined, 'not json']) {
      const r = createRunner({ created, start: async () => { throw new Error('must not start') } })
      await expect(r.invoke({ title: TASK.title })).rejects.toThrow(/no task id/i)
      // An empty id would build the path /tasks//start, which is a different
      // route entirely — the guard must stop before the second call.
      expect(r.paths(), JSON.stringify(created ?? null)).toEqual(['POST /tasks'])
    }
  })
})

describe('reads answer a DERIVED execution state', () => {
  /** One task row as the REST route sends it, bookkeeping included. */
  function taskBody(over: Record<string, unknown>): { task: Record<string, unknown> } {
    return { task: { id: TASK.id, title: TASK.title, phase: 'IN_PROGRESS', status: 'in_progress', ...over } }
  }

  it('renders the live process status and drops the raw bookkeeping', () => {
    const r = mapped('task_get', taskBody({
      session_id: '7f0aa681', exec_session_id: '7f0aa681', session_ids: ['7f0aa681'],
      session_status: { process_status: 'running', mode: 'bypass' },
      exec_session_status: { process_status: 'running' },
    }), { id: TASK.id })
    const task = rec(r.task)
    // State only: the internal session id is not part of the agent-facing view.
    expect(rec(task.execution)).toEqual({ state: 'running' })
    for (const key of ['status', 'session_id', 'exec_session_id', 'session_ids', 'session_status', 'exec_session_status']) {
      expect(task, `${key} must not reach the caller`).not.toHaveProperty(key)
    }
    expect(r.outcome).toBe('Task phase: IN_PROGRESS. Execution: running.')
    // Something is on it, so the next step is reading or adding context.
    expect(r.next).toContain('task_history')
    expect(r.next).toContain('task_send')
  })

  it('a pending permission prompt outranks the process status', () => {
    const r = mapped('task_get', taskBody({
      session_id: '7f0aa681',
      session_status: { process_status: 'running', pendingPermissionTool: 'Bash' },
    }), { id: TASK.id })
    expect(rec(rec(r.task).execution).state).toBe('waiting')
    expect(r.outcome).toContain('Execution: waiting')
  })

  it('an empty session_ids array is not_started, and next is the dispatch line', () => {
    const r = mapped('task_get', taskBody({ phase: 'TODO', session_ids: [] }), { id: TASK.id })
    expect(rec(rec(r.task).execution).state).toBe('not_started')
    expect(r.outcome).toContain('Execution: not_started')
    expect(r.next).toBe(dispatchHint(TASK.id))
  })

  it('a session id with no status slot is unknown, not idle', () => {
    // The row says a session exists but not what it is doing. Answering "idle"
    // would invent liveness the body never reported.
    const r = mapped('task_get', taskBody({ session_id: '7f0aa681', session_ids: ['7f0aa681'] }), { id: TASK.id })
    expect(rec(rec(r.task).execution)).toEqual({ state: 'unknown' })
    expect(r.next).toContain('task_history')
  })

  it('a slim body with no session fields answers unknown, never "no session"', () => {
    // The PATCH/complete projections carry no session fields at all. Reading a
    // missing field as "none" told a task being updated from inside its own live
    // session that nothing was working on it (caught live, 2026-09-01).
    const r = mapped('task_get', { task: { id: TASK.id, title: TASK.title, phase: 'NEED_ACTION' } }, { id: TASK.id })
    expect(rec(rec(r.task).execution).state).toBe('unknown')
    expect(r.outcome).toContain('Execution: unknown')
    expect(r.outcome).not.toMatch(/no session/i)
    expect(r.next).toContain('task_history')
  })

  it('a missing phase reads as unknown rather than an empty sentence', () => {
    const r = mapped('task_get', { task: { id: TASK.id } }, { id: TASK.id })
    expect(r.outcome).toBe('Task phase: unknown. Execution: unknown.')
  })

  it('refuses a body whose task has no id instead of dressing it up', () => {
    // A truncated 200 must not pass for a real task: without an id the result
    // would carry raw bookkeeping and a next line pointing at a task nobody read.
    for (const body of [{ task: { phase: 'TODO', session_ids: [] } }, { task: { id: '' } }]) {
      expect(() => mapped('task_get', body, { id: TASK.id }), JSON.stringify(body))
        .toThrow(/Task response is incomplete; retry task_get\./)
    }
  })

  it.each([
    ['failed attempt', { last_start: { state: 'failed', error: 'Missing cwd' }, session_ids: [] }, 'error'],
    ['retry before linking', { last_start: { state: 'starting', session_id: 'new' }, session_id: 'old', session_status: { process_status: 'error' } }, 'starting'],
    ['uncertain attempt', { last_start: { state: 'unconfirmed', session_id: 'run' }, session_id: 'run', session_status: { process_status: 'stopped' } }, 'unknown'],
    ['confirmed recovery', { last_start: { state: 'failed', session_id: 'run' }, session_id: 'run', session_status: { process_status: 'running', pid: 42 } }, 'running'],
    ['provider-issued recovery', { last_start: { state: 'unconfirmed', at: '2026-09-16T00:00:00Z' }, session_id: 'provider-run', session_status: { process_status: 'idle', engine: 'codex', startedAt: '2026-09-16T00:00:01Z' } }, 'idle'],
    ['archived history', { session_ids: [], session_history_count: 2 }, 'stopped'],
    ['unavailable store', { session_ids: [], session_status_unavailable: true }, 'unknown'],
  ])('%s has an honest execution state', (_label, input, expected) => {
    const result = mapped('task_get', taskBody(input as Record<string, unknown>), { id: TASK.id });
    expect(rec(rec(result.task).execution).state).toBe(expected);
    expect(rec(result.task)).not.toHaveProperty('last_start');
  });

  it('task_list rows carry the same derived execution, never a status slot', async () => {
    const r = runner('task_list', async () => ({
      tasks: [{
        id: TASK.id, title: TASK.title, phase: 'IN_PROGRESS', project: 'marina', updated_at: '2026-09-16T00:00:00.000Z',
        status: 'in_progress', session_id: '7f0aa681', session_ids: ['7f0aa681'],
        session_status: { process_status: 'idle' },
      }],
      total: 1,
    }))
    const listed = rec(await r.invoke({ fields: 'list' }))
    const row = rec((listed.tasks as unknown[])[0])
    expect(rec(row.execution)).toEqual({ state: 'idle' })
    for (const key of ['status', 'session_id', 'session_ids', 'session_status']) {
      expect(row, `${key} must not reach a row`).not.toHaveProperty(key)
    }
  })
})

describe('task_list scope', () => {
  const WORKER = { kind: 'worker', task: { id: 't_caller', title: 'Refactor the fixture', project: 'marina' } }
  const FOLDERED = { kind: 'worker', task: { ...WORKER.task, group_id: 'g_f1', group_label: 'Fixture work' } }
  /** A stub server: GET /me answers `me`, the list answers `list`. */
  const scoped = (me: unknown, list: unknown = { tasks: [], total: 0 }) =>
    runner('task_list', async (_method, path) => (path === '/me' ? me : list))

  it('scope=all never asks where the caller stands', async () => {
    const r = runner('task_list', async () => ({ tasks: [], total: 0 }))
    const listed = rec(await r.invoke({ scope: 'all' }))
    expect(r.paths()).toEqual(['GET /api/tasks?limit=50'])
    expect(listed.scope).toBe('all')
    expect(listed.you).toBeUndefined()
  })

  it('refuses an unplaceable caller instead of answering the whole board', async () => {
    // Silently widening to every task would answer a different question than the
    // one asked, and the caller could not tell.
    const r = scoped({ kind: 'human' })
    await expect(r.invoke({ scope: 'folder' })).rejects.toThrow(/Cannot locate the caller/i)
    expect(r.paths()).toEqual(['GET /me'])
  })

  it('a caller in no folder asking for its folder is measured by its project', async () => {
    const r = scoped(WORKER)
    const listed = rec(await r.invoke({ scope: 'folder' }))
    expect(listed.scope).toBe('project')
    expect(rec(listed.you)).toEqual({ id: 't_caller', title: 'Refactor the fixture', project: 'marina' })
    expect(r.paths()[1]).toContain('project=marina')
    // Asked for, so no "by default" line.
    expect(listed.hint).toBeUndefined()
  })

  it('a filter contradicting the caller place answers empty, and queries nothing', async () => {
    const r = scoped(WORKER, { tasks: [{ id: 'other' }], total: 1 })
    const listed = rec(await r.invoke({ scope: 'project', project: 'acme' }))
    expect(listed).toMatchObject({ count: 0, total: 0, truncated: false, scope: 'project', tasks: [] })
    expect(r.paths()).toEqual(['GET /me'])
  })

  it('from inside a task, no scope means the folder ring, said out loud', async () => {
    const r = scoped(FOLDERED, { tasks: [{ id: 't_caller', title: 'Refactor the fixture', phase: 'IN_PROGRESS' }], total: 1 })
    const listed = rec(await r.invoke({}))
    expect(r.paths()).toEqual(['GET /me', 'GET /api/tasks?group_id=g_f1&limit=50'])
    expect(listed.scope).toBe('folder')
    expect(rec(listed.you)).toEqual({
      id: 't_caller', title: 'Refactor the fixture', project: 'marina', group_id: 'g_f1', group_label: 'Fixture work',
    })
    expect(listed.hint).toBe('Listed folder "Fixture work" in project marina by default, because you called from inside a task. '
      + 'Pass scope:"project" for your whole project or scope:"all" for the board.')
  })

  it('a worker in no folder gets its project ring by default', async () => {
    const r = scoped(WORKER, { tasks: [{ id: 't_flake', title: 'Fix the flake' }], total: 1 })
    const listed = rec(await r.invoke({ q: 'flake' }))
    expect(r.paths()[1]).toBe('GET /api/tasks?q=flake&project=marina&limit=50')
    expect(listed.scope).toBe('project')
    expect(listed.hint).toMatch(/^Listed project marina by default \(your task sits in no folder\)/)
  })

  it('a title search that finds nothing near widens: folder, then project, then the board', async () => {
    // "Does this exist yet?" answered from an empty folder would read as "no".
    const hitOnBoard = { tasks: [{ id: 'far', title: 'Login bug' }], total: 1 }
    const r = runner('task_list', async (_method, path) => {
      if (path === '/me') return FOLDERED
      return path.includes('group_id=') || path.includes('project=') ? { tasks: [], total: 0 } : hitOnBoard
    })
    const listed = rec(await r.invoke({ q: 'login bug' }))
    expect(r.paths()).toEqual([
      'GET /me',
      'GET /api/tasks?q=login+bug&group_id=g_f1&limit=50',
      'GET /api/tasks?q=login+bug&limit=50&project=marina',
      'GET /api/tasks?q=login+bug&limit=50',
    ])
    expect(listed.scope).toBe('all')
    expect(listed.count).toBe(1)
    expect(listed.hint).toBe('Nothing in your folder matched "login bug", so this searched the whole board.')
  })

  it('stops widening at the first ring with a hit, and never widens an ASKED scope', async () => {
    const r = runner('task_list', async (_method, path) => {
      if (path === '/me') return FOLDERED
      return path.includes('project=') ? { tasks: [{ id: 'near' }], total: 1 } : { tasks: [], total: 0 }
    })
    const listed = rec(await r.invoke({ q: 'fixture' }))
    expect(listed.scope).toBe('project')
    expect(listed.hint).toBe('Nothing in your folder matched "fixture", so this searched your whole project.')
    const asked = runner('task_list', async (_method, path) => (path === '/me' ? FOLDERED : { tasks: [], total: 0 }))
    const strict = rec(await asked.invoke({ q: 'fixture', scope: 'folder' }))
    expect(strict).toMatchObject({ scope: 'folder', count: 0 })
    expect(asked.paths()).toHaveLength(2)
  })

  it('the default hint rides along with the truncation warning, never replaces it', async () => {
    const r = scoped(WORKER, { tasks: [{ id: 'a' }], total: 7 })
    const listed = rec(await r.invoke({ limit: 1 }))
    expect(String(listed.hint)).toMatch(/by default.*Showing 1 of 7 matching tasks/)
  })

  it.each([
    ['project', { project: 'acme' }],
    ['projects', { projects: 'acme,marina' }],
    ['group_id', { group_id: 'g_other' }],
    ['ids', { ids: 'a,b' }],
    ['working_set', { working_set: true }],
    ['parent_task_id', { parent_task_id: 't_parent' }],
    ['focus_tier', { focus_tier: 'focus' }],
    ['pinned', { pinned: true }],
    ['unread', { unread: true }],
  ])('a call naming a place or the board (%s) is not second-guessed', async (_key, args) => {
    const r = scoped(FOLDERED)
    const listed = rec(await r.invoke(args))
    expect(r.paths().some((p) => p === 'GET /me')).toBe(false)
    expect(listed.scope).toBeUndefined()
    expect(listed.you).toBeUndefined()
  })

  it.each([
    ['the Personal AI', { kind: 'ask', task: { id: 't_ask', title: 'Ask', project: 'Ask Walnut' } }],
    ['a human', { kind: 'human' }],
    ['an external process', { kind: 'external' }],
  ])('%s still gets the board by default', async (_who, me) => {
    const r = scoped(me)
    const listed = rec(await r.invoke({}))
    expect(r.paths()).toEqual(['GET /me', 'GET /api/tasks?limit=50'])
    expect(listed.scope).toBeUndefined()
    expect(listed.hint).toBeUndefined()
  })

  it('a server too old to answer /me degrades to the board, not an error', async () => {
    const r = runner('task_list', async (_method, path) => {
      if (path === '/me') throw new Error('Walnut API error (404): Not Found')
      return { tasks: [], total: 0 }
    })
    const listed = rec(await r.invoke({}))
    expect(listed.scope).toBeUndefined()
    expect(r.paths()).toEqual(['GET /me', 'GET /api/tasks?limit=50'])
  })
})

describe('task_history resolves the task, then its transcript', () => {
  /** The task read comes from the v1 route, whose raw row keeps archived sessions. */
  const TASK_READ = `GET /tasks/${TASK.id}`

  /** Stub: the task row first, then the transcript (or whatever the test wants). */
  function historyRunner(task: Record<string, unknown>, transcript: () => Promise<unknown>): ReturnType<typeof runner> {
    return runner('task_history', async (_method, path) => (
      path.startsWith('/sessions') ? await transcript() : { task }
    ))
  }

  it('reads the task, then that session transcript', async () => {
    const r = historyRunner({ id: TASK.id, session_id: '7f0aa681', session_ids: ['7f0aa681'] },
      async () => ({ messages: [{ role: 'user', text: 'Reproduce, then fix.' }] }))
    const history = rec(await r.invoke({ id: TASK.id }))
    expect(r.paths()).toEqual([TASK_READ, 'GET /sessions/7f0aa681/transcript'])
    expect(history.taskId).toBe(TASK.id)
    expect((history.messages as unknown[]).length).toBe(1)
  })

  it('prefers the live slot, then the exec slot, then the newest archived session', async () => {
    // A task can carry several sessions; the LAST id is the current conversation,
    // and an older one would answer with a transcript the user is not reading.
    const cases: Array<{ task: Record<string, unknown>; sid: string }> = [
      { task: { id: TASK.id, session_id: 'aaaa1111', exec_session_id: 'bbbb2222', session_ids: ['cccc3333'] }, sid: 'aaaa1111' },
      { task: { id: TASK.id, exec_session_id: 'bbbb2222', session_ids: ['cccc3333'] }, sid: 'bbbb2222' },
      { task: { id: TASK.id, session_ids: ['cccc3333', 'dddd4444'] }, sid: 'dddd4444' },
    ]
    for (const { task, sid } of cases) {
      const r = historyRunner(task, async () => ({ messages: [] }))
      await r.invoke({ id: TASK.id })
      expect(r.paths(), JSON.stringify(task)).toEqual([TASK_READ, `GET /sessions/${sid}/transcript`])
    }
  })

  it('fresh=true forces the live read on the primary box', async () => {
    const r = historyRunner({ id: TASK.id, exec_session_id: '7f0aa681' }, async () => ({ messages: [] }))
    await r.invoke({ id: TASK.id, fresh: true })
    expect(r.paths()[1]).toBe('GET /sessions/7f0aa681/transcript?fresh=1')
  })

  it('a placeholder answers not_started and no messages, with no transcript read', async () => {
    // not_started is claimed on PROOF only: an empty session_ids array plus no
    // slot. That is the one shape that means "nothing has ever run here".
    const r = historyRunner({ id: TASK.id, session_ids: [] }, async () => { throw new Error('must not read a transcript') })
    const history = rec(await r.invoke({ id: TASK.id }))
    expect(r.paths()).toEqual([TASK_READ])
    expect(history).toEqual({ taskId: TASK.id, execution: { state: 'not_started' }, messages: [] })
  })

  it('a body that reports no session fields at all is refused, not called empty', async () => {
    // Unknown is not "placeholder". A slim projection with no session bookkeeping
    // must not be answered as an empty conversation — that is the confident wrong
    // answer this whole family of results exists to prevent.
    const r = historyRunner({ id: TASK.id, phase: 'IN_PROGRESS' }, async () => { throw new Error('must not read a transcript') })
    await expect(r.invoke({ id: TASK.id })).rejects.toThrow()
    expect(r.paths()).toEqual([TASK_READ])
  })

  it('a transcript failure propagates — it never becomes an empty conversation', async () => {
    // "No messages" and "the read failed" are opposite answers. Swallowing the
    // failure would report a conversation that exists as empty.
    const r = historyRunner({ id: TASK.id, session_id: '7f0aa681' },
      async () => { throw new Error('Walnut API error (503): transcript_unavailable') })
    await expect(r.invoke({ id: TASK.id })).rejects.toThrow(/transcript_unavailable/)
  })

  it('an empty transcript body invents no message list', async () => {
    const r = historyRunner({ id: TASK.id, session_id: '7f0aa681' }, async () => null)
    await expect(r.invoke({ id: TASK.id })).rejects.toThrow('Transcript response is incomplete')
  })

  it('a task body with no id is refused', async () => {
    const r = historyRunner({ title: TASK.title, session_id: '7f0aa681' },
      async () => { throw new Error('must not read a transcript') })
    await expect(r.invoke({ id: TASK.id })).rejects.toThrow(/no id/i)
    expect(r.paths()).toEqual([TASK_READ])
  })
})

describe('task_send: queued, deferred, and replies', () => {
  it('a queued message names the target task and refuses a resend', () => {
    const r = mapped('task_send', {
      delivery: 'queued', targetSessionId: '7f0aa681', targetTaskId: TASK.id, requestId: 'rq-a1b2c3',
    }, { to: TASK.id, text: 'One more thing.' })
    expect(r.outcome).toContain(`Message queued for ${TASK.id}`)
    expect(r.outcome).toContain('not a completed reply')
    expect(r.outcome).toContain('Do NOT resend')
    expect(r.next).toContain('rq-a1b2c3')
    expect(r.next).toContain('do not poll')
  })

  it('a deferred message says it is parked on a human prompt', () => {
    const r = mapped('task_send', { delivery: 'deferred', targetSessionId: '7f0aa681' },
      { to: TASK.id, text: 'One more thing.' })
    expect(r.outcome).toContain('parked on a human permission prompt')
    expect(r.outcome).toContain('Do NOT resend')
    // No request id: the plain arrival line still tells the caller not to poll.
    expect(r.next).toBe(REPLY_ARRIVES_HINT)
  })

  it('a reply routes by request id even when the body names no target', () => {
    const r = mapped('task_send', {}, { in_reply_to: 'rq-a1b2c3', text: 'Here is the answer.' })
    expect(r.outcome).toContain('rq-a1b2c3')
    expect(r.outcome).toContain('Do NOT resend')
  })

  it('falls back to the handle the caller used when the body names no session', () => {
    const r = mapped('task_send', { delivery: 'queued' }, { to: 'Refactor the fixture [aaaa1111]', text: 'Ping.' })
    expect(r.outcome).toContain('Refactor the fixture [aaaa1111]')
  })
})

describe('request_get', () => {
  it('pending means "not settled", and refuses to invite polling', () => {
    const r = mapped('request_get', { request: { status: 'pending' } }, { id: 'rq-a1b2c3' })
    expect(r.outcome).toContain('never "failed"')
    expect(r.next).toContain('Do not poll')
    expect(r.next).toContain('walnut wait')
  })

  it('a settled request says nothing is waiting on it', () => {
    const r = mapped('request_get', { request: { status: 'replied' } }, { id: 'rq-a1b2c3' })
    expect(r.outcome).toContain('replied')
    expect(r.next).toContain('Nothing else is required')
  })

  it('a body with no status reads as unknown rather than pending', () => {
    const r = mapped('request_get', {}, { id: 'rq-a1b2c3' })
    expect(r.outcome).toContain('unknown')
    expect(r.outcome).not.toContain('Still pending')
  })
})

describe('task_update writes the board, not the execution', () => {
  it('says the write started and stopped nothing, and invents no attachment', async () => {
    const r = runner('task_update', async () => ({ task: { id: TASK.id, phase: 'NEED_ACTION' } }))
    const updated = await r.speak({ id: TASK.id, phase: 'NEED_ACTION' })
    expect(r.seen).toEqual([{ method: 'PATCH', path: `/tasks/${TASK.id}`, body: { phase: 'NEED_ACTION' } }])
    expect(updated.outcome).toContain('No session was started or stopped by this')
    expect(updated.outcome).toContain('Execution is unchanged')
    expect(updated.outcome).not.toMatch(/no session is attached/i)
    expect(updated.next).toContain('ready for the human')
  })

  it('points at the live session when the body says one is attached', async () => {
    const r = runner('task_update', async () => ({
      task: { id: TASK.id, status: 'in_progress', session_ids: ['7f0aa681'], session_status: { process_status: 'running' } },
    }))
    const updated = await r.speak({ id: TASK.id, title: 'Fix the flaky auth test again' })
    expect(updated.next).toContain('task_send')
    expect(updated.next).toContain(TASK.id)
    // The attachment is read off the RAW body, but what comes back is the same
    // derived view every other read answers with.
    const view = rec(updated.task)
    expect(rec(view.execution).state).toBe('running')
    for (const key of ['status', 'session_ids', 'session_status']) {
      expect(view, `${key} must not reach the caller`).not.toHaveProperty(key)
    }
  })

  it('uses the unknown-form dispatch hint when the body cannot answer', async () => {
    const r = runner('task_update', async () => ({ task: { id: TASK.id, phase: 'TODO' } }))
    const updated = await r.speak({ id: TASK.id, title: 'Fix the flaky auth test again' })
    expect(updated.next).toBe(dispatchHint(TASK.id, false))
  })

  it('says "not started" only when the body really reported no session', async () => {
    const r = runner('task_update', async () => ({ task: { id: TASK.id, session_ids: [] } }))
    const updated = await r.speak({ id: TASK.id, title: 'Fix the flaky auth test again' })
    expect(updated.next).toBe(dispatchHint(TASK.id))
  })

  it('refuses a patch with nothing to change', async () => {
    const r = runner('task_update', async () => ({ task: { id: TASK.id } }))
    await expect(r.invoke({ id: TASK.id })).rejects.toThrow(/at least one field/i)
    expect(r.seen).toEqual([])
  })
})

describe('task_complete does not stop anything', () => {
  // ONE sentence for every body shape. The old three-way text guessed liveness
  // from session bookkeeping ("still alive" from a list of historical ids), which
  // is a claim the completion response cannot make. The state difference now
  // lives where it is derived: task.execution.
  const OUTCOME = 'Task marked complete. Execution is unchanged; completion does not stop running work.'
  const NEXT = 'No further action is required.'

  const cases: Array<{ label: string; task: Record<string, unknown>; state: string }> = [
    {
      label: 'a live session on it',
      task: { id: TASK.id, title: TASK.title, session_ids: ['7f0aa681'], session_status: { process_status: 'running' } },
      state: 'running',
    },
    { label: 'no session ever', task: { id: TASK.id, title: TASK.title, session_ids: [] }, state: 'not_started' },
    { label: 'a slim body', task: { id: TASK.id, title: TASK.title, phase: 'COMPLETE' }, state: 'unknown' },
  ]

  for (const { label, task, state } of cases) {
    it(`says the same thing with ${label}, and leaks no session bookkeeping`, () => {
      const r = mapped('task_complete', { task }, { id: TASK.id })
      expect(r.outcome).toBe(OUTCOME)
      expect(r.next).toBe(NEXT)
      // No liveness claim invented from the ids the row happened to carry.
      expect(r.outcome).not.toMatch(/still alive|no session was attached/i)
      const view = rec(r.task)
      expect(rec(view.execution).state, label).toBe(state)
      for (const key of ['status', 'session_id', 'session_ids', 'session_status']) {
        expect(view, `${key} must not reach the caller`).not.toHaveProperty(key)
      }
      expect(r.completed).toBe(true)
      expect(r.ref).toBe(`<task-ref id="${TASK.id}" label="${TASK.title}"/>`)
    })
  }
})

describe('the legacy session_* writes still speak', () => {
  it('session_start starts by task id without leaking `task` into the body', async () => {
    const r = runner('session_start', async () => RUNNING)
    const started = await r.speak({ task: TASK.id, message: 'Reproduce, then fix.' })
    expect(r.seen).toEqual([{
      method: 'POST', path: `/tasks/${TASK.id}/start`, body: { message: 'Reproduce, then fix.' },
    }])
    expect(rec(started.execution).state).toBe('running')
    expect(started.outcome).toContain(`Task ${TASK.id} started`)
  })

  it('session_send shapes its result exactly like task_send', () => {
    const body = { delivery: 'queued', targetSessionId: '7f0aa681', targetTaskId: TASK.id }
    const args = { to: '7f0aa681', text: 'One more thing.' }
    expect(mapped('session_send', body, args)).toEqual(mapped('task_send', body, args))
  })
})
