/**
 * scripts/browser-baseline.mjs: the browser suite's known-failures gate. It fails
 * only on a failure the committed list does not name, or on an error outside a
 * test; a flaky test passes, a test that never ran is neutral, and `record` only
 * adds (a passing known failure leaves only with --prune).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { isSerialSpec, judge, mergeReports, RECHECK_MAX, recheckLocations, recordBaseline, reportFiles } from '../../scripts/browser-baseline.mjs'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/browser-baseline.mjs')

type Status = 'expected' | 'unexpected' | 'flaky' | 'skipped'
/** A Playwright JSON report with one file suite per entry of `files`. */
function report(files: Record<string, Record<string, Status>>) {
  return {
    suites: Object.entries(files).map(([file, tests]) => ({
      title: file,
      file,
      specs: Object.entries(tests).map(([title, status], i) => ({
        title,
        file,
        line: 10 * (i + 1),
        tests: [{ status, results: status === 'unexpected' ? [{ error: { message: `\x1b[31mError: ${title} broke\x1b[39m\nstack` } }] : [] }],
      })),
    })),
  }
}

const tmpDirs: string[] = []
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-baseline-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('judge', () => {
  const { tests } = mergeReports([
    report({ 'a.spec.ts': { old: 'unexpected', fresh: 'unexpected', healed: 'expected', wobbly: 'flaky', later: 'skipped' } }),
  ])

  it('a failure in the list is quiet, one outside it is new', () => {
    const v = judge(['a.spec.ts :: old', 'a.spec.ts :: healed', 'a.spec.ts :: later'], tests)
    expect(v.failed).toEqual(['a.spec.ts :: fresh', 'a.spec.ts :: old'])
    expect(v.regressions).toEqual(['a.spec.ts :: fresh'])
  })

  it('a known test that ran and passed is listed as passing; one that never ran is not', () => {
    const v = judge(['a.spec.ts :: old', 'a.spec.ts :: healed', 'a.spec.ts :: later'], tests)
    expect(v.passing).toEqual(['a.spec.ts :: healed'])
  })

  it('a flaky test is a pass, listed as flaky', () => {
    const v = judge([], tests)
    expect(v.regressions).not.toContain('a.spec.ts :: wobbly')
    expect(v.flaky).toEqual(['a.spec.ts :: wobbly'])
    expect(v.skipped).toBe(1)
  })

  it('a known test missing from a file that ran is gone; one of a file that did not run is not', () => {
    const v = judge(['a.spec.ts :: renamed', 'b.spec.ts :: elsewhere'], tests)
    expect(v.gone).toEqual(['a.spec.ts :: renamed'])
    expect(v.passing).toEqual([])
  })
})

describe('mergeReports', () => {
  it('a key in two reports fails only when it failed in every report that ran it, and reads flaky when it passed in one', () => {
    const { tests } = mergeReports([
      report({ 'a.spec.ts': { once: 'unexpected', twice: 'unexpected', unrun: 'unexpected' } }),
      report({ 'a.spec.ts': { once: 'expected', twice: 'unexpected', unrun: 'skipped' } }),
    ])
    // The CI rerun of a new failure: it failed both tries in its shard and passed alone.
    expect(tests.get('a.spec.ts :: once')?.status).toBe('flaky')
    expect(judge([], tests).flaky).toEqual(['a.spec.ts :: once'])
    expect(tests.get('a.spec.ts :: twice')?.status).toBe('unexpected')
    expect(tests.get('a.spec.ts :: unrun')?.status).toBe('unexpected')
  })

  it('keeps the first line of the error without colours, and errors outside a test but the global timeout', () => {
    const r = {
      ...report({ 'a.spec.ts': { x: 'unexpected' } }),
      errors: [
        // The three lines a shard's --global-timeout left on CI (2026-10-31): nothing broke.
        { message: 'Timed out waiting 2700s for the test suite to run' },
        { message: 'Timed out waiting 2700s for the teardown for test suite to run' },
        { message: 'Timed out waiting 2700s for the teardown for plugin setup to run' },
        { message: 'Error: Timed out waiting 120000ms from config.webServer.\nmore' },
      ],
    }
    const { tests, errors } = mergeReports([r])
    expect(tests.get('a.spec.ts :: x')?.error).toBe('Error: x broke')
    expect(errors).toEqual(['Error: Timed out waiting 120000ms from config.webServer.'])
  })

  it('a test the global timeout cut off is not run, even after a failed first try', () => {
    const r = report({ 'a.spec.ts': { cut: 'unexpected' } })
    r.suites[0]!.specs[0]!.tests[0]!.results = [{ status: 'failed', error: { message: 'Error: first try' } }, { status: 'interrupted' }] as never
    expect(mergeReports([r]).tests.get('a.spec.ts :: cut')?.status).toBe('skipped')
  })

  it('keys a test by the spec file that ran it, not the helper it is written in', () => {
    const shared = (file: string, status: Status) => ({ title: file, file, specs: [{ title: 'records', file: 'stt-helpers.ts', tests: [{ status, results: [] }] }] })
    const { tests } = mergeReports([{ suites: [shared('stt.spec.ts', 'expected'), shared('stt.webkit.spec.ts', 'unexpected')] }])
    expect([...tests.keys()].sort()).toEqual(['stt.spec.ts :: records', 'stt.webkit.spec.ts :: records'])
    expect(tests.get('stt.webkit.spec.ts :: records')?.status).toBe('unexpected')
  })
})

describe('recheckLocations', () => {
  it('names each new failure where it is written, once, and no known one', () => {
    const { tests, errors } = mergeReports([
      report({ 'a.spec.ts': { old: 'unexpected', fresh: 'unexpected', ok: 'expected' }, 'b.spec.ts': { other: 'unexpected' } }),
    ])
    expect(recheckLocations(['a.spec.ts :: old'], tests, errors)).toEqual(['a.spec.ts:20', 'b.spec.ts:10'])
  })

  it('a test a helper defines is run again by its spec file', () => {
    const r = report({ 'a.spec.ts': { fresh: 'unexpected' } })
    r.suites[0]!.specs[0]!.file = 'helpers/shared.ts'
    const { tests, errors } = mergeReports([r])
    expect(recheckLocations([], tests, errors)).toEqual(['a.spec.ts'])
  })

  it('runs a new failure of a serial file again with its whole file, since its tests build on the earlier ones', () => {
    const { tests, errors } = mergeReports([
      report({ 'serial.spec.ts': { connect: 'expected', popup: 'unexpected', png: 'unexpected' }, 'plain.spec.ts': { fresh: 'unexpected' } }),
    ])
    expect(recheckLocations([], tests, errors, (f) => f === 'serial.spec.ts')).toEqual(['plain.spec.ts:10', 'serial.spec.ts'])
    // A helper's test names its file whole; that file's line-located failures add nothing.
    const h = report({ 'mixed.spec.ts': { shared: 'unexpected', own: 'unexpected' } })
    h.suites[0]!.specs[0]!.file = 'helpers/shared.ts'
    const mixed = mergeReports([h])
    expect(recheckLocations([], mixed.tests, mixed.errors, () => false)).toEqual(['mixed.spec.ts'])
  })

  it('reads a spec file as serial from its source, in either form', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-serial-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.spec.ts'), "test.describe.configure({ mode: 'serial' })\ntest('x', () => {})\n")
      fs.writeFileSync(path.join(dir, 'b.spec.ts'), "test.describe.serial('group', () => {})\n")
      fs.writeFileSync(path.join(dir, 'c.spec.ts'), "test.describe.configure({ retries: 1 })\ntest('x', () => {})\n")
      expect(isSerialSpec('a.spec.ts', dir)).toBe(true)
      expect(isSerialSpec('b.spec.ts', dir)).toBe(true)
      expect(isSerialSpec('c.spec.ts', dir)).toBe(false)
      expect(isSerialSpec('missing.spec.ts', dir)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // The real spec this rule came from is serial and found as such from the repo root.
    expect(isSerialSpec('extension-agent-outward.spec.ts', path.join(ROOT, 'tests/e2e/browser'))).toBe(true)
  })

  it('names none when the suite did not run cleanly, or when more than RECHECK_MAX are new (a real break)', () => {
    const many = Object.fromEntries(Array.from({ length: RECHECK_MAX + 1 }, (_, i) => [`t${i}`, 'unexpected' as Status]))
    const broke = mergeReports([report({ 'a.spec.ts': many })])
    expect(recheckLocations([], broke.tests, broke.errors)).toEqual([])
    const { tests } = mergeReports([report({ 'a.spec.ts': { fresh: 'unexpected' } })])
    expect(recheckLocations([], tests, ['Error: fixture server did not start'])).toEqual([])
    expect(recheckLocations([], tests, [])).toEqual(['a.spec.ts:10'])
  })
})

describe('recordBaseline', () => {
  const before = {
    failures: ['a.spec.ts :: old', 'a.spec.ts :: healed', 'a.spec.ts :: renamed', 'a.spec.ts :: later', 'b.spec.ts :: elsewhere'],
    reasons: { 'b.spec.ts :: elsewhere': 'kept reason' },
  }
  const { tests } = mergeReports([
    report({ 'a.spec.ts': { old: 'unexpected', fresh: 'unexpected', healed: 'expected', later: 'skipped' } }),
  ])

  it('adds the new failures and drops only a test gone from its file; a passing known failure stays', () => {
    // About 86 known failures came and went between two CI runs of one day: one that
    // passed once is not fixed, and dropping it turned the next run red.
    const next = recordBaseline(before, tests)
    expect(next.failures).toEqual(['a.spec.ts :: fresh', 'a.spec.ts :: healed', 'a.spec.ts :: later', 'a.spec.ts :: old', 'b.spec.ts :: elsewhere'])
    expect(next.count).toBe(5)
    expect(next.reasons['a.spec.ts :: fresh']).toBe('Error: fresh broke')
    expect(next.reasons['b.spec.ts :: elsewhere']).toBe('kept reason')
  })

  it('--prune also drops a known failure that passed', () => {
    const next = recordBaseline(before, tests, { prune: true })
    expect(next.failures).toEqual(['a.spec.ts :: fresh', 'a.spec.ts :: later', 'a.spec.ts :: old', 'b.spec.ts :: elsewhere'])
  })
})

describe('the CLI', () => {
  function setup() {
    const dir = tmp()
    const reports = path.join(dir, 'reports')
    fs.mkdirSync(reports)
    fs.writeFileSync(path.join(reports, 'browser-1.json'), JSON.stringify(report({ 'a.spec.ts': { old: 'unexpected', ok: 'expected' } })))
    fs.writeFileSync(path.join(reports, 'browser-2.json'), JSON.stringify(report({ 'b.spec.ts': { fresh: 'unexpected' } })))
    fs.writeFileSync(path.join(reports, 'notes.txt'), 'not a report')
    return { dir, reports, baseline: path.join(dir, 'known.json') }
  }
  const run = (baseline: string, ...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WALNUT_BROWSER_BASELINE_FILE: baseline } })

  it('reads every .json report in a directory', () => {
    const { reports } = setup()
    expect(reportFiles([reports]).map((f) => path.basename(f))).toEqual(['browser-1.json', 'browser-2.json'])
  })

  it('record, then check passes; a new failure fails the check and is named', () => {
    const { reports, baseline } = setup()
    expect(run(baseline, 'record', reports).status).toBe(0)
    expect(JSON.parse(fs.readFileSync(baseline, 'utf8')).failures).toEqual(['a.spec.ts :: old', 'b.spec.ts :: fresh'])
    expect(run(baseline, 'check', reports).status).toBe(0)
    fs.writeFileSync(baseline, JSON.stringify({ failures: ['a.spec.ts :: old'] }))
    const r = run(baseline, 'check', reports)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('`b.spec.ts :: fresh`: Error: fresh broke')
  })

  it('recheck prints the new failures to run again and exits 0; their rerun passing turns the check green', () => {
    const { dir, reports, baseline } = setup()
    fs.writeFileSync(baseline, JSON.stringify({ failures: ['a.spec.ts :: old'] }))
    const r = run(baseline, 'recheck', reports)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('b.spec.ts:10\n')
    expect(run(baseline, 'check', reports).status).toBe(1)
    fs.writeFileSync(path.join(reports, 'recheck.json'), JSON.stringify(report({ 'b.spec.ts': { fresh: 'expected' } })))
    const after = run(baseline, 'check', reports)
    expect(after.status).toBe(0)
    expect(after.stdout).toContain('1 flaky')
    expect(run(baseline, 'recheck', '--run', reports).status).toBe(2)
    void dir
  })

  it('refuses a path that does not exist, an unknown option, and a run with no tests', () => {
    const { dir, reports, baseline } = setup()
    expect(run(baseline, 'check', path.join(dir, 'nope.json')).status).toBe(2)
    expect(run(baseline, 'check').status).toBe(2)
    expect(run(baseline, 'check', '--prune', reports).status).toBe(2)
    fs.writeFileSync(path.join(dir, 'empty.json'), JSON.stringify({ suites: [] }))
    expect(run(baseline, 'check', path.join(dir, 'empty.json')).status).toBe(1)
  })

  it('a suite that did not run cleanly fails the check and is never recorded', () => {
    const { dir, baseline } = setup()
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, JSON.stringify({ ...report({ 'a.spec.ts': { ok: 'expected' } }), errors: [{ message: "SyntaxError: does not provide an export named 'x'" }] }))
    const r = run(baseline, 'check', broken)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain("SyntaxError: does not provide an export named 'x'")
    expect(run(baseline, 'record', broken).status).toBe(1)
    expect(fs.existsSync(baseline)).toBe(false)
  })
})

describe('the committed list and CI', () => {
  const known = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/setup/known-failures-browser.json'), 'utf8'))

  it('is sorted, without duplicates, and its count matches', () => {
    expect(known.failures).toEqual([...new Set(known.failures as string[])].sort())
    expect(known.count).toBe(known.failures.length)
  })

  it('names only spec files that exist', () => {
    const specs = new Set(
      execFileSync('git', ['ls-files', 'tests/e2e/browser'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((f) => path.relative('tests/e2e/browser', f).split(path.sep).join('/')),
    )
    const missing = (known.failures as string[]).map((k) => k.split(' :: ')[0]).filter((f) => !specs.has(f))
    expect([...new Set(missing)]).toEqual([])
  })

  type CiStep = { id?: string; if?: string; uses?: string; with?: Record<string, unknown>; run?: string; shell?: string; env?: Record<string, string>; 'continue-on-error'?: boolean }
  const baselineJob = () =>
    (parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: string; steps: CiStep[] }>
    }).jobs['browser-baseline']!

  it('CI judges the browser reports with it, in a step whose exit code survives the tee', () => {
    const job = baselineJob()
    expect(job.needs).toBe('browser')
    expect(job.steps.find((s) => s.uses?.startsWith('actions/download-artifact'))?.with?.pattern).toBe('browser-report-*')
    const checks = job.steps.filter((s) => s.run?.includes('bun scripts/browser-baseline.mjs check'))
    expect(checks).toHaveLength(2)
    // GitHub's default shell is `bash -e`: `check | tee` then exits with tee's 0, and a
    // new failure left the job green. `shell: bash` is `bash -eo pipefail`.
    for (const s of checks) {
      expect(s.run).toContain('| tee')
      expect(s.shell).toBe('bash')
    }
    // The first verdict may be red; the last one, after the rerun, decides the job.
    const [first, last] = checks
    expect(first!.id).toBe('judge')
    expect(first!['continue-on-error']).toBe(true)
    expect(last!.if).toBe("steps.judge.outcome == 'failure'")
    expect(last!['continue-on-error']).toBeUndefined()
    expect(job.steps.indexOf(last!)).toBe(job.steps.length - 1)
  })

  it('CI runs the new failures again alone, into a report the last verdict reads', () => {
    const steps = baselineJob().steps
    const find = steps.find((s) => s.run?.includes('bun scripts/browser-baseline.mjs recheck'))!
    expect(find.id).toBe('recheck')
    expect(find.if).toBe("steps.judge.outcome == 'failure'")
    const rerun = steps.find((s) => s.run?.includes('bun x playwright test'))!
    expect(rerun.run).toContain('--workers=1')
    expect(rerun.run).toContain('--project=chromium --project=chromium-host-fixture')
    expect(rerun.run).toContain('"${locs[@]}"')
    // Anchored under the testDir, and its time counted from the job's start.
    expect(rerun.run).toContain("sed 's|^|tests/e2e/browser/|'")
    expect(rerun.run).toMatch(/JOB_STARTED_AT \+ 40 \* 60/)
    expect(steps[0]!.run).toContain('JOB_STARTED_AT=')
    expect(rerun.env?.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe('${{ runner.temp }}/browser-reports/recheck.json')
    // Its own red is no verdict: the check after it reads its report.
    expect(rerun['continue-on-error']).toBe(true)
    // The build and the browsers it needs come only when there is something to run.
    for (const s of steps.slice(steps.indexOf(find) + 1, steps.indexOf(rerun) + 1)) expect(s.if).toContain('steps.recheck.outputs.count')
    expect(steps.some((s) => s.run?.startsWith('bash scripts/ci/install-browsers.sh'))).toBe(true)
  })

  it('CI names each browser shard that wrote no report, by the file its upload names', () => {
    const doc = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { shard?: number[] } }; steps: { uses?: string; with?: Record<string, unknown>; run?: string }[] }>
    }
    const shards = doc.jobs.browser!.strategy!.matrix!.shard!
    const upload = doc.jobs.browser!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))!
    expect(String(upload.with?.path)).toMatch(/\/browser-\$\{\{ matrix\.shard \}\}\.json$/)
    const judge = doc.jobs['browser-baseline']!.steps.find((s) => s.run?.includes('bun scripts/browser-baseline.mjs check'))!.run!
    // 2026-11-01: "only 15 of 16" with no number; the missing one was found by reading 16 logs.
    expect(judge).toContain(`$(seq 1 ${shards.length})`)
    expect(judge).toContain('"$RUNNER_TEMP/browser-reports/browser-$i.json"')
    expect(judge).toMatch(/no report from shard\$missing/)
  })
})
