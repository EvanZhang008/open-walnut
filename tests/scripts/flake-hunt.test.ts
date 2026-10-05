/**
 * The flake hunt (.github/workflows/flake-hunt.yml + scripts/flake-report.mjs):
 * every commit CI passes on main reruns the blocking tiers, and what a rerun
 * finds becomes warning annotations, never a red run.
 *
 * Real: the reporter script run as a child process against JSON files shaped
 * like test-baseline.mjs's run output; the committed workflows parsed as YAML.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { FLAKY_TITLE, HUNT_TITLE, annotationLine, flakeAnnotations } from '../../scripts/flake-report.mjs'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/flake-report.mjs')
const KNOWN = 'tests/a.test.ts :: a known one'
const NEW = 'tests/b.test.ts :: suite fails one time in twenty'

describe('flakeAnnotations', () => {
  const run = { failures: [KNOWN, NEW], reasons: { [NEW]: 'AssertionError: expected 1 to be 2 | at tests/b.test.ts:9:3' } }
  const baseline = { failures: [KNOWN] }

  it('says nothing about a leg that passed', () => {
    expect(flakeAnnotations({ label: 'quick 1/3', outcome: 'success', run, baseline })).toEqual([])
  })

  it('names each failure the baseline does not hold, with its reason', () => {
    expect(flakeAnnotations({ label: 'quick 1/3', outcome: 'failure', run, baseline })).toEqual([
      { title: `${FLAKY_TITLE} (quick 1/3)`, message: `${NEW}: AssertionError: expected 1 to be 2 | at tests/b.test.ts:9:3` },
    ])
    const bare = flakeAnnotations({ label: 'slow', outcome: 'failure', run: { failures: [NEW] }, baseline: null })
    expect(bare).toEqual([{ title: `${FLAKY_TITLE} (slow)`, message: NEW }])
  })

  it('still reports a leg that failed with nothing to name', () => {
    const noReport = flakeAnnotations({ label: 'e2e 2/4', outcome: 'failure', run: null, baseline })
    expect(noReport).toHaveLength(1)
    expect(noReport[0]!.title).toBe(`${HUNT_TITLE} (e2e 2/4)`)
    expect(noReport[0]!.message).toContain('without a report')
    const onlyKnown = flakeAnnotations({ label: 'quick 2/3', outcome: 'failure', run: { failures: [KNOWN] }, baseline })
    expect(onlyKnown[0]!.message).toContain('no new test failure')
    const setup = flakeAnnotations({ label: 'quick 3/3', outcome: 'skipped', run: null, baseline })
    expect(setup[0]!.message).toContain('never reached its tests')
  })
})

describe('annotationLine', () => {
  it('escapes what would end or split the workflow command', () => {
    expect(annotationLine({ title: 'Flaky test (e2e 1/4)', message: 'a: b, 100%\nnext' }))
      .toBe('::warning title=Flaky test (e2e 1/4)::a: b, 100%25%0Anext')
    expect(annotationLine({ title: 'x: y, z', message: 'm' })).toBe('::warning title=x%3A y%2C z::m')
  })
})

describe('flake-report.mjs as the workflow runs it', () => {
  let tmp = ''
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-flake-report-')) })
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const report = (args: string[]): Promise<{ code: number; out: string; summary: string }> => {
    const summary = path.join(tmp, `summary-${Math.random().toString(36).slice(2)}.md`)
    return new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } }, (err, stdout) => {
        const code = err ? Number((err as { code?: number }).code ?? 1) : 0
        resolve({ code, out: stdout, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' })
      })
    })
  }

  it('turns a failed leg into warnings and exits 0', async () => {
    const runFile = path.join(tmp, 'run.json')
    const baseFile = path.join(tmp, 'base.json')
    fs.writeFileSync(runFile, JSON.stringify({ config: 'vitest.quick.config.ts', count: 2, failures: [KNOWN, NEW], reasons: { [NEW]: 'boom' } }))
    fs.writeFileSync(baseFile, JSON.stringify({ failures: [KNOWN] }))
    const r = await report(['--label', 'quick 1/3', '--outcome', 'failure', '--run', runFile, '--baseline', baseFile])
    expect(r.code).toBe(0)
    expect(r.out.trim().split('\n')).toEqual([`::warning title=Flaky test (quick 1/3)::${NEW}: boom`])
    expect(r.summary).toContain('quick 1/3: 1 finding(s)')
  })

  it('a passing leg prints nothing; a missing run file is a finding, not a crash', async () => {
    const ok = await report(['--label', 'slow', '--outcome', 'success', '--run', path.join(tmp, 'absent.json')])
    expect(ok).toMatchObject({ code: 0, out: '' })
    expect(ok.summary).toContain('slow: no flake')
    const gone = await report(['--label', 'slow', '--outcome', 'failure', '--run', path.join(tmp, 'absent.json')])
    expect(gone.code).toBe(0)
    expect(gone.out).toContain('::warning title=Flake hunt (slow)::')
  })
})

describe('runner images', () => {
  it('every job of CI, Release, the archives and the hunt runs on a pinned image, never a -latest label', () => {
    // ubuntu-latest moves to 26.04 from 2026-10-19 on GitHub's schedule; a moving
    // label turns CI red without a commit. The archives also need each image's
    // other architecture (both standard runners for a public repository).
    const files = ['ci.yml', 'release.yml', 'release-archives.yml', 'flake-hunt.yml', 'mac-app.yml']
    for (const file of files) {
      const doc = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')) as {
        jobs: Record<string, { 'runs-on': string; uses?: string; strategy?: { matrix?: { os?: string[]; include?: Array<{ os: string }> } } }>
      }
      for (const [name, job] of Object.entries(doc.jobs)) {
        // A job that calls another workflow runs on that workflow's jobs, which this loop checks too.
        if (job.uses) {
          expect(files.map((f) => `./.github/workflows/${f}`), `${file} ${name}`).toContain(job.uses)
          continue
        }
        const matrix = job.strategy?.matrix
        const labels = job['runs-on'] === '${{ matrix.os }}' ? (matrix!.os ?? matrix!.include!.map((x) => x.os)) : [job['runs-on']]
        expect(labels.length, `${file} ${name}`).toBeGreaterThan(0)
        for (const label of labels) expect(label, `${file} ${name}`).toMatch(/^(ubuntu-24\.04(-arm)?|macos-26(-intel)?)$/)
      }
    }
  })
})

describe('flake-hunt.yml', () => {
  type Step = { uses?: string; run?: string; if?: string; id?: string; 'continue-on-error'?: boolean; with?: Record<string, string>; env?: Record<string, string> }
  type Leg = { leg: string; build: string; config: string; baseline: string; min: string; args: string }
  const hunt = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/flake-hunt.yml'), 'utf8')) as {
    on: { workflow_run: { workflows: string[]; types: string[]; branches: string[] } }
    concurrency?: unknown
    permissions: Record<string, string>
    jobs: { hunt: { if: string; 'continue-on-error': boolean; strategy: { matrix: { include: Leg[] } }; steps: Step[] } }
  }
  const ci = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Step[]; strategy?: { matrix: { include?: Array<{ tier: string; cmd: string }>; shard?: number[] } } }>
  }
  const job = hunt.jobs.hunt
  const legs = job.strategy.matrix.include

  it('runs after CI on main, only for a green push, and never cancels itself', () => {
    expect(hunt.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'], branches: ['main'] })
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(job.if).toContain("github.event.workflow_run.event == 'push'")
    expect(hunt.concurrency).toBeUndefined()
    expect(hunt.permissions).toEqual({ contents: 'read' })
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout'))!
    expect(checkout.with!.ref).toContain('github.event.workflow_run.head_sha')
  })

  it('reruns every blocking leg CI has, with CI\'s own arguments', () => {
    const quickCmds = ci.jobs.test!.strategy!.matrix.include!.filter((l) => l.tier.startsWith('quick')).map((l) => l.cmd)
    expect(legs.filter((l) => l.leg.startsWith('quick')).map((l) => `npm run test:baseline -- ${l.args}`)).toEqual(quickCmds)
    const e2eRun = ci.jobs['test-e2e']!.steps.map((s) => s.run ?? '').find((r) => r.includes('test-baseline.mjs'))!
    for (const shard of ci.jobs['test-e2e']!.strategy!.matrix.shard!) {
      const leg = legs.find((l) => l.leg === `e2e ${shard}/4`)!
      expect(e2eRun.replace('${{ matrix.shard }}', String(shard))).toBe(`node scripts/test-baseline.mjs check ${leg.args}`)
      expect(leg.baseline).toBe('tests/setup/known-failures-e2e.json')
    }
    const slowRun = ci.jobs['test-heavy']!.steps.map((s) => s.run ?? '').find((r) => r.includes('test:slow'))!
    const slow = legs.find((l) => l.leg === 'slow')!
    expect(slowRun).toBe(`npm run test:slow -- ${slow.args}`)
    expect(slow.config).toBe('vitest.slow.config.ts')
  })

  it('a leg that finds something stays green and reports it', () => {
    expect(job['continue-on-error']).toBe(true)
    const tests = job.steps.find((s) => s.id === 'tests')!
    expect(tests['continue-on-error']).toBe(true)
    expect(tests.run).toContain('node scripts/test-baseline.mjs check ${{ matrix.args }}')
    const reportStep = job.steps.find((s) => s.run?.includes('scripts/flake-report.mjs'))!
    expect(reportStep.if).toBe('always()')
    expect(reportStep.run).toContain('--outcome "${{ steps.tests.outcome }}"')
    // Both steps read and write the same two files.
    expect(reportStep.env).toEqual({ WALNUT_BASELINE_FILE: tests.env!.WALNUT_BASELINE_FILE, WALNUT_BASELINE_RUN_OUT: tests.env!.WALNUT_BASELINE_RUN_OUT })
  })
})
