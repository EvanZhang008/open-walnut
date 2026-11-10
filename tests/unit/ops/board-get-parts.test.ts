/**
 * board_get on a big board (src/ops/boards.ts + board-get-view.ts): the default
 * read answers the whole board while it fits BOARD_GET_BUDGET and a summary
 * past it (2026-11-10: a team board answered 165,884 characters, more than one
 * tool result takes), and `parts` / `thread` / `since` return exactly the
 * parts asked for, the html unclipped so a read-then-edit still works.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'
import { BOARD_GET_BUDGET } from '../../../src/ops/board-get-view.js'

type Body = Record<string, unknown>
interface Spoken { outcome: string; next: string; [key: string]: unknown }

const OWN = { task_id: 'lead01', title: 'Bakery launch', self: true, has_board: true }

async function read(board: Body, args: Body = {}): Promise<Spoken> {
  const op = getOp('board_get')!
  const call = async (_m: string, path: string) => (path.endsWith('/board') ? board : OWN)
  return await op.handler!({ task: 'lead01', ...args }, call as never) as Spoken
}

const SMALL: Body = {
  board_task_id: 'lead01', board_task_title: 'Bakery launch', board_version: 3,
  board: { html: '<h1>Plan</h1><walnut-thread id="area-a" title="Area A"></walnut-thread>', version: 3, updated_at: '2026-10-01T10:00:00.000Z', updated_by: 'task:lead01' },
  threads: { 'area-a': [{ id: 'bm-1', author: 'user', text: 'Why red?', ts: '2026-10-01T09:00:00.000Z' }] },
  marks: {}, projects: {}, checks: {}, choices: {}, reminders: {}, refs: [],
}

/** A board like the one that broke: many projects, threads, kanban cards and team rows. */
function bigBoard(): Body {
  const sections = Array.from({ length: 12 }, (_, i) =>
    `<h2>Area ${i}</h2><section data-project="p${i}"><walnut-thread id="t${i}" title="Thread ${i}"></walnut-thread>${'<p>filler text for the page.</p>'.repeat(40)}</section>`)
  const html = `<!doctype html><html><body><h1>Team board</h1>${sections.join('')}</body></html>`
  const projects = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, {
    title: `Project ${i}`, status: ['decide', 'wip', 'wait', 'done'][i % 4], tasks: [`w${i}`, `w${i + 1}`],
    summary: 'x'.repeat(400), latest: 'y'.repeat(400), ...(i === 0 ? { status_by: 'human' } : {}),
  }]))
  const threads = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, Array.from({ length: 10 }, (_, j) => ({
    id: `bm-${i}-${j}`, author: j % 2 ? 'task:lead01' : 'user', text: `message ${j} of thread ${i} `.repeat(30),
    ts: `2026-10-${String(10 + i).padStart(2, '0')}T09:${String(j).padStart(2, '0')}:00.000Z`,
  }))]))
  const team = Array.from({ length: 200 }, (_, i) => ({ id: `w${i}`, phase: i % 3 ? 'COMPLETE' : 'IN_PROGRESS' }))
  const cards = Object.fromEntries(team.map((t) => [t.id, { lane: 'done', summary: 'z'.repeat(150), summary_at: 'now' }]))
  return {
    board_task_id: 'lead01', board_task_title: 'Bakery launch', board_version: 9,
    board: { html, version: 9, updated_at: '2026-10-20T10:00:00.000Z', updated_by: 'task:lead01' },
    threads, projects, team, cards,
    marks: { 'area-1': { state: 'revisit', note: 'Look again '.repeat(50) } },
    checks: { c1: { hash: 'h1', read: true }, c2: { hash: 'h2', read: false, changed: true } },
    choices: { deploy: { option: 'now', label: 'Run it now', text: 'only after the backup' } },
    reminders: { deploy: { at: '2099-01-01T00:00:00.000Z' } },
    refs: team.slice(0, 30).map((t) => ({ ref: t.id, id: t.id, title: `Task ${t.id}`, phase: t.phase, status: 'x', user: t.phase === 'COMPLETE' ? 'done' : 'working' })),
    lanes_effective: [{ id: 'todo', name: 'To do', kind: 'todo' }, { id: 'done', name: 'Done', kind: 'done' }],
    kanban_seen: { at: 'now', cards: Object.fromEntries(team.map((t) => [t.id, { lane: 'done', summaryHash: 'abcd1234', unread: false }])) },
  }
}

describe('board_get size budget and parts', () => {
  it('a small board answers whole, as before', async () => {
    const got = await read(SMALL)
    expect(got.summarized).toBeUndefined()
    expect(got.board).toEqual(SMALL.board)
    expect(got.threads).toEqual(SMALL.threads)
    expect(got.outcome).toBe('Board of lead01: version 3, 1 thread (1 message from the user), 0 marks, 71 chars of html, last written 2026-10-01T10:00:00.000Z by task:lead01.')
    expect(got.next).toMatch(/board_edit.*board_post/)
  })

  it('a big board answers a summary under the budget, with the counts right and the next calls named', async () => {
    const big = bigBoard()
    expect(JSON.stringify(big).length).toBeGreaterThan(BOARD_GET_BUDGET * 2)
    const got = await read(big)
    expect(JSON.stringify(got).length).toBeLessThanOrEqual(BOARD_GET_BUDGET)
    expect(got.summarized).toBe(true)
    expect(got.board_version).toBe(9)
    expect(got.board).toBeUndefined()
    expect(got.threads).toBeUndefined()
    const s = got.summary as Record<string, Record<string, unknown>>
    expect(s.page).toMatchObject({ version: 9, html_chars: (big.board as { html: string }).html.length, project_sections: 12 })
    expect((s.page.sections as string[])[0]).toBe('# Team board')
    expect(s.page.sections as string[]).toContain('## Area 11')
    expect(s.projects).toMatchObject({ count: 60, by_status: { decide: 15, wip: 15, wait: 15, done: 15 } })
    expect((s.projects.list as Array<Record<string, unknown>>)[0]).toEqual({ id: 'p0', title: 'Project 0', status: 'decide', status_by: 'human', tasks: 2 })
    expect((s.projects.list as unknown[]).length + Number(s.projects.more ?? 0)).toBe(60)
    expect(s.threads).toMatchObject({ count: 12, messages: 120, from_user: 60 })
    const t = (s.threads.list as Array<Record<string, unknown>>)[0]
    expect(t).toMatchObject({ id: 't11', title: 'Thread 11', messages: 10, last_at: '2026-10-21T09:09:00.000Z', last_author: 'task:lead01' })
    expect(String(t.last_text).length).toBeLessThanOrEqual(201)
    expect(s.checks).toEqual({ count: 2, read: 1, changed: 1 })
    expect(s.choices).toMatchObject({ count: 1, list: [{ id: 'deploy', option: 'now', label: 'Run it now', text: 'only after the backup' }] })
    expect(s.marks).toMatchObject({ count: 1 })
    expect(s.tasks).toEqual({ count: 30, by_state: { working: 10, done: 20 } })
    expect(s.kanban).toMatchObject({ team: 200, open: 67, cards: 200, lanes: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] })
    const sizes = got.part_chars as Record<string, number>
    expect(sizes.html).toBe(JSON.stringify(big.board).length)
    expect(sizes.cards).toBe(JSON.stringify(big.cards).length)
    expect(got.full_chars).toBeGreaterThan(BOARD_GET_BUDGET)
    expect(got.outcome).toContain('this is a summary')
    expect(got.next).toContain(`board_get {"task":"lead01","parts":["html"]}`)
    expect(got.next).toContain(`board_get {"task":"lead01","parts":["threads"],"thread":"<id>"}`)
  })

  it('parts ["html"] returns the exact html and the version, nothing else', async () => {
    const big = bigBoard()
    const got = await read(big, { parts: ['html'] })
    expect(got.board).toEqual(big.board)
    expect((got.board as { html: string }).html).toBe((big.board as { html: string }).html)
    expect(got.board_version).toBe(9)
    expect(got.task_id).toBe('lead01')
    for (const k of ['threads', 'projects', 'cards', 'team', 'refs', 'summary']) expect(got[k]).toBeUndefined()
    expect(got.outcome).toContain('Parts: html.')
    expect(got.next).toMatch(/board_edit/)
  })

  it('parts threads with a thread id returns that thread\'s messages only; since narrows further', async () => {
    const big = bigBoard()
    const one = await read(big, { parts: ['threads'], thread: 't3' })
    expect(Object.keys(one.threads as object)).toEqual(['t3'])
    expect((one.threads as Record<string, unknown[]>).t3).toEqual((big.threads as Record<string, unknown[]>).t3)
    expect(one.board).toBeUndefined()
    expect(one.outcome).toContain('Thread "t3": 10 messages.')

    // `thread` alone implies the threads part.
    const newer = await read(big, { thread: 't3', since: '2026-10-13T09:07:00.000Z' })
    expect((newer.threads as Record<string, Array<{ id: string }>>).t3.map((m) => m.id)).toEqual(['bm-3-8', 'bm-3-9'])
    expect(newer.outcome).toContain('Thread "t3": 2 messages after 2026-10-13T09:07:00.000Z.')

    const missing = await read(big, { parts: ['threads'], thread: 'nope' })
    expect(missing.threads).toEqual({})
    expect(missing.outcome).toContain('Thread "nope": no such thread.')
  })

  it('several parts, a group and all', async () => {
    const big = bigBoard()
    const two = await read(big, { parts: ['projects', 'tasks'] })
    expect(two.projects).toEqual(big.projects)
    expect(two.refs).toEqual(big.refs)
    expect(two.threads).toBeUndefined()
    const kanban = await read(big, { parts: ['kanban'] })
    expect(Object.keys(kanban).sort()).toEqual(['board_task_id', 'board_task_title', 'board_version', 'cards', 'kanban_seen', 'lanes_effective', 'next', 'outcome', 'task_id', 'team'])
    expect(kanban.outcome).toMatch(/This answer is [\d,]+ characters: ask for fewer parts/)
    const all = await read(big, { parts: ['all'] })
    expect(all.board).toEqual(big.board)
    expect(all.cards).toEqual(big.cards)
  })

  it('an unknown part is refused by the schema', () => {
    const op = getOp('board_get')!
    const schema = op.input.parts as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse(['html', 'threads']).success).toBe(true)
    expect(schema.safeParse(['everything']).success).toBe(false)
  })

  it('a since that is not a time is refused; a thread named with parts that leave threads out is not reported missing', async () => {
    await expect(read(SMALL, { parts: ['threads'], since: 'yesterday' })).rejects.toThrow(/ISO time/)
    const got = await read(SMALL, { parts: ['html'], thread: 'area-a' })
    expect(got.outcome).not.toMatch(/no such thread/)
  })
})
