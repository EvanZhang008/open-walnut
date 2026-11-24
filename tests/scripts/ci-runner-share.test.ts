/**
 * CI on a push to main leaves most of the repository's runners to the push gate (ci.yml,
 * CI_RUNNER_SHARE). 2026-11-09: two post-push CI runs held 12 to 17 of the 20 jobs GitHub runs at a
 * time for 80 to 90 minutes, the gate that every land waits on before it writes main ran 3 to 8
 * jobs with 20 to 45 queued, and lands went live at 3 an hour. Every matrix of more than three legs
 * is capped on a push, a pull request keeps its full width, and the caps together stay under half
 * of the 20. A workflow ci.yml calls (`uses:`, the binary matrix since 2026-11-24) runs its jobs in
 * CI's run, so its matrices count here as CI's own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
type Job = { uses?: string; strategy?: { 'max-parallel'?: string | number; matrix?: { include?: unknown[]; [axis: string]: unknown } } }
const doc = parseYaml(raw) as { on: Record<string, unknown>; jobs: Record<string, Job> }
/** ci.yml's jobs and, for a job that calls a workflow, that workflow's jobs as `<job>/<its job>`. */
const jobs: Record<string, Job> = Object.fromEntries(Object.entries(doc.jobs).flatMap(([name, job]) => {
  if (!job.uses) return [[name, job]]
  const called = parseYaml(fs.readFileSync(path.join(ROOT, job.uses), 'utf8')) as { jobs: Record<string, Job> }
  return Object.entries(called.jobs).map(([k, j]) => [`${name}/${k}`, j])
}))

/** The legs a job's matrix makes: the product of its axes, or its include list. */
function legs(job: Job): number {
  const m = job.strategy?.matrix
  if (!m) return 1
  const axes = Object.entries(m).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v)) as [string, unknown[]][]
  const product = axes.reduce((n, [, v]) => n * v.length, axes.length ? 1 : 0)
  return Math.max(product, (m.include ?? []).length)
}
/**
 * The cap on a push: `${{ github.event_name == 'push' && N || M }}` gives N, and so does a called
 * workflow's `${{ inputs.files == '' && github.event_name == 'push' && N || M }}` (CI's call has no
 * files; a release's call, with them, is not CI's run); none gives Infinity.
 */
function pushCap(job: Job): number {
  const mp = job.strategy?.['max-parallel']
  if (mp === undefined) return Infinity
  if (typeof mp === 'number') return mp
  const m = /^\$\{\{\s*(?:inputs\.files == '' && )?github\.event_name == 'push' && (\d+) \|\| (\d+)\s*\}\}$/.exec(mp)
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
    const wide = Object.entries(jobs).filter(([, j]) => legs(j) > 3)
    expect(wide.map(([n]) => n).sort()).toEqual(['binary-matrix/linux', 'browser', 'field', 'ios', 'node-side', 'test', 'test-e2e'])
    for (const [name, job] of wide) {
      expect(pushCap(job), `${name}: max-parallel on a push`).toBeLessThanOrEqual(4)
      expect(prCap(job), `${name}: a pull request keeps every leg`).toBeGreaterThanOrEqual(legs(job))
    }
  })

  it('keeps the capped matrices together under half of the 20 jobs', () => {
    // The iOS job's two are not new: it ran two legs, uncapped, before its UI layer took three
    // shards (run 42735468568 ran out of time on one), and on a push it still holds two runners at a time.
    // The field rehearsal's two are not new either: it ran two legs, uncapped, before its Linux
    // leg split into three (2026-11-15, 87 of its 90 minutes), and on a push it holds two still.
    // The binary matrix's two are not new either: before 2026-11-24 its 14 Linux rows ran uncapped on
    // every push in a workflow of their own; inside CI's run they hold two at a time, about a minute each.
    const sum = Object.values(jobs).filter((j) => legs(j) > 3).reduce((n, j) => n + pushCap(j), 0)
    expect(pushCap(doc.jobs.ios!)).toBeLessThanOrEqual(2)
    expect(pushCap(doc.jobs.field!)).toBeLessThanOrEqual(2)
    expect(pushCap(jobs['binary-matrix/linux']!)).toBeLessThanOrEqual(2)
    expect(sum).toBeLessThanOrEqual(11 + 2 + 2 + 2)
  })

  it('caps the Macs of a called workflow on a push too: macOS runners are the scarcest', () => {
    // CI's call of the binary matrix: three Macs, two at a time on a push, all three otherwise.
    const mac = jobs['binary-matrix/macos']!
    expect(legs(mac)).toBe(3)
    expect(pushCap(mac)).toBeLessThanOrEqual(2)
    expect(prCap(mac)).toBeGreaterThanOrEqual(legs(mac))
    // A release's call (with its files) is never capped: the expression gives the cap only without files.
    expect(String(mac.strategy!['max-parallel'])).toMatch(/^\$\{\{ inputs\.files == '' && github\.event_name == 'push' && \d+ \|\| \d+ \}\}$/)
    expect(String(jobs['binary-matrix/linux']!.strategy!['max-parallel'])).toMatch(/^\$\{\{ inputs\.files == '' && github\.event_name == 'push' && \d+ \|\| \d+ \}\}$/)
  })
})
