/**
 * task_history on a slow history source (src/ops/work.ts). 2026-11-12 16:00Z: 16 of 77 tasks read
 * hub_timeout on every try, and `"fresh": false` changed nothing: limit and since still sent fresh=1,
 * so the caller could not ask for the saved copy. The route now answers a slow live read with that
 * copy marked `degraded`; the op passes the mark on with a line the reader understands, never spends
 * another slow read on the page before it, and reads an engine switch's sessions side by side.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { degradedLine, withinMs } from '../../src/ops/work.js'

type Call = (method: string, path: string) => Promise<unknown>

const op = () => getOp('task_history')!
const run = (input: Record<string, unknown>, call: Call) =>
  (op().handler as (i: Record<string, unknown>, c: Call) => Promise<Record<string, unknown>>)(input, call)

function fakeCall(paths: string[], page: (path: string) => Promise<Record<string, unknown>> | Record<string, unknown>, sessions = 1): Call {
  return async (_method, path) => {
    paths.push(path)
    if (path.startsWith('/tasks/t-1/sessions')) {
      return { sessions: Array.from({ length: sessions }, (_, i) => ({ session_id: `s-${i + 1}`, engine: 'claude', active: i === sessions - 1 })) }
    }
    if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: `s-${sessions}` } }
    return page(path)
  }
}

const rows = [
  { role: 'user', text: 'first', timestamp: '2026-11-12T15:00:00.000Z' },
  { role: 'assistant', text: 'reply', timestamp: '2026-11-12T15:01:00.000Z' },
]
const mark = { reason: 'slow_source', savedAt: '2026-11-12T15:50:00.000Z', ageSeconds: 600 }

describe('task_history fresh:false', () => {
  it('reaches the route: no live read for any shape the caller asked for', async () => {
    for (const shape of [{}, { limit: 5 }, { since: '2026-11-12T15:00:30.000Z' }, { limit: 5, since: '2026-11-12T15:00:30.000Z', compact: true }]) {
      const paths: string[] = []
      await run({ id: 't-1', fresh: false, ...shape }, fakeCall(paths, () => ({ truncated: false, messages: rows })))
      const reads = paths.filter((p) => p.startsWith('/sessions/'))
      expect(reads.length, JSON.stringify(shape)).toBeGreaterThan(0)
      for (const p of reads) expect(p, JSON.stringify(shape)).not.toContain('fresh=1')
    }
  })

  it('never reads the page before a cut saved copy either: that page is a live read', async () => {
    const paths: string[] = []
    const out = await run({ id: 't-1', fresh: false, since: '2026-11-12T14:00:00.000Z' },
      fakeCall(paths, () => ({ truncated: true, messages: rows })))
    const reads = paths.filter((p) => p.startsWith('/sessions/'))
    expect(reads).toHaveLength(1)
    expect(reads[0]).not.toMatch(/fresh=1|before=/)
    expect(out.truncated).toBe(true)
  })

  it('unset keeps the live read for limit and since; true always asks for it', async () => {
    const paths: string[] = []
    await run({ id: 't-1', limit: 5 }, fakeCall(paths, () => ({ truncated: false, messages: rows })))
    await run({ id: 't-1', fresh: true }, fakeCall(paths, () => ({ truncated: false, messages: rows })))
    await run({ id: 't-1' }, fakeCall(paths, () => ({ truncated: false, messages: rows })))
    const reads = paths.filter((p) => p.startsWith('/sessions/'))
    expect(reads).toEqual(['/sessions/s-1/transcript?fresh=1&visible=5', '/sessions/s-1/transcript?fresh=1', '/sessions/s-1/transcript'])
  })
})

describe('task_history on a slow source', () => {
  it('passes the saved copy on marked with its age, and spends no read on the page before it', async () => {
    const paths: string[] = []
    // Nothing in the page is at or before `since`, so only the page before it could say what is unread.
    const out = await run({ id: 't-1', limit: 5, since: '2026-11-12T14:00:00.000Z' },
      fakeCall(paths, () => ({ truncated: true, degraded: mark, messages: rows })))
    expect(out.degraded).toEqual(mark)
    expect(out.degraded_note).toContain('saved copy (10 min old')
    expect(paths.filter((p) => p.includes('before='))).toEqual([])
    expect(out.truncated).toBe(true)
  })

  it('a slow check of the page before a cut one ends in time and says older rows may exist', async () => {
    const paths: string[] = []
    const t0 = Date.now()
    const out = await run({ id: 't-1', since: '2026-11-12T14:00:00.000Z' }, fakeCall(paths, (p) => p.includes('before=')
      ? new Promise<Record<string, unknown>>(() => { /* the host never answers */ })
      : { truncated: true, messages: rows }))
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect(out.truncated).toBe(true)
    expect((out.older as { before: string }).before).toBe('2026-11-12T15:00:00.000Z')
  }, 10_000)

  it('all:true reads every session side by side and names the ones served from a saved copy', async () => {
    const paths: string[] = []
    let inFlight = 0
    let most = 0
    const out = await run({ id: 't-1', all: true }, fakeCall(paths, async (p) => {
      inFlight++; most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 50))
      inFlight--
      return p.includes('s-2') ? { degraded: mark, messages: rows } : { messages: rows }
    }, 3))
    expect(most).toBe(3)
    expect(out.degraded).toEqual([{ session_id: 's-2', ...mark }])
    expect(out.degraded_note).toContain('saved copy')
  })

  it('names the age plainly', () => {
    expect(degradedLine([{ reason: 'slow_source', ageSeconds: 30 }])).toContain('30 s old')
    expect(degradedLine([{ reason: 'slow_source', ageSeconds: 7200 }])).toContain('2 h old')
    expect(degradedLine([{ reason: 'source_failed', ageSeconds: null }])).toContain('could not be read')
  })

  it('withinMs answers the fallback when the work is late, the work when it is not', async () => {
    expect(await withinMs(20, new Promise<number>(() => {}), 7)).toBe(7)
    expect(await withinMs(1_000, Promise.resolve(3), 7)).toBe(3)
  })
})
