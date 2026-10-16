/**
 * Every router-level error funnel under src/web/routes passes a NeedsLeaderError
 * on to the app's error handler (docs/plan/walnut-replica-servers-impl.md, WP5).
 * A host replica throws one where it only holds a copy of the Mac's store (the
 * favorites, the routines, the chat lists, config): the app's handler answers it
 * 503 needs_leader with its why, the same answer the dispatcher gives a
 * needs-leader row. A funnel that answered it itself said 500 "internal" and
 * logged it as an error (a card), so the phone read a copy it was not given as a
 * broken server. Reads src/ as text; the answers themselves are pinned by
 * tests/core/replication/kinds/prefs.test.ts (GET /api/v1/favorites) and
 * routines.test.ts (/api/v1/routines).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROUTES = path.resolve(import.meta.dirname, '../../src/web/routes')
const FUNNEL = /\.use\(\(err: unknown, _req: Request, res: Response, (_?next): NextFunction\) => \{\n([^\n]*\n){0,4}/g

describe('the v1 error funnels and needs_leader', () => {
  const funnels: Array<{ file: string; head: string; next: string }> = []
  const counts: Array<[string, number, number]> = []
  for (const name of readdirSync(ROUTES)) {
    if (!/\.ts$/.test(name)) continue
    const text = readFileSync(path.join(ROUTES, name), 'utf8')
    const found = [...text.matchAll(FUNNEL)]
    for (const m of found) funnels.push({ file: name, head: m[0], next: m[1]! })
    counts.push([name, found.length, [...text.matchAll(/\.use\(\(err\b/g)].length])
  }

  it('the scan finds the funnels (a scan that went blind would pass anything)', () => {
    // A funnel written some other way would slip past the scan: every error-arity use is one it read.
    expect(counts.filter(([, seen, all]) => seen !== all)).toEqual([])
    expect(funnels.length).toBeGreaterThanOrEqual(18)
    expect(funnels.map((f) => f.file)).toContain('search-memory-v1.ts')
    expect(funnels.map((f) => f.file)).toContain('routines-v1.ts')
  })

  it('each one hands a NeedsLeaderError on before it answers anything itself', () => {
    const missing = funnels.filter((f) => !new RegExp(`if \\(isNeedsLeaderError\\(err\\)[^)]*\\) \\{ ${f.next}\\(err\\); return \\}`).test(f.head))
      .map((f) => f.file)
    expect(missing).toEqual([])
  })
})
