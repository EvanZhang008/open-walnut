/**
 * The four board ops (src/ops/boards.ts) against a stub transport: which route
 * each one reaches, how the board task defaults to the caller's own task
 * (GET /me) and how a worker names its leader instead, and what each outcome says.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface Seen { method: Method; path: string; body?: unknown }
interface Spoken { outcome: string; next: string; [key: string]: unknown }

const ME = { kind: 'worker', task: { id: 'lead01', title: 'Bakery launch' } }
const BOARD = {
  board: { html: '<html>x</html>', version: 3, updated_at: '2026-10-01T10:00:00.000Z', updated_by: 'task:lead01' },
  threads: { 'area-a': [{ id: 'bm-1', author: 'user', text: 'Why red?', ts: '2026-10-01T09:00:00.000Z' }, { id: 'bm-2', author: 'task:lead01', text: 'Because.', ts: '2026-10-01T09:05:00.000Z' }], 'area-b': [] },
  marks: { 'area-a': { state: 'revisit', updated_at: '2026-10-01T09:30:00.000Z' } },
  refs: [{ id: 'w1', title: 'Menu page', phase: 'TODO', status: 'todo' }],
}

function run(name: string, reply: (method: Method, path: string, body?: unknown) => unknown) {
  const op = getOp(name)
  if (!op?.handler) throw new Error(`${name} must declare a handler`)
  const seen: Seen[] = []
  const call = async (method: Method, path: string, body?: unknown) => {
    seen.push({ method, path, body })
    return reply(method, path, body)
  }
  return {
    seen,
    paths: () => seen.map((c) => `${c.method} ${c.path}`),
    speak: async (args: Record<string, unknown>) => await op.handler!(args, call) as Spoken,
  }
}

const server = (over: Record<string, unknown> = {}) => (method: Method, path: string) => {
  if (path === '/me') return ME
  if (method === 'GET') return over.get ?? BOARD
  if (method === 'PUT') return { board: { ...BOARD.board, version: 4 } }
  if (path.endsWith('/edits')) return { board: { ...BOARD.board, version: 5 } }
  if (path.includes('/threads/')) return { message: { id: 'bm-9', author: 'task:lead01', text: 'ok', ts: 'now' }, delivery: { state: 'stored' } }
  return {}
}

describe('board ops', () => {
  it('board_get reads the caller\'s own board by default and sums up what is on it', async () => {
    const r = run('board_get', server())
    const got = await r.speak({})
    expect(r.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board'])
    expect(got.outcome).toBe('Board of lead01: version 3, 2 threads (1 message from the user), 1 mark, 14 chars of html, last written 2026-10-01T10:00:00.000Z by task:lead01.')
    expect(got.next).toMatch(/board_edit.*board_post/)
    expect(got.task_id).toBe('lead01')
    expect(got.refs).toEqual(BOARD.refs)
  })

  it('a worker names its leader and skips the /me lookup', async () => {
    const r = run('board_get', server())
    await r.speak({ task: 'lead01' })
    expect(r.paths()).toEqual(['GET /tasks/lead01/board'])
  })

  it('board_get with no board points at the skill', async () => {
    const r = run('board_get', server({ get: { board: null, threads: {}, marks: {}, refs: [] } }))
    const got = await r.speak({})
    expect(got.outcome).toBe('Task lead01 has no board yet.')
    expect(got.next).toContain('skill_read \'{"dirName":"walnut-board"}\'')
    expect(got.next).toContain('board_set')
  })

  it('board_get fails plainly when the caller has no task and named none', async () => {
    const r = run('board_get', (m, p) => (p === '/me' ? { kind: 'human' } : BOARD))
    await expect(r.speak({})).rejects.toThrow(/pass task/)
  })

  it('board_set PUTs the whole html, forwarding a version only when given', async () => {
    const r = run('board_set', server())
    const got = await r.speak({ html: '<html>new</html>' })
    expect(r.seen[1]).toEqual({ method: 'PUT', path: '/tasks/lead01/board', body: { html: '<html>new</html>' } })
    expect(got.outcome).toBe('Board of lead01 written: version 4, 16 chars. The user sees it on the Board tab.')
    const v = run('board_set', server())
    await v.speak({ task: 'lead01', html: '<p>', version: 3 })
    expect(v.seen[0].body).toEqual({ html: '<p>', version: 3 })
  })

  it('board_edit posts the replacements in order and reports the new version', async () => {
    const r = run('board_edit', server())
    const edits = [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }]
    const got = await r.speak({ edits })
    expect(r.seen[1]).toEqual({ method: 'POST', path: '/tasks/lead01/board/edits', body: { edits } })
    expect(got.outcome).toBe('Board of lead01 updated: 2 edits, now version 5.')
  })

  it('board_post lands in the named thread and asks for the matching board edit', async () => {
    const r = run('board_post', server())
    const got = await r.speak({ thread: 'area a/b', text: 'Fixed.' })
    expect(r.seen[1]).toEqual({ method: 'POST', path: '/tasks/lead01/board/threads/area%20a%2Fb', body: { text: 'Fixed.' } })
    expect(got.outcome).toBe('Posted in thread "area a/b" of lead01\'s board.')
    expect(got.next).toMatch(/board_edit/)
    expect(got.delivery).toEqual({ state: 'stored' })
  })

  it('tags: board_get is read-only, the writers are primary-only and remote-allowed', () => {
    expect(getOp('board_get')!.tags).toMatchObject({ readonly: true, remote: 'allow' })
    for (const n of ['board_set', 'board_edit', 'board_post']) {
      expect(getOp(n)!.tags, n).toMatchObject({ readonly: false, remote: 'allow', primaryOnly: true })
    }
  })
})
