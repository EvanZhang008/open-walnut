/**
 * scripts/test-baseline.mjs, the gate CI's quick and e2e tiers pass through.
 *
 * Run for real against a fake `npx` that writes a canned vitest JSON report, so
 * every verdict is the script's own: a known failure passes, a new one fails
 * with its reason, a crashed or truncated run never passes, a file that fails
 * to load counts, and a --shard run neither calls the rest of the baseline
 * "fixed" nor loses its own failures (WALNUT_BASELINE_RUN_OUT keeps them).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../scripts/test-baseline.mjs')

let tmp: string
let bin: string

// Writes $FAKE_REPORT to the --outputFile vitest was given; no file when it is empty
// (a crashed run). Records its argv so the test can check what reached vitest.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)))
const out = process.argv.find((a) => a.startsWith('--outputFile='))
if (process.env.FAKE_REPORT && out) fs.writeFileSync(out.slice('--outputFile='.length), fs.readFileSync(process.env.FAKE_REPORT))
process.exit(Number(process.env.FAKE_EXIT || 0))
`

interface FileResult { name: string; status: 'passed' | 'failed'; message?: string; assertionResults: Array<{ fullName: string; status: string; failureMessages?: string[] }> }

/** A report of `files` (repo-relative names), each passing unless listed in `failed`. */
function report(files: string[], failed: Record<string, string[]> = {}, broken: string[] = []): object {
  const testResults: FileResult[] = files.map((f) => ({
    name: `/runner/work/repo/${f}`,
    status: broken.includes(f) || failed[f] ? 'failed' : 'passed',
    ...(broken.includes(f) ? { message: 'Error: Cannot find module x\n    at y' } : {}),
    assertionResults: broken.includes(f) ? [] : [
      { fullName: 'suite ok', status: 'passed' },
      ...(failed[f] ?? []).map((name) => ({ fullName: name, status: 'failed', failureMessages: [`AssertionError: ${name} broke\n    at z`] })),
    ],
  }))
  return { numTotalTests: testResults.length, testResults }
}

function run(mode: 'check' | 'record', opts: {
  report?: object | null; baseline?: object; minFiles?: number; runOut?: string; args?: string[]
}): Promise<{ code: number; out: string }> {
  const reportFile = path.join(tmp, 'report.json')
  if (opts.report) fs.writeFileSync(reportFile, JSON.stringify(opts.report))
  const baselineFile = path.join(tmp, 'baseline.json')
  if (opts.baseline) fs.writeFileSync(baselineFile, JSON.stringify(opts.baseline))
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, mode, ...(opts.args ?? [])], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TMPDIR: tmp,
        FAKE_ARGV: path.join(tmp, 'argv.json'),
        FAKE_REPORT: opts.report ? reportFile : '',
        WALNUT_BASELINE_CONFIG: 'vitest.e2e.config.ts',
        WALNUT_BASELINE_FILE: baselineFile,
        WALNUT_BASELINE_MIN_FILES: String(opts.minFiles ?? 2),
        ...(opts.runOut ? { WALNUT_BASELINE_RUN_OUT: opts.runOut } : {}),
      },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

const A = 'tests/e2e/a.test.ts'
const B = 'tests/e2e/b.test.ts'
const C = 'tests/e2e/c.test.ts'
const baseline = (failures: string[]) => ({ config: 'vitest.e2e.config.ts', count: failures.length, failures })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-baseline-gate-'))
  bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'npx'), FAKE_NPX, { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('test-baseline.mjs check', () => {
  it('passes a known failure and runs vitest with the caller\'s options and its own report', async () => {
    const r = await run('check', {
      report: report([A, B], { [A]: ['known one'] }),
      baseline: baseline([`${A} :: known one`]),
      args: ['--maxWorkers=1', '--shard=2/4'],
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('No new failures')
    const argv = JSON.parse(fs.readFileSync(path.join(tmp, 'argv.json'), 'utf8')) as string[]
    expect(argv.slice(0, 4)).toEqual(['vitest', 'run', '--config', 'vitest.e2e.config.ts'])
    expect(argv).toEqual(expect.arrayContaining(['--maxWorkers=1', '--shard=2/4', '--reporter=json']))
  })

  it('fails a new failure and prints why it failed', async () => {
    const r = await run('check', { report: report([A, B], { [B]: ['new one'] }), baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${B} :: new one`)
    expect(r.out).toContain('AssertionError: new one broke')
  })

  it('counts a file that failed to load', async () => {
    const r = await run('check', { report: report([A, B], {}, [B]), baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${B} :: <file failed to load or collect>`)
    expect(r.out).toContain('Cannot find module x')
  })

  it('never passes a run that wrote no report (a crashed worker pool)', async () => {
    const r = await run('check', { report: null, baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain('No JSON report produced')
  })

  it('never passes a truncated run', async () => {
    const r = await run('check', { report: report([A]), baseline: baseline([]), minFiles: 25 })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Only 1 test file(s) ran')
  })

  it('on a shard, calls fixed only what ran here and passed', async () => {
    const r = await run('check', {
      report: report([A, B]),
      baseline: baseline([`${A} :: was broken`, `${C} :: another shard's`]),
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('1 test(s) in the baseline now PASS')
    expect(r.out).toContain(`${A} :: was broken`)
    expect(r.out).not.toContain("another shard's")
  })

  it('keeps this run\'s failures for CI to upload, pass or fail', async () => {
    const runOut = path.join(tmp, 'run-out.json')
    const r = await run('check', {
      report: report([A, B], { [A]: ['known one'], [B]: ['new one'] }),
      baseline: baseline([`${A} :: known one`]),
      runOut,
    })
    expect(r.code).toBe(1)
    const kept = JSON.parse(fs.readFileSync(runOut, 'utf8')) as { count: number; failures: string[]; reasons: Record<string, string> }
    expect(kept.failures).toEqual([`${A} :: known one`, `${B} :: new one`])
    expect(kept.reasons[`${B} :: new one`]).toContain('AssertionError: new one broke')
  })
})

describe('test-baseline.mjs record', () => {
  it('writes every failure with its reason', async () => {
    const r = await run('record', { report: report([A, B], { [B]: ['new one'] }) })
    expect(r.code, r.out).toBe(0)
    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'baseline.json'), 'utf8')) as { config: string; failures: string[] }
    expect(written.config).toBe('vitest.e2e.config.ts')
    expect(written.failures).toEqual([`${B} :: new one`])
  })
})
