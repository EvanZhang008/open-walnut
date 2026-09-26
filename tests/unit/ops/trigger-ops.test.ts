/**
 * The trigger ops' description contract (src/ops/triggers.ts): trigger_create
 * refuses a call without one before it reaches the server (the executor
 * validates args with `z.object(op.input).strict()`), and trigger_list hands
 * the description back so an agent answering "what are you watching?" can
 * say what each trigger does, not only its script path.
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
