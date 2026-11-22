/**
 * Every op's answer to an agent is small by construction (src/ops/answer.ts).
 *
 * 2026-11-21: seven days of sessions made 27,251 Walnut calls. 1,712 answers were
 * over 10,000 characters and 207 were cut by the agent's own harness, which showed
 * a write that had succeeded as a failure (thread_update answered 27,446 characters:
 * the whole thread it had just changed).
 *
 * The class this guards: an op whose answer can grow with the user's data. It fails
 * when ANY op, a new one included, answers more than its cap for a large object,
 * when a write answers content without being on the list below, or when an op
 * declares a cap over the ceiling.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { listOps, executeOp, getOp } from '../../src/ops/index.js'
import { definePluginOp } from '../../src/ops/registry.js'
import {
  ANSWER_CEILING_CHARS, ANSWER_SURFACES, ANSWER_SURFACE_NAMES, CONTENT_MAX_CHARS, RECEIPT_MAX_CHARS, agentAnswer, answerFit, answerPolicy,
  cutMark, cutTextPath, cutTextRefusal, cutToFit, printedSize, surfaceOf, type AnswerSurface,
} from '../../src/ops/answer.js'
import { PAGE_MARK } from '../../src/ops/doc-page.js'
import { cliAnswerText } from '../../src/lib/tool-answer-size.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

/**
 * The writes whose answer is what they ran or fetched, not the object they changed.
 * Adding a name here is a decision: say in the op why its answer is content, and give it a cap.
 */
const CONTENT_WRITES = [
  'api', 'approval_wait', 'browser', 'host_copy', 'host_exec', 'host_exec_pinned', 'host_http',
  'host_mcp_call', 'mcp_call', 'org_report', 'password_use', 'password_wait', 'subagent_run', 'subagent_send', 'trigger_create',
  'trigger_test',
].sort()

const size = (v: unknown): number => JSON.stringify(v).length

/** An answer shaped like the user's real data at its worst: a long text, a long list, a nested echo. */
function largeResult(): Record<string, unknown> {
  const text = 'A line of the note that goes on. '.repeat(900)
  const row = (i: number) => ({ id: `id-${i}`, title: `Row ${i}`, text: text.slice(0, 2_000), tags: ['a', 'b'], nested: { note: text.slice(0, 1_500) } })
  return {
    id: 'obj-1',
    ok: true,
    outcome: 'Saved.',
    next: 'Nothing else is required.',
    task: { id: 't-1', title: 'A task', note: text, summary: text.slice(0, 3_000), field_at: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, '2026-11-21T00:00:00.000Z'])) },
    thread: { id: 'th-1', messages: Array.from({ length: 80 }, (_, i) => row(i)) },
    items: Array.from({ length: 120 }, (_, i) => row(i)),
    output: text,
  }
}

describe('every op answers an agent within its cap', () => {
  const ops = listOps({ includeDeprecated: true })

  it('there are ops to check', () => {
    expect(ops.length).toBeGreaterThan(150)
  })

  it('no op, whatever its result, answers more than its cap', () => {
    const big = largeResult()
    expect(size(big)).toBeGreaterThan(300_000)
    const over: string[] = []
    for (const op of ops) {
      // An op answered whole for every call (a check script's read) has no cap to hold; the list below names each.
      if (op.answer?.whole_for?.({})) continue
      const policy = answerPolicy(op)
      const answer = agentAnswer(op, {}, big)
      if (size(answer) > policy.max) over.push(`${op.name}: ${size(answer)} > ${policy.max}`)
    }
    expect(over).toEqual([])
  })

  it('no op declares a cap over the ceiling, and a default cap is the kind\'s', () => {
    for (const op of ops) {
      const policy = answerPolicy(op)
      expect(policy.max, op.name).toBeLessThanOrEqual(ANSWER_CEILING_CHARS)
      if (op.answer?.max === undefined) expect(policy.max, op.name).toBe(policy.kind === 'receipt' ? RECEIPT_MAX_CHARS : CONTENT_MAX_CHARS)
    }
  })

  it('a write answers a receipt unless it is one of the listed writes that return what they ran', () => {
    const contentWrites = ops.filter((op) => !op.tags.readonly && answerPolicy(op).kind === 'content').map((op) => op.name).sort()
    expect(contentWrites).toEqual(CONTENT_WRITES.filter((name) => ops.some((op) => op.name === name)))
    // A read is never a receipt: its answer is what was asked for.
    expect(ops.filter((op) => op.tags.readonly && answerPolicy(op).kind === 'receipt').map((op) => op.name)).toEqual([])
  })

  it('only a hook\'s or a check script\'s read and an inline image are answered uncut', () => {
    expect(ops.filter((op) => op.answer?.whole_for).map((op) => op.name).sort()).toEqual(['agent_memory_read', 'browser', 'link_check', 'open_items', 'trigger_template_check'])
    const op = ops.find((o) => o.name === 'open_items')!
    const big = largeResult()
    expect(agentAnswer(op, { hook: 'compact' }, big)).toBe(big)
    expect(size(agentAnswer(op, {}, big))).toBeLessThanOrEqual(answerPolicy(op).max)
  })

  it('an op that names how to read the whole object names an op that exists', () => {
    const names = new Set(ops.map((op) => op.name))
    for (const op of ops) {
      const whole = op.answer?.whole
      if (!whole) continue
      expect(names.has(whole.split(/[\s{]/)[0]), `${op.name}: ${whole}`).toBe(true)
    }
  })
})

/**
 * A long Markdown document: headings, paragraphs with quotes and newlines, a code fence. `cjk`
 * writes its prose in Chinese (3 UTF-8 bytes a character), given as escapes per the repo's rule.
 */
function markdown(sections: number, cjk = false): string {
  const prose = cjk ? '\u8fd9\u662f\u4e00\u4e2a\u5f88\u957f\u7684\u6587\u6863\uff0c\u5b83\u8bf4\u4e86"\u5f88\u591a"\u4e8b\u60c5\u3002 ' : 'The rule says "keep going" and the next line follows. '
  const parts = ['# A long document\n\nIntro.\n']
  for (let i = 0; i < sections; i++) {
    parts.push(`## Section ${i}\n\n${prose.repeat(30)}\n${prose.repeat(12)}\n`)
    if (i % 7 === 3) parts.push('```bash\n# not a heading\necho "hi"\n```\n')
  }
  return parts.join('\n')
}

/** The keys a document op reads its text from (doc-page.ts pagedResult paths), each as a result. */
const DOC_PATHS = ['skill.content', 'skill.text', 'memory.content', 'content', 'text', 'memory.text', 'answer', 'output']
function docResult(path: string, text: string): Record<string, unknown> {
  const keys = path.split('.')
  const leaf: Record<string, unknown> = { [keys[keys.length - 1]]: text, id: 'sa-0123abcd', path: 'Projects/Big', contentHash: 'h1', name: 'big' }
  return keys.length === 1 ? { ...leaf, outcome: 'Read.', next: 'Nothing else is required.' } : { [keys[0]]: leaf, outcome: 'Read.', next: 'Nothing else is required.' }
}

describe('every op answers within what each surface keeps, printed as that surface prints it', () => {
  const ops = listOps({ includeDeprecated: true })

  it('each surface holds an answer well under what its agent\'s harness keeps, and the CLI counts its pretty print', () => {
    expect(ANSWER_SURFACE_NAMES.sort()).toEqual(['cli', 'mcp'])
    for (const name of ANSWER_SURFACE_NAMES) {
      const s = ANSWER_SURFACES[name]
      expect(s.keeps - s.max, name).toBeGreaterThanOrEqual(1_000)
    }
    // Answers of 10 KB were saved to a file and ones under about 9 KB passed: the CLI keeps a fifth spare.
    expect(ANSWER_SURFACES.cli.max).toBeLessThanOrEqual(Math.floor(ANSWER_SURFACES.cli.keeps * 0.8))
    expect(ANSWER_CEILING_CHARS).toBe(Math.max(...ANSWER_SURFACE_NAMES.map((n) => ANSWER_SURFACES[n].max)))
    const v = { a: '\u4e2d\u6587', b: [1, 2] }
    expect(printedSize(v, 'cli')).toBe(Buffer.byteLength(cliAnswerText(v), 'utf-8'))
    expect(printedSize(v, 'mcp')).toBe(JSON.stringify(v).length)
  })

  it('a caller that names no surface, or one it does not know, gets the CLI\'s smaller cap', () => {
    expect(surfaceOf('mcp')).toBe('mcp')
    expect(surfaceOf('cli')).toBe('cli')
    expect(surfaceOf(undefined)).toBe('cli')
    expect(surfaceOf('unknown')).toBe('cli')
  })

  // The class: every op, every surface, every result an op's data can grow into.
  const fixtures: Array<[string, () => unknown]> = [
    ['large', largeResult],
    ...DOC_PATHS.flatMap((p): Array<[string, () => unknown]> => [
      [`doc ${p}`, () => docResult(p, markdown(60))],
      [`non-ASCII doc ${p}`, () => docResult(p, markdown(40, true))],
    ]),
  ]
  for (const surface of ANSWER_SURFACE_NAMES) {
    it(`no op answers more than the ${surface} surface keeps, for any of its results`, () => {
      const limit = ANSWER_SURFACES[surface].max
      const over: string[] = []
      for (const op of ops) {
        if (op.answer?.whole_for?.({})) continue
        const fit = answerFit(op, surface)
        expect(fit.max, op.name).toBeLessThanOrEqual(limit)
        for (const [label, make] of fixtures) {
          const result = make()
          const answer = agentAnswer(op, {}, result, false, surface)
          const printed = printedSize(answer, surface)
          if (printed > fit.max) over.push(`${op.name} (${label}): ${printed} > ${fit.max}`)
          // Never more than the op's own cap either, in compact characters.
          if (JSON.stringify(answer).length > answerPolicy(op).max) over.push(`${op.name} (${label}): over its own cap`)
        }
      }
      expect(over).toEqual([])
    }, 120_000)
  }
})

/**
 * The class: reading your own memory, notes and skills never loses text silently. A node reads its
 * MEMORY.md back after a compaction (2026-11-22, 15:46 UTC: a 9,012 character MEMORY.md read through
 * the CLI was saved to a file by the harness). Every op that declares paging (an `offset` and a
 * `section` argument, doc-page.ts DOC_PART_INPUT) is read through the executor as a session's MCP
 * tool or its CLI reads it: the document comes whole in one answer, or in pages whose answer says
 * FIRST that it is a part and names the exact call that reads on, and following those calls gives
 * back the document exactly. A new paging op fails here until it has a fixture below.
 */
describe('reading a stored document never loses text silently, on every surface', () => {
  const TASK = 't-0123'
  type Read = { label: string; op: string; args: Record<string, unknown>; routes: (text: string) => Record<string, unknown>; text: (r: Record<string, unknown>) => string }
  const me = { '/me': { task: { id: TASK } } }
  const READS: Read[] = [
    {
      label: 'own MEMORY.md', op: 'agent_memory_read', args: {},
      routes: (t) => ({ ...me, [`/tasks/${TASK}/agent-memory`]: { title: 'A lead', memory: { text: t, at: '2026-11-22T15:46:00Z' }, chars: t.length, soft_limit: 12_000, limit: 20_000 }, [`/tasks/${TASK}/memory-files`]: { files: [{ name: 'notes.1a2b3c4d.md', chars: 40 }] } }),
      text: (r) => String((r.memory as { text: string }).text),
    },
    {
      label: 'memory folder file', op: 'agent_memory_read', args: { file: 'notes.1a2b3c4d.md' },
      routes: (t) => ({ ...me, [`/tasks/${TASK}/memory-files/notes.1a2b3c4d.md`]: { name: 'notes.1a2b3c4d.md', walnut: false, at: '2026-11-22T15:46:00Z', text: t } }),
      text: (r) => String(r.text),
    },
    {
      label: 'own skill', op: 'agent_skill_read', args: { name: 'big' },
      routes: (t) => ({ ...me, [`/tasks/${TASK}/agent-skills/big`]: { task_id: TASK, scope: 'own', skill: { name: 'big', description: 'd', text: t, at: '2026-11-22T00:00:00Z' } } }),
      text: (r) => String((r.skill as { text: string }).text),
    },
    {
      label: 'skill', op: 'skill_read', args: { dirName: 'big' },
      routes: (t) => ({ '*': { skill: { dirName: 'big', name: 'big', description: 'd', location: '/s/big/SKILL.md', content: t } } }),
      text: (r) => String((r.skill as { content: string }).content),
    },
    {
      label: 'note', op: 'note_read', args: { path: 'Projects/Big' },
      routes: (t) => ({ '*': { content: t, contentHash: 'h1', updatedAt: '2026-11-22T00:00:00Z' } }),
      text: (r) => String(r.content),
    },
    {
      label: 'global memory', op: 'memory_read', args: { doc: 'global' },
      routes: (t) => ({ '*': { memory: { content: t, contentHash: 'm1', updatedAt: '2026-11-22T00:00:00Z' } } }),
      text: (r) => String((r.memory as { content: string }).content),
    },
    {
      label: 'subagent answer', op: 'subagent_read', args: { id: 'sa-0123abcd' },
      routes: (t) => ({ '*': { id: 'sa-0123abcd', state: 'completed', open: false, answer: t } }),
      text: (r) => String(r.answer),
    },
    {
      label: 'MCP text answer', op: 'mcp_read', args: { server: 'docs', tool: 'read_doc', arguments: {} },
      routes: (t) => ({ '*': { isError: false, text: t } }),
      text: (r) => String(r.text),
    },
  ]

  /** A Markdown document of exactly `length` characters (ASCII, or Chinese prose with quotes, escaped). */
  const doc = (length: number, cjk: boolean): string => {
    let t = markdown(Math.ceil(length / 800) + 2, cjk)
    while (t.length < length) t += t
    return t.slice(0, length)
  }
  const DOCS: Array<[string, string]> = [
    ['9,012 ASCII', doc(9_012, false)], ['9,012 non-ASCII', doc(9_012, true)],
    ['20,000 ASCII', doc(20_000, false)], ['20,000 non-ASCII', doc(20_000, true)],
  ]
  const pageText = (text: string): string => {
    const at = text.indexOf(`\n\n${PAGE_MARK}`)
    return at < 0 ? text : text.slice(0, at)
  }

  it('every op that declares paging has a fixture here', () => {
    const paging = listOps({ includeDeprecated: true })
      .filter((op) => { const input = (op as { input?: Record<string, unknown> }).input ?? {}; return 'offset' in input && 'section' in input })
      .map((op) => op.name).sort()
    expect(paging.length).toBeGreaterThanOrEqual(7)
    expect(paging.filter((name) => !READS.some((r) => r.op === name))).toEqual([])
  })

  for (const surface of ['mcp', 'cli'] as AnswerSurface[]) {
    for (const [kind, text] of DOCS) {
      for (const read of READS) {
        it(`${read.label} (${read.op}), ${kind}, on the ${surface} surface`, async () => {
          const routes = read.routes(text)
          const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = new URL(String(input instanceof Request ? input.url : input))
            const route = url.pathname.replace(/^\/api(\/v1)?/, '')
            const body = routes[decodeURIComponent(route)] ?? routes['*']
            return body === undefined ? new Response('{"error":"not found"}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
          })
          try {
            const cap = answerFit(getOp(read.op)!, surface).max
            let joined = ''
            let args: Record<string, unknown> = { ...read.args }
            let pages = 0
            for (; pages < 60; pages++) {
              const r = await executeOp(read.op, args, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: surface })
              expect(r.ok, r.ok ? '' : r.message).toBe(true)
              const answer = r.result as Record<string, unknown>
              expect(printedSize(answer, surface)).toBeLessThanOrEqual(cap)
              // Never the generic cut: no cut mark, no _cut note.
              expect(JSON.stringify(answer)).not.toContain('[Walnut cut:')
              expect(answer._cut).toBeUndefined()
              const page = answer.page as { part?: string; next?: string } | undefined
              joined += pageText(read.text(answer))
              if (!page) {
                expect(pages, 'a whole answer comes only first').toBe(0)
                break
              }
              // The page says so first: the first lines a reader sees are that this is a part, and the next call.
              expect(Object.keys(answer)[0]).toBe('page')
              const head = cliAnswerText(answer).split('\n').slice(0, 5).join('\n')
              const call = /^(\w+) (\{.*\})$/.exec(String(page.next ?? ''))
              if (!call) {
                expect(page.part).toBe('The last part.')
                break
              }
              const part = pages === 0 ? /^Part 1 of about \d+: NOT the whole text/ : /^A later part, about \d+ more parts? follows?: NOT the whole text/
              expect(page.part).toMatch(part)
              expect(head).toMatch(new RegExp(part.source.replace('^', '"part": "')))
              expect(head).toContain(`"next": ${JSON.stringify(page.next)}`)
              expect(call[1]).toBe(read.op)
              args = { ...read.args, ...JSON.parse(call[2]) as Record<string, unknown> }
            }
            expect(joined).toBe(text)
            // A 9 KB memory is one MCP answer; on the CLI (8,000 bytes) it pages.
            if (kind.startsWith('9,012') && surface === 'mcp') expect(pages).toBe(0)
            if (surface === 'cli') expect(pages).toBeGreaterThan(0)
          } finally { fetcher.mockRestore() }
        })
      }
    }
  }
})

describe('cutToFit', () => {
  it('leaves an answer that fits untouched', () => {
    const v = { id: 'a', note: 'short' }
    expect(cutToFit(v, 1_000)).toBe(v)
  })

  it('keeps ids, the outcome and the next step, and says what it cut and how to read it whole', () => {
    const cut = cutToFit(largeResult(), 2_000, 'task_get {"id":"<id>"}') as Record<string, unknown>
    expect(size(cut)).toBeLessThanOrEqual(2_000)
    expect(cut.id).toBe('obj-1')
    expect(cut.outcome).toBe('Saved.')
    expect(cut.next).toBe('Nothing else is required.')
    const note = cut._cut as { note: string; fields: Record<string, string>; whole: string }
    expect(note.note).toContain('nothing failed')
    expect(Object.keys(note.fields).length).toBeGreaterThan(0)
    expect(note.whole).toContain('task_get {"id":"<id>"}')
    expect(note.whole).toContain('"_full": true')
  })

  it('cuts long text before it drops list rows', () => {
    const v = { rows: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` })), text: 'x'.repeat(20_000) }
    const cut = cutToFit(v, 3_000) as { rows: unknown[]; text: string }
    expect(cut.rows).toHaveLength(5)
    expect(cut.text.length).toBeLessThan(3_000)
  })

  it('a list answer keeps its head and counts the rest', () => {
    const cut = cutToFit({ items: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) }, 2_000) as { items: unknown[]; _cut: { fields: Record<string, string> } }
    expect(cut.items.length).toBeGreaterThan(5)
    expect(cut._cut.fields.items).toMatch(/^\d+ more items$/)
  })

  it('a top-level list is answered under `result`', () => {
    const cut = cutToFit(Array.from({ length: 500 }, (_, i) => `row ${i} ${'x'.repeat(50)}`), 1_500) as { result: unknown[] }
    expect(Array.isArray(cut.result)).toBe(true)
    expect(size(cut)).toBeLessThanOrEqual(1_500)
  })
})

describe('cutToFit on answers that are hard to fit', () => {
  it('counts characters as JSON does: a text full of tabs, quotes and newlines still fits, and keeps what it can', () => {
    const cut = cutToFit({ id: 'x', note: 'line\t"q"\n'.repeat(1_400) }, 8_000) as { note: string }
    expect(size(cut)).toBeLessThanOrEqual(8_000)
    expect(cut.note.length).toBeGreaterThan(3_000)
  })

  it('a wide object of short kept values still fits', () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}_id`, 'v'.repeat(200)]))
    expect(size(cutToFit(wide, 2_000))).toBeLessThanOrEqual(2_000)
  })

  it('a long value under a kept key is cut like any other text', () => {
    expect(size(cutToFit({ path: 'p'.repeat(30_000) }, 2_000))).toBeLessThanOrEqual(2_000)
  })

  it('a few megabytes are cut in well under a second, and the caller\'s object is left alone', () => {
    const huge = { rows: Array.from({ length: 4_000 }, (_, i) => ({ id: i, text: 'y'.repeat(1_200) })) }
    const before = size(huge)
    const started = Date.now()
    expect(size(cutToFit(huge, 8_000))).toBeLessThanOrEqual(8_000)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(size(huge)).toBe(before)
  })

  it('a result JSON cannot hold is answered as it is, never an error', () => {
    const cycle: Record<string, unknown> = { a: 1 }
    cycle.self = cycle
    const op = { name: 'x', tags: { readonly: true, remote: 'allow' as const } }
    expect(agentAnswer(op, {}, cycle)).toBe(cycle)
    expect(agentAnswer(op, {}, { n: BigInt(1) })).toEqual({ n: BigInt(1) })
  })
})

describe('a shortened text is never stored back', () => {
  it('every text cutToFit shortens ends with the mark a write looks for', () => {
    const cut = cutToFit({ note: 'x'.repeat(30_000), rows: [{ text: 'y'.repeat(9_000) }] }, 2_000)
    expect(cutTextPath(cut)).toBe('note')
    expect(cutTextPath({ a: { b: ['ok', `head… ${cutMark(12)}`] } })).toBe('a.b[1]')
    expect(cutTextPath({ a: 'the words Walnut cut are fine without the mark' })).toBeUndefined()
  })

  it('every receipt write refuses it; a read and a write that runs something do not', () => {
    const ops = listOps({ includeDeprecated: true })
    const args = { content: `the first lines… ${cutMark(4_000)}` }
    for (const op of ops) {
      const refusal = cutTextRefusal(op, args)
      const stores = !op.tags.readonly && answerPolicy(op).kind === 'receipt'
      expect(refusal !== undefined, op.name).toBe(stores)
    }
    expect(cutTextRefusal(ops.find((o) => o.name === 'task_note_write')!, { content: 'one page\n\n[Walnut: this is part of a longer document: 1 of 3.]' })).toContain('_full')
  })

  it('the executor refuses before anything runs', async () => {
    let ran = false
    const h = definePluginOp('answer-policy-test', {
      name: 'answer_policy_test_store', title: 't', description: 't', input: { content: z.string() },
      handler: async () => { ran = true; return { ok: true } },
      tags: { readonly: false, remote: 'allow' },
    })
    try {
      const r = await executeOp('answer_policy_test_store', { content: `head… ${cutMark(9)}` }, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: 'cli' })
      expect(r.ok).toBe(false)
      expect(ran).toBe(false)
    } finally { h.dispose() }
  })
})

describe('executeOp holds an agent caller to the policy, and only an agent caller', () => {
  const handles: { dispose(): void }[] = []
  afterEach(() => { for (const h of handles.splice(0)) h.dispose() })

  const define = (name: string, readonly: boolean) => {
    handles.push(definePluginOp('answer-policy-test', {
      name, title: name, description: name, input: {},
      handler: async () => largeResult(),
      tags: { readonly, remote: 'allow' },
    }))
  }

  it('a write answers a receipt to an agent and the whole result to server code', async () => {
    define('answer_policy_test_write', false)
    const agent = await executeOp('answer_policy_test_write', {}, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: 'cli' })
    expect(agent.ok).toBe(true)
    expect(size(agent.result)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    const server = await executeOp('answer_policy_test_write', {}, { origin: LOCAL_ORIGIN, callerSid: 's-1' })
    expect(size(server.result)).toBeGreaterThan(300_000)
  })

  it('a read answers capped content, and `_full` lifts the cap for one call', async () => {
    define('answer_policy_test_read', true)
    const capped = await executeOp('answer_policy_test_read', {}, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: 'cli' })
    expect(size(capped.result)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    const full = await executeOp('answer_policy_test_read', { _full: true }, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: 'cli' })
    expect(full.ok).toBe(true)
    expect(size(full.result)).toBeGreaterThan(300_000)
    const bad = await executeOp('answer_policy_test_read', { _full: 'yes' }, { origin: LOCAL_ORIGIN, callerSid: 's-1', forAgent: 'cli' })
    expect(bad.ok).toBe(false)
  })
})
