/**
 * macOS runners are few (3 ran at once on 2026-11-23) and every push to main asked for more:
 * the binary matrix's push run for every commit, three macOS jobs each, though GitHub keeps one
 * pending CI run on main and the next push replaces it, so most commits are never judged by CI;
 * and the Release workflow's nightly build job, on macOS, for every CI run that ended, only to
 * find no nightly due. 59 macOS jobs queued; Release run 45208086362's nightly build waited
 * 3 h 15 min and was cancelled, and no nightly came out for five days.
 *
 * So a macOS job runs only when it has work:
 *   - in release.yml, a macOS job follows a Linux job that decided there is something to build
 *     (its `if` reads that job's outputs), or runs on a release tag only;
 *   - binary-matrix.yml has no push or pull_request run of its own: CI calls it inside its own run
 *     (ci.yml, job binary-matrix), so only a commit CI runs asks for its macOS rows.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { NIGHTLY_SHAPE } from '../../scripts/nightly-version.mjs'
import { releaseInFlight } from '../../scripts/lib/release-in-flight.mjs'

const REPO = path.join(import.meta.dirname, '..', '..')
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string }
type Job = {
  'runs-on'?: string; if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[]
  strategy?: { matrix?: Record<string, unknown> & { include?: Array<Record<string, unknown>> } }
}
const workflow = (name: string) => parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> }
/** The runners a job may take: its runs-on, or every value of the matrix key that runs-on names. */
function runnersOf(job: Job): string[] {
  const label = String(job['runs-on'] ?? '')
  const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(label)?.[1]
  if (!key) return [label]
  const matrix = job.strategy?.matrix ?? {}
  return [...[matrix[key] ?? []].flat(), ...(matrix.include ?? []).map((row) => row[key])].map(String)
}
const onMac = (job: Job) => runnersOf(job).some((r) => /^macos/.test(r))

describe('release.yml asks for a macOS runner only with work for it', () => {
  const { jobs } = workflow('release.yml')
  const macJobs = Object.entries(jobs).filter(([, job]) => onMac(job))

  it('finds its macOS jobs, the nightly build among them', () => {
    // promote-smoke takes macOS through its matrix.
    expect(macJobs.map(([id]) => id)).toEqual(expect.arrayContaining(['nightly-build', 'stable-build', 'promote-build', 'promote-smoke']))
  })

  it('every macOS job runs on a tag only, or after a job that decided there is work, read from its outputs', () => {
    for (const [id, job] of macJobs) {
      const cond = String(job.if ?? '')
      if (/^startsWith\(github\.ref, 'refs\/tags\/v'\)$/.test(cond)) continue
      const needs = [job.needs ?? []].flat()
      expect(needs.length, id).toBeGreaterThan(0)
      // Exactly "needs.<decider>.outputs.<flag> == 'true'": nothing that could run it anyway (always(), ||).
      const decider = /^needs\.([\w-]+)\.outputs\.[\w-]+ == 'true'$/.exec(cond)?.[1]
      expect(decider && needs.includes(decider), `${id}: its if (${cond}) is not one of its needs' outputs`).toBe(true)
      expect(onMac(jobs[decider!]!), `${id}: its decider ${decider} runs on Linux`).toBe(false)
    }
  })

  it('the nightly pick is that Linux job, and it runs on every check', () => {
    expect(jobs['nightly-pick']!['runs-on']).toBe('ubuntu-24.04')
    expect(jobs['nightly-pick']!.if).toContain("github.event_name == 'workflow_run'")
    expect(jobs['nightly-build']!.if).toBe("needs.nightly-pick.outputs.publish == 'true'")
  })

  it('the pick stands down while an older run builds or publishes a nightly, the last check before yes', () => {
    const pick = jobs['nightly-pick']!.steps!.find((s) => s.id === 'pick')!.run!
    const inFlight = pick.indexOf('inflight="$(bun scripts/nightly-version.mjs in-flight)" && [ -n "$inflight" ]')
    expect(inFlight).toBeGreaterThan(pick.indexOf('bun scripts/components-release-ready.mjs'))
    expect(inFlight).toBeLessThan(pick.indexOf('echo "publish=true"'))
    expect(pick.slice(inFlight).split('\n').slice(0, 6).join('\n')).toContain('echo "publish=false"')
  })

  it('the nightly\'s in-flight shape names release.yml\'s own jobs', () => {
    expect(NIGHTLY_SHAPE.build.test(String((jobs['nightly-build'] as { name?: string }).name))).toBe(true)
    // A called workflow's job reads "<caller job name> / <row>".
    expect(NIGHTLY_SHAPE.needs.test(`${(jobs['nightly-files'] as { name?: string }).name} / macos-26 (walnut-darwin-arm64)`)).toBe(true)
  })
})

describe('binary-matrix.yml runs only inside a caller\'s run', () => {
  const raw = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/binary-matrix.yml'), 'utf8')) as { on: Record<string, unknown> }

  it('has no push or pull_request trigger of its own, and CI calls it', () => {
    expect(Object.keys(raw.on).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
    const ci = workflow('ci.yml').jobs as Record<string, Job & { uses?: string }>
    expect(Object.values(ci).some((job) => job.uses === './.github/workflows/binary-matrix.yml')).toBe(true)
  })
})

describe('releaseInFlight with the nightly\'s shape', () => {
  const run = (id: number, status = 'in_progress') => ({ id, status, html_url: `https://example.test/runs/${id}` })
  const job = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion })
  const files = "The nightly's files on every system / macos-26 (walnut-darwin-arm64)"

  it('an older run whose build is queued, running or done, its legs not broken, is in flight', () => {
    for (const build of [job('Build the nightly from main', 'queued'), job('Build the nightly from main', 'in_progress'), job('Build the nightly from main', 'completed', 'success')]) {
      expect(releaseInFlight([run(5)], () => [build, job(files, 'queued')], 9, NIGHTLY_SHAPE)).toBe('https://example.test/runs/5')
    }
  })

  it('a newer run, a skipped or failed build, a broken leg, a finished run: not in flight', () => {
    const building = () => [job('Build the nightly from main', 'in_progress')]
    expect(releaseInFlight([run(12)], building, 9, NIGHTLY_SHAPE)).toBeNull()
    expect(releaseInFlight([run(5)], () => [job('Build the nightly from main', 'completed', 'skipped')], 9, NIGHTLY_SHAPE)).toBeNull()
    expect(releaseInFlight([run(5)], () => [job('Build the nightly from main', 'completed', 'failure')], 9, NIGHTLY_SHAPE)).toBeNull()
    expect(releaseInFlight([run(5)], () => [job('Build the nightly from main', 'completed', 'success'), job(files, 'completed', 'failure')], 9, NIGHTLY_SHAPE)).toBeNull()
    expect(releaseInFlight([run(5, 'completed')], building, 9, NIGHTLY_SHAPE)).toBeNull()
  })
})
