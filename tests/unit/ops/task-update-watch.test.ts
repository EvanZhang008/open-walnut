/**
 * task_update and task_update_bulk take `watched_at` (src/ops/tasks.ts), so an agent can
 * watch a task the way the user does from the task panel: the field rides the PATCH as
 * is ("" and null stop watching). The handler runs against a recording stub transport.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const DESCRIPTION = 'ISO time to keep the task on the user\'s Watching list at the top of the task panel, "" to stop watching. '
  + 'Changes nothing else (phase, board tier, pin)'

function inputOf(name: string): Record<string, { description?: string; safeParse: (v: unknown) => { success: boolean } }> {
  const op = getOp(name)
  if (!op) throw new Error(`${name} must be registered`)
  return op.input as never
}

describe('task_update watched_at', () => {
  it('declares the field with its description', () => {
    expect(inputOf('task_update').watched_at?.description).toBe(DESCRIPTION)
  })

  it('accepts an ISO time, "" and null', () => {
    const field = inputOf('task_update').watched_at
    expect(field.safeParse('2026-10-29T08:30:00.000Z').success).toBe(true)
    expect(field.safeParse('').success).toBe(true)
    expect(field.safeParse(null).success).toBe(true)
    expect(field.safeParse(42).success).toBe(false)
  })

  it('forwards the value on the PATCH and names the field in the outcome', async () => {
    const op = getOp('task_update')!
    const seen: Array<{ method: Method; path: string; body?: unknown }> = []
    const call = async (method: Method, path: string, body?: unknown) => {
      seen.push({ method, path, body })
      return { task: { id: 't_ab12cd', title: 'Ship the release', phase: 'IN_PROGRESS', watched_at: '2026-10-29T08:30:00.000Z' } }
    }
    const out = await op.handler!({ id: 't_ab12cd', watched_at: '2026-10-29T08:30:00.000Z' }, call as never) as { outcome: string }
    expect(seen).toEqual([{ method: 'PATCH', path: '/tasks/t_ab12cd', body: { watched_at: '2026-10-29T08:30:00.000Z' } }])
    expect(out.outcome).toContain('Task fields updated (watched_at).')

    seen.length = 0
    await op.handler!({ id: 't_ab12cd', watched_at: '' }, call as never)
    expect(seen[0].body).toEqual({ watched_at: '' })
  })
})

describe('task_update_bulk watched_at', () => {
  it('lets one patch of the batch carry watched_at', () => {
    const updates = inputOf('task_update_bulk').updates
    expect(updates.safeParse([{ id: 't_ab12cd', watched_at: '2026-10-29T08:30:00.000Z' }]).success).toBe(true)
    expect(updates.safeParse([{ id: 't_ab12cd', watched_at: '' }]).success).toBe(true)
  })
})
