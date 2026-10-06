/**
 * The kanban ops (src/ops/board-kanban-ops.ts) and the G19 lines in ops the
 * leader already reads (task_create, board_get), against a stub transport:
 * which route each reaches, that the board defaults to the team board, the
 * 409 message passed through, override_user, and that nothing is added when
 * the owner has no board (C41, C79).
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'
import { TRIAGE_LANES } from '../../../src/core/boards/board-lanes.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface Seen { method: Method; path: string; body?: unknown }
interface Spoken { outcome: string; next: string; [key: string]: unknown }
type Reply = (method: Method, path: string, body?: unknown) => unknown

function run(name: string, reply: Reply) {
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

const ME = { kind: 'worker', task: { id: 'lead01', title: 'Payments resolver group' } }
const OWN = { task_id: 'lead01', title: 'Payments resolver group', self: true, has_board: true }
const KANBAN = { lanes_effective: TRIAGE_LANES, cards: {}, team: [{ id: 'w1', phase: 'IN_PROGRESS' }] }
const REFUSED = 'Walnut API error (status_set_by_user): The user placed this card in "Waiting on CR" at 2026-10-04T08:00:00.000Z. '
  + 'Leave lane out to keep their pick, or pass override_user: true to replace it. '
  + 'Your suggestion to move it to "Mitigating" was recorded on the card; the user can accept it.'

function server(opts: { refuse?: boolean } = {}): Reply {
  return (method, path, body) => {
    if (path === '/me') return ME
    if (path.endsWith('/board/owner')) return OWN
    if (path.endsWith('?fields=kanban')) return KANBAN
    if (path.includes('/cards/')) {
      const b = body as Record<string, unknown>
      if (opts.refuse && b.lane && !b.override_user) throw new Error(REFUSED)
      return { card: { lane: b.lane ?? 'investigating', summary: b.summary }, lane_effective: b.lane ?? 'investigating' }
    }
    if (path.endsWith('/lanes')) {
      if (opts.refuse && !(body as Record<string, unknown>).override_user) {
        throw new Error('Walnut API error (status_set_by_user): The user set this board\'s lanes at 2026-10-04T08:00:00.000Z.')
      }
      return { lanes: (body as { lanes: unknown[] }).lanes, cards_unplaced: ['w2'] }
    }
    throw new Error(`unexpected call: ${method} ${path}`)
  }
}

describe('board_card_set (C41)', () => {
  it('writes the card on the team board by default and names the new lane', async () => {
    const r = run('board_card_set', server())
    const got = await r.speak({ card: 'w1', lane: 'mitigating', summary: 'Refund job stuck on one shard' })
    expect(r.paths()).toEqual(['GET /me', 'GET /tasks/lead01/board/owner', 'PUT /tasks/lead01/board/cards/w1',
      'GET /tasks/lead01/board?fields=kanban'])
    expect(r.seen[2].body).toEqual({ lane: 'mitigating', summary: 'Refund job stuck on one shard' })
    expect(got.outcome).toBe('Card w1 on lead01\'s board is in "Mitigating"; summary set.')
    expect(got.next).toContain('worker reports')
  })

  it('a refused lane passes the 409 message through; override_user replaces the user\'s pick', async () => {
    const r = run('board_card_set', server({ refuse: true }))
    await expect(r.speak({ task_id: 'lead01', card: 'w1', lane: 'mitigating' })).rejects.toThrow(REFUSED)
    expect(r.paths()).toEqual(['PUT /tasks/lead01/board/cards/w1'])
    const over = await r.speak({ task: 'lead01', card: 'w1', lane: 'mitigating', override_user: true })
    expect(r.seen.at(-2)!.body).toEqual({ lane: 'mitigating', override_user: true })
    expect(over.outcome).toBe('Card w1 on lead01\'s board is in "Mitigating".')
  })

  it('describes when to use it and the override_user rule', () => {
    const d = getOp('board_card_set')!.description
    expect(d).toContain('Keep every worker\'s card current')
    expect(d).toContain('a card the user placed keeps their lane unless override_user')
  })
})

describe('board_lanes_set (C41)', () => {
  it('success, refusal and override', async () => {
    const lanes = [{ name: 'Open', kind: 'todo' }, { name: 'Done', kind: 'done' }]
    const ok = await run('board_lanes_set', server()).speak({ task: 'lead01', lanes })
    expect(ok.outcome).toBe('Lanes of lead01\'s board: Open, Done. 1 card lost a deleted lane and went back to automatic placement.')
    const r = run('board_lanes_set', server({ refuse: true }))
    await expect(r.speak({ task: 'lead01', lanes })).rejects.toThrow(/status_set_by_user.*The user set this board's lanes/)
    const over = await r.speak({ task: 'lead01', lanes, override_user: true })
    expect(r.seen.at(-1)!.body).toEqual({ lanes, override_user: true })
    expect(over.outcome).toContain('Open, Done')
    const d = getOp('board_lanes_set')!.description
    expect(d).toContain('Only when the team\'s process really differs from the template')
    expect(d).toContain('a session\'s write over theirs is refused unless override_user')
  })
})

describe('the card lines in ops the leader already reads (C79)', () => {
  const created = { task: { id: 'w9', title: 'V1000000140 checkout latency' }, placement: { project: 'acme', parent_task_id: 'lead01' } }
  const createServer = (hasBoard: boolean): Reply => (method, path) => {
    if (method === 'POST' && path === '/tasks') return created
    if (path === '/tasks/lead01/board/owner') return { ...OWN, has_board: hasBoard, task_id: hasBoard ? 'lead01' : 'root01' }
    if (path === '/tasks/lead01/board?fields=kanban') return { ...KANBAN, team: [...KANBAN.team, { id: 'w9', phase: 'TODO' }] }
    throw new Error(`unexpected call: ${method} ${path}`)
  }

  it('task_create: a direct subtask of an owner with a board hears where its card is; none without a board', async () => {
    const withBoard = await run('task_create', createServer(true)).speak({ title: 'V1000000140 checkout latency', record_only: true })
    expect(withBoard.outcome).toContain('Its card is in New on your Board; keep it current with board_card_set (summary, lane, waiting_on).')
    const without = await run('task_create', createServer(false)).speak({ title: 'V1000000140 checkout latency', record_only: true })
    expect(without.outcome).not.toContain('board_card_set')
    expect(without.outcome).not.toContain('Its card')
  })

  it('task_create: a board that belongs to a grandparent (not the direct parent) adds nothing', async () => {
    const r = run('task_create', (method, path) => {
      if (method === 'POST' && path === '/tasks') return created
      if (path === '/tasks/lead01/board/owner') return { task_id: 'root01', has_board: true, self: false }
      throw new Error(`unexpected call: ${method} ${path}`)
    })
    expect((await r.speak({ title: 'x', record_only: true })).outcome).not.toContain('board_card_set')
  })

  it('board_get: a cards line on a board, none when the owner has no board', async () => {
    const body = {
      board: { html: '<h1>x</h1>', version: 2, updated_at: '2026-10-04T08:00:00.000Z', updated_by: 'task:lead01' },
      threads: {}, marks: {}, refs: [],
      cards: { w1: { summary: 'Has one', lane_suggested: { lane: 'mitigating', by: 'lead01', at: 'now' } }, gone: { lane_suggested: {} } },
      team: [{ id: 'w1', phase: 'IN_PROGRESS' }, { id: 'w2', phase: 'NEED_ACTION' }, { id: 'w3', phase: 'COMPLETE' }],
    }
    const got = await run('board_get', (m, p) => (p === '/tasks/lead01/board' ? body : OWN)).speak({ task: 'lead01' })
    expect(got.outcome).toContain('cards: 2 open, 1 with no summary from you, 1 suggestion the user has not answered.')
    const none = await run('board_get', () => ({ board: null, threads: {}, marks: {}, refs: [], cards: {}, team: body.team }))
      .speak({ task: 'lead01' })
    expect(none.outcome).toBe('Task lead01 has no board yet.')
    // A card write made the file, nobody wrote a page: no "0 chars of html", and the next step is a first page.
    const pageless = await run('board_get', (m, p) => (p === '/tasks/lead01/board'
      ? { ...body, board: { ...body.board, html: '', version: 0 } } : OWN)).speak({ task: 'lead01' })
    expect(pageless.outcome).toBe('The board of lead01 has no page yet, only its kanban cards. cards: 2 open, 1 with no summary from you, 1 suggestion the user has not answered.')
    expect(pageless.outcome).not.toContain('chars of html')
    expect(pageless.next).toContain('board_set')
  })
})
