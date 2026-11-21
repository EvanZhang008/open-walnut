/**
 * Ratchet: every op in the registry (src/ops, enumerated through listOps) has a decision for
 * what a host's follower does with it while the leader is away (src/replica/away-op-decisions.ts),
 * and the decision agrees with the route table that decides it (src/replica/route-table.ts):
 *   - no op without a row, no row without an op, every why says something;
 *   - a `host` row with no `by` names an op one of whose routes the follower answers (a read,
 *     a host write, a queue or a note write, for this host's own call: `localAway` first);
 *   - a `leader` row with no `by` names an op one of whose routes answers needs_leader;
 *   - a `by` names a module that exists (the one that answers, or refuses, that call here).
 * An op's routes are its binding and the literal paths its handler calls; a handler whose paths
 * are built (boardPath, `${path}`, a variable) is checked by its row's `by` and why alone.
 * A route the table calls a read can still refuse in its own handler on every follower: that
 * is checked against a booted replica in away-op-decisions-routes.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listOps } from '../../src/ops/index.js'
import { AWAY_OP_DECISIONS, opsAnsweredHere } from '../../src/replica/away-op-decisions.js'
import { ANSWERED, awayOf, buildsPaths, routesOf } from './away-op-routes.js'

const ROOT = path.resolve(__dirname, '../..')

describe('every op has a decision while the leader is away', () => {
  const ops = listOps({ includeDeprecated: true })

  it('one row per op in the registry, none stale, each with its reason', () => {
    const names = new Set(ops.map((o) => o.name))
    expect(names.size).toBeGreaterThan(150)
    const missing = [...names].filter((n) => !AWAY_OP_DECISIONS[n])
    expect(missing, `ops with no row in src/replica/away-op-decisions.ts: ${missing.join(', ')}`).toEqual([])
    const stale = Object.keys(AWAY_OP_DECISIONS).filter((n) => !names.has(n))
    expect(stale, 'rows for ops that no longer exist').toEqual([])
    for (const [name, d] of Object.entries(AWAY_OP_DECISIONS)) {
      expect(['host', 'held', 'leader'], name).toContain(d.answer)
      expect(d.why.length, `${name}: say why`).toBeGreaterThan(20)
    }
  })

  it('a row agrees with the routes the op reaches, or names the module that decides it', () => {
    const wrong: string[] = []
    for (const op of ops) {
      const d = AWAY_OP_DECISIONS[op.name]
      if (!d) continue
      if (d.by) {
        if (!fs.existsSync(path.join(ROOT, d.by))) wrong.push(`${op.name}: by ${d.by} does not exist`)
        continue
      }
      const aways = routesOf(op).map(([m, p]) => awayOf(m, p))
      if (!aways.length) continue
      const answered = aways.some((a) => ANSWERED.has(a) || a.startsWith('queue:'))
      const refused = aways.includes('needs-leader')
      if (d.answer === 'host' && !answered) wrong.push(`${op.name}: host, but every route needs the leader (${aways.join(', ')})`)
      // A write whose path is built is not seen: its row's why is the check.
      if (d.answer === 'leader' && !refused && !buildsPaths(op)) wrong.push(`${op.name}: leader, but no route needs the leader (${aways.join(', ')})`)
    }
    expect(wrong).toEqual([])
  })

  it('what answers here is the host and held rows: what tools.list and walnut_status name', () => {
    const here = new Set(opsAnsweredHere())
    for (const [name, d] of Object.entries(AWAY_OP_DECISIONS)) expect(here.has(name), name).toBe(d.answer !== 'leader')
    // The reads a session leans on while away are among them.
    for (const n of ['task_get', 'task_list', 'session_list', 'request_get', 'open_items', 'search', 'walnut_status']) expect(here.has(n), n).toBe(true)
  })
})
