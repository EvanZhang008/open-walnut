/**
 * Class guard: everything the store reads to refuse a write that puts a thread before him is
 * something a card line carries (experiment threads_reply_tag).
 *
 * 2026-11-25, a live walk: the store refused a decision line because he had written on its thread
 * ("Pass since_you_wrote ..."), the session wrote since_you_wrote into its line, and the line had no
 * such attribute, so it was dropped and the decision never reached its card. A card line has one
 * send-back a turn, so a field the refusal reads and the line cannot carry is a decision that can
 * never be put to him through the line.
 *
 * The fields are read from the source, not listed here: each `patch.<field>` the return rules read
 * (thread-return.ts returnLack), each `rest.<field>` the needs branch of threads-store.ts patchThread
 * reads, and each field of the object type taken by the checks that branch hands `rest` to. Each is
 * either a field of the thread_update a decision line stands for (reply-card-decision.ts needsPatch,
 * with every attribute of the line given) or an exception below with its reason. A new field read
 * there with neither fails this test; so does an exception nothing reads any more.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { needsPatch } from '../../../src/core/org/reply-card-decision.js'
import { CARD_ALIASES, readCardTags, type CardTag } from '../../../src/lib/card-tag.js'

const ORG = path.join(process.cwd(), 'src', 'core', 'org')
const read = (file: string) => fs.readFileSync(path.join(ORG, file), 'utf8')

/** The text of a function from its declaration to the next top-level declaration. */
function body(src: string, head: string): string {
  const at = src.indexOf(head)
  expect(at, head).toBeGreaterThanOrEqual(0)
  const next = src.slice(at + head.length).search(/\n(?:export |function |async function |const |\/\*\*)/)
  return src.slice(at, next < 0 ? undefined : at + head.length + next)
}

const fieldsOf = (text: string, name: string) => new Set([...text.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)\\b`, 'g'))].map((m) => m[1]))

/** The fields the refusal of a return reads, with where each is read. */
function readFields(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of fieldsOf(body(read('thread-return.ts'), 'export function returnLack('), 'patch')) out.set(f, 'thread-return.ts returnLack')
  const store = read('threads-store.ts')
  const patch = body(store, 'export async function patchThread(')
  const from = patch.indexOf("if (by !== 'human' && !owner) {")
  const to = patch.indexOf('// His Acknowledge alone')
  expect(from, 'the needs branch of patchThread').toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const branch = patch.slice(from, to)
  for (const f of fieldsOf(branch, 'rest')) if (!out.has(f)) out.set(f, 'threads-store.ts patchThread')
  // The checks the branch hands the patch to, and the fields of the object type each takes.
  const callees = [...new Set([...branch.matchAll(/\.?\b([A-Za-z]+)\((?:[^()]|\([^()]*\))*\brest\b(?![.\w])/g)].map((m) => m[1]))]
  expect(callees.length).toBeGreaterThan(0)
  const sources = ['threads-store.ts', 'thread-supersede.ts', 'thread-same-subject.ts', 'threads-model.ts'].map((f) => [f, read(f)] as const)
  for (const name of callees) {
    // The model's own update runs every rule of a write; its return rules are returnLack, read above.
    if (name === 'updateThread') continue
    const hit = sources.find(([, src]) => new RegExp(`function ${name}\\(`).test(src))
    expect(hit, `${name}: a check the needs branch hands the patch to, declared in ${sources.map(([f]) => f).join(', ')}`).toBeDefined()
    const decl = hit![1].slice(hit![1].search(new RegExp(`function ${name}\\(`)))
    // Its parameters: an object type of named fields, or a Pick of ThreadPatch.
    const params = decl.slice(0, decl.indexOf('{\n'))
    const type = /\b(?:input|patch): \{([^}]*)\}/.exec(params)?.[1].matchAll(/\b([a-z_]+)\?:/g)
      ?? /\b(?:input|patch): Pick<ThreadPatch, ([^>]*)>/.exec(params)?.[1].matchAll(/'([a-z_]+)'/g)
    expect(type, `${name} takes the patch as an object type of named fields, or a Pick of ThreadPatch`).toBeDefined()
    for (const m of type!) if (!out.has(m[1])) out.set(m[1], `${hit![0]} ${name}`)
  }
  return out
}

/** Every attribute of a decision line given: what the line can carry into its thread_update. */
const FULL: CardTag = {
  thread: 'th-aaaaaa01', state: 'needs', title: 'Fence wood', summary: 'Larch lasts 15 years, oak 30.', ask: 'Which wood for the fence?',
  options: ['Larch', 'Oak'], kind: 'spending', why: 'oak is twice the budget he set', since: 'Measured the gap again.', decision: 'same',
}

/** Read by the refusal and not carried by a line, each with why. */
const NOT_CARRIED: Record<string, string> = {
  supersedes: 'a line names no other ask it replaces; a new decision names its old thread itself (reply-card-decision.ts openNewDecision)',
  separate_reason: 'a line opens no second ask beside the task\'s others: the refusal is sent back in the store\'s words',
  same_ask_reason: 'a line never asks what a teammate already asks: the refusal is sent back in the store\'s words',
  ref: 'a line points at nothing outside: the thread it names is the item',
  tasks: 'a line names no tasks: the thread keeps its own list',
  add_tasks: 'a line names no tasks: the thread keeps its own list',
  close: 'a decision line never closes its thread: a thread that is done gets state="done", a line of its own',
  reopen: 'a line names only open threads (reply-card-decision.ts notOpenReason): a closed one is a new thread',
}

describe('class guard: what the refusal of a return reads, a card line carries', () => {
  const fields = readFields()
  const carried = new Set(Object.keys(needsPatch({ title: 'how tall should', state: 'working' }, FULL)))

  it('the source reads the fields this guard knows of (the walk found them)', () => {
    for (const f of ['since_you_wrote', 'decision', 'options', 'state', 'supersedes']) expect(fields.has(f), f).toBe(true)
  })

  it('every field read is carried by a decision line, or named with its reason', () => {
    const neither = [...fields].filter(([f]) => !carried.has(f) && !NOT_CARRIED[f]).map(([f, where]) => `${f} (${where})`)
    expect(neither, 'read by the refusal of a return, and no card line carries it: add it to the grammar (lib/card-tag.ts) and needsPatch, or to NOT_CARRIED with why').toEqual([])
  })

  it('no exception is stale, and none is carried after all', () => {
    for (const f of Object.keys(NOT_CARRIED)) {
      expect(fields.has(f), `${f}: nothing reads it any more`).toBe(true)
      expect(carried.has(f), `${f}: a line carries it now`).toBe(false)
    }
  })

  it('a field the store\'s texts name by the op\'s name reads in a line by that name too', () => {
    for (const [op, attr] of Object.entries(CARD_ALIASES)) {
      const line = `<walnut-card thread="th-aaaaaa01" state="needs" ask="Which wood?" ${op}="Measured the gap again."/>`
      expect(readCardTags(line).cards[0]?.[attr as keyof CardTag], op).toBe('Measured the gap again.')
      expect(carried.has(op), `${op} reaches the thread_update`).toBe(true)
    }
  })
})
