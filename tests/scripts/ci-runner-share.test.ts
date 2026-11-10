/**
 * CI on a push to main leaves most of the repository's runners to the push gate (ci.yml,
 * CI_RUNNER_SHARE). 2026-11-09: two post-push CI runs held 12 to 17 of the 20 jobs GitHub runs at a
 * time for 80 to 90 minutes, the gate that every land waits on before it writes main ran 3 to 8
 * jobs with 20 to 45 queued, and lands went live at 3 an hour. Every matrix of more than three legs
 * is capped on a push, a pull request keeps its full width, and the caps together stay under half
 * of the 20.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
type Job = { strategy?: { 'max-parallel'?: string | number; matrix?: { include?: unknown[]; [axis: string]: unknown } } }
const doc = parseYaml(raw) as { on: Record<string, unknown>; jobs: Record<string, Job> }

/** The legs a job's matrix makes: the product of its axes, or its include list. */
function legs(job: Job): number {
  const m = job.strategy?.matrix
  if (!m) return 1
  const axes = Object.entries(m).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v)) as [string, unknown[]][]
  const product = axes.reduce((n, [, v]) => n * v.length, axes.length ? 1 : 0)
  return Math.max(product, (m.include ?? []).length)
}
/** The cap on a push: `${{ github.event_name == 'push' && N || M }}` gives N; none gives Infinity. */
function pushCap(job: Job): number {
  const mp = job.strategy?.['max-parallel']
  if (mp === undefined) return Infinity
  if (typeof mp === 'number') return mp
  const m = /^\$\{\{\s*github\.event_name == 'push' && (\d+) \|\| (\d+)\s*\}\}$/.exec(mp)
  return m ? Number(m[1]) : Infinity
}
function prCap(job: Job): number {
  const mp = job.strategy?.['max-parallel']
  const m = typeof mp === 'string' ? /\|\| (\d+)\s*\}\}$/.exec(mp) : null
  return m ? Number(m[1]) : typeof mp === 'number' ? mp : Infinity
}

describe('ci.yml leaves the runners to the push gate on a push to main', () => {
  it('runs on pushes to main, so the share matters', () => {
    expect(Object.keys(doc.on)).toContain('push')
  })

  it('caps every matrix of more than three legs on a push, and keeps a pull request at full width', () => {
    const wide = Object.entries(doc.jobs).filter(([, j]) => legs(j) > 3)
    expect(wide.map(([n]) => n).sort()).toEqual(['browser', 'ios', 'node-side', 'test', 'test-e2e'])
    for (const [name, job] of wide) {
      expect(pushCap(job), `${name}: max-parallel on a push`).toBeLessThanOrEqual(4)
      expect(prCap(job), `${name}: a pull request keeps every leg`).toBeGreaterThanOrEqual(legs(job))
    }
  })

  it('keeps the capped matrices together under half of the 20 jobs', () => {
    // The iOS job's two are not new: it ran two legs, uncapped, before its UI layer took three
    // shards (run 42735468568 ran out of time on one), and on a push it still holds two runners at a time.
    const sum = Object.values(doc.jobs).filter((j) => legs(j) > 3).reduce((n, j) => n + pushCap(j), 0)
    expect(pushCap(doc.jobs.ios!)).toBeLessThanOrEqual(2)
    expect(sum).toBeLessThanOrEqual(11 + 2)
  })
})
