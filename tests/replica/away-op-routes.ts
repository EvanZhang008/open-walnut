/**
 * The routes an op reaches and what a host's follower does with each, for the decision-table
 * guards (tests/replica/away-op-decisions.test.ts, away-op-decisions-routes.test.ts).
 */
import { listOps } from '../../src/ops/index.js'
import { classify } from '../../src/replica/route-table.js'

export type Op = ReturnType<typeof listOps>[number]

/** The route-table answers a follower gives this host's own call. */
export const ANSWERED = new Set(['read', 'host-write', 'note-write'])

/** The routes an op reaches: its binding and the literal paths its handler calls (method, path under /api). */
export function routesOf(op: Op): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const full = (p: string) => (p.startsWith('/api/') ? p : `/api/v1${p.startsWith('/') ? p : `/${p}`}`).split('?')[0]!
  if (op.bind) out.push([op.bind.method, full(op.bind.path)])
  if (op.handler) {
    const re = /call\(\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*(['"`])(\/[^'"`]*)\2/g
    for (const m of op.handler.toString().matchAll(re)) out.push([m[1]!, full(m[3]!.replace(/\$\{[^}]*\}/g, 'x'))])
  }
  return out
}

/** A handler that calls a path it builds (`${path}`, a variable): its routes are not all known here. */
export function buildsPaths(op: Op): boolean {
  const calls = op.handler?.toString().match(/call\(\s*['"`](?:GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*[^)]{2}/g) ?? []
  return calls.some((c) => !/,\s*['"`]\/$/.test(c))
}

/** What the follower does with one route for this host's own call. */
export function awayOf(method: string, p: string): string {
  const d = classify(method, p) as { away: string; row?: { localAway?: string } }
  return d.row?.localAway ?? d.away
}

/** Whether the table answers the route here (not needs_leader). */
export function tableAnswers(method: string, p: string): boolean {
  const a = awayOf(method, p)
  return ANSWERED.has(a) || a.startsWith('queue:')
}
