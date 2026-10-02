/**
 * scripts/test-baseline.mjs, the gate CI's quick and e2e tiers pass through.
 *
 * Run for real against a fake `npx` that writes a canned vitest JSON report, so
 * every verdict is the script's own: a known failure passes, a new one fails
 * with its reason, a crashed or truncated run never passes, a file that fails
 * to load counts, and a --shard run neither calls the rest of the baseline
 * "fixed" nor loses its own failures (WALNUT_BASELINE_RUN_OUT keeps them).
 * The fake also answers `vitest list`: every listed file this run covers must
 * report. test-baseline-shard-cut.test.ts checks the --shard cut against the
 * real vitest.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../scripts/test-baseline.mjs')

let tmp: string
let bin: string

// \`vitest run\` writes $FAKE_REPORT to the --outputFile it was given; no file when it is
// empty (a crashed run). \`vitest list\` writes $FAKE_LIST (repo-relative names) to its
// --json file, or nothing when it is unset. Each records its argv so the test can
// check what reached vitest.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const argv = process.argv.slice(2)
if (argv[1] === 'list') {
  fs.writeFileSync(process.env.FAKE_LIST_ARGV, JSON.stringify(argv))
  const out = argv.find((a) => a.startsWith('--json='))
  if (process.env.FAKE_LIST && out) {
    const files = JSON.parse(process.env.FAKE_LIST).map((f) => ({ file: path.join(process.cwd(), f) }))
    fs.writeFileSync(out.slice('--json='.length), JSON.stringify(files))
  }
  process.exit(process.env.FAKE_LIST ? 0 : 1)
}
fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv))
const out = argv.find((a) => a.startsWith('--outputFile='))
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

/** The repo-relative files in a canned report. */
const reported = (r: object | null | undefined) =>
  ((r as { testResults?: FileResult[] } | null)?.testResults ?? []).map((t) => t.name.replace('/runner/work/repo/', ''))

/** `list` defaults to exactly the report's files; null = `vitest list` fails. */
function run(mode: 'check' | 'record', opts: {
  report?: object | null; list?: string[] | null; baseline?: object; minFiles?: number; runOut?: string; args?: string[]
}): Promise<{ code: number; out: string }> {
  const list = opts.list === undefined ? reported(opts.report) : opts.list
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
        FAKE_LIST_ARGV: path.join(tmp, 'list-argv.json'),
        FAKE_REPORT: opts.report ? reportFile : '',
        FAKE_LIST: list ? JSON.stringify(list) : '',
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
      args: ['--maxWorkers=1', '--shard=1/1'],
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('No new failures')
    const argv = JSON.parse(fs.readFileSync(path.join(tmp, 'argv.json'), 'utf8')) as string[]
    expect(argv.slice(0, 4)).toEqual(['vitest', 'run', '--config', 'vitest.e2e.config.ts'])
    expect(argv).toEqual(expect.arrayContaining(['--maxWorkers=1', '--shard=1/1', '--reporter=json']))
    // The files it must report are listed with the same config and filters.
    const listArgv = JSON.parse(fs.readFileSync(path.join(tmp, 'list-argv.json'), 'utf8')) as string[]
    expect(listArgv.slice(0, 4)).toEqual(['vitest', 'list', '--config', 'vitest.e2e.config.ts'])
    expect(listArgv).toEqual(expect.arrayContaining(['--filesOnly', '--maxWorkers=1', '--shard=1/1']))
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
    const r = await run('check', { report: null, list: [A, B], baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain('No JSON report produced')
  })

  it('never passes a run that is missing a file it covers, and names it', async () => {
    const r = await run('check', { report: report([A]), list: [A, B, C], baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain('2 of the 3 test file(s) this run covers never reported')
    expect(r.out).toContain(B)
    expect(r.out).toContain(C)
  })

  it('never passes a tier that lists fewer files than its floor', async () => {
    const r = await run('check', { report: report([A]), baseline: baseline([]), minFiles: 25 })
    expect(r.code).toBe(1)
    expect(r.out).toContain('lists only 1 test file(s), expected at least 25')
    // The verdict comes before the run: nothing was spent on it.
    expect(fs.existsSync(path.join(tmp, 'argv.json'))).toBe(false)
  })

  it('never passes a tier vitest cannot list', async () => {
    const r = await run('check', { report: report([A, B]), list: null, baseline: baseline([]) })
    expect(r.code).toBe(1)
    expect(r.out).toContain('vitest could not list vitest.e2e.config.ts')
  })

  // Six files in two slices of three. A leg's slice is read off the gate itself:
  // given an empty report, it names every file it expected.
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `tests/e2e/${n}.test.ts`)
  async function sliceOf(shard: string): Promise<string[]> {
    const r = await run('check', { report: report([]), list: six, baseline: baseline([]), args: [`--shard=${shard}`] })
    expect(r.code).toBe(1)
    expect(r.out).toContain('3 of the 3 test file(s) this run covers never reported')
    return six.filter((f) => r.out.includes(`    ${f}`))
  }

  it('a shard is held to its own slice, not the whole tier', async () => {
    const [one, two] = [await sliceOf('1/2'), await sliceOf('2/2')]
    expect([...one, ...two].sort()).toEqual(six)
    const r = await run('check', { report: report(two), list: six, baseline: baseline([]), args: ['--shard=2/2'] })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('outside the computed --shard slice')
    const short = await run('check', { report: report(two.slice(1)), list: six, baseline: baseline([]), args: ['--shard=2/2'] })
    expect(short.code).toBe(1)
    expect(short.out).toContain(`1 of the 3 test file(s) this run covers never reported`)
    expect(short.out).toContain(`    ${two[0]}`)
  })

  it('when its shard cut disagrees with vitest, checks the count and says so', async () => {
    // A report of the OTHER slice is what a changed cut looks like.
    const one = await sliceOf('1/2')
    const full = await run('check', { report: report(one), list: six, baseline: baseline([]), args: ['--shard=2/2'] })
    expect(full.code, full.out).toBe(0)
    expect(full.out).toContain('3 reported file(s) are outside the computed --shard slice')
    const short = await run('check', { report: report(one.slice(1)), list: six, baseline: baseline([]), args: ['--shard=2/2'] })
    expect(short.code).toBe(1)
    expect(short.out).toContain('1 of the 3 test file(s) this run covers never reported')
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
