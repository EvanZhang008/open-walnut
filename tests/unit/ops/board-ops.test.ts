/**
 * The board ops (src/ops/boards.ts) against a stub transport: which route
 * each one reaches, how the board task defaults to the team's shared board
 * (GET /me, then GET /tasks/<own>/board/owner) and how naming a task skips
 * both, and what each outcome says.
 */
import { describe, it, expect } from 'vitest'
import { getOp, listOps } from '../../../src/ops/index.js'

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

const OWN = { task_id: 'lead01', title: 'Bakery launch', self: true, has_board: true }
const server = (over: Record<string, unknown> = {}) => (method: Method, path: string) => {
  if (path === '/me') return ME
  if (path.endsWith('/board/owner')) return over.owner ?? OWN
  if (method === 'GET') return over.get ?? BOARD
  if (path.includes('/projects/')) return { project: { status: 'wip', tasks: ['w1', 'w2', 'w3'], updated_at: 'now', updated_by: 'task:lead01' } }
  if (path.includes('/reminders/')) return { reminder: { at: '2026-10-02T16:00:00.000Z', set_at: 'now', set_by: 'task:lead01' } }
  if (method === 'DELETE') return { message: { id: 'bm-2', author: 'task:lead01', text: 'Because.', ts: '2026-10-01T09:05:00.000Z' } }
  if (method === 'PUT') return { board: { ...BOARD.board, version: 4 } }
  if (path.endsWith('/edits')) return { board: { ...BOARD.board, version: 5 } }
  if (path.includes('/threads/')) return { message: { id: 'bm-9', author: 'task:lead01', text: 'ok', ts: 'now' }, delivery: { state: 'stored' } }
  return {}
}

describe('board ops', () => {
  it('board_get reads the caller\'s own board by default and sums up what is on it', async () => {
    const r = run('board_get', server())
    const got = await r.speak({})
    expect(r.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board/owner', 'GET /tasks/lead01/board'])
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
    expect(r.seen[2]).toEqual({ method: 'PUT', path: '/tasks/lead01/board', body: { html: '<html>new</html>' } })
    expect(got.outcome).toBe('Board of lead01 written: version 4, 16 chars. The user sees it on the Board tab.')
    const v = run('board_set', server())
    await v.speak({ task: 'lead01', html: '<p>', version: 3 })
    expect(v.seen[0].body).toEqual({ html: '<p>', version: 3 })
  })

  it('board_edit posts the replacements in order and reports the new version', async () => {
    const r = run('board_edit', server())
    const edits = [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }]
    const got = await r.speak({ edits })
    expect(r.seen[2]).toEqual({ method: 'POST', path: '/tasks/lead01/board/edits', body: { edits } })
    expect(got.outcome).toBe('Board of lead01 updated: 2 edits, now version 5.')
  })

  it('board_post lands in the named thread, names the new message id, and asks for the matching board edit', async () => {
    const r = run('board_post', server())
    const got = await r.speak({ thread: 'area a/b', text: 'Fixed.' })
    expect(r.seen[2]).toEqual({ method: 'POST', path: '/tasks/lead01/board/threads/area%20a%2Fb', body: { text: 'Fixed.' } })
    expect(got.outcome).toBe('Posted bm-9 in thread "area a/b" of lead01\'s board.')
    expect(got.next).toMatch(/board_edit/)
    expect(got.delivery).toEqual({ state: 'stored' })
    expect(getOp('board_post')!.input.text.description).toMatch(/light markdown \(bold, italic, `code`, lists, code blocks, quotes, links\)/)
  })

  it('board_post_delete DELETEs the message on the caller\'s own board by default and names what went', async () => {
    const r = run('board_post_delete', server())
    const got = await r.speak({ thread: 'area a/b', id: 'bm-2' })
    expect(r.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board/owner', 'DELETE /tasks/lead01/board/threads/area%20a%2Fb/messages/bm-2'])
    expect(r.seen[2].body).toBeUndefined()
    expect(got.outcome).toBe('Deleted bm-2 from thread "area a/b" of lead01\'s board.')
    expect(got.message).toMatchObject({ id: 'bm-2' })
    expect(got.task_id).toBe('lead01')
    // A worker names its leader's board and skips the /me lookup.
    const w = run('board_post_delete', server())
    await w.speak({ task: 'lead01', thread: 'area-a', id: 'bm-2' })
    expect(w.paths()).toEqual(['DELETE /tasks/lead01/board/threads/area-a/messages/bm-2'])
  })

  it('a worker\'s default is its team\'s board: the owner from /board/owner, named as shared in every outcome', async () => {
    const LEADER = { task_id: 'boss01', title: 'Bakery lead', self: false, has_board: true }
    const get = run('board_get', server({ owner: LEADER }))
    const got = await get.speak({})
    expect(get.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board/owner', 'GET /tasks/boss01/board'])
    expect(got.task_id).toBe('boss01')
    expect(got.outcome).toMatch(/^Board of boss01 \(your leader's, shared with your team\): version 3/)
    const post = run('board_post', server({ owner: LEADER }))
    expect((await post.speak({ thread: 'area-a', text: 'Done.' })).outcome)
      .toBe('Posted bm-9 in thread "area-a" of boss01\'s board (your leader\'s, shared with your team).')
    expect(post.seen[2].path).toBe('/tasks/boss01/board/threads/area-a')
    const set = run('board_set', server({ owner: LEADER }))
    expect((await set.speak({ html: '<p>' })).outcome).toMatch(/^Board of boss01 \(your leader's, shared with your team\) written/)
    for (const name of ['board_edit', 'board_post_delete', 'board_project_set', 'board_remind']) {
      const r = run(name, server({ owner: LEADER }))
      const args = { board_edit: { edits: [{ old: 'a', new: 'b' }] }, board_post_delete: { thread: 't', id: 'bm-2' },
        board_project_set: { id: 'p', status: 'wip' }, board_remind: { target: 't', at: '2026-10-02T16:00:00.000Z' } }[name]!
      await r.speak(args)
      expect(r.seen[2].path, name).toMatch(/^\/tasks\/boss01\/board/)
    }
  })

  it('an owner lookup that fails falls back to the caller\'s own task', async () => {
    const r = run('board_get', (m, p) => {
      if (p === '/me') return ME
      if (p.endsWith('/owner')) throw new Error('404')
      return BOARD
    })
    const got = await r.speak({})
    expect(r.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board/owner', 'GET /tasks/lead01/board'])
    expect(got.outcome).toMatch(/^Board of lead01: /)
  })

  it('board_get sums up projects by status, read ticks, answered choices and reminders', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const r = run('board_get', server({
      get: {
        ...BOARD,
        projects: {
          'cause-a': { status: 'decide' }, 'cause-b': { status: 'wip', status_by: 'human' }, 'cause-c': { status: 'wip' },
          'cause-d': { status: 'done' }, 'cause-e': { title: 'No status yet' },
        },
        checks: {
          f1: { hash: 'a', read: true }, f2: { hash: 'b', read: true }, f3: { hash: 'c', read: false, changed: true }, f4: { hash: 'd', read: false },
        },
        choices: { when: { option: 'now', label: 'Run it now' }, rollout: { option: 'b' } },
        reminders: { when: { at: '2026-10-01T09:00:00.000Z', fired_at: '2026-10-01T09:00:01.000Z' }, 'area-a': { at: soon } },
      },
    }))
    const got = await r.speak({ task: 'lead01' })
    expect(got.outcome).toContain(' 5 projects: 1 decide, 2 wip, 1 done, 1 without a status. The user set cause-b to wip.')
    expect(got.outcome).toContain(' 2 of 4 points read, 1 changed since read.')
    expect(got.outcome).toContain(' 2 choices answered: when "Run it now"; rollout "b".')
    expect(got.outcome).toContain(` Reminders: 1 due (when), 1 pending (area-a at ${soon}).`)
    expect(got.next).toMatch(/^A reminder the user set is due on when: raise it with the user now\. Keep it current/)
    // The payload keeps the full maps.
    expect(got.checks).toMatchObject({ f3: { changed: true } })
    expect(got.choices).toMatchObject({ when: { label: 'Run it now' } })
  })

  it('board_project_set PUTs only the fields given and names status and task count; a removed one says so', async () => {
    const r = run('board_project_set', server())
    const got = await r.speak({ id: 'cause a', status: 'wip', tasks: ['w1', 'w2', 'w3'] })
    expect(r.seen[2]).toEqual({ method: 'PUT', path: '/tasks/lead01/board/projects/cause%20a', body: { status: 'wip', tasks: ['w1', 'w2', 'w3'] } })
    expect(got.outcome).toBe('Project "cause a" of lead01\'s board: wip, 3 tasks.')
    expect(got.next).toMatch(/recolors on its own/)
    const d = run('board_project_set', (m, p) => (p === '/me' ? ME : p.endsWith('/owner') ? OWN : { project: null }))
    const gone = await d.speak({ id: 'cause-a', delete: true })
    expect(d.seen[2].body).toEqual({ delete: true })
    expect(gone.outcome).toBe('Project "cause-a" removed from lead01\'s board.')
    expect(getOp('board_project_set')!.description).toMatch(/NOT a Walnut project/)
    // A status the user picked is replaced only on purpose: override_user rides along, false is left out.
    const o = run('board_project_set', server())
    await o.speak({ id: 'cause-a', status: 'done', override_user: true })
    expect(o.seen[2].body).toEqual({ status: 'done', override_user: true })
    const k = run('board_project_set', server())
    await k.speak({ id: 'cause-a', status: 'done', override_user: false })
    expect(k.seen[2].body).toEqual({ status: 'done' })
    expect(getOp('board_project_set')!.description).toMatch(/stays theirs: changing or removing it is refused unless you pass override_user: true/)
  })

  it('board_remind sets with an ISO time and clears with ""', async () => {
    const r = run('board_remind', server())
    const got = await r.speak({ task: 'lead01', target: 'when', at: '2026-10-02T16:00:00.000Z', note: 'after the deploy' })
    expect(r.seen[0]).toEqual({ method: 'PUT', path: '/tasks/lead01/board/reminders/when', body: { at: '2026-10-02T16:00:00.000Z', note: 'after the deploy' } })
    expect(got.outcome).toBe('Reminder on "when" of lead01\'s board set for 2026-10-02T16:00:00.000Z.')
    expect(got.next).toMatch(/Walnut tells you in this session/)
    const c = run('board_remind', (m, p) => ({ reminder: null, p }))
    const cleared = await c.speak({ task: 'lead01', target: 'when', at: '' })
    expect(c.seen[0].body).toEqual({ at: null })
    expect(cleared.outcome).toBe('Reminder on "when" of lead01\'s board cleared.')
  })

  it('the board ops are exactly these: none writes the user\'s read ticks, choices or sections seen', () => {
    expect(listOps().map((op) => op.name).filter((n) => n.startsWith('board_')).sort()).toEqual([
      'board_edit', 'board_get', 'board_post', 'board_post_delete', 'board_project_set', 'board_remind', 'board_set',
    ])
  })

  it('tags: board_get is read-only, the writers are primary-only and remote-allowed', () => {
    expect(getOp('board_get')!.tags).toMatchObject({ readonly: true, remote: 'allow' })
    for (const n of ['board_set', 'board_edit', 'board_post', 'board_post_delete', 'board_project_set', 'board_remind']) {
      expect(getOp(n)!.tags, n).toMatchObject({ readonly: false, remote: 'allow', primaryOnly: true })
    }
  })
})
