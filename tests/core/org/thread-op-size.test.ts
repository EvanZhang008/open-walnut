/**
 * Guard: loading a thread op stays cheap. Claude Code loads a Walnut tool on demand, so the first
 * call of a thread op in a process pays for its whole definition (title, description and JSON
 * input schema) as context. Until 2026-11-22 each op carried a 5 K copy of the Threads rules that
 * every node already reads in its always-loaded prompt: thread_update loaded 16.0 K (about 4.3K
 * tokens) and ran 1,718 times in 7 days, thread_create 12.7 K, the others 6.8 to 7.6 K. After the
 * cut: thread_update 7.5 K, thread_create 5.1 K, the others 0.8 to 1.7 K.
 *
 * Fails when any thread op's loaded definition grows past its cap: the measured size of the cut
 * text plus a small margin. A rule a node needs belongs in the keepers' prompt (the "Your Threads"
 * paragraph) or, when some keeper's prompt lacks it, once in the op it applies to (thread-rule-places.ts). The ops are read
 * from the registry by their group (op-groups.ts `threads`), so a new thread op is held too.
 */
import { describe, it, expect } from 'vitest'
import { opInputJsonSchema } from '../../../src/ops/index.js'
import { threadOps } from './thread-rule-places.js'

/** Measured 2026-11-22, plus about 150 characters. */
const CAPS: Record<string, number> = {
  thread_update: 7_519 + 150, // 29 arguments (2.0 K of schema alone), the op-only rules (options, source check) and a writer's few rules
  thread_create: 5_069 + 150, // 18 arguments and the same rules
  thread_list: 1_675 + 150,
  thread_get: 1_129 + 150,
  thread_split: 1_199 + 150,
  thread_file: 782 + 150,
  thread_move: 1_341 + 150, // carries THREADS_MOVE_RULE: a task with Threads on reads it nowhere else
}
/** A new thread op: about the size of the small ones. */
const DEFAULT_CAP = 1_800

/** What a tool search loads for one op. */
const loaded = (op: ReturnType<typeof threadOps>[number]): number =>
  op.title.length + op.description.length + JSON.stringify(opInputJsonSchema(op)).length

describe('a thread op loads small', () => {
  it('every thread op in the registry is found', () => {
    const names = threadOps().map((op) => op.name)
    expect(names).toEqual(expect.arrayContaining(['thread_list', 'thread_get', 'thread_update', 'thread_create', 'thread_split', 'thread_file', 'thread_move']))
    for (const name of Object.keys(CAPS)) expect(names, name).toContain(name)
  })

  it('each definition is within its cap', () => {
    const over = threadOps()
      .map((op) => ({ name: op.name, size: loaded(op), cap: CAPS[op.name] ?? DEFAULT_CAP }))
      .filter((o) => o.size > o.cap)
      .map((o) => `${o.name}: ${o.size} > ${o.cap}`)
    expect(over, 'a thread op grew: move a rule every node reads into its prompt, or cut words, before raising a cap').toEqual([])
  })
})
