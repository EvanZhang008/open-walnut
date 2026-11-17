#!/usr/bin/env bun
/**
 * The browser suite's baseline gate: judge Playwright JSON reports against a
 * recorded list of known failures, and fail ONLY on a failure that is not in it.
 *
 *   bun scripts/browser-baseline.mjs check  <report.json | dir>...          # judge reports (CI)
 *   bun scripts/browser-baseline.mjs record [--prune] <report.json | dir>... # update the list from them
 *   bun scripts/browser-baseline.mjs check|record [--prune] --run [playwright args]  # run, then that
 *   bun scripts/browser-baseline.mjs recheck <report.json | dir>...          # where the new failures are, to run again
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
 * - not run is neutral as a test: skipped, or cut off by a shard's --global-timeout
 *   (an `interrupted` result, even after a failed first try). It proves nothing.
 * - a shard that ran out of time (its --global-timeout's lines in `report.errors`)
 *   fails the check while a test it never finished (never started, or cut off) ran
 *   in no other report: those tests were not judged, which is never a pass. The
 *   verdict names the shard and the spec files it did not finish.
 * - an error outside any test fails the check (a spec that does not load, a
 *   fixture server that does not start), except the global timeout's own lines.
 *
 * `record` only adds: this run's failures go in, and an entry whose spec file ran
 * without that test (renamed or deleted) goes out. A known failure that passed is
 * kept, because about 86 of them came and went between two CI runs of one day:
 * recording from one run turned the next one red. `--prune` also removes the
 * known failures that passed, for after a fix, read from a run that repeated the
 * fixed specs (`--run --repeat-each=3 <specs>`).
 *
 * `recheck` prints the new failures' locations (`<spec file>:<line>`, relative to
 * the Playwright testDir), one per line, for CI to run again alone on a quiet
 * runner. About 15 of ~4,400 tests failed both tries in a loaded shard on every
 * main run of 2026-11-10 (a different 15 each time), so the job was red every
 * run. A test that passes alone is judged as flaky (mergeReports: failed only
 * when it failed in every report that ran it); one that fails again stays new.
 * It prints nothing when the suite did not run cleanly (an error outside a test;
 * a shard's global timeout is none). It names at most RECHECK_MAX locations,
 * taken in turn from each shard's new failures so one broken shard cannot take
 * them all, and says on stderr which new failures it left out: they stay new.
 * (2026-11-17: 60 new failures, over the old all-or-nothing cap, so none ran
 * again; run alone, 13 of them still failed.)
 * A new failure in a serial spec file is run again with its whole file: its
 * tests build on the ones before them (connect the extension, then act through
 * it), so a test run alone by its line fails on the missing setup, never on what
 * failed in the shard (2026-11-11: the agent tab spec's popup test answered 409
 * browser_not_connected alone, every time, and read as failing again).
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
 * The reports as one run: key -> { status, error, from, failures }, an
 * interrupted test counted as not run. A key in two reports (a shard run twice) is
 * failed only when it failed in every one of them that ran it; `from` names the
 * report it first failed in, `failures` how many reports it failed in. `errors`
 * are the errors outside a test, without the global timeout's. `timedOut` lists
 * each report whose run hit its global timeout (by `names`, default its place),
 * with the tests it never finished: never started, or cut off.
 */
export function mergeReports(reports, names = reports.map((_, i) => `report ${i + 1}`)) {
  const tests = new Map()
  const errors = []
  const timedOut = []
  reports.forEach((report, i) => {
    const name = names[i]
    let outOfTime = false
    for (const e of report.errors ?? []) {
      const line = String(e.message ?? e.value ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].trim().slice(0, 300)
      if (GLOBAL_TIMEOUT.test(line)) outOfTime = true
      else errors.push(line)
    }
    const unfinished = []
    for (const raw of testsOf(report)) {
      if (outOfTime && (raw.interrupted || raw.unrun)) unfinished.push(raw.key)
      const t = raw.interrupted ? { ...raw, status: 'skipped' } : raw
      const failed = t.status === 'unexpected'
      const prev = tests.get(t.key)
      if (!prev || prev.status === 'skipped') tests.set(t.key, { ...t, ...(failed ? { from: name, failures: 1 } : {}) })
      // Failed in one report and passed in another (the rerun of a new failure): flaky.
      else if (prev.status === 'unexpected' && t.status !== 'skipped' && !failed) tests.set(t.key, { ...t, status: 'flaky' })
      else if (prev.status === 'unexpected' && failed) prev.failures += 1
    }
    if (outOfTime) timedOut.push({ name, unfinished: [...new Set(unfinished)].sort() })
  })
  return { tests, errors, timedOut }
}

/** The most locations `recheck` names: the rerun gets the rest of the job's time, one worker. */
export const RECHECK_MAX = 40

/** Where Playwright's testDir is: report locations are relative to it. */
const TEST_DIR = 'tests/e2e/browser'

/** A spec file whose tests run in order, each on what the earlier ones left (`describe.configure({ mode: 'serial' })`). */
export function isSerialSpec(file, testDir = TEST_DIR) {
  try {
    return /describe\.(?:configure\(\s*\{[^}]*mode:\s*['"]serial['"]|serial\s*\()/.test(fs.readFileSync(path.join(testDir, file), 'utf8'))
  } catch {
    return false
  }
}

/**
 * What to run again: `locations`, one per new failure, without duplicates, at most `max`;
 * `unrechecked`, the new failures they leave out. Nothing to run when the run broke (an
 * error outside a test). Over the cap, each shard's new failures take turns (`from`, the
 * report a test failed in), so one shard that broke whole leaves the others their reruns.
 * A failure in a serial file is run again with the whole file (`isSerial`), never by its line.
 */
export function recheckPlan(known, tests, errors, isSerial = isSerialSpec, max = RECHECK_MAX) {
  const { regressions } = judge(known, tests)
  if (errors.length) return { locations: [], unrechecked: regressions }
  const locOf = (k) => (isSerial(fileOf(k)) ? fileOf(k) : (tests.get(k)?.loc ?? fileOf(k)))
  // A file run whole already runs each of its lines: `<file>:<line>` counts as `<file>` when that is listed.
  const wholeFiles = new Set(regressions.map(locOf).filter((l) => !/:\d+$/.test(l)))
  const placeOf = (k) => (wholeFiles.has(fileOf(k)) ? fileOf(k) : locOf(k))
  const byShard = new Map()
  for (const k of regressions) {
    const shard = tests.get(k)?.from ?? ''
    byShard.set(shard, [...(byShard.get(shard) ?? []), k])
  }
  const queues = [...byShard.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((s) => byShard.get(s))
  const chosen = new Set()
  for (let round = 0; queues.some((q) => round < q.length); round++) {
    for (const q of queues) {
      const k = q[round]
      if (k !== undefined && (chosen.size < max || chosen.has(placeOf(k)))) chosen.add(placeOf(k))
    }
  }
  return { locations: [...chosen].sort(), unrechecked: regressions.filter((k) => !chosen.has(placeOf(k))) }
}

const fileOf = (key) => key.split(' :: ')[0]
const ran = (t) => t && t.status !== 'skipped'

/** What a run means against the known list; `timedOut` is mergeReports' list of shards that ran out of time. */
export function judge(known, tests, timedOut = []) {
  const knownSet = new Set(known)
  const files = new Set([...tests.keys()].map(fileOf))
  const failed = [...tests].filter(([, t]) => t.status === 'unexpected').map(([k]) => k).sort()
  // A test a shard never finished counts until another report (the rerun) ran it.
  const outOfTime = timedOut.map((s) => ({ name: s.name, cut: s.unfinished.length, unfinished: s.unfinished.filter((k) => !ran(tests.get(k))) }))
  return {
    failed,
    regressions: failed.filter((k) => !knownSet.has(k)),
    outOfTime,
    unfinished: [...new Set(outOfTime.flatMap((s) => s.unfinished))].sort(),
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
export function verdictText(v, knownCount, errors, reasons = new Map(), tests = new Map()) {
  const lines = [
    `**Browser baseline:** ${v.failed.length} failing, ${knownCount} known, ${v.regressions.length} new; ` +
      `${v.passed} passed, ${v.flaky.length} flaky, ${v.skipped} not run` +
      `${v.unfinished?.length ? ` (${v.unfinished.length} of them in a shard that ran out of time)` : ''}.`,
  ]
  if (errors.length) {
    lines.push('', '**The suite did not run cleanly (errors outside a test):**', '')
    for (const [e, n] of errors.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map())) lines.push(`- ${e}${n > 1 ? ` (×${n})` : ''}`)
  }
  for (const s of v.outOfTime ?? []) {
    if (!s.unfinished.length) {
      lines.push('', s.cut
        ? `**${s.name} ran out of time;** the ${s.cut} tests it never finished ran in another report and are judged there.`
        : `**${s.name} ran out of time** in its teardown, after every test it holds had finished.`)
      continue
    }
    const perFile = s.unfinished.reduce((m, k) => m.set(fileOf(k), (m.get(fileOf(k)) ?? 0) + 1), new Map())
    lines.push('', `**${s.name} ran out of time: ${s.unfinished.length} tests never finished and ran nowhere else, so they are not judged (a failure):**`, '')
    for (const [f, n] of [...perFile].sort()) lines.push(`- \`${f}\` (${n})`)
  }
  if (v.regressions.length) {
    const again = (k) => (tests.get(k)?.failures ?? 1) > 1
    const alone = v.regressions.filter((k) => !again(k)).length
    lines.push('', `**New failures, not in ${DEFAULT_BASELINE} (${v.regressions.length}${alone ? `; ${alone} of them not run again alone` : ''}):**`, '')
    for (const k of v.regressions) lines.push(`- \`${k}\`${again(k) ? ' (failed again alone)' : ''}${reasons.get(k) ? `: ${reasons.get(k)}` : ''}`)
  }
  lines.push(...list('Known failures that passed this run (many come and go; after a fix, `record --prune` a repeated run)', v.passing, 20))
  lines.push(...list('Known failures whose test is gone from its file (the next record removes them)', v.gone))
  return `${lines.join('\n')}\n`
}

function main(argv) {
  const usage = 'usage: bun scripts/browser-baseline.mjs check <report.json | dir>...\n' +
    '       bun scripts/browser-baseline.mjs record [--prune] <report.json | dir>...\n' +
    '       bun scripts/browser-baseline.mjs check|record [--prune] --run [playwright args]\n' +
    '       bun scripts/browser-baseline.mjs recheck <report.json | dir>...\n'
  const mode = argv[0]
  if (!['check', 'record', 'recheck'].includes(mode)) {
    process.stderr.write(usage)
    return 2
  }
  let args = argv.slice(1)
  let prune = false
  let runSuite = false
  while (args.length && args[0].startsWith('--')) {
    const flag = args.shift()
    if (flag === '--prune' && mode === 'record') prune = true
    else if (flag === '--run' && mode !== 'recheck') { runSuite = true; break }
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
  const { tests, errors, timedOut } = mergeReports(files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))), files.map((f) => path.basename(f)))
  const baseline = readBaseline(BASELINE)
  if (mode === 'recheck') {
    const { locations, unrechecked } = recheckPlan(baseline.failures, tests, errors)
    if (locations.length) process.stdout.write(`${locations.join('\n')}\n`)
    if (unrechecked.length) {
      const why = errors.length ? 'the suite did not run cleanly' : `over the cap of ${RECHECK_MAX} locations`
      process.stderr.write(`${unrechecked.length} new failure(s) not run again (${why}); they stay new:\n${unrechecked.map((k) => `  ${k}`).join('\n')}\n`)
    }
    return 0
  }
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
  const v = judge(baseline.failures, tests, timedOut)
  const reasons = new Map([...tests].map(([k, t]) => [k, t.error]))
  process.stdout.write(verdictText(v, baseline.failures.length, errors, reasons, tests))
  if (!tests.size && !errors.length) {
    process.stderr.write(`${files.length} report(s) with no tests: the suite did not run.\n`)
    return 1
  }
  return v.regressions.length || errors.length || v.unfinished.length ? 1 : 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)))
}
