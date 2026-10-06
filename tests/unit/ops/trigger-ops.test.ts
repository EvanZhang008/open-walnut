/**
 * The trigger ops' contracts (src/ops/triggers.ts): trigger_create refuses a
 * call without a description before it reaches the server (the executor
 * validates args with `z.object(op.input).strict()`), trigger_list hands the
 * description and the run state back so an agent answering "what are you
 * watching?" can say what each trigger does and whether it polls, and
 * trigger_pause / trigger_resume set the state asked for (never a flip) on a
 * trigger only.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getOp } from '../../../src/ops/index.js'

const args = { run: 'bash ~/.open-walnut/triggers/pr/check.sh', every: '5m', prompt: 'Reply to the comment.' }

describe('trigger_create input', () => {
  const schema = () => z.object(getOp('trigger_create')!.input).strict()

  it('requires a non-empty description', () => {
    expect(schema().safeParse(args).success).toBe(false)
    expect(schema().safeParse({ ...args, description: '' }).success).toBe(false)
    expect(schema().safeParse({ ...args, description: 'Checks PR 123 for new comments.' }).success).toBe(true)
  })

  it('tells the model what the description is for', () => {
    const op = getOp('trigger_create')!
    expect(op.description).toContain('`description` is required')
    expect(op.input.description.description).toMatch(/what this watches, when it fires/)
  })
})

describe('trigger_create output', () => {
  it('puts the new trigger id and name at the top level, beside the job', () => {
    // A caller had to run trigger_list to learn the id it had just created
    // (2026-10-02): the server answers { job, host }, and the id sat at .job.id only.
    const op = getOp('trigger_create')!
    const body = {
      job: { id: 'rt_1', name: 'PR comments', schedule: { kind: 'every', everyMs: 300_000 } },
      host: 'devbox', nextCheckAt: null,
    }
    const out = op.mapResult!({ body, args: {} }) as Record<string, unknown>
    expect(out).toMatchObject({ id: 'rt_1', name: 'PR comments', host: 'devbox' })
    expect((out.job as { id: string }).id).toBe('rt_1')
    expect(out.outcome).toContain('every 5m')
    expect(out.next).toContain('trigger_delete \'{"id":"rt_1"}\'')
  })

  it('omits the top-level id when the server body has no job', () => {
    const out = getOp('trigger_create')!.mapResult!({ body: {}, args: {} }) as Record<string, unknown>
    expect('id' in out).toBe(false)
  })

  // The outcome says what the call did to the task, so the model never tells the
  // user "it is waiting" when it is not, or the reverse (2026-10-04).
  const job = { id: 'rt_1', name: 'PR review', schedule: { kind: 'every', everyMs: 300_000 } }
  const mapWith = (wait: Record<string, unknown>, args: Record<string, unknown> = {}) =>
    getOp('trigger_create')!.mapResult!({ body: { job, host: '__local__', nextCheckAt: null, wait }, args }) as
      { outcome: string; next: string; wait: unknown }

  it('says the task is parked and until when, and that a park sends no letter', () => {
    // 2026-10-05: one receipt letter per (re-)park filled the user's inbox.
    const out = mapWith({ parked: true, task_id: 't1', wait_until: '2026-10-07T12:00:00.000Z' })
    expect(out.outcome).toContain('The task is now Waiting, off the user\'s list, until it fires or 2026-10-07T12:00:00.000Z.')
    expect(out.outcome).not.toMatch(/receipt|inbox/)
    expect(out.next).toMatch(/^End your turn now with one line saying what you wait on; the fire starts a new one here\./)
    expect(out.next).toContain('park again (task_update phase=WAITING) as your last call, with no letter')
    expect(mapWith({ parked: true, task_id: 't1', wait_until: null }).outcome).toContain('until it fires.')
  })

  it('asks for a short wait_until when the park named none, and a re-check before every re-park', () => {
    // 2026-10-05: the default clock is a guess; a session usually knows when a
    // CI run or a review should land, and a new trigger may be wrong.
    const parked = { parked: true, task_id: 't1', wait_until: '2026-10-06T12:00:00.000Z' }
    expect(mapWith(parked).outcome)
      .toContain('You named no wait_until: when you can tell when it should happen, set one (task_update wait_until), kept short.')
    expect(mapWith(parked, { wait_until: '2h' }).outcome).not.toContain('You named no wait_until')
    expect(mapWith({ parked: false, task_id: 't1', reason: 'wait_false' }).outcome).not.toContain('You named no wait_until')
    expect(mapWith(parked).next).toContain('Before each re-park (after a fire or the clock), check that the trigger fired for the right reason')
  })

  it('says why the task was left alone', () => {
    expect(mapWith({ parked: false, task_id: 't1', reason: 'wait_false' }).outcome)
      .toContain('left as it is (wait:false); park it with task_update phase=WAITING once only the wait is left')
    expect(mapWith({ parked: false, task_id: 't2', reason: 'other_task' }).outcome)
      .toContain('not your task; pass wait:true to park it')
    expect(mapWith({ parked: false, task_id: 't3', reason: 'complete' }).outcome)
      .toContain('is complete, so it was not parked')
    expect(mapWith({ parked: false, task_id: 't4', reason: 'not_written', error: 'locked' }).outcome)
      .toContain('The task could not be parked (locked).')
    // Not parked: the old one-line report to the user, never "end your turn".
    expect(mapWith({ parked: false, task_id: 't1', reason: 'wait_false' }).next)
      .toMatch(/^Tell the user in one line what is watched and how often\./)
  })
})

describe('trigger_create wait inputs', () => {
  const schema = () => z.object(getOp('trigger_create')!.input).strict()
  const base = { ...args, description: 'Checks PR 123 for review comments.' }

  it('accepts wait and wait_until, types them, and has no wait_report (a park writes no letter)', () => {
    expect(schema().safeParse({ ...base, wait: false }).success).toBe(true)
    expect(schema().safeParse({ ...base, wait: true, wait_until: '6h' }).success).toBe(true)
    expect(schema().safeParse({ ...base, wait: 'no' }).success).toBe(false)
    expect(schema().safeParse({ ...base, wait_report: 'PR 123 is pushed.' }).success).toBe(false)
  })

  it('tells the model it parks by default, to use it unasked, and how to opt out', () => {
    const op = getOp('trigger_create')!
    expect(op.description).toContain('It PARKS your own task by default')
    expect(op.description).toContain('Pass wait:false while you or the user still have work on this task')
    expect(op.description).toContain('do not ask the user to watch it')
  })

  it('tells the model to set a short clock itself, and that the default is 1 day', () => {
    const op = getOp('trigger_create')!
    expect(op.description).toContain('Set wait_until yourself to when you expect the event, kept short')
    expect(op.description).toContain('the clock running out is how you find out')
    expect(op.description).not.toMatch(/3 days/)
    expect(op.input.wait_until.description).toMatch(/Default 1 day/)
    const update = getOp('task_update')!
    expect(update.description).toContain('Set it to when you expect the event, kept short')
    expect(update.description).toContain('gets 1 day from now')
    expect(update.input.wait_until.description).toMatch(/1 day from now/)
  })
})

describe('trigger_list output', () => {
  it('returns each trigger\'s description, and omits the field for one that has none', async () => {
    const op = getOp('trigger_list')!
    const jobs = [
      { id: 'a', name: 'PR comments', description: 'Checks PR 123 for new comments.', enabled: true,
        schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'bash a.sh', host: '__local__' }, state: {} },
      { id: 'b', name: 'Legacy', enabled: true,
        schedule: { kind: 'every', everyMs: 3_600_000 }, check: { run: 'bash b.sh', host: 'devbox' }, state: {} },
      // A plain scheduled routine is not a trigger.
      { id: 'c', name: 'Plain', description: 'Not a trigger.', enabled: true, schedule: { kind: 'every', everyMs: 60_000 }, state: {} },
    ]
    const out = await op.handler!({}, async () => ({ jobs })) as { count: number; triggers: Array<Record<string, unknown>> }
    expect(out.count).toBe(2)
    expect(out.triggers[0]).toMatchObject({ id: 'a', description: 'Checks PR 123 for new comments.', every: '5m' })
    expect(out.triggers[1]).toMatchObject({ id: 'b', every: '1h', host: 'devbox' })
    expect('description' in out.triggers[1]).toBe(false)
  })
})

describe('trigger_list state', () => {
  it('says armed, paused (with when) or stopped for each trigger', async () => {
    const op = getOp('trigger_list')!
    const base = { schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'bash a.sh', host: '__local__' } }
    const pausedAt = Date.parse('2026-09-30T10:00:00Z')
    const jobs = [
      { ...base, id: 'on', name: 'On', enabled: true, state: {} },
      { ...base, id: 'paused', name: 'Paused', enabled: false, state: { pausedAtMs: pausedAt } },
      { ...base, id: 'stopped', name: 'Stopped', enabled: false, state: { consecutiveErrors: 5, lastError: 'exit 1' } },
      // Switched off before pausedAtMs existed, and not for failing: a pause.
      { ...base, id: 'legacy', name: 'Legacy', enabled: false, state: { consecutiveErrors: 1 } },
    ]
    const out = await op.handler!({}, async () => ({ jobs })) as { triggers: Array<Record<string, unknown>> }
    const byId = Object.fromEntries(out.triggers.map((t) => [t.id, t]))
    expect(byId.on).toMatchObject({ state: 'armed', enabled: true })
    expect('pausedAt' in byId.on).toBe(false)
    expect(byId.paused).toMatchObject({ state: 'paused', enabled: false, pausedAt: '2026-09-30T10:00:00.000Z' })
    expect(byId.stopped).toMatchObject({ state: 'stopped', enabled: false })
    expect(byId.legacy).toMatchObject({ state: 'paused' })
    expect('pausedAt' in byId.legacy).toBe(false)
  })
})

describe('trigger_pause / trigger_resume', () => {
  type Call = { method: string; path: string; body?: unknown }
  function server(job: Record<string, unknown> | null) {
    const calls: Call[] = []
    let current = job
    const call = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (!current) throw new Error('Cron job not found: nope')
      if (method === 'PATCH') {
        const enabled = (body as { enabled: boolean }).enabled
        current = { ...current, enabled, state: { ...(current.state as object), pausedAtMs: enabled ? undefined : 1 } }
      }
      return { job: current }
    }
    return { calls, call }
  }
  const trigger = (enabled: boolean, state: Record<string, unknown> = {}) => ({
    id: 't1', name: 'PR comments', enabled, state,
    schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'bash a.sh', host: '__local__' },
  })

  it('pause PATCHes enabled:false once and reports the new state', async () => {
    const s = server(trigger(true))
    const out = await getOp('trigger_pause')!.handler!({ id: 't1' }, s.call) as Record<string, unknown>
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /routines/t1', 'PATCH /routines/t1'])
    expect(s.calls[1].body).toEqual({ enabled: false })
    expect(out).toMatchObject({ id: 't1', state: 'paused', changed: true })
    expect(String(out.outcome)).toContain('stays on the task as Paused')
  })

  it('pausing a paused trigger changes nothing, and a stopped one says why it is off', async () => {
    const s = server(trigger(false, { pausedAtMs: 1 }))
    const out = await getOp('trigger_pause')!.handler!({ id: 't1' }, s.call) as Record<string, unknown>
    expect(s.calls.map((c) => c.method)).toEqual(['GET'])
    expect(out).toMatchObject({ state: 'paused', changed: false })
    const stoppedSrv = server(trigger(false, { consecutiveErrors: 5 }))
    const stoppedOut = await getOp('trigger_pause')!.handler!({ id: 't1' }, stoppedSrv.call) as Record<string, unknown>
    expect(stoppedOut).toMatchObject({ state: 'stopped', changed: false })
    expect(String(stoppedOut.outcome)).toContain('kept failing')
  })

  it('resume PATCHes enabled:true, and resuming a running trigger is a no-op', async () => {
    const s = server(trigger(false, { pausedAtMs: 1 }))
    const out = await getOp('trigger_resume')!.handler!({ id: 't1' }, s.call) as Record<string, unknown>
    expect(s.calls[1]).toMatchObject({ method: 'PATCH', path: '/routines/t1', body: { enabled: true } })
    expect(out).toMatchObject({ state: 'armed', changed: true })
    expect(String(out.outcome)).toContain('every 5m')
    const again = server(trigger(true))
    expect(await getOp('trigger_resume')!.handler!({ id: 't1' }, again.call)).toMatchObject({ changed: false })
    expect(again.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses a plain scheduled routine and surfaces an unknown id', async () => {
    const plain = server({ id: 'r1', name: 'Morning digest', enabled: true, state: {}, schedule: { kind: 'every', everyMs: 60_000 } })
    await expect(getOp('trigger_pause')!.handler!({ id: 'r1' }, plain.call)).rejects.toThrow(/not a trigger/)
    expect(plain.calls.map((c) => c.method)).toEqual(['GET'])
    await expect(getOp('trigger_resume')!.handler!({ id: 'nope' }, server(null).call)).rejects.toThrow(/not found/)
  })

  it('tells the model what resume does with what appeared while paused', () => {
    for (const name of ['trigger_pause', 'trigger_resume']) {
      const op = getOp(name)!
      expect(op.description).toMatch(/arrives as ONE fire/)
      expect(op.tags).toMatchObject({ readonly: false, destructive: false })
    }
  })
})
