/**
 * A required CI leg GitHub never gave a machine is run again (scripts/ci-runner-retry.mjs,
 * .github/workflows/ci-runner-retry.yml). 2026-11-10, CI run 42851742614: the live update rehearsal
 * on macos-26 waited 21 minutes for a runner, was cancelled with no step run, and CI OK went red on
 * a commit nothing had tested. A leg that ran and failed is never run again.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { MAX_ATTEMPT, WORKFLOWS, ghRetry, neverRan, planRetry, requiredLegPatterns } from '../../scripts/ci-runner-retry.mjs'

const ROOT = path.resolve(__dirname, '../..')
const ciYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const ci = parseYaml(ciYml) as { jobs: Record<string, { name?: string; needs?: string[]; uses?: string; strategy?: { matrix?: Record<string, unknown> } }> }
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
      // A leg's name with each matrix expression filled in with something; a called
      // workflow's jobs are "<the calling job's name> / <their own>".
      const name = (job.name ?? key).replace(/\$\{\{.*?\}\}/g, 'x') + (job.uses ? ' / x' : '')
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

  it('runs every failed job again when several required legs got no runner and nothing else is red', () => {
    const quiet = run42851742614().filter((j) => !['iOS app (unit)', 'iOS app (ui 1/3)', 'Browser baseline'].includes(j.name))
    expect(planRetry([...quiet, dropped(10, 'Release rehearsal (ubuntu-24.04)')], patterns, 1)).toMatchObject({ action: 'failed' })
  })

  it('runs them one per attempt when a report-only job is red, so "rerun failed jobs" never runs it again', () => {
    // The iOS UI shards are red on their own (six macOS runners): a dropped leg must not bring them back.
    const jobs = [...run42851742614(), dropped(10, 'Release rehearsal (ubuntu-24.04)')]
    expect(planRetry(jobs, patterns, 1)).toMatchObject({ action: 'job', ids: [130007400115] })
    // The next attempt: the first is green now, the second is run.
    const next = jobs.map((j) => (j.id === 130007400115 ? ran(j.id, j.name) : j))
    expect(planRetry(next, patterns, 2)).toMatchObject({ action: 'job', ids: [10] })
  })

  it('runs CI OK again alone when every required leg passed after it judged them', () => {
    // A leg's rerun that did not take CI OK along (a called workflow's job) leaves CI OK red on legs
    // that all passed now.
    const after = run42851742614().map((j) => (j.id === 130007400115 ? ran(j.id, j.name) : j))
    expect(planRetry(after, patterns, 2)).toMatchObject({ action: 'job', ids: [9], names: ['CI OK'] })
    // Not when a required leg was skipped: CI OK is right to be red then.
    const skipped = after.map((j) => (j.name === 'Archive (darwin-x64)' ? { ...j, conclusion: 'skipped' } : j))
    expect(planRetry(skipped, patterns, 2).action).toBe('none')
  })

  it('leaves a run alone when a required leg ran and failed, CI OK passed, or it already ran again twice', () => {
    expect(planRetry([...run42851742614(), ran(11, 'Test (slow)', 'failure')], patterns, 1).action).toBe('none')
    expect(planRetry([...run42851742614(), ran(12, 'Release rehearsal (ubuntu-24.04)', 'cancelled')], patterns, 1).action).toBe('none')
    const green = run42851742614().map((j) => (j.name === 'CI OK' ? { ...j, conclusion: 'success' } : j))
    expect(planRetry(green, patterns, 1).action).toBe('none')
    expect(planRetry(run42851742614(), patterns, MAX_ATTEMPT).action).toBe('none')
  })
})

// Binary matrix run 43036597217 (2026-11-11): macos-15 got no runner. Since 2026-11-24 its rows are
// jobs of CI's own run (ci.yml calls the matrix, CI OK needs it), named as GitHub names a called
// workflow's jobs, so a dropped row is a required CI leg like any other.
describe('the binary matrix, inside CI\'s run', () => {
  const rows = (): Job[] => [
    ...run42851742614().filter((j) => j.name !== 'Release rehearsal, live update (macos-26)'),
    ran(20, 'Binary matrix / Build the files'), ran(21, 'Binary matrix / ubuntu:24.04 (walnut-linux-x64)'),
    dropped(130579022498, 'Binary matrix / macos-15 (walnut-darwin-arm64)'),
  ]

  it('its rows are required legs, its own name alone is not a job', () => {
    for (const name of ['Binary matrix / Build the files', 'Binary matrix / macos-15 (walnut-darwin-arm64)', 'Binary matrix / centos 7 VM (kernel 3.10)']) {
      expect(patterns.some((p) => p.test(name)), name).toBe(true)
    }
    // A job of the same name outside the call (a report-only one, say) is not one of them.
    expect(patterns.some((p) => p.test('Binary matrix (x)'))).toBe(false)
  })

  it('runs again the one row that got no runner, alone: the red iOS jobs are not run again', () => {
    expect(planRetry(rows(), patterns, 1)).toMatchObject({ action: 'job', ids: [130579022498], names: ['Binary matrix / macos-15 (walnut-darwin-arm64)'] })
    // GitHub's docs promise the job's dependents, not the caller's CI OK: if CI OK stayed red, the
    // next attempt runs it again.
    const after = rows().map((j) => (j.id === 130579022498 ? ran(j.id, j.name) : j))
    expect(planRetry(after, patterns, 2)).toMatchObject({ action: 'job', names: ['CI OK'] })
  })

  it('leaves it alone when a row ran and did not pass, the 2026-11-11 run with its hung VM', () => {
    expect(planRetry([...rows(), ran(22, 'Binary matrix / centos 7 VM (kernel 3.10)', 'cancelled')], patterns, 1).action).toBe('none')
    expect(planRetry(rows(), patterns, MAX_ATTEMPT).action).toBe('none')
  })

  it('a build that got no runner is run again: GitHub runs again the rows that need it', () => {
    const jobs = [...rows().filter((j) => j.id !== 130579022498 && j.id !== 20 && j.id !== 21), dropped(23, 'Binary matrix / Build the files'),
      { ...ran(24, 'Binary matrix / macos-15 (walnut-darwin-arm64)'), conclusion: 'skipped' }]
    expect(planRetry(jobs, patterns, 1)).toMatchObject({ action: 'job', ids: [23] })
  })
})

describe('the script against a fake gh', () => {
  it('reads every page of the run\'s jobs and runs again the matrix row on the second page', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runner-retry-'))
    try {
      // 101 jobs: CI OK and 99 report-only legs on page 1, the dropped row on page 2.
      const page1 = [ran(9, 'CI OK', 'failure'), ...Array.from({ length: 99 }, (_, i) => ran(1000 + i, `Browser (${i + 1}/99)`))]
      const page2 = [dropped(777, 'Binary matrix / macos-15 (walnut-darwin-arm64)')]
      fs.writeFileSync(path.join(tmp, 'pages.json'), JSON.stringify({ 1: page1, 2: page2 }))
      const bin = path.join(tmp, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(tmp)}
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\\n')
if (args.includes('POST')) process.exit(0)
const m = /runs\\/123\\/jobs\\?per_page=100&page=(\\d+)/.exec(args[1])
if (!m) { process.stderr.write('unexpected ' + args.join(' ')); process.exit(1) }
const pages = JSON.parse(fs.readFileSync(path.join(dir, 'pages.json'), 'utf8'))
process.stdout.write(JSON.stringify({ total_count: 101, jobs: pages[m[1]] ?? [] }))
`, { mode: 0o755 })
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/ci-runner-retry.mjs'), '123', '1', 'CI'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const calls = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8').trim().split('\n')
      expect(calls).toEqual([
        'api repos/{owner}/{repo}/actions/runs/123/jobs?per_page=100&page=1',
        'api repos/{owner}/{repo}/actions/runs/123/jobs?per_page=100&page=2',
        'api -X POST repos/{owner}/{repo}/actions/jobs/777/rerun',
      ])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('the workflow', () => {
  const wf = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci-runner-retry.yml'), 'utf8')) as {
    on: { workflow_run: { workflows: string[]; branches: string[] } }; permissions: Record<string, string>
    jobs: { retry: { if: string; steps: { run?: string; with?: { 'sparse-checkout'?: string } }[] } }
  }
  it('follows a finished push run of CI on main, may start a rerun and runs the script it checks out', () => {
    // CI alone: the binary matrix has no push run of its own any more, its rows are CI's.
    expect(Object.keys(WORKFLOWS)).toEqual(['CI'])
    expect(wf.on.workflow_run).toMatchObject({ workflows: ['CI'], branches: ['main'] })
    expect(wf.permissions.actions).toBe('write')
    expect(wf.jobs.retry.if).toContain("workflow_run.event == 'push'")
    const sparse = wf.jobs.retry.steps.find((s) => s.with?.['sparse-checkout'])!.with!['sparse-checkout']!
    expect(sparse).toContain('scripts/ci-runner-retry.mjs')
    expect(sparse).toContain('.github/workflows/ci.yml')
    expect(wf.jobs.retry.steps.some((s) => s.run?.includes('bun scripts/ci-runner-retry.mjs') && s.run.includes('run_attempt') && s.run.includes('"$WORKFLOW"'))).toBe(true)
  })
})

describe('gh calls ride out GitHub\'s own errors', () => {
  // 2026-11-11, run 43089327630: `gh: Server Error (HTTP 502)` during an Actions outage ended the job.
  const fail = (text: string) => Object.assign(new Error(`Command failed: gh api\n${text}`), { stderr: text })
  const noSleep = () => {}

  it('a 502, a 429 or a dropped connection is tried again, then the answer is returned', () => {
    for (const text of ['gh: Server Error (HTTP 502)', 'gh: HTTP 429: rate limited', 'read ECONNRESET', 'error connecting to api.github.com']) {
      let calls = 0
      const out = ghRetry(() => { if (++calls < 3) throw fail(text); return '{"jobs":[]}' }, ['api', 'x'], { sleep: noSleep })
      expect(out).toBe('{"jobs":[]}')
      expect(calls).toBe(3)
    }
  })

  it('stops after its tries and throws the last error', () => {
    let calls = 0
    expect(() => ghRetry(() => { calls++; throw fail('gh: Server Error (HTTP 503)') }, ['api', 'x'], { tries: 4, sleep: noSleep })).toThrow(/503/)
    expect(calls).toBe(4)
  })

  it('any other error is thrown at once', () => {
    let calls = 0
    expect(() => ghRetry(() => { calls++; throw fail('gh: Not Found (HTTP 404)') }, ['api', 'x'], { sleep: noSleep })).toThrow(/404/)
    expect(calls).toBe(1)
  })

  it('a rerun whose first answer was lost and is then refused counts as done', () => {
    let calls = 0
    const run = () => { if (++calls === 1) throw fail('gh: Server Error (HTTP 502)'); throw fail('gh: This job is already running (HTTP 403)') }
    expect(ghRetry(run, ['api', '-X', 'POST', 'jobs/1/rerun'], { sleep: noSleep })).toBe('')
    expect(calls).toBe(2)
  })

  it('every gh call of the script goes through it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/ci-runner-retry.mjs'), 'utf8')
    expect(src.match(/execFileSync\('gh'/g)?.length).toBe(1)
    expect(src).toMatch(/return ghRetry\(\(a\) => execFileSync\('gh'/)
  })
})
