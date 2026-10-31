#!/usr/bin/env bun
/**
 * The browser suite's baseline gate: judge Playwright JSON reports against a
 * recorded list of known failures, and fail ONLY on a failure that is not in it.
 *
 *   bun scripts/browser-baseline.mjs check  <report.json | dir>...          # judge reports (CI)
 *   bun scripts/browser-baseline.mjs record [--prune] <report.json | dir>... # update the list from them
 *   bun scripts/browser-baseline.mjs check|record [--prune] --run [playwright args]  # run, then that
 *
 * The browser suite had hundreds of old failures (2026-10-31: 511 tests over two
 * CI runs), so a pass/fail gate on it was always red and CI only reported it.
 * This is the same idea as scripts/test-baseline.mjs for vitest: a committed
 * list (tests/setup/known-failures-browser.json) that may only shrink, so a
 * change that breaks a passing spec is caught while the old reds are fixed.
 *
 * Keys are `spec file :: describe › title` (scripts/playwright-summary.mjs). What
 * counts:
 * - failed: status `unexpected`, i.e. it failed on every retry.
 * - flaky (failed, then passed on a retry) is a pass here; the verdict lists it.
 * - not run is neutral: skipped, or cut off by a shard's --global-timeout (an
 *   `interrupted` result, even after a failed first try). It proves nothing.
 * - an error outside any test fails the check (a spec that does not load, a
 *   fixture server that does not start), except the global timeout's own lines.
 *
 * `record` only adds: this run's failures go in, and an entry whose spec file ran
 * without that test (renamed or deleted) goes out. A known failure that passed is
 * kept, because about 86 of them came and went between two CI runs of one day:
 * recording from one run turned the next one red. `--prune` also removes the
 * known failures that passed, for after a fix, read from a run that repeated the
 * fixed specs (`--run --repeat-each=3 <specs>`).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testsOf } from './playwright-summary.mjs'

export const DEFAULT_BASELINE = 'tests/setup/known-failures-browser.json'

/** The lines a run's --global-timeout leaves in `report.errors`: the shard ran out of time, nothing broke. */
const GLOBAL_TIMEOUT = /^Timed out waiting \d+s for the (test suite|teardown for .+) to run$/

/** Every `.json` report named, a directory standing for the reports in it (not recursive). */
export function reportFiles(args) {
  const out = []
  for (const a of args) {
    const st = fs.statSync(a)
    if (st.isDirectory()) out.push(...fs.readdirSync(a).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(a, f)))
    else out.push(a)
  }
  return out
}

/**
 * The reports as one run: key -> { status, error }, an interrupted test counted
 * as not run. A key in two reports (a shard run twice) is failed only when it
 * failed in every one of them that ran it. `errors` are the errors outside a
 * test, without the global timeout's.
 */
export function mergeReports(reports) {
  const tests = new Map()
  const errors = []
  for (const report of reports) {
    for (const e of report.errors ?? []) {
      const line = String(e.message ?? e.value ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].trim().slice(0, 300)
      if (!GLOBAL_TIMEOUT.test(line)) errors.push(line)
    }
    for (const raw of testsOf(report)) {
      const t = raw.interrupted ? { ...raw, status: 'skipped' } : raw
      const prev = tests.get(t.key)
      if (!prev || prev.status === 'skipped') tests.set(t.key, t)
      else if (prev.status === 'unexpected' && t.status !== 'skipped' && t.status !== 'unexpected') tests.set(t.key, t)
    }
  }
  return { tests, errors }
}

const fileOf = (key) => key.split(' :: ')[0]
const ran = (t) => t && t.status !== 'skipped'

/** What a run means against the known list. */
export function judge(known, tests) {
  const knownSet = new Set(known)
  const files = new Set([...tests.keys()].map(fileOf))
  const failed = [...tests].filter(([, t]) => t.status === 'unexpected').map(([k]) => k).sort()
  return {
    failed,
    regressions: failed.filter((k) => !knownSet.has(k)),
    // Known entries that ran and did not fail. Advisory: many come and go.
    passing: known.filter((k) => ran(tests.get(k)) && tests.get(k).status !== 'unexpected').sort(),
    // Known entries whose file ran without the test at all: renamed or deleted.
    gone: known.filter((k) => !tests.has(k) && files.has(fileOf(k))).sort(),
    flaky: [...tests].filter(([, t]) => t.status === 'flaky').map(([k]) => k).sort(),
    skipped: [...tests.values()].filter((t) => t.status === 'skipped').length,
    passed: [...tests.values()].filter((t) => t.status === 'expected').length,
  }
}

/** The known list after this run: its failures added, gone tests removed, passing ones too with `prune`. */
export function recordBaseline(baseline, tests, { prune = false } = {}) {
  const v = judge(baseline.failures, tests)
  const drop = new Set([...v.gone, ...(prune ? v.passing : [])])
  const failures = [...new Set([...baseline.failures.filter((k) => !drop.has(k)), ...v.failed])].sort()
  const reasons = {}
  for (const k of failures) reasons[k] = tests.get(k)?.error ?? baseline.reasons?.[k] ?? ''
  return { suite: 'playwright: chromium, chromium-host-fixture', count: failures.length, failures, reasons }
}

export function readBaseline(file) {
  if (!fs.existsSync(file)) return { failures: [], reasons: {} }
  const b = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { failures: b.failures ?? [], reasons: b.reasons ?? {} }
}

const list = (title, keys, max = 40) => {
  if (!keys.length) return []
  const shown = keys.slice(0, max).map((k) => `- \`${k}\``)
  return ['', `**${title} (${keys.length}):**`, '', ...shown, ...(keys.length > max ? [`- … and ${keys.length - max} more`] : [])]
}

/** The verdict as markdown (CI's step summary reads it as is). */
export function verdictText(v, knownCount, errors, reasons = new Map()) {
  const lines = [
    `**Browser baseline:** ${v.failed.length} failing, ${knownCount} known, ${v.regressions.length} new; ` +
      `${v.passed} passed, ${v.flaky.length} flaky, ${v.skipped} not run.`,
  ]
  if (errors.length) {
    lines.push('', '**The suite did not run cleanly (errors outside a test):**', '')
    for (const [e, n] of errors.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map())) lines.push(`- ${e}${n > 1 ? ` (×${n})` : ''}`)
  }
  if (v.regressions.length) {
    lines.push('', `**New failures, not in ${DEFAULT_BASELINE} (${v.regressions.length}):**`, '')
    for (const k of v.regressions) lines.push(`- \`${k}\`${reasons.get(k) ? `: ${reasons.get(k)}` : ''}`)
  }
  lines.push(...list('Known failures that passed this run (many come and go; after a fix, `record --prune` a repeated run)', v.passing, 20))
  lines.push(...list('Known failures whose test is gone from its file (the next record removes them)', v.gone))
  return `${lines.join('\n')}\n`
}

function main(argv) {
  const usage = 'usage: bun scripts/browser-baseline.mjs check <report.json | dir>...\n' +
    '       bun scripts/browser-baseline.mjs record [--prune] <report.json | dir>...\n' +
    '       bun scripts/browser-baseline.mjs check|record [--prune] --run [playwright args]\n'
  const mode = argv[0]
  if (!['check', 'record'].includes(mode)) {
    process.stderr.write(usage)
    return 2
  }
  let args = argv.slice(1)
  let prune = false
  let runSuite = false
  while (args.length && args[0].startsWith('--')) {
    const flag = args.shift()
    if (flag === '--prune' && mode === 'record') prune = true
    else if (flag === '--run') { runSuite = true; break }
    else { process.stderr.write(`unknown option for ${mode}: ${flag}\n${usage}`); return 2 }
  }
  const BASELINE = process.env.WALNUT_BROWSER_BASELINE_FILE ?? DEFAULT_BASELINE
  if (runSuite) {
    // Run the suite the way CI does, into a temp report, then judge or record that.
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-browser-baseline-')), 'report.json')
    const pw = ['playwright', 'test', '--project=chromium', '--project=chromium-host-fixture', '--reporter=line,json']
    if (!args.some((a) => a.startsWith('--retries'))) pw.push('--retries=1')
    const run = spawnSync('bun', ['x', ...pw, ...args], { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out } })
    if (!fs.existsSync(out)) {
      process.stderr.write(`Playwright wrote no report (exited ${run.status}): nothing to judge.\n`)
      return 1
    }
    args = [out]
  }
  const missing = args.filter((a) => !fs.existsSync(a))
  if (!args.length || missing.length) {
    process.stderr.write(`${missing.length ? `No such report: ${missing.join(' ')}` : 'Name the reports to judge, or pass --run'}\n${usage}`)
    return 2
  }
  const files = reportFiles(args)
  if (!files.length) {
    process.stderr.write(`No reports in ${args.join(' ')}: nothing to judge.\n`)
    return 1
  }
  const { tests, errors } = mergeReports(files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))))
  const baseline = readBaseline(BASELINE)
  if (mode === 'record') {
    if (errors.length) {
      process.stderr.write(`Not recorded: the suite did not run cleanly:\n${[...new Set(errors)].map((e) => `  ${e}`).join('\n')}\n`)
      return 1
    }
    const next = recordBaseline(baseline, tests, { prune })
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    const was = new Set(baseline.failures)
    const now = new Set(next.failures)
    process.stdout.write(
      `Recorded ${next.count} known failures (was ${was.size}: ${next.failures.filter((k) => !was.has(k)).length} added, ` +
        `${baseline.failures.filter((k) => !now.has(k)).length} removed) from ${files.length} report(s) → ${BASELINE}\n`,
    )
    return 0
  }
  const v = judge(baseline.failures, tests)
  const reasons = new Map([...tests].map(([k, t]) => [k, t.error]))
  process.stdout.write(verdictText(v, baseline.failures.length, errors, reasons))
  if (!tests.size && !errors.length) {
    process.stderr.write(`${files.length} report(s) with no tests: the suite did not run.\n`)
    return 1
  }
  return v.regressions.length || errors.length ? 1 : 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)))
}
