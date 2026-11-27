/**
 * Unknown op argument keys (src/ops/arg-hints.ts, used by parseOpArgs in src/ops/executor.ts).
 *
 * An agent calling `search` with `query` used to read only
 * `Unrecognized key: "query"` and had to fetch the op's help to learn the key is
 * `q`. A key whose meaning is certain (a spelling of a declared key, another name
 * for the task, thread or letter the call is about, a usual other name) is read as
 * that key when the call then validates, and the answer's note says so
 * (2026-11-23: 1,389 such refusals on one host in three days). Anything else is
 * refused, from the call as it came, with a hint that names the intended key when
 * it is clear (a one or two character typo, or the only missing required key next
 * to the only unknown one) and stays silent otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePluginOp, executeOp, getOp, getOpOwner, listOps, parseOpArgs } from '../../../src/ops/index.js'
import { KEY_NOTES, editDistance, inferRenames } from '../../../src/ops/arg-hints.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import type { WalnutOp } from '../../../src/ops/registry.js'

const op = (name: string) => getOp(name)!
const fakeOp = (input: Record<string, z.ZodTypeAny>) => ({ name: 'fake_op', input }) as unknown as WalnutOp

function refusal(o: WalnutOp, args: Record<string, unknown>): string {
  const r = parseOpArgs(o, args)
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.message
}

describe('a typo of a declared key', () => {
  it('names the key one swap away', () => {
    expect(refusal(op('task_update'), { id: 't1', titel: 'Rename' }))
      .toMatch(/^Invalid arguments for task_update: \(root\): Unrecognized key: "titel"; did you mean "title"\?; task_update takes: id, /)
  })

  it('names the key one or two edits away', () => {
    expect(refusal(op('task_update'), { id: 't1', phse: 'TODO' })).toContain('Unrecognized key: "phse"; did you mean "phase"?')
    expect(refusal(op('search'), { q: 'x', limt: 5 })).toContain('; did you mean "limit"?')
    expect(refusal(op('task_update'), { id: 't1', descrption: 'x' })).toContain('; did you mean "description"?')
    expect(refusal(op('task_update'), { id: 't1', descriptoin_: 'x' })).toContain('; did you mean "description"?')
  })

  it('a case-only difference in a call that fails anyway is hinted, and wins over a missing required key', () => {
    const msg = refusal(op('search'), { Limit: 5 })
    expect(msg).toContain('Unrecognized key: "Limit"; did you mean "limit"?')
    expect(msg).not.toContain('did you mean "q"')
    expect(refusal(fakeOp({ task_id: z.string().optional(), name: z.string() }), { taskID: 't1' })).toContain('; did you mean "task_id"?')
  })

  it('hints in a nested object, through optional wrappers', () => {
    const o = fakeOp({ meta: z.object({ name: z.string().optional() }).strict().optional() })
    expect(refusal(o, { meta: { nmae: 'x' } })).toContain('meta: Unrecognized key: "nmae"; did you mean "name"?')
  })

  it('hints inside a list item at that item\'s path', () => {
    expect(refusal(op('task_update_bulk'), { updates: [{ id: 't1', titel: 'x' }] }))
      .toContain('updates.0: Unrecognized key: "titel"; did you mean "title"?')
  })

  it('never rewrites the call', () => {
    const raw = { id: 't1', titel: 'Rename' }
    expect(parseOpArgs(op('task_update'), raw).ok).toBe(false)
    expect(raw).toEqual({ id: 't1', titel: 'Rename' })
  })
})

// An op shaped like the old search: `query` is a usual other name of `q`, so it is read as q.
const oldSearch = fakeOp({ q: z.string().min(1), limit: z.number().optional() })

describe('one missing required key next to one unknown key', () => {
  it('an op called with an unrelated name instead of q', () => {
    const msg = refusal(oldSearch, { phrase: 'deploy failures' })
    expect(msg).toContain('(root): Unrecognized key: "phrase"; did you mean "q"?')
    // The missing key is still reported as its own issue.
    expect(msg).toContain('q: ')
  })

  it('search takes query as q, and says so', () => {
    expect(parseOpArgs(op('search'), { query: 'deploy failures' }))
      .toEqual({ ok: true, args: { q: 'deploy failures' }, renamed: [['query', 'q']] })
  })

  it('works with a key too far to match by spelling', () => {
    expect(refusal(fakeOp({ id: z.string() }), { task_id: 't1' })).toContain('Unrecognized key: "task_id"; did you mean "id"?')
  })
})

describe('no guess when the intended key is not clear', () => {
  it('several unknown keys and one missing required key', () => {
    const msg = refusal(oldSearch, { query: 'x', text: 'y' })
    expect(msg).toContain('Unrecognized keys: "query", "text"')
    expect(msg).not.toContain('did you mean')
  })

  it('an unrelated key when nothing required is missing', () => {
    expect(refusal(op('search'), { q: 'x', banana: 1 })).not.toContain('did you mean')
    expect(refusal(op('task_get'), { id: 't1', wait_report: 'x' })).not.toContain('did you mean')
  })

  it('a one-letter key is no typo of another one-letter key', () => {
    expect(refusal(fakeOp({ q: z.string().optional() }), { x: 'a' })).not.toContain('did you mean')
  })

  it('two declared keys equally close', () => {
    expect(refusal(fakeOp({ cat: z.string().optional(), car: z.string().optional() }), { cax: 'a' })).not.toContain('did you mean')
  })

  it('two unknown keys aimed at the same declared key', () => {
    const msg = refusal(fakeOp({ title: z.string().optional() }), { titel: 'a', tilte: 'b' })
    expect(msg).not.toContain('did you mean')
  })

  it('a key the call already set is not offered again, nor is the runner-up', () => {
    expect(refusal(op('task_update'), { id: 't1', title: 'a', titel: 'b' })).not.toContain('did you mean')
    const o = fakeOp({ title: z.string().optional(), tile: z.string().optional() })
    expect(refusal(o, { title: 'a', titel: 'b' })).not.toContain('did you mean')
  })

  it('a tied near miss is not read as a stand-in for the missing required key', () => {
    const o = fakeOp({ cat: z.string().optional(), car: z.string().optional(), name: z.string() })
    expect(refusal(o, { cax: 'a' })).not.toContain('did you mean')
  })

  it('a key that is a near miss of a set key is not read as a stand-in either', () => {
    const o = fakeOp({ title: z.string().optional(), name: z.string() })
    expect(refusal(o, { title: 'a', titel: 'b' })).not.toContain('did you mean')
  })

  it('a schema it cannot walk (union) gets no hint and no crash', () => {
    const o = fakeOp({ v: z.union([z.object({ a: z.string() }).strict(), z.string()]) })
    expect(refusal(o, { v: { b: 'x' } })).not.toContain('did you mean')
    expect(parseOpArgs(op('search'), ['q'] as unknown as Record<string, unknown>).ok).toBe(false)
    expect(parseOpArgs(op('task_update_bulk'), { updates: [null, { id: 't1', titel: 'x' }] }).ok).toBe(false)
  })
})

describe('several unknown keys, each judged on its own', () => {
  it('hints the typo and leaves the unrelated key alone', () => {
    expect(refusal(op('task_update'), { id: 't1', titel: 'x', banana: 1 }))
      .toContain('Unrecognized keys: "titel", "banana"; did you mean "title" for "titel"?')
  })
})

describe('retired fields are still dropped, never hinted or counted', () => {
  it('a retired field next to a typo', () => {
    const msg = refusal(op('task_update'), { id: 't1', wait_report: 'x', titel: 'y' })
    expect(msg).toMatch(/^Invalid arguments for task_update: \(root\): Unrecognized key: "titel"; did you mean "title"\?; task_update takes: /)
    expect(msg).not.toContain('wait_report')
  })

  it('a retired field does not count as a second unknown key', () => {
    expect(refusal(op('task_update'), { task_id: 't1', wait_report: 'x', phase: 'NOPE' })).toContain('Unrecognized key: "task_id"; did you mean "id"?')
  })

  it('a call with only a retired extra still passes', () => {
    // task_update carries wait_report's text into waiting_on (renamedInput); trigger_create drops it.
    expect(parseOpArgs(op('task_update'), { id: 't1', wait_report: 'x' }))
      .toEqual({ ok: true, args: { id: 't1', waiting_on: 'x' }, renamed: [['wait_report', 'waiting_on']] })
  })
})

describe('editDistance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('titel', 'title')).toBe(1)
    expect(editDistance('query', 'q')).toBe(4)
    expect(editDistance('', 'ab')).toBe(2)
    expect(editDistance('same', 'same')).toBe(0)
  })
})

// 2026-11-01: a small local model on OpenCode called task_list with `query`; told
// only `Unrecognized key: "query"`, it gave up and told the user they had used a
// wrong parameter.
describe('a usual other name for a declared key', () => {
  it('task_list called with query, search or keyword reads it as q', () => {
    for (const key of ['query', 'search', 'keyword']) {
      const r = parseOpArgs(op('task_list'), { [key]: 'garden', project: 'Side projects' })
      expect(r.ok && r.args).toMatchObject({ q: 'garden', project: 'Side projects' })
      expect(r.ok && r.renamed).toEqual([[key, 'q']])
    }
  })

  it('a call that fails another way is refused as it came, with the hint', () => {
    expect(refusal(op('task_list'), { query: 'garden', limit: 'many' }))
      .toMatch(/^Invalid arguments for task_list: .*\(root\): Unrecognized key: "query"; did you mean "q"\?; task_list takes: /)
  })

  it('limit under another name', () => {
    expect(parseOpArgs(op('task_list'), { max: 5 })).toMatchObject({ ok: true, args: { limit: 5 } })
    expect(refusal(op('task_list'), { max: 'five' })).toContain('did you mean "limit"?')
  })

  it('not when the call already set the declared key', () => {
    expect(refusal(op('task_list'), { q: 'a', query: 'b' })).not.toContain('did you mean')
  })
})

describe('an unknown key with no clear intended key names the keys the op takes', () => {
  it('lists the declared keys', () => {
    const msg = refusal(op('task_list'), { banana: 1 })
    expect(msg).toContain('Unrecognized key: "banana"; task_list takes: ')
    expect(msg).toContain(' q,')
    expect(msg).toContain('project')
  })

  it('names a nested object by its path', () => {
    const msg = refusal(fakeOp({ opts: z.strictObject({ deep: z.string().optional() }).optional() }), { opts: { banana: 1 } })
    expect(msg).toContain('fake_op opts takes: deep')
  })

  // 2026-11-06: a wrong guess alone still cost a `tools help` round trip.
  it('a refusal with a "did you mean" adds the list after it', () => {
    const msg = refusal(op('task_update'), { id: 't1', titel: 'x' })
    expect(msg.indexOf('did you mean "title"?')).toBeLessThan(msg.indexOf('; task_update takes: '))
    expect(msg).toContain(' title,')
  })

  it('shows at most 40 keys, then an ellipsis', () => {
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`key_${String(i).padStart(2, '0')}`, z.string().optional()]))
    const msg = refusal(fakeOp(many), { banana: 1 })
    expect(msg).toContain('key_39, …')
    expect(msg).not.toContain('key_40')
  })
})

// 2026-11-06: agents sent the message under another name (prompt for text, text for message).
describe('a message under another name, only where the op declares one such key', () => {
  it('prompt reads as text for task_send and as message for task_start', () => {
    expect(parseOpArgs(op('task_send'), { to: 't1', prompt: 'hi' })).toMatchObject({ ok: true, args: { to: 't1', text: 'hi' } })
    expect(parseOpArgs(op('task_start'), { id: 't1', prompt: 'hi' })).toMatchObject({ ok: true, args: { id: 't1', message: 'hi' } })
    expect(parseOpArgs(op('task_start'), { id: 't1', text: 'hi' })).toMatchObject({ ok: true, args: { id: 't1', message: 'hi' } })
    // task_send reads `message` as `text` since 2026-11-23 (renamedInput, measured-arg-names.test.ts).
    expect(parseOpArgs(op('task_send'), { to: 't1', message: 'hi' }))
      .toEqual({ ok: true, args: { to: 't1', text: 'hi' }, renamed: [['message', 'text']] })
  })

  it('no guess when the op declares both keys a name could mean', () => {
    const o = fakeOp({ text: z.string().optional(), message: z.string().optional() })
    expect(refusal(o, { prompt: 'hi' })).not.toContain('did you mean')
  })

  it('no guess when the call already set the key', () => {
    expect(refusal(op('task_send'), { to: 't1', text: 'a', prompt: 'b' })).not.toContain('did you mean')
  })
})

describe('a well-known wrong key says what to do instead', () => {
  it('task_list with include_completed: completed tasks are in by default, completion leaves them out', () => {
    const msg = refusal(op('task_list'), { include_completed: true })
    expect(msg).toContain('Unrecognized key: "include_completed"; "include_completed" is no key here: completed tasks are already listed by default')
    expect(msg).toContain('pass "completion"')
    expect(msg).toContain('; task_list takes: completion,')
  })

  it('only on an op that has the key that does it', () => {
    expect(refusal(fakeOp({ q: z.string().optional() }), { include_completed: true })).not.toContain('is no key here')
  })
})

// 2026-11-06: `walnut tools call search '{"q":"controller","types":["task","session"]}'`.
// Since 2026-11-21 search takes that list as it is; task_list's phases still take one string.
describe('a list where the op takes one comma-separated string', () => {
  it('search takes types as a list or as a string', () => {
    expect(parseOpArgs(op('search'), { q: 'controller', types: ['task', 'session'] })).toEqual({ ok: true, args: { q: 'controller', types: ['task', 'session'] } })
    expect(parseOpArgs(op('search'), { q: 'controller', types: 'task,session' }).ok).toBe(true)
    expect(parseOpArgs(op('search'), { q: 'controller', types: ['tasks'] }).ok).toBe(false)
  })

  it('task_list phases too', () => {
    expect(refusal(op('task_list'), { phases: ['TODO', 'IN_PROGRESS'] })).toContain('e.g. "TODO,IN_PROGRESS", not a list')
  })

  it('no example for a string field that is no comma list, a list of objects, or an empty list', () => {
    expect(refusal(op('search'), { q: ['a', 'b'] })).not.toContain('comma-separated')
    expect(refusal(op('search'), { q: 'x', types: [{ a: 1 }] })).not.toContain('comma-separated')
    expect(refusal(op('search'), { q: 'x', types: [] })).not.toContain('comma-separated')
  })
})

// 2026-11-23: 1,389 refusals for an unknown key on one host in three days, most of them a key
// whose meaning was certain (search `query`, board_get `task_id`, task_history `task_id`).
describe('a key whose meaning is certain is read as it, and the answer says so', () => {
  const read = (name: string, args: Record<string, unknown>) => {
    const r = parseOpArgs(op(name), args)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r.ok ? r : { args: {}, renamed: undefined }
  }

  it('a spelling of a declared key: case, camelCase or snake_case', () => {
    expect(read('host_exec', { host: 'h', command: 'ls', timeoutMs: 3_000 })).toEqual({
      args: { host: 'h', command: 'ls', timeout_ms: 3_000 }, renamed: [['timeoutMs', 'timeout_ms']], ok: true,
    })
    expect(read('task_get', { ID: 't1' }).args).toEqual({ id: 't1' })
    expect(read('search', { q: 'x', Limit: 5 }).args).toEqual({ q: 'x', limit: 5 })
  })

  it('another name for the task, thread or letter the call is about', () => {
    for (const key of ['task', 'task_id', 'taskId', 'Task_ID']) {
      expect(read('task_history', { [key]: 't1' }).args, key).toEqual({ id: 't1' })
      expect(read('board_get', { [key]: 't1' }).args, key).toEqual({ task: 't1' })
    }
    expect(read('trigger_list', { task_id: 't1' }).args).toMatchObject({ task: 't1' })
    expect(read('thread_list', { task_id: 't1' }).args).toMatchObject({ task: 't1' })
    expect(read('thread_get', { thread: 'th-abc123' }).args).toMatchObject({ id: 'th-abc123' })
    expect(read('human_inbox_mark', { letter: 'lt-1', read: true }).args).toEqual({ id: 'lt-1', read: true })
    expect(read('human_inbox_reply', { id: 'lt-1', text: 'ok' }).args).toEqual({ letter: 'lt-1', text: 'ok' })
    expect(read('task_send', { task: 't1', text: 'hi' }).args).toEqual({ to: 't1', text: 'hi' })
  })

  it('an op with a thread id and a task reads each name as its own', () => {
    const r = read('thread_update', { thread_id: 'th-abc123', task_id: 't1', title: 'x' })
    expect(r.args).toEqual({ id: 'th-abc123', task: 't1', title: 'x' })
    expect(r.renamed).toEqual([['thread_id', 'id'], ['task_id', 'task']])
    expect(read('thread_update', { thread: 'th-abc123', title: 'x' }).args).toEqual({ id: 'th-abc123', title: 'x' })
  })

  it('the same value under both names reads once, with nothing to note (as renamedInput does)', () => {
    expect(read('task_note_write', { id: 'abc', task_id: 'abc', content: 'x' })).toEqual({ ok: true, args: { id: 'abc', content: 'x' } })
    expect(read('thread_update', { id: 'th-abc123', thread_id: 'th-abc123', title: 'x' })).toEqual({ ok: true, args: { id: 'th-abc123', title: 'x' } })
  })

  it('a plugin\'s op gets no id names, whatever its name', () => {
    const h = definePluginOp('task-sync', {
      name: 'task_sync_get', title: 't', description: 'A plugin op named like a task op.', input: { id: z.string().optional() },
      handler: async () => ({ ok: true }), tags: { readonly: true, remote: 'allow' },
    })
    try {
      expect(getOpOwner('task_sync_get')).toBe('task-sync')
      expect(refusal(op('task_sync_get'), { task_id: 'x' })).toContain('Unrecognized key: "task_id"')
      expect(refusal(op('task_sync_get'), { task_id: 'x' })).not.toContain('did you mean')
    } finally { void h.dispose() }
  })

  it('a board op\'s own id is a post or a project, so a bare id is never read as its task', () => {
    expect(read('board_post_delete', { task_id: 't1', thread: 'th-abc123', id: 'bm-1' }).args)
      .toEqual({ task: 't1', thread: 'th-abc123', id: 'bm-1' })
    expect(read('board_get', { task_id: 't1' }).args).toEqual({ task: 't1' })
    const msg = refusal(op('board_post'), { id: 'bm-1', thread: 'th-abc123', text: 'x' })
    expect(msg).toContain('Unrecognized key: "id"; "id" is no key here: the board\'s task is "task"')
    expect(refusal(op('board_get'), { id: 't1' })).toContain('"id" is no key here: the board\'s task is "task"')
    // An id names no task on an op that is not about one (a trigger id, a memory file).
    expect(refusal(op('trigger_list'), { id: 'tr-1' })).toContain('Unrecognized key: "id"')
  })

  it('a usual other name, where the op declares exactly one key it can mean', () => {
    expect(read('task_create', { title: 'T', prompt: 'do it' }).args).toEqual({ title: 'T', message: 'do it' })
    expect(read('task_list', { query: 'x' }).args).toMatchObject({ q: 'x' })
    // A plugin's op gets it from its own schema, as slack_search with `query` does.
    const plugin = { name: 'chat_search', input: { q: z.string().min(1), limit: z.number().optional() } } as unknown as WalnutOp
    expect(parseOpArgs(plugin, { query: 'deploy' })).toEqual({ ok: true, args: { q: 'deploy' }, renamed: [['query', 'q']] })
  })

  it('the caller\'s object is never edited', () => {
    const raw = { task_id: 't1' }
    read('task_history', raw)
    expect(raw).toEqual({ task_id: 't1' })
  })
})

describe('a key read under another name stays a refusal when', () => {
  it('it is in another unit: the refusal names the key and its unit', () => {
    for (const key of ['timeout', 'timeoutSeconds', 'timeout_seconds']) {
      const msg = refusal(op('host_exec'), { host: 'h', command: 'ls', [key]: 30 })
      expect(msg, key).toContain(`Unrecognized key: "${key}"; "${key}" is no key here: the time limit is "timeout_ms", in milliseconds`)
      expect(msg, key).not.toContain('did you mean')
    }
    expect(refusal(op('trigger_create'), { run: 'true', timeout: 30 })).toContain('the time limit is "timeoutSeconds", in seconds')
    expect(refusal(op('trigger_test'), { run: 'true', timeout: 30 })).toContain('the time limit is "timeoutSeconds", in seconds')
    expect(refusal(op('subagent_run'), { prompt: 'x', timeout: 5 })).toContain('the time limit is "timeout_min", in minutes')
    // The same unit in another spelling is read as it.
    expect(parseOpArgs(op('trigger_test'), { run: 'true', timeout_seconds: 30 })).toMatchObject({ ok: true, args: { timeoutSeconds: 30 } })
  })

  it('its value then fails validation: refused with the message of the call as it came', () => {
    const msg = refusal(op('task_get'), { task_id: 7 })
    expect(msg).toContain('(root): Unrecognized key: "task_id"; did you mean "id"?')
    expect(msg).toContain('id: Invalid input: expected string, received undefined')
    expect(msg).not.toContain('received number')
  })

  it('another key of the call is still wrong', () => {
    const msg = refusal(op('task_history'), { task_id: 't1', banana: 1 })
    expect(msg).toContain('Unrecognized keys: "task_id", "banana"')
  })

  it('the call also set the right key to another value', () => {
    expect(refusal(op('task_get'), { id: 't1', task_id: 't2' })).toContain('Unrecognized key: "task_id"')
    expect(refusal(op('task_note_write'), { id: 'abc', task_id: 'abd', content: 'x' })).toContain('Unrecognized key: "task_id"')
    expect(refusal(op('thread_update'), { id: 'th-abc123', thread_id: 'th-def456', title: 'x' })).toContain('Unrecognized key: "thread_id"')
  })

  it('a name that only often means the key is hinted, never read', () => {
    const letter = { subject: 's', type: 'review', markdown: 'the body', body: 'b' }
    expect(refusal(op('human_inbox_send'), letter))
      .toContain('Unrecognized key: "body"; "body" is no key here: the letter\'s body is "markdown" (or "html"); "text" is only the short preview')
    expect(refusal(op('task_list'), { filter: 'todo' }))
      .toContain('Unrecognized key: "filter"; "filter" is no key here: "q" searches titles; "phases" or "completion" filter by state')
    expect(refusal(op('task_create'), { title: 'T', record_only: true, content: 'details' }))
      .toContain('Unrecognized key: "content"; "content" is no key here: the task\'s text is "description"')
    // Elsewhere such a name is still a hint.
    expect(refusal(op('task_send'), { to: 't1', body: 'b' })).toContain('Unrecognized key: "body"; did you mean "text"?')
    // Where the key of that name means another thing (a message id), not even a hint.
    expect(refusal(op('thread_get'), { id: 'th-abc123', text: 'x' })).not.toContain('did you mean')
  })

  it('two names aim at one key', () => {
    expect(refusal(op('task_get'), { task: 't1', task_id: 't1' })).toContain('Unrecognized keys: "task", "task_id"')
  })

  it('the name stands in for an unrelated missing key (a guess, hinted only)', () => {
    expect(refusal(op('thread_split'), { id: 'th-abc123', from: 'tm-abc123' })).toContain('Unrecognized key: "from"; did you mean "message"?')
  })
})

describe('a wrong key with no key to read it as says what to do instead', () => {
  const CASES: [op: string, args: Record<string, unknown>, line: string][] = [
    ['task_update', { id: 't1', summary: 'Shipped.' }, '"summary" is no key here: "description" replaces the task\'s description, "report" sets what it waits on next'],
    ['task_note_write', { id: 't1', section: 'Plan', content: 'x' }, '"section" is no key here: the note is one Markdown text'],
    ['task_create', { title: 'T', parent_task_id: 't1' }, '"parent_task_id" is no key here: a task created from your task is filed as its subtask already'],
    ['agent_memory_read', { id: 't1' }, '"id" is no key here: "task" names whose memory to read'],
    ['thread_list', { id: 'th-abc123' }, '"id" is no key here: "task" names whose threads to list'],
    ['host_load', { host: 'h' }, '"host" is no key here: host_load reads every host; host_get "host" reads one'],
    ['trigger_delete', { name: 'nightly' }, '"name" is no key here: this takes the trigger\'s "id"'],
  ]
  for (const [name, args, line] of CASES) {
    it(`${name} ${Object.keys(args).join(', ')}`, () => {
      const msg = refusal(op(name), args)
      expect(msg).toContain(line)
      // The line is the whole story for that key: no guess beside it.
      expect(msg).not.toContain('did you mean')
    })
  }
})

describe('executeOp carries the note in the answer', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('walnut_note names the key read under its right name, after the op\'s own note', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ results: [], walnut_note: 'an op note' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const r = await executeOp('search', { query: 'walnut' }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(urls.some((u) => /[?&]q=walnut\b/.test(u)), urls.join(' ')).toBe(true)
    expect((r as { result: { walnut_note: string } }).result.walnut_note).toBe('an op note Read "query" as "q", the key search takes.')
  })

  it('a refusal after a rename says what the key was read as', async () => {
    const h = definePluginOp('rename-refusal-test', {
      name: 'rename_refusal_test_list', title: 't', description: 'A plugin op whose handler refuses.', input: { limit: z.number().optional() },
      handler: async () => { throw new Error('Nothing to list.') }, tags: { readonly: true, remote: 'allow' },
    })
    try {
      const r = await executeOp('rename_refusal_test_list', { max: 5 }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN })
      expect(r).toMatchObject({ ok: false, message: 'Nothing to list. (Read "max" as "limit", the key rename_refusal_test_list takes.)' })
    } finally { void h.dispose() }
  })

  it('an agent\'s shaped answer keeps it', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ results: [{ id: 't1', type: 'task', title: 'A' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await executeOp('search', { query: 'walnut' }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN, forAgent: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify((r as { result: unknown }).result)).toContain('Read \\"query\\" as \\"q\\", the key search takes.')
  })
})

/**
 * The class guard: every op in the registry that takes exactly one "which task" key (`task`,
 * `task_id`, or a task op's `id`) reads each other name of it as that key. A new op gets it with
 * no entry anywhere, or this fails. Each op is called with whatever else it requires, filled in
 * from its own refusals; an op this cannot fill is named.
 */
describe('every op with one which-task key reads the other names of it', () => {
  const TASK_NAMES = ['task', 'task_id', 'taskId']
  const taskKeys = (o: WalnutOp): string[] => Object.keys(o.input)
    .filter((k) => TASK_NAMES.includes(k) || (k === 'id' && /^(task|team)_/.test(o.name)))

  /** Args that validate with `key` set to a task id: the op's other required arguments filled in from its refusals. */
  function validArgs(o: WalnutOp, key: string): Record<string, unknown> | null {
    const args: Record<string, unknown> = { [key]: 'abc123' }
    for (let i = 0; i < 12; i++) {
      if (parseOpArgs(o, args).ok) return args
      const parsed = z.object(o.input).strict().safeParse(args)
      if (parsed.success) return null
      let filled = false
      for (const issue of parsed.error.issues) {
        if (!issue.path.length || issue.path[0] === key) continue
        const v = issue.code === 'invalid_value' ? issue.values[0]
          : issue.code === 'invalid_type' ? ({ string: 'abc123', number: 1, boolean: true, array: ['abc123'], object: {} } as Record<string, unknown>)[String(issue.expected)]
            : issue.code === 'too_small' && issue.origin === 'string' ? 'x'.repeat(Number(issue.minimum))
              // An id pattern such as /^th-[a-f0-9]{6,32}$/: its prefix and hex digits.
              : issue.code === 'invalid_format' && issue.format === 'regex' ? `${/^\/\^([a-z]+-)?/.exec(String((issue as { pattern?: unknown }).pattern))?.[1] ?? ''}abc123`
                : undefined
        let at: unknown = args
        for (const seg of issue.path.slice(0, -1)) at = typeof at === 'object' && at !== null ? (at as Record<PropertyKey, unknown>)[seg] : undefined
        if (v === undefined || typeof at !== 'object' || at === null) continue
        ;(at as Record<PropertyKey, unknown>)[issue.path[issue.path.length - 1]] = v
        filled = true
      }
      if (!filled) return null
    }
    return null
  }

  const ops = listOps({ includeDeprecated: true }).filter((o) => taskKeys(o).length === 1)

  it('finds the ops it holds', () => {
    expect(ops.map((o) => o.name)).toEqual(expect.arrayContaining(['task_get', 'task_history', 'board_get', 'thread_list', 'trigger_list', 'agent_memory_read']))
  })

  it('reads task, task_id and taskId (and a bare id, for a task or board op) as the key', () => {
    const unfilled: string[] = []
    const wrong: string[] = []
    for (const o of ops) {
      const key = taskKeys(o)[0]
      const args = validArgs(o, key)
      if (!args) { unfilled.push(o.name); continue }
      const others = TASK_NAMES.filter((n) => n !== key && !(n in o.input))
      if (!('id' in o.input) && /^(task|team)_/.test(o.name)) others.push('id')
      for (const name of others) {
        const { [key]: value, ...rest } = args
        const r = parseOpArgs(o, { ...rest, [name]: value })
        if (!r.ok || r.args[key] !== value || !r.renamed?.some(([from, to]) => from === name && to === key)) wrong.push(`${o.name} ${name}: ${r.ok ? JSON.stringify(r.args) : r.message.slice(0, 160)}`)
      }
    }
    expect(wrong).toEqual([])
    // Ops whose other required arguments this cannot make up: each is held by a case above or its own test.
    expect(unfilled).toEqual([])
  })
})

/** The registry-wide guards on what inferRenames may read a key as. */
describe('every op in the registry', () => {
  const ID_NAMES = ['id', 'ID', 'task', 'task_id', 'taskId', 'Task_ID', 'thread', 'thread_id', 'threadId', 'letter', 'letter_id', 'letterId']
  const KIND: Record<string, RegExp> = { task: /task/i, thread: /thread/i, letter: /letter/i }
  const kindOf = (name: string): string | undefined => (/^task/i.test(name) ? 'task' : /^thread/i.test(name) ? 'thread' : /^letter/i.test(name) ? 'letter' : undefined)
  const descriptionOf = (schema: unknown): string => {
    for (let s = schema as { description?: string; _zod?: { def?: { innerType?: unknown } } } | undefined, i = 0; s && i < 8; i++) {
      if (s.description) return s.description
      s = s._zod?.def?.innerType as typeof s
    }
    return ''
  }

  it('never reads a key that has its own line (KEY_NOTES) as another key', () => {
    const read: string[] = []
    for (const o of listOps({ includeDeprecated: true })) {
      const core = getOpOwner(o.name) === 'core'
      for (const n of KEY_NOTES) {
        if (n.ops && !n.ops.includes(o.name)) continue
        if (n.declared && !(n.declared in o.input)) continue
        for (const key of n.keys) {
          if (key in o.input) continue
          for (const r of inferRenames(o.name, o.input, { [key]: 'x' }, [key], core)) read.push(`${o.name} ${key} -> ${r.to}`)
        }
      }
    }
    expect(read).toEqual([])
  })

  it('reads an id name only as a key of the same thing: a task, thread or letter key, or an `id` its description says is one', () => {
    const wrong: string[] = []
    for (const o of listOps({ includeDeprecated: true })) {
      const core = getOpOwner(o.name) === 'core'
      for (const name of ID_NAMES) {
        if (name in o.input) continue
        for (const r of inferRenames(o.name, o.input, { [name]: 'x' }, [name], core)) {
          // A spelling of the key itself (`ID` for `id`) is that key, whatever it names.
          if (r.to.toLowerCase().replace(/[_-]/g, '') === name.toLowerCase().replace(/[_-]/g, '')) continue
          const kind = r.to === 'id' ? undefined : kindOf(r.to)
          // A bare `id` may name any of the three; a named one only its own kind.
          const wanted = kindOf(name)
          const ok = r.to === 'id'
            ? Object.entries(KIND).some(([k, re]) => (!wanted || wanted === k) && re.test(descriptionOf(o.input.id)))
            : kind !== undefined && (!wanted || wanted === kind)
          if (!ok) wrong.push(`${o.name} ${name} -> ${r.to}${r.to === 'id' ? ` ("${descriptionOf(o.input.id).slice(0, 60)}")` : ''}`)
        }
      }
    }
    expect(wrong, 'an op whose key of that name means another thing: give it its own KEY_NOTES line, or rename the key').toEqual([])
  })
})

// 2026-11-26 and 27 (real calls, both hosts' transcripts): a value of another kind than the key takes
// was refused with the types alone, and memory_read's `query` was told "did you mean doc".
describe('a value of the wrong kind names what its key takes', () => {
  it('an object key given a string, and a choice given a list, get the key\'s own description', () => {
    expect(refusal(op('host_exec'), { host: 'devbox', command: 'git log', wait_for: 'exit' }))
      .toMatch(/wait_for: Invalid input: expected object, received string; wait_for is: Return as soon as one holds/)
    expect(refusal(op('task_list'), { scope: 'all', fields: ['id', 'title', 'phase'] }))
      .toContain('; fields is: list = slim rows (default); full = every field')
  })

  it('a choice given a wrong word keeps zod\'s list of options alone; a key left out is told it is required, as before', () => {
    const sort = refusal(op('task_list'), { sort: 'updated' })
    expect(sort).toContain('expected one of')
    expect(sort).not.toContain('sort is:')
    expect(refusal(op('host_exec'), { command: 'echo' })).not.toContain(' is: ')
  })

  it('a list where one comma-separated string goes keeps its own spelled-out line', () => {
    const msg = refusal(op('task_list'), { ids: ['mw72orri-8a87'] })
    expect(msg).toContain('ids takes one comma-separated string')
    expect(msg).not.toContain('ids is:')
  })

  it('memory_read asked to search is sent to search, never to "doc"', () => {
    const msg = refusal(op('memory_read'), { query: 'companion deploy' })
    expect(msg).toContain('use search "q"')
    expect(msg).not.toContain('did you mean "doc"')
  })
})
