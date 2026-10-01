/**
 * Unit test: from inside a task, a `task_list` LOOKUP (a title search or a tag) that finds
 * nothing in the caller's folder widens to the project, then the whole board, and says so.
 *
 * The defect this pins: a session asked to find the task carrying `ticket-id:<uuid>` called
 * `task_list {tag}` and got `count: 0`, because the worker default scoped the call to its own
 * folder and the tag lived in another project. A plain listing (no lookup) keeps the folder
 * ring: "what is beside me" must stay the folder.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

const ME = { kind: 'worker', task: { id: 'me-1', title: 'My task', project: 'marina', group_id: 'g_auth', group_label: 'Auth cleanup' } }
const HIT = { id: 'hit-1', title: 'Ticket run', project: 'imports', phase: 'TODO', tags: ['ticket-id:abc'] }

/** A stub server: answers /me, and lists `rowsBy` keyed by the query string it sees. */
function server(rowsBy: Record<string, unknown[]>) {
  const paths: string[] = []
  const call = async (_method: string, path: string) => {
    if (path === '/me') return ME
    paths.push(path)
    const query = path.split('?')[1] ?? ''
    for (const [key, rows] of Object.entries(rowsBy)) {
      if (query.includes(key)) return { tasks: rows, total: rows.length }
    }
    return { tasks: [], total: 0 }
  }
  return { call, paths }
}

async function list(args: Record<string, unknown>, rowsBy: Record<string, unknown[]>) {
  const op = getOp('task_list')
  if (!op?.handler) throw new Error('task_list must have a handler')
  const stub = server(rowsBy)
  const result = await op.handler(args, stub.call) as { count: number; scope?: string; hint?: string; tasks: unknown[] }
  return { result, paths: stub.paths }
}

describe('task_list lookups widen from the caller outwards', () => {
  it('a tag lookup with no hit in the folder tries the project, then the board, and names the widening', async () => {
    const { result, paths } = await list({ tag: 'ticket-id:abc' }, { 'project=': [], 'group_id=': [] , 'tag=': [HIT] })
    // The board query carries neither group_id nor project, so only it matches the last key.
    expect(paths.map((p) => [p.includes('group_id='), p.includes('project=')])).toEqual([[true, false], [false, true], [false, false]])
    expect(result.scope).toBe('all')
    expect(result.count).toBe(1)
    expect(result.hint).toContain('Nothing in your folder matched tag ticket-id:abc')
    expect(result.hint).toContain('the whole board')
  })

  it('stops at the first ring with a hit', async () => {
    const { result, paths } = await list({ q: 'ticket' }, { 'project=': [HIT] })
    expect(paths).toHaveLength(2)
    expect(result.scope).toBe('project')
    expect(result.hint).toContain('your whole project')
  })

  it('a plain listing never widens: an empty folder is the honest answer', async () => {
    const { result, paths } = await list({}, {})
    expect(paths).toHaveLength(1)
    expect(result.scope).toBe('folder')
    expect(result.count).toBe(0)
    expect(result.hint ?? '').not.toContain('Nothing in your')
  })

  it('an explicit scope is never widened', async () => {
    const { result, paths } = await list({ tag: 'ticket-id:abc', scope: 'folder' }, {})
    expect(paths).toHaveLength(1)
    expect(result.scope).toBe('folder')
    expect(result.count).toBe(0)
  })
})
