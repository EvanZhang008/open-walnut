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
