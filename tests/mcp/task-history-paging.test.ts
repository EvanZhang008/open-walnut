/**
 * task_history pages back (src/ops/work.ts). 2026-11-03: a lead asked to find what the user had said
 * in a task the night before read only the newest 193 rows (`truncated: true`) and had no way to ask
 * for older ones, though the transcript route pages with `before`; the task's own session had
 * compacted the same night away.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { olderPage } from '../../src/ops/work.js'

type Call = (method: string, path: string) => Promise<unknown>

function fakeCall(paths: string[], page: Record<string, unknown>): Call {
  return async (_method, path) => {
    paths.push(path)
    if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-1', engine: 'claude', active: true }] }
    if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
    return page
  }
}

const op = () => getOp('task_history')!
const run = (input: Record<string, unknown>, call: Call) =>
  (op().handler as (i: Record<string, unknown>, c: Call) => Promise<Record<string, unknown>>)(input, call)

describe('task_history pages back', () => {
  it('a cut conversation says where the page before it starts, and how to read it', async () => {
    const paths: string[] = []
    const out = await run({ id: 't-1', fresh: true }, fakeCall(paths, {
      truncated: true, messages: [{ role: 'assistant', text: 'x', timestamp: '2026-11-03T08:51:17.309Z' }],
    }))
    expect(paths).toContain('/sessions/s-1/transcript?fresh=1')
    expect(out.older).toEqual({
      before: '2026-11-03T08:51:17.309Z',
      how: `walnut tools call task_history '{"id":"t-1","before":"2026-11-03T08:51:17.309Z"}'`,
    })
  })

  it('before reads the page older than it; a whole conversation has no older page', async () => {
    const paths: string[] = []
    const out = await run({ id: 't-1', before: '2026-11-03T08:51:17.309Z' }, fakeCall(paths, {
      truncated: false, messages: [{ role: 'user', text: 'the night before', timestamp: '2026-11-02T20:04:06.418Z' }],
    }))
    expect(paths).toContain(`/sessions/s-1/transcript?before=${encodeURIComponent('2026-11-03T08:51:17.309Z')}`)
    expect(out.older).toBeUndefined()
    expect(olderPage('t-1', { truncated: true, messages: [] })).toEqual({})
  })

  it('before must be a time', () => {
    expect(op().input.before.safeParse('last night').success).toBe(false)
    expect(op().input.before.safeParse('2026-11-02T20:04:06.418Z').success).toBe(true)
    expect(op().description).toContain('older.before')
  })
})
