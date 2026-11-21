/**
 * Ratchet: a host's answer to a call of a kept-local task's own session (src/replica/kept-local-calls.ts)
 * knows every op that falls back on the caller's own task. Read from the registry (src/ops): an op that
 * asks GET /me, or one with an optional argument that defaults to "your own task" (or your team's), is
 * in OWN_TASK_OPS with the arguments that name another, or reviewed below as answered for that session.
 * The refusal itself is run in tests/core/replication/host-private.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { listOps } from '../../src/ops/index.js'
import { OWN_TASK_OPS } from '../../src/replica/kept-local-calls.js'
import { routesOf } from './away-op-routes.js'

/** How an op's text says an argument left out means the caller's own task. */
const OWN = /(default(s| is)?( to|:)? (to )?your (own )?task|omit (it |for )?(for |to use )?your own task|your own task by default|task defaults to your own|default: yours|defaults to your team)/i

/** Reviewed: ops that reach the caller's own task, answered for a kept task's session all the same. */
const ANSWERED: Record<string, string> = {
  task_session_set: 'its id is required: one naming the kept task or its session is refused by that name',
  task_list: 'a list of the copy, which holds none of the kept task: nothing of it is answered',
}

describe('every op that falls back on the caller\'s own task is known to the kept-local answer', () => {
  const ops = listOps({ includeDeprecated: true })
  const byName = new Map(ops.map((o) => [o.name, o]))

  it('an op asking GET /me, or with an argument defaulting to your own task, is in OWN_TASK_OPS or reviewed', () => {
    const missing: string[] = []
    const found = new Set<string>()
    for (const op of ops) {
      const me = routesOf(op).some(([m, p]) => m === 'GET' && p === '/api/v1/me')
      const own = Object.entries(op.input).some(([, v]) => v.isOptional() && OWN.test(String(v.description ?? '')))
      if (!(me || own || OWN.test(op.description))) continue
      found.add(op.name)
      if (!OWN_TASK_OPS[op.name] && !ANSWERED[op.name]) missing.push(op.name)
    }
    expect(missing, 'add each to src/replica/kept-local-calls.ts OWN_TASK_OPS (or review it here)').toEqual([])
    expect(Object.keys(ANSWERED).filter((n) => !found.has(n)), 'reviewed ops that no longer reach the caller\'s own task').toEqual([])
  })

  it('every row names a real op and arguments it takes; a reviewed op says why', () => {
    for (const [name, args] of Object.entries(OWN_TASK_OPS)) {
      const op = byName.get(name)
      expect(op, `${name}: no such op`).toBeDefined()
      for (const a of args) expect(Object.keys(op!.input), `${name}.${a}`).toContain(a)
    }
    for (const [name, why] of Object.entries(ANSWERED)) {
      expect(byName.has(name), `${name}: no such op`).toBe(true)
      expect(OWN_TASK_OPS[name], `${name}: in both lists`).toBeUndefined()
      expect(why.length).toBeGreaterThan(20)
    }
  })
})
