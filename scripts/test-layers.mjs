#!/usr/bin/env bun
/**
 * The three test layers, chosen by cost and by what a change touches.
 *
 *   L0 local  `bun run test` (test:local) while coding: the change's own tests, the fast tests (under
 *                                          1.5 s each) importing or naming a changed file, and the
 *                                          cheapest scan tests (ratchets, guards); about a minute.
 *                                          `--all`: every fast file of the quick tier
 *   L1 land   `bun run test:land`         before a land: every test the change needs, run to the end:
 *                                          its own tests (quick and slow tier), every quick test
 *                                          importing or naming a changed file, the scan tests up to
 *                                          6 s; no timer, no budget. A few minutes
 *   L2 deep   push gate + CI              the whole quick, slow, e2e, frontend and browser tiers,
 *                                          on GitHub's runners, after the land (unchanged)
 *
 *   bun scripts/test-layers.mjs list local|land [--base <ref> | --changed-from <file>]   print the chosen files
 *   bun scripts/test-layers.mjs plan local|land [--base <ref>]   counts, predicted time, why
 *   bun scripts/test-layers.mjs run  local|land [--base <ref>] [--json <file>] [--part <i>/<n>]
 *     --part i/n: only part i of n, the files dealt by measured time so each part costs about the
 *     same (the push gate's land jobs); the change's own slow-tier files go to part 1
 *   bun scripts/test-layers.mjs report                           quarantine and timing upkeep
 *   bun scripts/test-layers.mjs measure [vitest options]        rewrite tests/setup/test-durations.json
 *
 * Why: a land ran 1,000 to 2,000 quick files on a shared host (median 93 min, 2026-11-05 to 07),
 * and of its 61 refusals for tests, 31 were tests failing at random or under load; 25 of the 29
 * real ones came from scan tests that take milliseconds. docs/reference/testing-pipeline.md.
 *
 * A failing land run is judged once, not eight times: the failing files run again alone; a test
 * that fails again fails the run, one that passes alone is reported as flaky and does not.
 * Machine safety: workers come from tests/setup/worker-budget.ts unless --maxWorkers is given.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vitestCommand } from './bun-vitest.mjs'
import { offenderText, offenders, readLog, record as recordFlaky } from './flaky-log.mjs'
import { buildImportGraph, isTestFile } from './lib/import-graph.mjs'
import { fileIndex, listCode, namedPaths } from './test-changed-refs.mjs'
import { SLOW_TEST_DIRS, SLOW_TEST_FILES } from '../tests/setup/slow-tests.ts'
import { QUARANTINE, QUARANTINED_TEST_FILES } from '../tests/setup/quarantine.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const DURATIONS = path.join(ROOT, 'tests/setup/test-durations.json')

/** A file of the local layer takes at most this long in the measured run. */
export const LOCAL_MAX_MS = 1500
/**
 * The local layer runs the scan tests (ratchet, guard, tree rules) of at most this cost. A cost
 * counts the file's worker start and imports, about 0.3 s for the smallest file on a busy host,
 * so this keeps the cheapest third of them and the local run near a minute.
 */
export const SCAN_MAX_MS = 500
/** The land layer runs scan tests up to this long. */
export const LAND_SCAN_MAX_MS = 6000
/** These paths change how every test runs: the land layer adds the whole local layer for them. */
const SETUP_PATH = /^(vitest[^/]*\.config\.ts|tests\/setup\/[^/]+\.ts|bun\.lock|package\.json)$/
const FOREIGN = ['tests/e2e/', 'tests/web/notes-roundtrip/', 'tests/web/diff-view/', 'tests/web/markdown/', 'tests/web/workflow-graph/']
const SCAN_NAME = /(ratchet|guard)[^/]*\.test\.ts$/

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (e.name.endsWith('.test.ts')) out.push(path.relative(ROOT, p))
  }
}

/** The quick tier's files, as vitest.quick.config.ts selects them (quick-tier.test.ts pins it). */
export function quickUniverse() {
  const all = []
  walk(path.join(ROOT, 'tests'), all)
  const slow = new Set([...SLOW_TEST_FILES, ...QUARANTINED_TEST_FILES])
  const slowDirs = SLOW_TEST_DIRS.map((d) => d.replace(/\*\*$/, ''))
  return all.filter((f) => !f.endsWith('.live.test.ts') && !slow.has(f) && !slowDirs.some((d) => f.startsWith(d)) && !FOREIGN.some((d) => f.startsWith(d))).sort()
}

/** The slow tier's files (vitest.slow.config.ts): the slow list, the quarantine, the slow dirs. */
export function slowUniverse() {
  const all = []
  walk(path.join(ROOT, 'tests'), all)
  const slow = new Set([...SLOW_TEST_FILES, ...QUARANTINED_TEST_FILES])
  // As vitest.slow.config.ts includes them: tests/e2e has a config of its own, and a file the slow
  // config does not include answers "No test files found" (2026-11-09: every land that edited an
  // e2e test was refused that way).
  const slowDirs = SLOW_TEST_DIRS.filter((d) => d !== 'tests/e2e/**').map((d) => d.replace(/\*\*$/, ''))
  return all.filter((f) => !f.endsWith('.live.test.ts') && (slow.has(f) || slowDirs.some((d) => f.startsWith(d)))).sort()
}

export function readDurations(file = DURATIONS) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).files ?? {} } catch { return {} }
}

/** Unmeasured (new) files count as fast: a new slow file shows in the next measurement. */
const cost = (durations, f) => durations[f] ?? 0

/** Every fast file of the quick tier (`test:local --all`): about 9 minutes at 8 workers. */
export function fastFiles(universe = quickUniverse(), durations = readDurations()) {
  return universe.filter((f) => cost(durations, f) <= LOCAL_MAX_MS)
}

// A scan test reads the source tree as text and checks a rule over it (a ratchet, a guard, a
// partition): it starts nothing, so it costs milliseconds to seconds, and it is what caught most
// real problems in the land history. By name, or by what it does: reads files of the tree and
// starts no server; the cost limit keeps out the slow ones.
const SCAN_READS = /readFileSync|readdirSync|ls-files|globSync|new Bun\.Glob|walk\(/
const SCAN_TREE = /['"`](?:\.\.\/)*(?:src|web\/src|tests|scripts|ios-native|docs|\.github|web)\/|\bROOT\b|\bREPO\b|REPO_ROOT|repoRoot/
const SCAN_SERVER = /startServer\(|createServer\(|new WebSocket\(/
export function isScanTest(file, text) {
  return SCAN_NAME.test(file) || (SCAN_READS.test(text) && SCAN_TREE.test(text) && !SCAN_SERVER.test(text))
}

const scanCache = new Map()
export function scanTests(universe = quickUniverse(), durations = readDurations(), maxMs = SCAN_MAX_MS, read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')) {
  return universe.filter((f) => {
    if (cost(durations, f) > maxMs) return false
    if (!scanCache.has(f)) { let t = ''; try { t = read(f) } catch { /* gone */ } scanCache.set(f, isScanTest(f, t)) }
    return scanCache.get(f)
  })
}

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}

export function changedFiles(base) {
  const out = `${git(['diff', '--name-only', '--no-renames', base])}\n${git(['diff', '--cached', '--name-only', '--no-renames'])}\n${git(['ls-files', '--others', '--exclude-standard'])}`
  return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
}

/** The tests/ files that name one of `changed` by path in their text (a child they spawn, a file they read). */
function namers(changed) {
  const want = new Set(changed)
  const files = listCode(ROOT)
  const index = fileIndex([...files, ...changed])
  const out = new Set()
  for (const f of files) {
    if (!isTestFile(f)) continue
    let text
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    for (const p of namedPaths(f, text, index)) if (want.has(p)) { out.add(f); break }
  }
  return out
}

/**
 * What each layer holds. The land layer runs every test the change needs to the end, whatever it
 * costs: its own tests (of any tier), every test importing or naming a changed file, and the scan
 * tests; it is fast because it holds only those (2026-11-08, the user: tests in layers, "and the
 * tests it needs, run them"; no timer, no budget). The local layer is the quick look while
 * editing: the same, with only fast reached files.
 */
export const LIMITS = {
  local: { fileMaxMs: LOCAL_MAX_MS, maxReached: 60, scanMaxMs: SCAN_MAX_MS, depth: 1 },
  land: { fileMaxMs: Infinity, maxReached: Infinity, scanMaxMs: LAND_SCAN_MAX_MS, depth: 1 },
}

/**
 * The files a layer runs for a change: { files, slowFiles, why, leftToGate, predictedMs }.
 *   the change's own test files (any cost; slowFiles: the ones in the slow tier, run with its config),
 *   the tests importing a changed file directly and the tests naming one by path (the local
 *     layer: within its cost per file and count, cheapest first, the rest left to the land),
 *   every fast scan test (ratchets, guards: they caught most real problems, in milliseconds),
 *   and for a change to the test setup, the tests of the setup itself.
 */
export function scopedLayer(layer, changed, { universe = quickUniverse(), slow = slowUniverse(), durations = readDurations(), graph, namedBy = namers, read, limits = {} } = {}) {
  const { fileMaxMs, maxReached, scanMaxMs, depth } = { ...LIMITS[layer], ...limits }
  const inTier = new Set(universe)
  const why = new Map()
  const add = (f, r) => { if (inTier.has(f) && !why.has(f)) why.set(f, r) }
  for (const f of changed) if (isTestFile(f)) add(f, 'changed')
  const g = graph ?? buildImportGraph(ROOT)
  const direct = new Set(g.testsWithin(changed.filter((f) => !isTestFile(f)), depth).keys())
  const reached = [...new Set([...direct, ...namedBy(changed)])].filter((f) => inTier.has(f) && !why.has(f))
  const leftToGate = []
  const affordable = reached.filter((f) => (cost(durations, f) <= fileMaxMs ? true : (leftToGate.push(f), false)))
  affordable.sort((a, b) => cost(durations, a) - cost(durations, b) || a.localeCompare(b))
  for (const f of affordable.slice(0, maxReached)) add(f, direct.has(f) ? 'imports a changed file' : 'names a changed file')
  leftToGate.push(...affordable.slice(maxReached))
  for (const f of scanTests(universe, durations, scanMaxMs, read)) add(f, 'scan test')
  if (changed.some((f) => SETUP_PATH.test(f))) for (const f of universe) if (f.startsWith('tests/setup/')) add(f, 'the change touches the test setup')
  const files = [...why.keys()].sort()
  const slowSet = new Set(slow)
  const slowFiles = [...new Set(changed)].filter((f) => isTestFile(f) && slowSet.has(f)).sort()
  for (const f of slowFiles) why.set(f, 'changed (slow tier)')
  return { files, slowFiles, why, leftToGate: leftToGate.sort(), predictedMs: files.reduce((s, f) => s + cost(durations, f), 0) }
}

/** The land layer (L1) for a change. */
export const landLayer = (changed, opts) => scopedLayer('land', changed, opts)
/** The local layer (L0) for a change: the same shape, only fast files. */
export const localLayer = (changed, opts) => scopedLayer('local', changed, opts)

// A branch further than this from the main line is no one change (a checkout whose main and
// its remote's carry the same work under other hashes): only its uncommitted edits count then.
export const MAX_BRANCH_COMMITS = 50

/**
 * Where a change starts when no --base or WALNUT_DIFF_BASE names it: where this branch left the
 * main line (upstream/main for a fork's clone, then origin/main, then a local main), else HEAD,
 * so `bun run test` in any clone judges the branch's commits and its uncommitted edits alike.
 */
export function defaultBase(run = git) {
  for (const ref of ['upstream/main', 'origin/main', 'main']) {
    const at = run(['merge-base', 'HEAD', ref]).trim()
    if (!at) continue
    const ahead = Number(run(['rev-list', '--count', `${at}..HEAD`]).trim() || 0)
    return ahead > MAX_BRANCH_COMMITS ? 'HEAD' : at
  }
  return 'HEAD'
}

function parseArgs(argv) {
  const o = { cmd: argv[0], layer: argv[1], base: process.env.WALNUT_DIFF_BASE || null, json: null, all: false, extra: [] }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base') o.base = argv[++i]
    else if (argv[i] === '--json') o.json = argv[++i]
    else if (argv[i] === '--changed-from') o.changedFrom = argv[++i]
    else if (argv[i] === '--all') o.all = true
    else if (argv[i] === '--part') o.part = argv[++i]
    else o.extra.push(argv[i])
  }
  o.base ??= defaultBase()
  return o
}

/**
 * Runs vitest on `files` with a JSON report; returns { failed: ["file :: test"], crashed: [file], ms, runError }.
 * runError: vitest exited nonzero (an unhandled error or rejection, a crash) with no failing file
 * to explain it. The JSON report leaves those errors out, so only the exit status shows them.
 */
export function runVitest(files, extra, { config = 'vitest.quick.config.ts', root = ROOT } = {}) {
  const report = path.join(os.tmpdir(), `walnut-layer-${process.pid}-${Date.now()}.json`)
  const { cmd, args } = vitestCommand(['run', '--config', config, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...extra, ...files.map((f) => path.join(root, f))])
  const t0 = Date.now()
  const child = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  const ms = Date.now() - t0
  const exit = child.error ? `could not start: ${child.error.message}` : child.signal ? `killed by ${child.signal}` : child.status !== 0 ? `exited ${child.status}` : null
  let r = null
  try { r = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* vitest died before writing */ }
  fs.rmSync(report, { force: true })
  if (!r) return { failed: [], crashed: files, ms, runError: null }
  const failed = [], crashed = [], seen = new Set()
  for (const tf of r.testResults ?? []) {
    const rel = path.relative(root, tf.name)
    seen.add(rel)
    const bad = (tf.assertionResults ?? []).filter((a) => a.status === 'failed')
    if (bad.length) for (const a of bad) failed.push(`${rel} :: ${a.fullName ?? a.title}`)
    else if (tf.status === 'failed') crashed.push(rel)
  }
  // A file asked for that reported nothing never ran (left the tier, or vitest died first): never a pass.
  for (const f of files) if (!seen.has(f)) crashed.push(f)
  const runError = exit && !failed.length && !crashed.length ? `vitest ${exit} with every file passing: an unhandled error or rejection (see its "Errors" block above)` : null
  return { failed, crashed, ms, runError }
}

/**
 * Part `i` of `n` (1-based) of a layer's files: the costliest first, each to the part with the
 * least measured time so far (ties to the lower part), so the parts cost about the same and every
 * file is in exactly one. The slow-tier files (real processes, run one at a time) go to part 1.
 */
export function partOf(files, slowFiles, part, durations = readDurations()) {
  const m = /^(\d+)\/(\d+)$/.exec(part ?? '')
  const i = m ? Number(m[1]) : 0, n = m ? Number(m[2]) : 0
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`--part wants <i>/<n> with 1 <= i <= n, not ${part}`)
  const load = Array(n).fill(0), bins = Array.from({ length: n }, () => [])
  for (const f of [...files].sort((a, b) => cost(durations, b) - cost(durations, a) || a.localeCompare(b))) {
    let k = 0
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j
    bins[k].push(f); load[k] += cost(durations, f)
  }
  return { files: bins[i - 1].sort(), slowFiles: i === 1 ? slowFiles : [] }
}

/** The verdict of a first run and the rerun of its failing files alone. */
export function judge(first, again) {
  const againFiles = new Set([...again.failed.map((f) => f.split(' :: ')[0]), ...again.crashed])
  // An unhandled error names no file, so it cannot be rerun alone: it fails the run (never a pass).
  const fails = [...again.failed, ...again.crashed.map((f) => `${f} :: <file failed outside its tests>`), ...[first.runError, again.runError].filter(Boolean).map((e) => `<run> :: ${e}`)]
  const flaky = [...first.failed, ...first.crashed.map((f) => `${f} :: <file failed outside its tests>`)].filter((t) => !againFiles.has(t.split(' :: ')[0]))
  return { fails, flaky }
}

/** One tier's run: the files, then the failing ones once more, alone. */
function runTier(files, extra, config) {
  const first = runVitest(files, extra, { config })
  const failing = [...new Set([...first.failed.map((f) => f.split(' :: ')[0]), ...first.crashed])]
  let again = { failed: [], crashed: [], ms: 0, runError: null }
  if (failing.length) {
    console.log(`[test-layers] ${failing.length} file(s) failed: running them once more, alone`)
    again = runVitest(failing, ['--maxWorkers=1', ...extra.filter((a) => !a.startsWith('--maxWorkers'))], { config })
  }
  return { ...judge(first, again), ms: first.ms + again.ms }
}

/**
 * The config a slow-tier file runs with. tests/e2e is a slow dir that vitest.slow.config.ts leaves to
 * its own config (SLOW_DIR_GLOBS), so a changed e2e test run under the slow config found no file
 * and read as a failure (2026-11-09).
 */
export function slowTierConfig(file) {
  return file.startsWith('tests/e2e/') ? 'vitest.e2e.config.ts' : 'vitest.slow.config.ts'
}

function run(o, files, slowFiles = []) {
  if (!files.length && !slowFiles.length) { console.log('[test-layers] nothing to run'); return 0 }
  console.log(`[test-layers] ${o.layer}: ${files.length} file(s)${slowFiles.length ? `, and ${slowFiles.length} of the change's own in the slow tier` : ''}`)
  const tiers = []
  if (files.length) tiers.push(runTier(files, o.extra, 'vitest.quick.config.ts'))
  // The slow tier's files start real processes: one at a time, as CI runs them.
  const oneAtATime = ['--maxWorkers=1', ...o.extra.filter((a) => !a.startsWith('--maxWorkers'))]
  for (const config of [...new Set(slowFiles.map(slowTierConfig))]) {
    tiers.push(runTier(slowFiles.filter((f) => slowTierConfig(f) === config), oneAtATime, config))
  }
  const fails = tiers.flatMap((t) => t.fails), flaky = tiers.flatMap((t) => t.flaky)
  const n = files.length + slowFiles.length
  const verdict = { layer: o.layer, base: o.base, files: n, ms: tiers.reduce((s, t) => s + t.ms, 0), fails, flaky, ok: fails.length === 0 }
  if (flaky.length) console.log(`[test-layers] ${flaky.length} test(s) failed in the full run and passed alone (flaky, not counted):\n  ${flaky.join('\n  ')}`)
  // Each flake goes on the record; a file of this run flaky twice in a week fails it (scripts/flaky-log.mjs).
  recordFlaky(flaky, `test-layers ${o.layer}`)
  const repeat = offenders(readLog(), { only: new Set([...files, ...slowFiles]) })
  if (repeat.length) { console.log(offenderText(repeat)); verdict.ok = false }
  if (fails.length) console.log(`[test-layers] FAILED: ${fails.length} test(s) failed twice:\n  ${fails.join('\n  ')}`)
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(verdict, null, 2))
  console.log(`[test-layers] ${verdict.ok ? 'passed' : 'failed'}: ${n} file(s) in ${Math.round(verdict.ms / 1000)} s`)
  return verdict.ok ? 0 : 1
}

/**
 * Writes tests/setup/test-durations.json: runs the whole quick tier (with `extra` vitest options)
 * through scripts/lib/duration-reporter.mjs, or reads that reporter's output from `costsFile`.
 * A file's cost is all of it: worker prepare, environment, setup files, collection (its imports)
 * and its tests.
 */
function measure(costsFile, extra = []) {
  let file = costsFile
  if (!file) {
    file = path.join(os.tmpdir(), `walnut-durations-${process.pid}.json`)
    const { cmd, args } = vitestCommand(['run', '--config', 'vitest.quick.config.ts', '--reporter=dot', '--reporter=./scripts/lib/duration-reporter.mjs', ...extra])
    spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, WALNUT_DURATIONS_OUT: file } })
  }
  const files = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!costsFile) fs.rmSync(file, { force: true })
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  const out = { measuredAt: new Date().toISOString(), commit: git(['rev-parse', '--short=9', 'HEAD']).trim(), note: 'per-file ms of one quick-tier run: prepare, environment, setup, collection and tests (scripts/test-layers.mjs measure)', files: sorted }
  fs.writeFileSync(DURATIONS, JSON.stringify(out, null, 1) + '\n')
  console.log(`[test-layers] wrote ${Object.keys(sorted).length} file timings to ${path.relative(ROOT, DURATIONS)}`)
}

function report() {
  const today = Date.now()
  const old = QUARANTINE.filter((q) => (today - Date.parse(q.since)) / 86_400_000 > 21)
  let measured = null
  try { measured = JSON.parse(fs.readFileSync(DURATIONS, 'utf8')) } catch { /* none yet */ }
  const universe = quickUniverse(), d = readDurations()
  console.log(`quick tier: ${universe.length} files; fast (local --all): ${fastFiles(universe, d).length}; scan tests: ${scanTests(universe, d).length}`)
  console.log(`timings measured ${measured?.measuredAt ?? 'never'} at ${measured?.commit ?? '?'}; unmeasured quick files: ${universe.filter((f) => d[f] === undefined).length}`)
  console.log(`quarantine: ${QUARANTINE.length} file(s)${old.length ? `; over 21 days, fix or drop: ${old.map((q) => q.file).join(', ')}` : ''}`)
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2))
  if (o.cmd === 'report') { report(); process.exit(0) }
  if (o.cmd === 'measure') {
    const opt = (a) => a?.startsWith('-')
    measure(o.layer && !opt(o.layer) ? o.layer : null, opt(o.layer) ? [o.layer, ...o.extra] : o.extra); process.exit(0)
  }
  if (!['list', 'plan', 'run'].includes(o.cmd) || !['local', 'land'].includes(o.layer)) {
    console.error('usage: bun scripts/test-layers.mjs list|plan|run local|land [--base <ref>] [--changed-from <file>] [--json <file>] [--part <i>/<n>] [vitest options]\n       bun scripts/test-layers.mjs report\n       bun scripts/test-layers.mjs measure [<costs json>] [vitest options]')
    process.exit(2)
  }
  const universe = quickUniverse(), durations = readDurations()
  let files, slowFiles = [], plan = null
  if (o.all) files = fastFiles(universe, durations)
  else {
    // --changed-from <file>: the changed paths, one per line, instead of a diff (a replay of an old land).
    const changed = o.changedFrom ? fs.readFileSync(o.changedFrom, 'utf8').split('\n').filter(Boolean) : changedFiles(o.base)
    plan = scopedLayer(o.layer, changed, { universe, durations }); files = plan.files; slowFiles = plan.slowFiles
  }
  if (o.part) ({ files, slowFiles } = partOf(files, slowFiles, o.part, durations))
  if (o.cmd === 'list') { for (const f of [...files, ...slowFiles]) console.log(f); process.exit(0) }
  if (o.cmd === 'plan') {
    const ms = files.reduce((s, f) => s + cost(durations, f), 0)
    console.log(`${o.layer}: ${files.length} file(s), ${Math.round(ms / 1000)} s of measured test time`)
    if (plan) {
      const by = new Map()
      for (const r of plan.why.values()) by.set(r, (by.get(r) ?? 0) + 1)
      for (const [r, n] of by) console.log(`  ${n} ${r}`)
      if (plan.leftToGate.length) console.log(`  ${plan.leftToGate.length} reached but over the local layer's cost or count: the land layer runs them`)
    }
    process.exit(0)
  }
  process.exit(run(o, files, slowFiles))
}
