/**
 * The real-use store's hour rows are read per target, never every row of a kind per target, and a
 * batch of watches never holds the server's loop as one (core/usage-watch/store.ts readHours,
 * runtime.ts nextWatch).
 *
 * 2026-11-27: at every start the Mac's server judged 67 ended watches again (223 targets), and each
 * target read and parsed all 12,000 request rows of its window, back to back with no break: the
 * server stood still 2.5 to 3.2 s about 65 s after each start (three CPU profiles: JSON.parse in
 * parseAgg and SQLite's all() under mergedFor). On a copy of that store the same verdicts now take
 * 0.7 s instead of 10.4 s here, the slowest watch 42 ms instead of 470.
 * Pinned:
 *   - readHours with a name, a span or a `covers` gives exactly the rows filtering all of them gives,
 *     past the names one read takes at once;
 *   - every reader outside the store names what it reads (a name or `covers`), or is listed with why;
 *   - every loop over watches in runtime.ts lets the loop answer before each watch.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyAgg, type UsageKind } from '../../../src/core/usage-watch/agg.js'
import { addHours, closeUsageWatchStore, readHourNames, readHours, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'

const ROOT = path.resolve(__dirname, '../../..')
const H = 3_600_000
const T0 = Date.parse('2026-11-25T00:00:00Z')
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hour-reads-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
})
afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const rowsOf = (n: number) => {
  const rows: Array<{ hour: number; kind: UsageKind; name: string; agg: ReturnType<typeof emptyAgg> }> = []
  for (let h = 0; h < 6; h++) {
    for (let i = 0; i < n; i++) rows.push({ hour: T0 + h * H, kind: 'http', name: `GET /api/thing-${i}`, agg: { ...emptyAgg(), calls: h + 1 } })
    rows.push({ hour: T0 + h * H, kind: 'op', name: 'task_list', agg: { ...emptyAgg(), calls: 10 } })
  }
  return rows
}
const key = (r: { hour: number; kind: string; name: string; agg: { calls: number } }) => `${r.hour} ${r.kind} ${r.name} ${r.agg.calls}`

describe('readHours reads one target\'s rows', () => {
  it('a name, a span and covers give the rows filtering every row gives, past one read\'s names', () => {
    // More names than one read takes at once (500), so the kept names are read in parts.
    addHours(rowsOf(1_200))
    const all = readHours(T0)
    expect(all).toHaveLength(6 * 1_201)
    const covers = (kind: UsageKind, name: string) => kind === 'http' && /thing-(\d*[13579])$/.test(name)
    const want = all.filter((r) => r.hour < T0 + 4 * H && covers(r.kind, r.name)).map(key).sort()
    const got = readHours(T0 + H * 0, { kind: 'http', untilHour: T0 + 4 * H, covers }).map(key).sort()
    expect(got).toEqual(want)
    expect(got).toHaveLength(4 * 600)
    expect(readHours(T0 + 2 * H, { kind: 'op', name: 'task_list' }).map((r) => r.hour)).toEqual([2, 3, 4, 5].map((h) => T0 + h * H))
    expect(readHours(T0, { covers: () => false })).toEqual([])
    expect(readHourNames(T0 + 5 * H, 'op')).toEqual(['task_list'])
    expect(readHourNames(T0, 'http')).toHaveLength(1_200)
  })
})

describe('the class guard', () => {
  /** Readers that read a whole kind on purpose, with why. */
  const WHOLE_KIND: Record<string, string> = {
    'src/core/usage-watch/record.ts': 'the bad-argument gauge sums every op of the last day, at most every 5 minutes',
    'src/core/usage-watch/report.ts': 'the Real Use report of every target, read when someone opens it (one target\'s report names it)',
  }

  it('every hour reader outside the store names what it reads, or is listed', () => {
    const offenders: string[] = []
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []))
    let found = 0
    for (const file of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel === 'src/core/usage-watch/store.ts') continue
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\breadHours\(([^\n]*)/g)) {
        found++
        if (/\bname:|\bcovers\b|\.\.\.only\b/.test(m[1]!) || WHOLE_KIND[rel]) continue
        offenders.push(`${rel}: readHours(${m[1]!.slice(0, 80)}`)
      }
    }
    expect(found).toBeGreaterThanOrEqual(4)
    expect(offenders, 'name the target (name or covers), or list the reader in WHOLE_KIND with why').toEqual([])
  })

  it('every loop over watches in runtime.ts lets the server\'s loop answer before each one', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/usage-watch/runtime.ts'), 'utf8')
    const loops = [...src.matchAll(/for \(const w of [^)]+\) \{\n\s*([^\n]*)/g)]
    expect(loops.length).toBeGreaterThanOrEqual(2)
    for (const l of loops) expect(l[1]).toBe('await nextWatch()')
  })
})
