/**
 * What an agent reads back from the task ops (src/ops/task-answers.ts, the policy in answer.ts).
 *
 * 2026-11-21: a week of sessions showed task_complete answering p95 17,000 characters (the whole
 * task it had just closed, with its note, field_at and an engine switch's moved list) and task_get
 * p95 22,000, max 92,000. These tests run the real ops' result code over a task as dense as the
 * real ones and hold each answer to its size, keeping what an agent acts on.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import type { WalnutOp } from '../../src/ops/registry.js'
import { agentAnswer as answerOn, answerPolicy, cutTextRefusal, RECEIPT_MAX_CHARS, CONTENT_MAX_CHARS } from '../../src/ops/answer.js'
import { TASK_FOCUS_TIER_SET_ANSWER, TASK_PIN_SET_ANSWER, TASK_GET_TEXT_MAX } from '../../src/ops/task-answers.js'
import { TASK_HISTORY_ANSWER, AGENT_HISTORY_LIMIT } from '../../src/ops/task-history-shape.js'

/** Each op's own shape under its own cap, as an MCP tool answers it (answer-policy.test.ts holds every op to the CLI's smaller cap too). */
const agentAnswer = (op: Parameters<typeof answerOn>[0], args: Record<string, unknown>, result: unknown, full = false): unknown => answerOn(op, args, result, full, 'mcp')

type Obj = Record<string, unknown>
const size = (v: unknown): number => JSON.stringify(v).length
const AT = '2026-11-21T10:00:00.000Z'
const ID = 'mwcfs6kp-4cd8'

/** A note shaped like a real one: summary, request, progress, then a long work log. */
const NOTE = [
  '## Executive Summary', 'Every task op answers an agent a receipt or a compact read.', '',
  '## User Request', 'Make the answers of the task ops small.', '',
  '## Progress', '- [DONE] receipts for the writes', '- [WIP] task_get compact', '',
  '## Work Log',
  ...Array.from({ length: 90 }, (_, i) => `- 2026-11-${String(1 + (i % 28)).padStart(2, '0')} step ${i}: changed one more part of the answers and wrote down why.`),
].join('\n')

const row = (i: number) => ({
  id: `child-${i}`, title: `Subtask number ${i} with a title of a usual length`, phase: 'IN_PROGRESS', status: 'in_progress', priority: 'none',
  user_status: { state: 'working', now: 'Building the thing and running its tests on the dev host.', at: AT },
})

/** A task as dense as the real ones: long texts, Walnut's bookkeeping, a big team. */
function denseTask(over: Obj = {}): Obj {
  return {
    id: ID, title: 'Make every task op answer small for agents, with receipts for writes and a compact read',
    phase: 'NEED_ACTION', status: 'in_progress', priority: 'important', project: 'Walnut', group_id: 'g_abc',
    parent_task_id: 'parent-1', tags: ['label:answers', 'team:core'], source: 'local',
    description: 'The brief the task was created with. '.repeat(90), summary: 'What the last turn did, in some detail. '.repeat(40), note: NOTE,
    created_at: AT, updated_at: AT, phase_changed_at: AT,
    field_at: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, AT])),
    applied_ops: Array.from({ length: 30 }, (_, i) => `host-a|op-${i}|${i}`),
    completions: Array.from({ length: 10 }, (_, i) => `2026-11-${10 + i}T00:00:00.000Z`),
    legacy_session_ids: Array.from({ length: 12 }, (_, i) => `legacy-session-${i}`),
    session_ids: ['s-1'], session_id: 's-1', session_status: { process_status: 'idle', pid: 4242 },
    engine_switch: {
      id: 'es-1', state: 'done', at: AT, from_session_id: 's-0', to: { engine: 'claude', host: 'box' }, move: true,
      moved: Array.from({ length: 40 }, (_, i) => `repository ${i}: 3 commits, 12 changed files, 2 untracked files`),
      message: 'Carry on with the work. '.repeat(40),
    },
    ask_answered: { key: 'k-5', ask: 'Ship it?', text: 'Yes', by: 'task:lead', byTitle: 'Lead', at: AT },
    asks_answered: Array.from({ length: 5 }, (_, i) => ({ key: `k-${i}`, ask: `Question ${i}?`, text: 'An answer of a line or two. '.repeat(4), by: 'task:lead', byTitle: 'Lead', at: AT })),
    org_avatar: { svg: `<svg>${'x'.repeat(6_000)}</svg>`, at: AT },
    launch_source: { engine: 'project', model: 'project', mode: 'global' },
    user_status: { state: 'needs', ask: 'Review the receipts and say whether the task_get cut is right.', source: 'session', at: AT, checkedAt: AT, decision: 'ask-1' },
    result_report: { at: AT, result: 'Receipts shipped.', not_done: ['WebKit pass', 'docs page'], evidence: ['/tmp/x.png'] },
    children: Array.from({ length: 30 }, (_, i) => row(i)),
    parent: { id: 'parent-1', title: 'The leader', phase: 'IN_PROGRESS', status: 'in_progress', user_status: { state: 'working' } },
    ...over,
  }
}

/** A handler's server, answering by method and path; anything else answers nothing. */
const fakeCall = (answers: Record<string, unknown>) => async (method: string, path: string): Promise<unknown> =>
  answers[`${method} ${path.split('?')[0]}`]

const op = (name: string): WalnutOp => {
  const found = getOp(name)
  if (!found) throw new Error(`no op ${name}`)
  return found
}
const mapped = (name: string, body: unknown, args: Obj): Obj => op(name).mapResult!({ body, args }) as Obj
const run = async (name: string, args: Obj, answers: Record<string, unknown>): Promise<Obj> =>
  await op(name).handler!(args, fakeCall(answers) as never) as Obj
const text = (v: unknown) => JSON.stringify(v)
/** How every text Walnut shortens ends (answer.ts cutMark). */
const MARKED = /… \[Walnut cut: \d+ more characters\]$/
const jsonChars = (s: unknown) => JSON.stringify(s).length - 2

/** Every string in `v`, with its path. */
function strings(v: unknown, path = ''): Array<[string, string]> {
  if (typeof v === 'string') return [[path, v]]
  if (!v || typeof v !== 'object') return []
  return Object.entries(v as Obj).flatMap(([k, x]) => strings(x, path ? `${path}.${k}` : k))
}

/**
 * The routing lines task_get repeats at the top are cut by src/core/task-deliverable.ts, not by a
 * shape: they are left out here until that file cuts with the mark too.
 */
const CUT_ELSEWHERE = new Set(['deliverable', 'first_request', 'latest'])

/** A shortened text without the mark could be written back as if whole: none may end in a bare ellipsis. */
function expectEveryCutMarked(answer: unknown): void {
  for (const [path, s] of strings(answer)) {
    if (CUT_ELSEWHERE.has(path)) continue
    if (s.endsWith('…') || s.includes('… [')) expect(s, path).toMatch(MARKED)
  }
}

/** Walnut's bookkeeping that no receipt carries. */
const BOOKKEEPING_WORDS = ['field_at', 'applied_ops', 'asks_answered', 'engine_switch', 'completions', 'legacy_session_ids', 'org_avatar', '## Work Log', 'The brief the task was created with']

describe('a task write answers an agent a receipt', () => {
  it('task_complete: a short receipt instead of the whole task', () => {
    const result = mapped('task_complete', {
      task: denseTask({ phase: 'COMPLETE', status: 'done' }),
      open_subtasks: Array.from({ length: 7 }, (_, i) => ({ id: `child-${i}`, title: `Subtask ${i}`, phase: 'IN_PROGRESS' })),
    }, { id: ID })
    expect(size(result)).toBeGreaterThan(20_000)
    const answer = agentAnswer(op('task_complete'), { id: ID }, result) as Obj
    expect(size(answer)).toBeLessThan(RECEIPT_MAX_CHARS)
    expect(answer).not.toHaveProperty('_cut')
    expect(answer).toMatchObject({ id: ID, phase: 'COMPLETE', completed: true, task: { id: ID, phase: 'COMPLETE', project: 'Walnut', user_status: { state: 'done' } } })
    expect(answer.not_done).toEqual(['WebKit pass', 'docs page'])
    expect((answer.open_subtasks as unknown[]).length).toBe(5)
    for (const key of ['ref', 'instruction', 'outcome', 'next']) expect(answer[key], key).toBe(result[key])
    // A title is a few words: never cut (an agent may pass it back to task_update).
    expect(answer.title).toBe(denseTask().title)
    for (const word of BOOKKEEPING_WORDS) expect(text(answer), word).not.toContain(word)
    expectEveryCutMarked(answer)
    // `_full` (agentAnswer's last argument) is the old answer, untouched.
    expect(agentAnswer(op('task_complete'), { id: ID }, result, true)).toBe(result)
  })

  it('task_update names the fields it set, with their stored values, and keeps the headline', async () => {
    const args = { id: ID, title: 'Renamed', priority: 'backlog', description: 'A new brief. '.repeat(50) }
    const result = await run('task_update', args, { [`PATCH /tasks/${ID}`]: { task: denseTask({ title: 'Renamed', priority: 'backlog', description: args.description }) } })
    expect(size(result)).toBeGreaterThan(20_000)
    const answer = agentAnswer(op('task_update'), args, result) as Obj
    expect(size(answer)).toBeLessThan(RECEIPT_MAX_CHARS)
    expect(answer.changed).toEqual(['title', 'priority', 'description'])
    const task = answer.task as Obj
    expect(task).toMatchObject({ id: ID, title: 'Renamed', priority: 'backlog', phase: 'NEED_ACTION' })
    // A cut value carries the mark, so a write given it back is refused.
    expect(String(task.description).length).toBeLessThanOrEqual(160)
    expect(task.description).toMatch(MARKED)
    expect(cutTextRefusal(op('task_update'), { id: ID, description: task.description })).toMatch(/task_update refused/)
    expect(answer.outcome).toBe(result.outcome)
    expect(answer.next).toBe(result.next)
    for (const word of ['field_at', 'applied_ops', '## Work Log']) expect(text(answer), word).not.toContain(word)
  })

  it('task_create keeps where the task landed, the run state and the given fields, not the team list', async () => {
    const args = { record_only: true, title: 'A new task', priority: 'important', project: 'Walnut' }
    const placement = {
      project: 'Walnut', group_id: 'g_abc', group_label: 'Answers', parent_task_id: 'parent-1', tier: 'focus',
      open_subtasks: Array.from({ length: 8 }, (_, i) => ({ id: `child-${i}`, title: `Subtask ${i} with a longer title`, phase: 'TODO' })),
      more_open_subtasks: 4,
    }
    const result = await run('task_create', args, { 'POST /tasks': { task: denseTask({ phase: 'TODO', title: 'A new task' }), placement } })
    const answer = agentAnswer(op('task_create'), args, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(answerPolicy(op('task_create')).max)
    expect(answer.execution).toEqual({ state: 'not_started' })
    expect(answer.task).toMatchObject({ id: ID, title: 'A new task', priority: 'important', project: 'Walnut' })
    expect(answer.placement).toMatchObject({ group_id: 'g_abc', parent_task_id: 'parent-1', open_subtask_count: 12 })
    expect(answer.ref).toBe(result.ref)
    for (const word of BOOKKEEPING_WORDS) expect(text(answer), word).not.toContain(word)
  })

  it('a bulk write keeps every row\'s id and whether it went through', async () => {
    const updates = Array.from({ length: 50 }, (_, i) => ({ id: `${ID}-${i}`, phase: 'COMPLETE' }))
    const answers = Object.fromEntries(updates.map((u, i) => [`PATCH /tasks/${u.id}`, i === 7 ? undefined : { task: denseTask({ id: u.id }) }]))
    const result = await run('task_update_bulk', { updates }, answers)
    const answer = agentAnswer(op('task_update_bulk'), { updates }, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(answerPolicy(op('task_update_bulk')).max)
    expect(answer).not.toHaveProperty('_cut')
    const rows = answer.rows as Array<Obj>
    expect(rows).toHaveLength(50)
    expect(rows.every((r) => typeof r.id === 'string' && typeof r.ok === 'boolean')).toBe(true)
    expect(answer.changed).toBe(result.changed)
  })

  it('task_not_done_settle says how the items were settled, not the whole task', () => {
    const settled = { at: AT, by: 'human', how: 'taken', note: 'Moved to the follow-up task.' }
    const result = mapped('task_not_done_settle', { task: denseTask({ result_report: { at: AT, not_done: ['x'], settled } }) }, { id: ID, how: 'taken' })
    const answer = agentAnswer(op('task_not_done_settle'), { id: ID, how: 'taken' }, result) as Obj
    expect(size(answer)).toBeLessThan(RECEIPT_MAX_CHARS)
    expect(answer.settled).toEqual({ how: 'taken', note: 'Moved to the follow-up task.' })
    expect((answer.task as Obj).id).toBe(ID)
  })

  it('pinning and moving a tier answer the task, not the whole board', () => {
    const pin = { name: 'task_pin_set', tags: { readonly: false, remote: 'allow' as const }, answer: TASK_PIN_SET_ANSWER }
    const pinned = agentAnswer(pin, { id: ID, pinned: true }, { pinned_tasks: Array.from({ length: 200 }, (_, i) => `task-${i}`), outcome: 'Task pinned.', next: 'No further action is required.' }) as Obj
    expect(pinned).toEqual({ id: ID, pinned: true, pinned_count: 200, outcome: 'Task pinned.', next: 'No further action is required.' })
    const tier = { name: 'task_focus_tier_set', tags: { readonly: false, remote: 'allow' as const }, answer: TASK_FOCUS_TIER_SET_ANSWER }
    const moved = agentAnswer(tier, { id: ID, tier: 'focus' }, { focus: [denseTask()], satellite: [denseTask()], outcome: 'Moved.', next: 'Nothing.' }) as Obj
    expect(moved).toEqual({ id: ID, tier: 'focus', outcome: 'Moved.', next: 'Nothing.' })
  })

  it('every task write answers a receipt that names task_get for the whole task', () => {
    const writes = [
      'task_complete', 'task_update', 'task_not_done_settle', 'task_create', 'task_start', 'task_restart', 'task_stop',
      'task_focus_tier_set', 'task_pin_set', 'task_update_bulk', 'task_complete_bulk', 'task_note_write', 'task_report_set',
      'task_move', 'task_merge', 'task_session_set', 'task_switch_engine', 'task_transfer', 'task_ask_answer_withdraw',
      'task_make_local', 'task_sync_to_project', 'task_watch',
    ]
    for (const name of writes) {
      const o = op(name)
      expect(answerPolicy(o).kind, name).toBe('receipt')
      expect(o.answer?.shape, name).toBeTypeOf('function')
      expect(o.answer?.whole, name).toBe('task_get {"id":"<id>"}')
    }
  })
})

describe('task_get answers an agent the task without its bookkeeping', () => {
  const body = { task: denseTask() }

  it('keeps what an agent decides on, cuts the note with a pointer, and fits its cap', () => {
    const result = mapped('task_get', body, { id: ID })
    expect(size(result)).toBeGreaterThan(30_000)
    const policy = answerPolicy(op('task_get'))
    const answer = agentAnswer(op('task_get'), { id: ID }, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(policy.max)
    expect(answer).not.toHaveProperty('_cut')
    expect(answer).toMatchObject({ id: ID, phase: 'NEED_ACTION', outcome: result.outcome, next: result.next })
    const task = answer.task as Obj
    expect(task).toMatchObject({
      id: ID, phase: 'NEED_ACTION', parent_task_id: 'parent-1', tags: ['label:answers', 'team:core'],
      user_status: (body.task as Obj).user_status, result_report: (body.task as Obj).result_report, ask_answered: (body.task as Obj).ask_answered,
    })
    expect((task.execution as Obj).state).toBeTypeOf('string')
    expect(jsonChars(task.note)).toBeLessThanOrEqual(TASK_GET_TEXT_MAX.note)
    expect(String(task.note)).toContain('## Progress')
    expect(task.note).toMatch(MARKED)
    expect(task.note_cut).toBe('task_get {"id":"mwcfs6kp-4cd8","fields":["note"]} reads it whole')
    expect(task.description).toMatch(MARKED)
    expect(task.description_cut).toBeTypeOf('string')
    expectEveryCutMarked(answer)
    expect(task.omitted).toEqual(expect.arrayContaining(['field_at', 'applied_ops', 'completions', 'legacy_session_ids', 'org_avatar', 'launch_source', 'asks_answered']))
    for (const key of ['field_at', 'applied_ops', 'completions', 'org_avatar', 'asks_answered', 'session_ids']) expect(task, key).not.toHaveProperty(key)
    expect(task.engine_switch).toEqual({ state: 'done', at: AT, to: { engine: 'claude', host: 'box' }, move: true, moved_count: 40 })
    expect((task.children as unknown[]).length).toBe(20)
    expect(String(task.children_more)).toContain(`task_list {"parent_task_id":"${ID}"}`)
    expect(task.parent).toEqual({ id: 'parent-1', title: 'The leader', phase: 'IN_PROGRESS', user_status: { state: 'working' } })
    // `_full` is the old answer, untouched.
    expect(agentAnswer(op('task_get'), { id: ID }, result, true)).toBe(result)
  })

  it('fields answers the id and those fields only, whole, for every caller', () => {
    const result = mapped('task_get', body, { id: ID, fields: ['note', 'phase'] })
    expect(result).toEqual({ id: ID, note: NOTE, phase: 'NEED_ACTION' })
    expect(agentAnswer(op('task_get'), { id: ID, fields: ['note', 'phase'] }, result)).toEqual(result)
    const listed = mapped('task_get', body, { id: ID, fields: 'deliverable, no_such_field' })
    expect(listed.id).toBe(ID)
    expect(listed.deliverable).toBeTypeOf('string')
    expect(listed.absent).toEqual(['no_such_field'])
  })

  it('a short task reads whole: nothing is cut that fits', () => {
    const small = mapped('task_get', { task: { id: 't-1', title: 'Small', phase: 'TODO', note: 'A short note.', session_ids: [] } }, { id: 't-1' })
    const answer = agentAnswer(op('task_get'), { id: 't-1' }, small) as Obj
    expect((answer.task as Obj).note).toBe('A short note.')
    expect(answer.task).not.toHaveProperty('note_cut')
  })

  it('a note heavy with escapes read with fields is whole, or carries the mark and names _full', () => {
    // Tabs, quotes, backslashes and newlines are two JSON characters each: the cap counts JSON.
    const heavy = Array.from({ length: 400 }, (_, i) => `\t"step ${i}"\\path\\to\\file\t"ok"\n`).join('').slice(0, 9_800)
    expect(heavy.length).toBe(9_800)
    expect(jsonChars(heavy)).toBeGreaterThan(answerPolicy(op('task_get')).max)
    const args = { id: ID, fields: ['note'] }
    const result = mapped('task_get', { task: denseTask({ note: heavy }) }, args)
    const answer = agentAnswer(op('task_get'), args, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(answerPolicy(op('task_get')).max)
    if (answer.note !== heavy) {
      expect(answer.note).toMatch(MARKED)
      expect(answer.note_cut).toBe(`task_get {"id":"${ID}","fields":["note"],"_full":true} reads it whole`)
    }
    // A plain read of the same task points straight at `_full`: `fields` alone would not be whole.
    const plain = agentAnswer(op('task_get'), { id: ID }, mapped('task_get', { task: denseTask({ note: heavy }) }, { id: ID })) as Obj
    expect((plain.task as Obj).note_cut).toBe(`task_get {"id":"${ID}","fields":["note"],"_full":true} reads it whole`)
    expect(jsonChars((plain.task as Obj).note)).toBeLessThanOrEqual(TASK_GET_TEXT_MAX.note)
  })

  it('a cut note or description taken from task_get is refused by the writes that store it', () => {
    const answer = agentAnswer(op('task_get'), { id: ID }, mapped('task_get', body, { id: ID })) as Obj
    const task = answer.task as Obj
    expect(cutTextRefusal(op('task_note_write'), { id: ID, content: task.note })).toMatch(/task_note_write refused: `content`/)
    expect(cutTextRefusal(op('task_update'), { id: ID, description: task.description })).toMatch(/task_update refused: `description`/)
    // The whole text goes through.
    expect(cutTextRefusal(op('task_note_write'), { id: ID, content: NOTE })).toBeUndefined()
  })
})

describe('task_list and task_get_bulk hold their rows to one answer, with an honest count', () => {
  it('task_list gives the rows that fit and says how many it left out', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      id: `task-${i}`, title: `Task number ${i}`, phase: 'IN_PROGRESS', project: 'Walnut', updated_at: AT, user_state: 'working',
      user_status: { state: 'working', now: 'What it is doing right now, said at some length. '.repeat(8), at: AT },
      execution: { state: 'running' }, pinned: false,
    }))
    const result = { count: 50, total: 120, truncated: true, tasks }
    const answer = agentAnswer(op('task_list'), {}, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(answerPolicy(op('task_list')).max)
    expect(answer).not.toHaveProperty('_cut')
    const rows = answer.tasks as Obj[]
    expect(answer.count).toBe(rows.length)
    expect(answer.total).toBe(120)
    expect(answer.truncated).toBe(true)
    expect(rows[0].id).toBe('task-0')
    if (rows.length < 50) expect(String(answer.hint)).toMatch(/did not fit in this answer/)
  })

  it('task_get_bulk shares the answer between the rows\' long texts', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}`, phase: 'TODO', note: NOTE }))
    const result = { count: 30, errors: [], fields: ['title', 'phase', 'note'], tasks }
    const answer = agentAnswer(op('task_get_bulk'), { ids: tasks.map((t) => t.id), fields: ['note'] }, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(answerPolicy(op('task_get_bulk')).max)
    const rows = answer.tasks as Obj[]
    expect(rows[0].note_cut).toMatch(/task_get \{"id":"task-0","fields":\["note"\]\}/)
    expect(answer.count).toBe(rows.length)
  })
})

describe('task_history answers an agent the newest messages, compact, with how to page', () => {
  const history = { name: 'task_history', tags: { readonly: true, remote: 'allow' as const }, answer: TASK_HISTORY_ANSWER }
  const messages = Array.from({ length: 300 }, (_, i) => {
    const timestamp = new Date(Date.parse(AT) + i * 60_000).toISOString()
    return i % 3 === 0 ? { role: 'user', sentBy: 'person', text: `Person message ${i}`, timestamp }
      : i % 3 === 1 ? { role: 'assistant', kind: 'tool', text: 'Bash', detail: `run step ${i} ${'x'.repeat(400)}`, timestamp }
        : { role: 'assistant', text: `Reply ${i}: ${'a long reply line. '.repeat(150)}`, timestamp }
  })
  const result = { taskId: ID, messages, truncated: true, older: { before: messages[0].timestamp, how: 'old pointer' } }

  it('the default is the newest messages, compact, under its cap, with the call for the page before', () => {
    expect(size(result)).toBeGreaterThan(100_000)
    const answer = agentAnswer(history, { id: ID }, result) as Obj
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    expect(answer).not.toHaveProperty('_cut')
    const rows = answer.messages as Obj[]
    // The newest reply is whole up to the compact form's own clip; older ones give their gist.
    expect(rows.at(-1)!.text).toContain('Reply 299')
    expect(String(rows.at(-1)!.text).length).toBeGreaterThan(1_900)
    const replies = rows.filter((r) => r.role === 'assistant' && !r.kind)
    expect(replies.slice(0, -1).every((r) => String(r.text).length <= 600)).toBe(true)
    expectEveryCutMarked(answer)
    expect(rows.filter((r) => r.kind === 'tool').every((r) => String(r.text).length <= 160)).toBe(true)
    expect(rows.filter((r) => r.role === 'assistant' && !r.kind).length).toBeGreaterThan(2)
    expect(answer.truncated).toBe(true)
    const older = answer.older as { before: string; how: string }
    expect(older.before).toBe(rows.find((r) => typeof r.timestamp === 'string')!.timestamp)
    // The page before names no limit or form, so it is this same default again.
    expect(older.how).toBe(`walnut tools call task_history '${JSON.stringify({ id: ID, before: older.before })}'`)
    expect(String(answer.shown)).toMatch(/newest \d+ messages, compact/)
    expect((answer.left_out as { cutOlder: number }).cutOlder).toBeGreaterThan(0)
  })

  it('a caller that names its window or form keeps it, its newest rows held to the cap; `_full` gets the answer as the op gave it', () => {
    for (const args of [{ id: ID, limit: 50 }, { id: ID, compact: false }, { id: ID, since: AT }]) {
      const answer = agentAnswer(history, args, result) as Obj
      // The default shaping is skipped (no compact form); the cap holds by leaving out the oldest rows,
      // and the page before them is the same window (2026-11-24: the newest rows were the ones lost).
      const rows = answer.messages as Obj[]
      expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
      expect(rows.at(-1)!.timestamp).toBe(messages.at(-1)!.timestamp)
      expect(rows.some((r) => r.kind === 'tool' && String(r.detail).length > 400)).toBe(true)
      const older = answer.older as { before: string; how: string }
      expect(older.before).toBe(rows[0].timestamp)
      expect(older.how).toBe(`walnut tools call task_history '${JSON.stringify({ ...args, before: older.before })}'`)
    }
    // A window that fits is the op's own answer, its own `older` included.
    const small = { ...result, messages: messages.slice(-3) }
    expect(agentAnswer(history, { id: ID, limit: 1 }, small)).toBe(small)
    expect(agentAnswer(history, { id: ID }, result, true)).toBe(result)
    expect(AGENT_HISTORY_LIMIT).toBe(20)
  })
})
