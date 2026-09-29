/**
 * The asks list rules (src/core/sessions/ask-list.ts): the ONE definition the
 * web drawer imports and GET /api/v1/asks serves the phone from.
 *
 * Scenario matrix (each block below names its row):
 *   several agents, an ask with no session yet, running / idle / done, a
 *   brand-new ask, title drift, an old ask continued today, an edit that is not
 *   activity, search, 60+ asks, mixed-script titles, ties, broken stamps, the
 *   held order and printed stamps while the drawer is open (one snapshot per
 *   agent), and the two parity pins against the
 *   board's own session-id and circle rules.
 *
 * All data is invented. Non-ASCII titles are written as \u escapes (test data
 * only): U+7814 U+7A76 reads "research", U+90E8 U+7F72 reads "deploy".
 */
import { describe, it, expect } from 'vitest'
import {
  ASK_WALNUT_PROJECT, GENERAL_AGENT_ID,
  askActivityAt, askProjectFor, askSessionId, askState, askTitle, buildAskList,
  compareAsks, holdOrder, isAskOf, matchesAskQuery, nextHeldOrder, printedStamp, selectAsks, toAskRow,
  type AskTaskLike, type HeldOrder, type HeldRowView, type PrintedStamp,
} from '../../../src/core/sessions/ask-list.js'
import { resolveTaskSessionId, taskCircleClass } from '../../../web/src/utils/session-status.js'
import type { Task } from '../../../src/core/types.js'

const WALNUT = { id: GENERAL_AGENT_ID, project: ASK_WALNUT_PROJECT }
const MENTOR = { id: 'mentor', project: askProjectFor({ id: 'mentor', name: 'Mentor' }) }

function ask(id: string, over: Partial<AskTaskLike> = {}): AskTaskLike {
  return {
    id,
    title: `ask ${id}`,
    project: ASK_WALNUT_PROJECT,
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    walnut_agent: true,
    created_at: '2026-09-01T00:00:00.000Z',
    session_id: `sess-${id}`,
    session_ids: [`sess-${id}`],
    ...over,
  }
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

describe('membership: several agents', () => {
  const tasks = [
    ask('w-born'),
    ask('w-moved', { project: 'Some Project' }),
    ask('m-born', { agent_id: 'mentor', project: 'Ask Mentor' }),
    ask('m-moved', { agent_id: 'mentor', project: 'Elsewhere' }),
    ask('filed-by-hand', { walnut_agent: undefined, project: 'ask walnut ' }),
    ask('plain', { walnut_agent: undefined, project: 'Some Project' }),
    ask('mentor-project-only', { walnut_agent: undefined, project: 'Ask Mentor' }),
  ]

  it("Walnut's list: its stamped asks wherever filed, plus anything under Ask Walnut", () => {
    expect(ids(selectAsks(tasks, WALNUT)).sort()).toEqual(['filed-by-hand', 'w-born', 'w-moved'])
  })

  it("Mentor's list: stamped mentor asks plus its project, never Walnut's", () => {
    expect(ids(selectAsks(tasks, MENTOR)).sort()).toEqual(['m-born', 'm-moved', 'mentor-project-only'])
  })

  it('a config agent with a free-text name folds to a legal project', () => {
    expect(askProjectFor({ id: 'x', name: '  a/b..c  ' })).toBe('Ask a-b.c')
    expect(askProjectFor({ id: 'fallback-id', name: '   ' })).toBe('Ask fallback-id')
    expect(askProjectFor({ id: GENERAL_AGENT_ID, name: 'Anything' })).toBe(ASK_WALNUT_PROJECT)
    expect(isAskOf(ask('t', { walnut_agent: undefined, project: 'Ask a-b.c' }), { id: 'x', project: 'Ask a-b.c' })).toBe(true)
  })
})

describe('state: no session yet, running, idle, done', () => {
  it('no session yet is todo, and its activity is its birth', () => {
    const t = ask('fresh', { session_id: undefined, session_ids: [], created_at: '2026-09-20T10:00:00.000Z' })
    expect(askState(t)).toBe('todo')
    expect(askActivityAt(t)).toBe('2026-09-20T10:00:00.000Z')
    expect(toAskRow(t, WALNUT)).not.toHaveProperty('sessionId')
  })

  it('running follows the live status over the enrichment snapshot', () => {
    const t = ask('r', { session_status: { process_status: 'idle' } })
    expect(askState(t)).toBe('idle')
    expect(askState(t, { process_status: 'running' })).toBe('running')
    expect(askState(ask('r2', { session_status: { process_status: 'running' } }))).toBe('running')
  })

  it('done wins over a running session, by phase or by status', () => {
    expect(askState(ask('d', { phase: 'COMPLETE', status: 'done' }), { process_status: 'running' })).toBe('done')
    expect(askState(ask('d2', { phase: 'COMPLETE' }))).toBe('done')
  })

  it('a NEED_ACTION ask with an idle session is idle (the blue dot)', () => {
    expect(askState(ask('n', { phase: 'NEED_ACTION', session_status: { process_status: 'stopped' } }))).toBe('idle')
  })
})

describe('order: activity first, and the printed stamp is the sort stamp', () => {
  it('a brand-new ask with no message yet sits on top by its birth', () => {
    const rows = selectAsks([
      ask('older', { created_at: '2026-09-10T00:00:00.000Z', last_session_update: '2026-09-10T00:01:00.000Z' }),
      ask('brand-new', { created_at: '2026-09-26T09:00:00.000Z', session_id: undefined, session_ids: [] }),
    ], WALNUT)
    expect(ids(rows)).toEqual(['brand-new', 'older'])
  })

  it('an old ask continued today climbs to the top', () => {
    const before = [
      ask('a', { created_at: '2026-09-20T00:00:00.000Z', last_session_update: '2026-09-20T00:00:00.000Z' }),
      ask('old', { created_at: '2026-08-01T00:00:00.000Z', last_session_update: '2026-08-01T00:00:00.000Z' }),
    ]
    expect(ids(selectAsks(before, WALNUT))).toEqual(['a', 'old'])
    const after = before.map((t) => (t.id === 'old' ? { ...t, last_session_update: '2026-09-26T08:00:00.000Z' } : t))
    expect(ids(selectAsks(after, WALNUT))).toEqual(['old', 'a'])
  })

  it('title drift renames a row without moving it', () => {
    const tasks = [
      ask('x', { created_at: '2026-09-20T00:00:00.000Z', last_session_update: '2026-09-21T00:00:00.000Z' }),
      ask('y', { created_at: '2026-09-19T00:00:00.000Z', last_session_update: '2026-09-19T00:00:00.000Z' }),
    ]
    const renamed = tasks.map((t) => (t.id === 'y' ? { ...t, title: 'Trip plan: hotel shortlist' } : t))
    const { asks } = buildAskList(renamed, WALNUT)
    expect(ids(asks)).toEqual(['x', 'y'])
    expect(asks[1].title).toBe('Trip plan: hotel shortlist')
  })

  it('an edit that is not activity (a bulk re-file bumping updated_at) moves nothing', () => {
    const tasks = [
      ask('p', { created_at: '2026-09-02T00:00:00.000Z', last_session_update: '2026-09-02T00:00:00.000Z' }),
      ask('q', { created_at: '2026-09-01T00:00:00.000Z', last_session_update: '2026-09-01T00:00:00.000Z' }),
    ].map((t) => ({ ...t, updated_at: '2026-09-25T00:00:00.000Z' }) as AskTaskLike)
    expect(ids(selectAsks(tasks, WALNUT))).toEqual(['p', 'q'])
  })

  it('activity older than birth (an imported session) reads as the birth', () => {
    const t = ask('imp', { created_at: '2026-09-10T00:00:00.000Z', last_session_update: '2026-01-01T00:00:00.000Z' })
    expect(askActivityAt(t)).toBe('2026-09-10T00:00:00.000Z')
  })

  it('ties: same activity, newer birth first, then the id by code unit, input order irrelevant', () => {
    const at = '2026-09-15T12:00:00.000Z'
    const tasks = [
      ask('b', { created_at: '2026-09-14T00:00:00.000Z', last_session_update: at }),
      ask('Z', { created_at: '2026-09-15T00:00:00.000Z', last_session_update: at }),
      ask('a', { created_at: '2026-09-15T00:00:00.000Z', last_session_update: at }),
    ]
    // 'Z' (0x5A) sorts before 'a' (0x61) by code unit, whatever the locale.
    expect(ids(selectAsks(tasks, WALNUT))).toEqual(['Z', 'a', 'b'])
    expect(ids(selectAsks([...tasks].reverse(), WALNUT))).toEqual(['Z', 'a', 'b'])
    expect(compareAsks(tasks[1], tasks[1])).toBe(0)
  })

  it('a row with no usable stamp sorts last instead of scrambling the list', () => {
    const tasks = [ask('broken', { created_at: '', last_session_update: 'garbage' }), ask('good')]
    expect(ids(selectAsks(tasks, WALNUT))).toEqual(['good', 'broken'])
    expect(toAskRow(tasks[0], WALNUT).activityAt).toBe('')
  })

  it('does not mutate the input (the web passes its shared store array)', () => {
    const tasks = [ask('1', { created_at: '2026-09-01T00:00:00.000Z' }), ask('2', { created_at: '2026-09-05T00:00:00.000Z' })]
    const snapshot = ids(tasks)
    selectAsks(tasks, WALNUT)
    expect(ids(tasks)).toEqual(snapshot)
  })
})

describe('60+ asks, mixed-script titles, search', () => {
  // 64 asks over ~two months with every state, a few ties and a few bare todos.
  const many: AskTaskLike[] = Array.from({ length: 64 }, (_, i) => {
    const born = Date.UTC(2026, 7, 1) + i * 20 * 3600_000
    const used = i % 7 === 0 ? undefined : new Date(born + ((i * 37) % 200) * 3600_000).toISOString()
    const titles = ['Weekly plan', 'Garden \u7814\u7a76 notes', 'Release \u90e8\u7f72 checklist', 'Reading list', '']
    return ask(`t${String(i).padStart(2, '0')}`, {
      title: titles[i % titles.length],
      created_at: new Date(born).toISOString(),
      ...(used ? { last_session_update: used } : { session_id: undefined, session_ids: [] }),
      ...(i % 5 === 0 ? { phase: 'COMPLETE', status: 'done' } : {}),
      ...(i % 11 === 0 ? { session_status: { process_status: 'running' } } : {}),
    })
  })

  it('lists every ask, times never increase down the list, total counts them all', () => {
    const { total, asks } = buildAskList(many, WALNUT)
    expect(total).toBe(64)
    expect(asks).toHaveLength(64)
    for (let i = 1; i < asks.length; i++) {
      expect(Date.parse(asks[i - 1].activityAt)).toBeGreaterThanOrEqual(Date.parse(asks[i].activityAt))
    }
    expect(new Set(asks.map((r) => r.state))).toEqual(new Set(['running', 'idle', 'done', 'todo']))
  })

  it('an untitled ask reads as the agent project', () => {
    const { asks } = buildAskList(many, WALNUT)
    expect(asks.filter((r) => r.title === ASK_WALNUT_PROJECT).length).toBeGreaterThan(0)
    expect(askTitle(ask('u', { title: '   ' }), MENTOR)).toBe('Ask Mentor')
  })

  it('limit caps the rows but total still says how many matched', () => {
    const { total, asks } = buildAskList(many, WALNUT, { limit: 10 })
    expect(total).toBe(64)
    expect(ids(asks)).toEqual(ids(buildAskList(many, WALNUT).asks.slice(0, 10)))
  })

  it('search: every word, any case, any script, in list order', () => {
    expect(matchesAskQuery('iOS build 73 deploy', 'deploy IOS')).toBe(true)
    expect(matchesAskQuery('iOS build 73 deploy', 'deploy android')).toBe(false)
    expect(matchesAskQuery('Garden \u7814\u7a76 notes', '\u7814\u7a76')).toBe(true)
    expect(matchesAskQuery('anything', '   ')).toBe(true)
    const hits = buildAskList(many, WALNUT, { query: '\u90e8\u7f72 release' })
    expect(hits.total).toBe(many.filter((t) => t.title === 'Release \u90e8\u7f72 checklist').length)
    const all = ids(buildAskList(many, WALNUT).asks)
    expect(ids(hits.asks)).toEqual(all.filter((id) => ids(hits.asks).includes(id)))
  })
})

describe('holdOrder: the drawer does not move rows while it is open', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('keeps the open-time places when the true order changes', () => {
    const reordered = [{ id: 'c' }, { id: 'a' }, { id: 'b' }]
    expect(ids(holdOrder(reordered, ids(rows)))).toEqual(['a', 'b', 'c'])
  })

  it('a row that arrives while open joins at the end; a removed row is gone', () => {
    const next = [{ id: 'new' }, { id: 'c' }, { id: 'a' }]
    expect(ids(holdOrder(next, ids(rows)))).toEqual(['a', 'c', 'new'])
  })

  it('holding nothing is the live order (which is why the drawer never holds an empty list)', () => {
    expect(ids(holdOrder(rows, []))).toEqual(['a', 'b', 'c'])
  })
})

/**
 * The drawer advances its snapshots once per render (nextHeldOrder), orders the
 * rows with holdOrder and prints printedStamp. These replay the renders of one
 * open, the way the drawer does, and read what the user sees at each step: the
 * order and the stamp each row prints.
 */
describe('nextHeldOrder + printedStamp: what the open drawer shows', () => {
  const HOUR = 3_600_000
  const T0 = Date.UTC(2026, 8, 20, 12)
  const ids42 = Array.from({ length: 42 }, (_, i) => `ask-${String(i).padStart(2, '0')}`)
  /** ids42[i] was last used i hours before T0, so ids42 is the true order. */
  const at = (hoursAgo: number) => new Date(T0 - hoursAgo * HOUR).toISOString()
  const baseStamps = new Map<string, string>(ids42.map((id, i) => [id, at(i)]))
  const rowsOf = (list: readonly string[], stamps: ReadonlyMap<string, string>): HeldRowView[] =>
    list.map((id) => (stamps.has(id) ? { id, activityAt: stamps.get(id)! } : { id }))
  const label = (p: PrintedStamp) => (p.kind === 'time' ? p.at : p.kind === 'new' ? 'New' : '')

  /** One render: advance the snapshots, return them, the order on screen and what each row prints. */
  function render(prev: HeldOrder | null, view: {
    open?: boolean; agentId?: string; rows: readonly string[]; stamps?: ReadonlyMap<string, string>; loading?: boolean;
  }) {
    const agentId = view.agentId ?? 'general'
    const rows = rowsOf(view.rows, view.stamps ?? baseStamps)
    const held = nextHeldOrder(prev, { open: view.open ?? true, agentId, rows, loading: view.loading ?? false })
    const list = held?.byAgent.get(agentId)
    const shown = list ? holdOrder(rows, list.ids) : rows
    return { held, list, shown: ids(shown), printed: shown.map((r) => label(printedStamp(list, r))) }
  }

  /** The printed times, top to bottom, never get newer ("New" rows aside). */
  function readsInOrder(printed: readonly string[]): boolean {
    const times = printed.filter((p) => p && p !== 'New').map((p) => Date.parse(p))
    return times.every((t, i) => i === 0 || times[i - 1] >= t)
  }

  it('opened before the board loaded: the rows hold once they arrive (the gate repro)', () => {
    // The opening frame: the task list has not answered yet.
    let step = render(null, { rows: [], loading: true })
    expect(step.held).toBeNull()
    // The board lands with 42 asks while the drawer stays open.
    step = render(step.held, { rows: ids42 })
    expect(step.shown).toEqual(ids42)
    // The oldest ask gets a message: the live order puts it first...
    const live = ['ask-41', ...ids42.slice(0, 41)]
    step = render(step.held, { rows: live, stamps: new Map([...baseStamps, ['ask-41', at(-0.1)]]) })
    // ...and it stays where the user saw it, at the bottom.
    expect(step.shown).toEqual(ids42)
    expect(step.shown.indexOf('ask-41')).toBe(41)
  })

  it('a held row continued since keeps its old stamp and a newcomer reads New, so the times still read in order', () => {
    let step = render(null, { rows: ids42 })
    expect(step.printed).toEqual(ids42.map((_, i) => at(i)))
    // While open: the oldest ask is continued, then a brand-new ask arrives.
    const stamps = new Map([...baseStamps, ['ask-41', at(-0.1)], ['ask-new', at(-0.2)]])
    step = render(step.held, { rows: ['ask-new', 'ask-41', ...ids42.slice(0, 41)], stamps })
    expect(step.shown).toEqual([...ids42, 'ask-new'])
    // The continued row prints the stamp it had ("1d ago"), not "just now"...
    expect(step.printed[41]).toBe(at(41))
    // ...and the newcomer at the end prints "New", not "just now" under "1d ago".
    expect(step.printed[42]).toBe('New')
    expect(readsInOrder(step.printed)).toBe(true)
    // Without the held stamps the same order would not read in order: the gate's finding.
    const live = step.shown.map((id) => stamps.get(id)!)
    expect(readsInOrder(live)).toBe(false)
  })

  it('the just-launched ask the snapshot saw without a stamp reads New, before and after the store carries it', () => {
    const noTaskYet = new Map([...baseStamps].filter(([id]) => id !== 'ask-00'))
    let step = render(null, { rows: ids42, stamps: noTaskYet })
    expect(step.printed[0]).toBe('New')
    step = render(step.held, { rows: ids42, stamps: new Map([...baseStamps, ['ask-00', at(-0.1)]]) })
    expect(step.shown[0]).toBe('ask-00')
    expect(step.printed[0]).toBe('New')
  })

  it('no snapshot yet (loading): live order and live stamps; a row without a task prints nothing', () => {
    const noTaskYet = new Map([...baseStamps].filter(([id]) => id !== 'ask-07'))
    const step = render(null, { rows: ['ask-07', 'ask-03'], stamps: noTaskYet, loading: true })
    expect(step.held).toBeNull()
    expect(step.printed).toEqual(['', at(3)])
  })

  it('rows that arrive in two batches: a partial list while loading is not held; the loaded one is', () => {
    // A live event put one ask in the store before the board answered.
    let step = render(null, { rows: ['ask-07'], loading: true })
    expect(step.held).toBeNull()
    expect(step.shown).toEqual(['ask-07'])
    // The board answers: the snapshot is the full list in its live order.
    step = render(step.held, { rows: ids42 })
    expect(step.list?.ids).toEqual(ids42)
    // A genuinely new ask after that joins at the end, and nothing else moves.
    step = render(step.held, { rows: ['ask-new', ...ids42] })
    expect(step.shown).toEqual([...ids42, 'ask-new'])
  })

  it('loaded but empty: the first row that arrives is the snapshot', () => {
    let step = render(null, { rows: [] })
    expect(step.held).toBeNull()
    step = render(step.held, { rows: ['ask-05'] })
    expect(step.list?.ids).toEqual(['ask-05'])
    expect(step.printed).toEqual([at(5)])
  })

  it('one snapshot per agent for the whole open: Walnut, Mentor, Walnut shows Walnut as first seen', () => {
    const walnut = ids42.slice(0, 20)
    const mentor = ids42.slice(20)
    let step = render(null, { rows: walnut })
    const walnutFirst = step.list
    // Switch to Mentor: its own snapshot, Walnut's kept alongside.
    step = render(step.held, { agentId: 'mentor', rows: mentor })
    expect(step.shown).toEqual(mentor)
    expect(step.held?.byAgent.get('general')).toBe(walnutFirst)
    // While on Mentor, a Walnut ask is continued and a Walnut ask is launched.
    const stamps = new Map([...baseStamps, ['ask-19', at(-0.1)], ['ask-w-new', at(-0.2)]])
    const walnutLive = ['ask-w-new', 'ask-19', ...walnut.slice(0, 19)]
    // Back to Walnut: the list as it was, not a fresh snapshot of the live order.
    step = render(step.held, { rows: walnutLive, stamps })
    expect(step.list).toBe(walnutFirst)
    expect(step.shown).toEqual([...walnut, 'ask-w-new'])
    expect(step.printed[19]).toBe(at(19))
    expect(step.printed[20]).toBe('New')
    // And Mentor again: its first snapshot too.
    const mentorAgain = render(step.held, { agentId: 'mentor', rows: [...mentor].reverse(), stamps })
    expect(mentorAgain.shown).toEqual(mentor)
    // Close: every snapshot goes. The next open is the true order with real times.
    expect(render(mentorAgain.held, { open: false, rows: walnutLive, stamps }).held).toBeNull()
    const reopened = render(null, { rows: walnutLive, stamps })
    expect(reopened.shown).toEqual(walnutLive)
    expect(reopened.printed.slice(0, 2)).toEqual([at(-0.2), at(-0.1)])
    expect(readsInOrder(reopened.printed)).toBe(true)
  })

  it('keeps the same object across renders, also while another agent is still loading', () => {
    const first = render(null, { rows: ['ask-00', 'ask-01'] }).held
    expect(render(first, { rows: ['ask-01', 'ask-00'] }).held).toBe(first)
    expect(render(first, { agentId: 'mentor', rows: [], loading: true }).held).toBe(first)
    expect(render(first, { agentId: 'mentor', rows: [] }).held).toBe(first)
  })

  it('does not alias the rows it was given', () => {
    const rows: HeldRowView[] = [{ id: 'a', activityAt: at(1) }, { id: 'b', activityAt: at(2) }]
    const held = nextHeldOrder(null, { open: true, agentId: 'general', rows, loading: false })
    rows.reverse()
    rows[0] = { id: 'b', activityAt: at(0) }
    expect(held?.byAgent.get('general')?.ids).toEqual(['a', 'b'])
    expect(held?.byAgent.get('general')?.stamps.get('b')).toBe(at(2))
  })
})

describe('parity with the board: same session id, same circle', () => {
  const sessionShapes: Array<Partial<AskTaskLike>> = [
    {},
    { session_id: 'one' },
    { exec_session_id: 'exec' },
    { plan_session_id: 'plan' },
    { session_ids: ['old', 'newest'] },
    { session_id: 'one', exec_session_id: 'exec', plan_session_id: 'plan', session_ids: ['x'] },
    { exec_session_id: 'exec', plan_session_id: 'plan' },
  ]
  const phases = [
    { phase: 'TODO', status: 'todo' },
    { phase: 'IN_PROGRESS', status: 'in_progress' },
    { phase: 'NEED_ACTION', status: 'in_progress' },
    { phase: 'COMPLETE', status: 'done' },
  ]
  const lives = [undefined, null, { process_status: 'running' }, { process_status: 'idle' }, { process_status: 'stopped' }]
  const snapshots = [undefined, { process_status: 'running' }, { process_status: 'error' }]
  const CLASS = { running: 'task-circle-running', idle: 'task-circle-session', done: 'task-circle-done', todo: 'task-circle-todo' }

  it('askSessionId === resolveTaskSessionId for every slot shape', () => {
    for (const shape of sessionShapes) {
      const t = { id: 'p', session_id: undefined, session_ids: [], ...shape } as AskTaskLike
      expect(askSessionId(t)).toBe(resolveTaskSessionId(t as unknown as Task))
    }
  })

  it('askState maps onto taskCircleClass for every phase x slot x live x snapshot', () => {
    let checked = 0
    for (const shape of sessionShapes) for (const ph of phases) for (const live of lives) for (const snap of snapshots) {
      const t = { id: 'p', session_id: undefined, session_ids: [], ...shape, ...ph, ...(snap ? { session_status: snap } : {}) } as AskTaskLike
      expect(CLASS[askState(t, live)]).toBe(taskCircleClass(t as unknown as Task, live as never))
      checked++
    }
    expect(checked).toBe(sessionShapes.length * phases.length * lives.length * snapshots.length)
  })
})
