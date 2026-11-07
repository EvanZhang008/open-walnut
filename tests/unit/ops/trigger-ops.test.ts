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

  it('refuses an empty description; one left out is for the server to refuse unless a template brings it', () => {
    // A plugin template writes its own description, so the schema cannot require
    // one; the server refuses a scripted trigger without it (tests/e2e/trigger-routines.test.ts).
    expect(schema().safeParse(args).success).toBe(true)
    expect(schema().safeParse({ template: 'mail:new-mail', params: { from: 'a@' } }).success).toBe(true)
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
      .toContain('left as it is (no wait:true); park it with task_update phase=WAITING once only the wait is left')
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

  it('tells the model it parks only with wait:true, never after answering the user, and to use it unasked', () => {
    const op = getOp('trigger_create')!
    expect(op.description).toContain('It does NOT park the task unless you pass wait:true')
    expect(op.description).toContain('never in the turn that answers the user\'s message')
    expect(op.input.wait.description).toMatch(/Default false/)
    expect(op.description).toContain('do not ask the user to watch it')
  })

  it('tells the model to set a short clock itself, and that the default is 4 hours', () => {
    const op = getOp('trigger_create')!
    expect(op.description).toContain('Set wait_until yourself to when you expect the event, kept short')
    expect(op.description).toContain('the clock running out is how you find out')
    expect(op.description).not.toMatch(/3 days/)
    expect(op.input.wait_until.description).toMatch(/Default 4 hours/)
    const update = getOp('task_update')!
    expect(update.description).toContain('Set it to when you expect the event, kept short')
    expect(update.description).toContain('gets 4 hours from now')
    expect(update.input.wait_until.description).toMatch(/4 hours from now/)
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

describe('trigger_list filters, limit and compact rows', () => {
  type Out = {
    count: number; shown?: number; more?: number; hint?: string
    triggers: Array<Record<string, unknown>>; clocks?: unknown[]
  }
  const op = () => getOp('trigger_list')!
  const T0 = Date.parse('2026-11-06T08:00:00Z')
  const job = (id: string, name: string, extra: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
    id, name, enabled: true, schedule: { kind: 'every', everyMs: 300_000 },
    check: { run: `bash ~/.open-walnut/triggers/${id}/check.sh ${'x'.repeat(2000)}`, host: '__local__' },
    executor: { type: 'session', config: { target: `task-${id}` } },
    state, ...extra,
  })
  const checkLog = (n: number, atMs: number) => Array.from({ length: n }, (_, i) => ({
    atMs: atMs - i * 300_000, outcome: 'quiet', reason: 'all-seen', injected: { chars: 4000, preview: 'p'.repeat(4000) },
  }))
  // A registry the size of the 2026-11-06 one: about a hundred triggers, each with a long script and history.
  const many = Array.from({ length: 120 }, (_, i) => job(`t${i}`, i === 77 ? 'VP Ops daily reflection' : `Watch ${i}`,
    { description: `Watches thing ${i}. ${'d'.repeat(600)}`, enabled: i % 4 !== 0 },
    { lastCheck: { atMs: T0 + i * 1000, outcome: 'quiet', reason: 'all-seen' }, checkLog: checkLog(6, T0 + i * 1000),
      fireLog: [{ atMs: T0 - 3_600_000, outcome: 'fired', items: 2, delivery: { status: 'ok' } }], fireCount: 3,
      ...(i % 4 === 0 ? { pausedAtMs: T0 } : {}) }))
  const list = async (args: Record<string, unknown>, jobs: unknown[] = many) =>
    await op().handler!(args, async () => ({ jobs })) as Out

  it('answers short by default: 25 compact rows, newest activity first, with how many were left out', async () => {
    const out = await list({})
    expect(out.count).toBe(120)
    expect(out.triggers).toHaveLength(25)
    expect(out).toMatchObject({ shown: 25, more: 95 })
    expect(out.hint).toMatch(/95 more not shown: narrow with name, task or state/)
    expect(out.triggers[0].id).toBe('t119')
    expect(JSON.stringify(out).length).toBeLessThan(15_000)
    const row = out.triggers[0]
    expect(row).toMatchObject({
      id: 't119', state: 'armed', enabled: true, every: '5m', host: '__local__', task: 'task-t119', fires: 3,
      last: `quiet (all-seen) at ${new Date(T0 + 119_000).toISOString()}`,
      lastFire: `${new Date(T0 - 3_600_000).toISOString()}, 2 items, delivery ok`,
    })
    for (const gone of ['run', 'lastCheck', 'recentChecks']) expect(gone in row).toBe(false)
    expect(String(row.description).length).toBeLessThanOrEqual(160)
  })

  it('name finds one trigger by a piece of its name, id or description, in any case', async () => {
    const out = await list({ name: 'REFLECTION' })
    expect(out.triggers.map((t) => t.id)).toEqual(['t77'])
    expect(out).toMatchObject({ count: 1 })
    expect('more' in out).toBe(false)
    expect((await list({ name: 't77' })).triggers.map((t) => t.id)).toEqual(['t77'])
    expect((await list({ name: 'thing 42.' })).triggers.map((t) => t.id)).toEqual(['t42'])
    const none = await list({ name: 'no such watch' })
    expect(none).toMatchObject({ count: 0, triggers: [] })
    expect(none.hint).toBe('No trigger matches name "no such watch".')
  })

  it('state keeps only armed (or paused, or stopped) triggers', async () => {
    const armed = await list({ state: 'armed', limit: 500 })
    expect(armed.count).toBe(90)
    expect(armed.triggers.every((t) => t.state === 'armed')).toBe(true)
    const paused = await list({ state: 'paused', limit: 500 })
    expect(paused.count).toBe(30)
    expect(paused.triggers.every((t) => t.state === 'paused' && typeof t.pausedAt === 'string')).toBe(true)
    expect((await list({ state: 'stopped' })).count).toBe(0)
    expect(z.object(op().input).strict().safeParse({ state: 'on' }).success).toBe(false)
  })

  it('limit sets the page size and is capped; full brings back the whole row with a shorter page', async () => {
    expect((await list({ limit: 3 })).triggers.map((t) => t.id)).toEqual(['t119', 't118', 't117'])
    expect((await list({ limit: 10_000 })).triggers).toHaveLength(120)
    expect(z.object(op().input).strict().safeParse({ limit: 0 }).success).toBe(false)
    const full = await list({ full: true })
    expect(full.triggers).toHaveLength(5)
    const row = full.triggers[0]
    expect(String(row.run)).toContain('check.sh')
    expect(row.lastCheck).toMatchObject({ outcome: 'quiet' })
    expect((row.recentChecks as unknown[]).length).toBe(6)
    expect(JSON.stringify(row.recentChecks)).not.toContain('preview')
    const one = await list({ name: 'reflection', full: true })
    expect(one.triggers.map((t) => t.id)).toEqual(['t77'])
  })

  it('combines with task: only what wakes the task, filtered and limited the same way', async () => {
    const calls: string[] = []
    const out = await op().handler!({ task: 'lead', state: 'armed', limit: 1 }, async (_m: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/tasks/')) {
        return { root: { id: 'lead', title: 'Lead' }, routines: [
          { id: 't1', target: 'lead', kind: 'trigger' }, { id: 't2', target: 'lead', kind: 'trigger' },
          { id: 't4', target: 'lead', kind: 'trigger' },
        ], clocks: [] }
      }
      return { jobs: many }
    }) as Out
    expect(calls[0]).toBe('/tasks/lead/wake-sources?team=0')
    expect(out).toMatchObject({ count: 2, shown: 1, more: 1 })
    expect(out.triggers[0]).toMatchObject({ id: 't2', kind: 'trigger', target: 'lead' })
    expect('task' in out.triggers[0]).toBe(false)
    expect(out.hint).toMatch(/1 more not shown/)
    expect(out.hint).toMatch(/team_stop/)
  })

  it('writes the last check as one line for a fire, a quiet check and an error', async () => {
    const at = Date.parse('2026-11-07T01:02:03Z')
    const jobs = [
      job('f', 'F', {}, { lastCheck: { atMs: at, outcome: 'fired', items: 1, retryPending: true } }),
      job('e', 'E', {}, { lastCheck: { atMs: at - 1, outcome: 'error', error: `jq: command not found\n${'y'.repeat(400)}` } }),
      job('n', 'N'),
    ]
    const rows = (await list({}, jobs)).triggers
    expect(rows[0].last).toBe('fired 1 item at 2026-11-07T01:02:03.000Z, delivery retrying')
    expect(String(rows[1].last)).toMatch(/^error at 2026-11-07T01:02:02\.999Z: jq: command not found y+…$/)
    expect(String(rows[1].last).length).toBeLessThan(220)
    expect('last' in rows[2]).toBe(false)
    expect('lastFire' in rows[2]).toBe(false)
  })

  it('lastFire is the newest fire by its time, not the head of the log a late fire was put at', async () => {
    const t1 = Date.parse('2026-11-07T01:00:00Z'), t0 = Date.parse('2026-11-07T00:00:00Z')
    // A backlog fire from 00:00 arrived after the 01:00 one, so it heads the log (mergeFireAttempt).
    const late = job('late', 'Late', {}, {
      lastCheck: { atMs: t1, outcome: 'fired', items: 1 },
      fireLog: [{ atMs: t0, outcome: 'fired', items: 4, delivery: { status: 'ok' } }, { atMs: t1, outcome: 'fired', items: 1, delivery: { status: 'ok' } }],
      checkLog: [{ atMs: t0, outcome: 'fired', items: 4 }, { atMs: t1, outcome: 'fired', items: 1 }],
    })
    const row = (await list({}, [late])).triggers[0]
    expect(row.lastFire).toBe('2026-11-07T01:00:00.000Z, 1 item, delivery ok')
  })

  it('a task view puts a plain timed routine by its last run among the triggers, and keeps it inside the limit', async () => {
    const t0 = Date.parse('2026-11-07T00:00:00Z')
    const jobs = [
      job('old', 'Old trigger', {}, { lastCheck: { atMs: t0, outcome: 'quiet', reason: 'fire-false' } }),
      { id: 'cron', name: 'Morning digest', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 },
        executor: { type: 'session', config: { target: 'lead' } }, state: { lastRunAtMs: t0 + 3_600_000 } },
    ]
    const out = await op().handler!({ task: 'lead', limit: 1 }, async (_m: string, path: string) => path.startsWith('/tasks/')
      ? { root: { id: 'lead', title: 'Lead' }, routines: [{ id: 'old', target: 'lead', kind: 'trigger' }, { id: 'cron', target: 'lead', kind: 'routine' }], clocks: [] }
      : { jobs }) as Out
    expect(out).toMatchObject({ count: 2, more: 1 })
    expect(out.triggers[0]).toMatchObject({ id: 'cron', kind: 'routine', lastRunAt: '2026-11-07T01:00:00.000Z' })
  })

  it('tells the model how to find one trigger', () => {
    const d = op().description
    expect(d).toContain('To find one trigger, narrow it')
    expect(d).toContain('state:"armed"')
    expect(d).toContain('full:true')
    expect(Object.keys(op().input).sort()).toEqual(['full', 'limit', 'name', 'state', 'task', 'team'])
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
