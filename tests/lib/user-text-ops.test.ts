/**
 * Class guard of the one list of words a session's op hands the user (src/lib/user-text-ops.ts),
 * which the reply-language send gate and the link note read. Every core write op that takes prose
 * (an argument named like words someone reads: text, title, message, summary, ...) is listed there or
 * exempt with why, a new op included; every prose argument of a listed op is one it reads or one it
 * says why not, a new argument included.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { opInputJsonSchema, listOpEntries, getOp } from '../../src/ops/registry.js'
import { USER_TEXT_EXEMPT, USER_TEXT_OPS, opUserText } from '../../src/lib/user-text-ops.js'

/** The last segment of an argument path that names words someone reads. */
const PROSE = /^(text|title|subject|markdown|html|message|reply|summary|latest|next|note|content|ask|ask_more|ask_new|detail|why|description|result|prompt|label|question|instructions|start_message|new|since_you_wrote|user_kind_why|user_request|user_words|user_kind_words|waiting_on)$/

/** Every string argument path of an op's JSON schema (arrays walked, enums and constants left out). */
function stringPaths(schema: unknown, at = '', out: string[] = []): string[] {
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown; anyOf?: unknown[]; oneOf?: unknown[]; items?: unknown; properties?: Record<string, unknown> } | null
  if (!s || typeof s !== 'object') return out
  for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) stringPaths(alt, at, out)
  if (s.type === 'string' && s.enum === undefined && s.const === undefined && at) out.push(at)
  if (s.type === 'array') stringPaths(s.items, at, out)
  if (s.properties) for (const [k, v] of Object.entries(s.properties)) stringPaths(v, at ? `${at}.${k}` : k, out)
  return out
}

const prosePaths = (name: string): string[] =>
  [...new Set(stringPaths(opInputJsonSchema(getOp(name)!)))].filter((p) => PROSE.test(p.split('.').pop()!))

/** Ops that take prose nobody reads as a session's words to the user, with why. */
const NOT_FOR_THE_USER: Record<string, string> = {}

describe('every op that takes prose is classed for the user\'s words (guard)', () => {
  let core: string[] = []
  beforeAll(async () => {
    await import('../../src/ops/index.js')
    core = listOpEntries().filter((e) => e.owner === 'core' && !e.op.tags.readonly && !e.op.deprecated && prosePaths(e.op.name).length).map((e) => e.op.name)
  })

  it('lists each such op, a new one included', () => {
    const unclassed = core.filter((n) => !USER_TEXT_OPS[n] && !USER_TEXT_EXEMPT[n] && !NOT_FOR_THE_USER[n])
    expect(unclassed, 'add the op to USER_TEXT_OPS (its fields the user reads) or USER_TEXT_EXEMPT (why not)').toEqual([])
  })

  it('every prose argument of a listed op is read or says why not, a new argument included', () => {
    const missing: string[] = []
    for (const [name, spec] of Object.entries(USER_TEXT_OPS)) {
      for (const p of prosePaths(name)) if (!spec.fields.includes(p) && !spec.others?.[p]) missing.push(`${name}.${p}`)
    }
    expect(missing).toEqual([])
  })

  it('every field it names is one the op takes, and is a string', () => {
    const bad: string[] = []
    for (const [name, spec] of Object.entries(USER_TEXT_OPS)) {
      const op = getOp(name)
      if (!op) { bad.push(`${name}: no such op`); continue }
      const all = stringPaths(opInputJsonSchema(op))
      for (const f of [...spec.fields, ...Object.keys(spec.others ?? {})]) if (!all.includes(f)) bad.push(`${name}.${f}`)
    }
    for (const name of Object.keys(USER_TEXT_EXEMPT)) if (!getOp(name)) bad.push(`${name}: no such op`)
    expect(bad).toEqual([])
  })

  it('reads the listed fields, nested and in arrays, and nothing else', () => {
    const t = opUserText('thread_update', { id: 'th-1', reply: 'R', options: [{ id: 'a', label: 'L1' }, { id: 'b', label: 'L2', detail: 'D' }], user_words: 'his' })!
    expect(t.text.split('\n\n').sort()).toEqual(['D', 'L1', 'L2', 'R'])
    expect(opUserText('task_report_set', { id: 't', report: { ask: 'A', user_words: 'his' } })!.text).toBe('A')
    expect(opUserText('note_write', { content: 'x' })).toBeNull()
  })

  // 2026-11-23: a lead's thread_update with a Chinese summary was refused for its English
  // user_kind_why, a line Walnut checks and never shows him (user-kind-letter.ts drops it).
  it('never reads user_kind_why, which the user never sees', () => {
    const why = 'Which of 10 page-header looks he wants is his own taste call on a screen he uses all day.'
    for (const op of ['thread_update', 'thread_create', 'human_inbox_send']) {
      expect(opUserText(op, { reply: 'R', text: 'R', subject: 'R', user_kind_why: why })!.text).not.toContain(why)
    }
    expect(opUserText('task_report_set', { report: { ask: 'A', user_kind_why: why } })!.text).toBe('A')
  })
})
