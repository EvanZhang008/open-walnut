/**
 * A required CI leg GitHub never gave a machine is run again (scripts/ci-runner-retry.mjs,
 * .github/workflows/ci-runner-retry.yml). 2026-11-10, CI run 42851742614: the live update rehearsal
 * on macos-26 waited 21 minutes for a runner, was cancelled with no step run, and CI OK went red on
 * a commit nothing had tested. A leg that ran and failed is never run again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { MAX_ATTEMPT, neverRan, planRetry, requiredLegPatterns } from '../../scripts/ci-runner-retry.mjs'

const ROOT = path.resolve(__dirname, '../..')
const ciYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const ci = parseYaml(ciYml) as { jobs: Record<string, { name?: string; needs?: string[]; strategy?: { matrix?: Record<string, unknown> } }> }
const patterns = requiredLegPatterns(ciYml)

type Job = { id: number; name: string; conclusion: string; runner_name: string; steps: { name: string; conclusion: string }[] }
const ran = (id: number, name: string, conclusion = 'success'): Job => ({ id, name, conclusion, runner_name: `GitHub Actions ${id}`, steps: [{ name: 'Set up job', conclusion: 'success' }] })
const dropped = (id: number, name: string): Job => ({ id, name, conclusion: 'cancelled', runner_name: '', steps: [] })

// Run 42851742614's jobs that matter here, as GitHub listed them.
const run42851742614 = (): Job[] => [
  ran(1, 'Lint & build'),
  ran(2, 'Release rehearsal (macos-26)'),
  ran(3, 'Release rehearsal, field update (macos-26)'),
  ran(4, 'Release rehearsal, live update (ubuntu-24.04)'),
  dropped(130007400115, 'Release rehearsal, live update (macos-26)'),
  ran(5, 'Archive (darwin-x64)'),
  ran(6, 'iOS app (unit)', 'failure'),
  ran(7, 'iOS app (ui 1/3)', 'failure'),
  ran(8, 'Browser baseline', 'failure'),
  ran(9, 'CI OK', 'failure'),
]

describe('the legs CI OK needs', () => {
  it('are read from ci.yml the way GitHub names them', () => {
    const gate = Object.values(ci.jobs).find((j) => j.name === 'CI OK')!
    expect(patterns).toHaveLength(gate.needs!.length)
    for (const key of gate.needs!) {
      const job = ci.jobs[key]
      // A leg's name with each matrix expression filled in with something.
      const name = (job.name ?? key).replace(/\$\{\{.*?\}\}/g, 'x')
      expect(patterns.some((p) => p.test(name)), key).toBe(true)
    }
    for (const name of ['Release rehearsal, live update (macos-26)', 'Archive (darwin-x64)', 'Lint & build']) expect(patterns.some((p) => p.test(name)), name).toBe(true)
  })

  it('leave out the report-only jobs', () => {
    for (const name of ['iOS app (unit)', 'iOS app (ui 2/3)', 'Browser baseline', 'CI OK']) expect(patterns.some((p) => p.test(name)), name).toBe(false)
  })
})

describe('planRetry', () => {
  it('runs again the one required leg that got no runner, the 2026-11-10 run', () => {
    expect(neverRan(dropped(1, 'x'))).toBe(true)
    expect(neverRan(ran(1, 'x', 'cancelled'))).toBe(false)
    expect(planRetry(run42851742614(), patterns, 1)).toMatchObject({ action: 'job', ids: [130007400115] })
    expect(planRetry(run42851742614(), patterns, 2)).toMatchObject({ action: 'job' })
  })

  it('runs every failed job again when several required legs got no runner', () => {
    const jobs = [...run42851742614(), dropped(10, 'Release rehearsal (ubuntu-24.04)')]
    expect(planRetry(jobs, patterns, 1)).toMatchObject({ action: 'failed' })
  })

  it('leaves a run alone when a required leg ran and failed, CI OK passed, or it already ran again twice', () => {
    expect(planRetry([...run42851742614(), ran(11, 'Test (slow)', 'failure')], patterns, 1).action).toBe('none')
    expect(planRetry([...run42851742614(), ran(12, 'Release rehearsal (ubuntu-24.04)', 'cancelled')], patterns, 1).action).toBe('none')
    const green = run42851742614().map((j) => (j.name === 'CI OK' ? { ...j, conclusion: 'success' } : j))
    expect(planRetry(green, patterns, 1).action).toBe('none')
    expect(planRetry(run42851742614(), patterns, MAX_ATTEMPT).action).toBe('none')
  })
})

describe('the workflow', () => {
  const wf = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci-runner-retry.yml'), 'utf8')) as {
    on: { workflow_run: { workflows: string[]; branches: string[] } }; permissions: Record<string, string>
    jobs: { retry: { if: string; steps: { run?: string; with?: { 'sparse-checkout'?: string } }[] } }
  }
  it('follows a finished push run of CI on main, may start a rerun and runs the script it checks out', () => {
    expect(wf.on.workflow_run).toMatchObject({ workflows: ['CI'], branches: ['main'] })
    expect(wf.permissions.actions).toBe('write')
    expect(wf.jobs.retry.if).toContain("workflow_run.event == 'push'")
    const sparse = wf.jobs.retry.steps.find((s) => s.with?.['sparse-checkout'])!.with!['sparse-checkout']!
    expect(sparse).toContain('scripts/ci-runner-retry.mjs')
    expect(sparse).toContain('.github/workflows/ci.yml')
    expect(wf.jobs.retry.steps.some((s) => s.run?.includes('bun scripts/ci-runner-retry.mjs') && s.run.includes('run_attempt'))).toBe(true)
  })
})
