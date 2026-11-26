/**
 * The class of the 2026-11-25 report (experiment threads_each_question): every path that puts a
 * message of his into or under another thread than the one it opened. Enumerated from the source,
 * so a new member fails here until it is listed with the behaviour test that proves it keeps his
 * question its own thread with the switch on:
 *   (a) every call of mergeThreads( and splitMessageInto( in src/ (a merge, or one message moved
 *       into another thread), by file;
 *   (b) every way fileMessage files his message into an existing thread it did not name, read
 *       from the `joined` union of FileMessageResult.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const UNIT = 'tests/core/org/thread-each-question.test.ts'
const E2E = 'tests/e2e/thread-each-question.test.ts'

/** Each file that moves a thread or a message of his into another thread: its calls, and the test that proves each refuses his question. */
const MOVERS: Record<string, { calls: number; tests: Array<[file: string, name: string]> }> = {
  'src/core/org/threads-model.ts': { calls: 1, tests: [[UNIT, 'splitMessageInto: his question that opened its thread is not moved into another, a remark is']] },
  'src/core/sessions/status-thread-title.ts': { calls: 1, tests: [[UNIT, 'settleHeldTitles: the status answer\'s merge of his question is refused and its title stays held'], [E2E, 'flag on: two questions, two threads; the status answer\'s merge of the second is refused and its title is asked again']] },
  'src/core/org/threads-store.ts': { calls: 2, tests: [[E2E, 'a node\'s thread_update merge_into and thread_split merge_into of his question are refused; his own merge goes through']] },
  'src/core/org/thread-tree-merge.ts': { calls: 1, tests: [[E2E, 'merge_into a thread on a task below refuses his question and moves nothing']] },
  'src/core/org/thread-join-check.ts': { calls: 3, tests: [[UNIT, 'splitWhereItIs: a split the check already did is not merged into another thread when it holds his question'], [UNIT, 'splitMessageInto: his question that opened its thread is not moved into another, a remark is']] },
  // The answered check merges the threads of his questions one reply answers into the oldest's (2026-11-25, the user: "u need to combine them").
  'src/core/org/thread-answered-check.ts': { calls: 1, tests: [['tests/core/org/thread-answered-check.test.ts', 'one reply answering two questions: one thread listed for him, holding both questions, each with the reply']] },
  'src/core/org/reply-card-stop.ts': { calls: 1, tests: [[E2E, 'a card line\'s merge of his question is refused at the turn end and by the reply, and he is told why']] },
  // reply-card.ts merges through threads-store.ts mergeThread and thread-tree-merge.ts mergeAcrossTree (counted there).
}

/** The calls of a function in a file, outside comments and its own definition. */
function callsIn(src: string, fn: string): number {
  return src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !l.includes(`function ${fn}(`) && new RegExp(`\\b${fn}\\(`).test(l)).length
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    return e.isDirectory() ? srcFiles(rel) : e.name.endsWith('.ts') ? [rel] : []
  })
}

/** A behaviour test of that name exists in that file. */
function hasTest(file: string, name: string): boolean {
  const src = read(file)
  const quoted = [`'${name.replace(/'/g, "\\'")}'`, `"${name}"`, `\`${name}\``]
  return quoted.some((q) => src.includes(`it(${q}`))
}

describe('every path that moves his message into another thread keeps his question its own', () => {
  it('(a) every call of mergeThreads( and splitMessageInto( is listed with its behaviour test', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const src = read(f)
      const n = callsIn(src, 'mergeThreads') + callsIn(src, 'splitMessageInto')
      if (n) found[f] = n
    }
    expect(found, 'a new place merges threads or moves one of his messages into another: list it in MOVERS with the test that proves it refuses his question').toEqual(
      Object.fromEntries(Object.entries(MOVERS).map(([f, v]) => [f, v.calls])),
    )
    for (const [f, v] of Object.entries(MOVERS)) for (const [file, name] of v.tests) expect(hasTest(file, name), `${f}: no test "${name}" in ${file}`).toBe(true)
  })

  it('(b) every join of fileMessage is listed: a behaviour test, or why it is no member', () => {
    const src = read('src/core/org/threads-model.ts')
    const block = src.slice(src.indexOf('export interface FileMessageResult'))
    const union = /joined\?:\s*((?:'[a-z]+'\s*\|?\s*)+);/.exec(block)
    expect(union, 'FileMessageResult.joined not found').not.toBeNull()
    const kinds = [...union![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
    const JOINS: Record<string, { test: [string, string] } | { exempt: string }> = {
      recent: { test: [UNIT, 'fileMessage: his question right after another opens its own thread (the recent join)'] },
      reaction: { test: [UNIT, 'fileMessage: a question never joins as a bare reaction (the reaction join)'] },
      // A Follow up names the thread: he put it there himself.
      reopened: { exempt: 'a Follow up he sent from the thread he named' },
    }
    expect(kinds, 'a new way fileMessage joins his message to a thread: list it in JOINS').toEqual(Object.keys(JOINS).sort())
    for (const [k, v] of Object.entries(JOINS)) if ('test' in v) expect(hasTest(v.test[0], v.test[1]), `${k}: no test "${v.test[1]}"`).toBe(true)
    expect(hasTest(UNIT, 'a Follow up that names a thread keeps today\'s rules')).toBe(true)
  })
})
