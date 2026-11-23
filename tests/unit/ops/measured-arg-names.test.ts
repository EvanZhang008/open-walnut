/**
 * Argument names agents really sent for a declared one are read as it (WalnutOp.renamedInput).
 *
 * 2026-11-23: 72 hours of sessions on the Mac held 65 calls refused for their arguments, most of
 * them one well-known other name for a declared key (`message` for task_send's `text`,
 * `from_path` for host_copy's `from`, `summary` for thread_update's `reply`). Each cost the agent
 * a failed call and a retry. Each name below is from that record; search's `query` (2026-11-21)
 * is the first of them. A name the caller set both ways keeps the declared one. The answer's
 * walnut_note names each move, so the caller learns the declared name. A task or thread id under
 * another name (`task_id` for task_note_write's `id`) needs no entry: every op reads those
 * (src/ops/arg-hints.ts, unknown-key-hint.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { getOp, opInputJsonSchema, parseOpArgs } from '../../../src/ops/index.js'

const SEEN: [op: string, given: Record<string, unknown>, read: Record<string, unknown>][] = [
  ['search', { query: 'walnut' }, { q: 'walnut' }],
  ['host_copy', { from_path: '/a/b.txt', to_path: '/c/b.txt' }, { from: '/a/b.txt', to: '/c/b.txt' }],
  ['task_send', { task_id: 'abc', message: 'hello' }, { to: 'abc', text: 'hello' }],
  ['task_send', { id: 'abc', message: 'hello' }, { to: 'abc', text: 'hello' }],
  ['thread_update', { thread_id: 'th-abc123', summary: 'Done.' }, { id: 'th-abc123', reply: 'Done.' }],
  ['task_note_write', { task_id: 'abc', content: 'x' }, { id: 'abc', content: 'x' }],
  ['agent_memory_write', { text: 'a fact' }, { content: 'a fact' }],
  ['agent_skill_write', { name: 'deploy', description: 'When to deploy', text: 'Steps' }, { name: 'deploy', description: 'When to deploy', content: 'Steps' }],
  ['task_complete', { id: 'abc', summary: 'Shipped.' }, { id: 'abc', result: 'Shipped.' }],
  ['task_not_done_settle', { id: 'abc', how: 'dropped', reason: 'Not needed.' }, { id: 'abc', how: 'dropped', note: 'Not needed.' }],
  // 2026-11-23, the next three days of the same record.
  ['task_send', { task: 'abc', text: 'hello' }, { to: 'abc', text: 'hello' }],
  ['note_edit', { path: 'a.md', old_string: 'x', new_string: 'y' }, { path: 'a.md', old_str: 'x', new_str: 'y' }],
  ['task_note_write', { id: 'abc', note: 'x' }, { id: 'abc', content: 'x' }],
  ['thread_create', { title: 'T', text: 'The post', from: 'node', summary: 'The card' }, { title: 'T', text: 'The post', from: 'node', reply: 'The card' }],
]

describe('a name agents really sent is read as the declared one', () => {
  for (const [name, given, read] of SEEN) {
    it(`${name} ${Object.keys(given).join(', ')}`, () => {
      const op = getOp(name)
      expect(op, name).toBeDefined()
      const r = parseOpArgs(op!, given)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(r.ok && r.args).toMatchObject(read)
      for (const k of Object.keys(given)) if (!(k in read)) expect(r.ok && r.renamed?.map(([from]) => from), k).toContain(k)
      // The other name is never also passed on, nor offered in the catalog.
      for (const k of Object.keys(given)) {
        if (!(k in read)) {
          expect(r.ok && Object.hasOwn(r.args, k), k).toBe(false)
          expect(Object.keys((opInputJsonSchema(op!).properties ?? {}) as object), k).not.toContain(k)
        }
      }
    })
  }

  it('a call that names both with the same value reads once; with different values it is refused', () => {
    expect(parseOpArgs(getOp('task_send')!, { to: 'abc', task_id: 'abc', text: 'same', message: 'same' }))
      .toEqual({ ok: true, args: { to: 'abc', text: 'same' } })
    const r = parseOpArgs(getOp('task_send')!, { to: 'abc', task_id: 'other', text: 'kept', message: 'not the same' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/task_id/)
    expect(!r.ok && r.message).toMatch(/message/)
  })

  it('the value moves as it came: never trimmed, never cut, so an over-long one is refused, not shortened', () => {
    const long = 'x'.repeat(40_001)
    const r = parseOpArgs(getOp('agent_memory_write')!, { text: long })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/content: Too big/)
    expect(parseOpArgs(getOp('agent_memory_write')!, { text: '  kept as is  ' }))
      .toEqual({ ok: true, args: { content: '  kept as is  ' }, renamed: [['text', 'content']] })
    // A wrong type under the other name is refused under the declared one.
    const typed = parseOpArgs(getOp('host_copy')!, { from_path: 7, to: '/x' })
    expect(typed.ok).toBe(false)
    expect(!typed.ok && typed.message).toMatch(/from:/)
  })
})
