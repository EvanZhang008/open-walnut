/**
 * task_history pages back (src/ops/work.ts). 2026-11-03: a lead asked to find what the user had said
 * in a task the night before read only the newest 193 rows (`truncated: true`) and had no way to ask
 * for older ones, though the transcript route pages with `before`; the task's own session had
 * compacted the same night away.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { olderPage, isPageMiss } from '../../src/ops/work.js'

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
    expect(paths).toContain('/sessions/s-1/transcript?fresh=1&ids=1')
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
    expect(paths).toContain(`/sessions/s-1/transcript?ids=1&before=${encodeURIComponent('2026-11-03T08:51:17.309Z')}&wait=15000`)
    expect(out.older).toBeUndefined()
    expect(olderPage('t-1', { truncated: true, messages: [] })).toEqual({})
  })

  it('before must be a time', () => {
    expect(op().input.before.safeParse('last night').success).toBe(false)
    expect(op().input.before.safeParse('2026-11-02T20:04:06.418Z').success).toBe(true)
    expect(op().description).toContain('older.before')
  })
})

/** The route's 503 for an older page it could not build in time, as the executor throws it. */
function pageMiss(): Error {
  return Object.assign(new Error('Walnut API error (page_unavailable): The session could not be read in time; retry shortly'),
    { status: 503, code: 'page_unavailable', retryAfterMs: 1000 })
}

describe('task_history asks once more for an older page that missed its deadline', () => {
  // 2026-11-19 20:10Z: an agent paging 110 tasks back 8 at a time got this 503 on 36 of them
  // and lost their history; the route keeps the late build for the retry (transcript-page-share.ts).
  const page = { truncated: false, messages: [{ role: 'user', text: 'kept', timestamp: '2026-11-19T10:00:00.000Z' }] }
  const caller = (fails: number, paths: string[]): Call => {
    let left = fails
    return async (_m, path) => {
      paths.push(path)
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      if (left-- > 0) throw pageMiss()
      return page
    }
  }

  it('one miss, then the kept page answers', async () => {
    const paths: string[] = []
    const out = await run({ id: 't-1', before: '2026-11-19T16:00:00Z' }, caller(1, paths))
    expect(out.messages).toEqual(page.messages)
    expect(paths.filter((p) => p.includes('/transcript')).length).toBe(2)
  })

  it('a second miss is the answer: no third try', async () => {
    const paths: string[] = []
    await expect(run({ id: 't-1', before: '2026-11-19T16:00:00Z' }, caller(2, paths))).rejects.toThrow('page_unavailable')
    expect(paths.filter((p) => p.includes('/transcript')).length).toBe(2)
  })

  it('only that 503 is retried', async () => {
    expect(isPageMiss(pageMiss())).toBe(true)
    expect(isPageMiss(Object.assign(new Error('x'), { status: 503, code: 'host_reconnecting' }))).toBe(false)
    expect(isPageMiss(Object.assign(new Error('x'), { status: 404, code: 'page_unavailable', retryAfterMs: 1000 }))).toBe(false)
    // A page that could not be read (its build failed) or a primary out of reach: a retry does not help.
    expect(isPageMiss(Object.assign(new Error('x'), { status: 503, code: 'page_unavailable' }))).toBe(false)
    const paths: string[] = []
    const gone: Call = async (_m, path) => {
      paths.push(path)
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' })
    }
    await expect(run({ id: 't-1', before: '2026-11-19T16:00:00Z' }, gone)).rejects.toThrow('not found')
    expect(paths.filter((p) => p.includes('/transcript')).length).toBe(1)
  })
})

describe('the retry stays inside task_history\'s own budget', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a retry that hangs gives back the first miss within the budget', async () => {
    vi.useFakeTimers()
    let reads = 0
    const call: Call = async (_m, path) => {
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      reads++
      if (reads === 1) { await new Promise((r) => setTimeout(r, 5_000)); throw pageMiss() }
      return new Promise(() => {})
    }
    const out = run({ id: 't-1', before: '2026-11-19T16:00:00Z' }, call)
    const settled = out.then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)
    // What is left of the 18 s budget, then the first miss is the answer.
    await vi.advanceTimersByTimeAsync(13_000)
    expect(await settled).toContain('page_unavailable')
  })

  it('with under a second left, no retry', async () => {
    vi.useFakeTimers()
    let reads = 0
    const call: Call = async (_m, path) => {
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      reads++
      await new Promise((r) => setTimeout(r, 17_500))
      throw pageMiss()
    }
    const settled = run({ id: 't-1', before: '2026-11-19T16:00:00Z' }, call).then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(17_500)
    expect(await settled).toContain('page_unavailable')
    expect(reads).toBe(1)
  })
})

describe('an older page asks the route to wait for it', () => {
  it('task_history sends wait with before; the phone\'s plain read does not', async () => {
    const paths: string[] = []
    await run({ id: 't-1', before: '2026-11-19T16:00:00Z', since: '2026-11-19T04:00:00Z', limit: 200 }, fakeCall(paths, { truncated: false, messages: [] }))
    const page = paths.find((p) => p.includes('/transcript'))!
    expect(new URLSearchParams(page.split('?')[1]).get('wait')).toBe('15000')
    const plain: string[] = []
    await run({ id: 't-1', fresh: true }, fakeCall(plain, { truncated: false, messages: [] }))
    expect(plain.find((p) => p.includes('/transcript'))).not.toContain('wait=')
  })

  it('the op waits longer than the 10 s default for that', () => {
    expect(op().timeoutMs).toBe(30_000)
  })
})
