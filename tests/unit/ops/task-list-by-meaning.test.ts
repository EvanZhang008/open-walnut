/**
 * task_list's `q` matches title words only, so its answer adds `by_meaning`: the OPEN tasks search
 * finds for q by meaning, in any language, that the title filter missed.
 *
 * The real case of 2026-11-16, with neutral data: a lead looked for an owner with
 * task_list q=<a Chinese word>, got only finished tasks with that word in their Chinese titles,
 * and missed the open task titled in English.
 */
import { describe, expect, it } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

// "bakery" in Chinese, as the lead typed it.
const Q = '\u9762\u5305\u5e97'
const OLD = { id: 'mold0001-aaaa', title: `2024 ${Q} menu`, project: 'Design', phase: 'COMPLETE' }
const OPEN = { id: 'mopen001-aaaa', title: 'Logo redesign · Bakery Website Launch', project: 'Design', phase: 'IN_PROGRESS' }
const VP = { id: 'mvp00001-aaaa', title: 'Design VP', project: 'Design', phase: 'IN_PROGRESS', org_role: 'lead' }
const DONE_TOO = { id: 'mdone001-aaaa', title: 'Old bakery menu print', project: 'Design', phase: 'COMPLETE' }

function server(opts: { search?: 'ok' | 'fail' | 'slow' } = {}) {
  const paths: string[] = []
  const call = async (_method: string, path: string): Promise<unknown> => {
    paths.push(path)
    if (path === '/me') return { kind: 'person' }
    if (path.startsWith('/search')) {
      if (opts.search === 'fail') throw new Error('search down')
      if (opts.search === 'slow') await new Promise((r) => setTimeout(r, 6_000))
      return { results: [
        { type: 'task', taskId: OLD.id }, { type: 'memory', title: 'x' },
        { type: 'task', taskId: DONE_TOO.id }, { type: 'task', taskId: VP.id }, { type: 'task', taskId: OPEN.id },
      ] }
    }
    if (path.includes('ids=')) return { tasks: [DONE_TOO, VP, OPEN], total: 3 }
    return { tasks: [OLD], total: 1 }
  }
  return { call, paths }
}

async function list(args: Record<string, unknown>, opts: Parameters<typeof server>[0] = {}) {
  const stub = server(opts)
  const result = await getOp('task_list')!.handler!(args, stub.call) as Record<string, any>
  return { result, paths: stub.paths }
}

describe('task_list q adds the open tasks search finds by meaning', () => {
  it('finds the English-titled open task for a Chinese word, leaving out finished ones, org nodes and title hits', async () => {
    const { result, paths } = await list({ q: Q })
    expect(result.tasks.map((t: { id: string }) => t.id)).toEqual([OLD.id])
    expect(result.by_meaning.map((t: { id: string }) => t.id)).toEqual([OPEN.id])
    expect(result.hint).toContain('q matches title words only; by_meaning lists 1 open task(s)')
    expect(paths.find((p) => p.startsWith('/search'))).toBe(`/search?q=${encodeURIComponent(Q)}&types=task&limit=12&semanticWaitMs=2500`)
  })

  it('no q, no search; a failing search leaves the list as it was', async () => {
    const plain = await list({ project: 'Design' })
    expect(plain.paths.some((p) => p.startsWith('/search'))).toBe(false)
    expect(plain.result.by_meaning).toBeUndefined()
    const failed = await list({ q: Q }, { search: 'fail' })
    expect(failed.result.by_meaning).toBeUndefined()
    expect(failed.result.tasks).toHaveLength(1)
  })

  it('a slow search does not hold the answer past its deadline', async () => {
    const t0 = Date.now()
    const slow = await list({ q: Q }, { search: 'slow' })
    expect(Date.now() - t0).toBeLessThan(5_500)
    expect(slow.result.by_meaning).toBeUndefined()
  }, 10_000)
})
