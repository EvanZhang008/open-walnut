#!/usr/bin/env bun
/**
 * Which browser spec files one CI shard runs, so every shard ends inside its time.
 *
 * Playwright's own --shard=i/n cuts the list of tests into n runs of equal COUNT, in
 * project order. The specs that run one at a time (one worker: the host fixture's and the
 * sign-in state's, tests/e2e/browser/one-at-a-time-specs.ts) are projects of their own,
 * so they all landed in one shard each: on 2026-11-27 (run 45945821701) shard 16 held all
 * 195 host fixture tests on its one worker while its other three workers sat idle for 21
 * minutes, and shards 1, 6 and 16 ran out of their 45 minutes with 270 tests never run.
 *
 * This script spreads the files instead, by their measured time (spec-durations.json; a file
 * not measured yet counts its tests at the median time per test), largest first, each to the
 * shard that ends soonest with it. A shard's end is the longest of: its one-at-a-time chain
 * of each group (one worker each), and all its work spread over the run's workers.
 *
 *   bun scripts/ci/browser-shard.mjs <i> <n>             the files of shard i of n, one per line
 *   bun scripts/ci/browser-shard.mjs <i> <n> --explain   ... and every shard's estimate on stderr
 *   bun scripts/ci/browser-shard.mjs record <reports>    rewrite spec-durations.json from a run's reports
 *
 * Each line is a Playwright file filter that matches that one file only (a regex anchored at
 * its directory, so `board.spec.ts` never also picks `my-board.spec.ts`).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_FIXTURE_CALL, SIGN_IN_CALL } from '../../tests/e2e/browser/one-at-a-time-specs.ts'

const ROOT = path.join(import.meta.dirname, '..', '..')
const BROWSER_DIR = path.join(ROOT, 'tests/e2e/browser')
export const DURATIONS_FILE = path.join(BROWSER_DIR, 'spec-durations.json')
/** The projects CI's browser legs run (ci.yml). */
export const PROJECTS = ['chromium', 'chromium-host-fixture']
/** Workers per CI leg (playwright.config.ts: perRunWorkers on a 4-core runner). */
export const WORKERS = 4
const DEFAULT_SECONDS_PER_TEST = 20

/** The one-at-a-time group a spec's source puts it in, or null when it runs in parallel. */
export function serialGroup(source) {
  if (HOST_FIXTURE_CALL.test(source)) return 'host-fixture'
  if (SIGN_IN_CALL.test(source)) return 'sign-in'
  return null
}

/** Test count per spec file (its name in tests/e2e/browser) from a `playwright test --list --reporter=json` report. */
export function testCounts(report) {
  const counts = new Map()
  const walk = (suite, file) => {
    const f = suite.file ?? file
    for (const spec of suite.specs ?? []) counts.set(f, (counts.get(f) ?? 0) + spec.tests.length)
    for (const s of suite.suites ?? []) walk(s, f)
  }
  for (const s of report.suites ?? []) walk(s, undefined)
  return counts
}

/** Seconds each spec file took on its first tries, from one run's JSON reports. */
export function measuredSeconds(reports) {
  const secs = new Map()
  const walk = (suite, file) => {
    const f = suite.file ?? file
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const first = t.results?.[0]
        if (first && first.status !== 'skipped') secs.set(f, (secs.get(f) ?? 0) + first.duration / 1000)
      }
    }
    for (const s of suite.suites ?? []) walk(s, f)
  }
  for (const r of reports) for (const s of r.suites ?? []) walk(s, undefined)
  return secs
}

/**
 * Every shard's files. `files`: [{ file, tests, group }]; `durations`: { file: seconds }.
 * Deterministic for one input, so every leg computes the same split and takes its own part.
 */
export function assign(files, durations, n, workers = WORKERS) {
  const measured = files.filter((f) => durations[f.file] > 0 && f.tests > 0)
  const perTest = measured.map((f) => durations[f.file] / f.tests).sort((a, b) => a - b)
  const median = perTest.length ? perTest[Math.floor(perTest.length / 2)] : DEFAULT_SECONDS_PER_TEST
  const cost = (f) => (durations[f.file] > 0 ? durations[f.file] : f.tests * median)
  const shards = Array.from({ length: n }, () => ({ files: [], total: 0, chains: {} }))
  const end = (s, f, c) => {
    const total = s.total + c
    let longest = total / workers
    for (const [g, t] of Object.entries(s.chains)) longest = Math.max(longest, t + (g === f.group ? c : 0))
    if (f.group && !(f.group in s.chains)) longest = Math.max(longest, c)
    return longest
  }
  const order = [...files].sort((a, b) => cost(b) - cost(a) || a.file.localeCompare(b.file))
  for (const f of order) {
    const c = cost(f)
    let best = 0
    for (let i = 1; i < n; i++) if (end(shards[i], f, c) < end(shards[best], f, c)) best = i
    const s = shards[best]
    s.files.push(f.file)
    s.total += c
    if (f.group) s.chains[f.group] = (s.chains[f.group] ?? 0) + c
  }
  return shards.map((s) => ({
    files: s.files.sort(),
    seconds: Math.round(Math.max(s.total / workers, ...Object.values(s.chains))),
    chains: Object.fromEntries(Object.entries(s.chains).map(([g, t]) => [g, Math.round(t)])),
  }))
}

/** The Playwright file filter that matches `file` (a name in tests/e2e/browser) and nothing else. */
export function fileFilter(file) {
  return `/[\\\\/]tests[\\\\/]e2e[\\\\/]browser[\\\\/]${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`
}

function listSpecs() {
  const out = execFileSync('bun', ['x', 'playwright', 'test', '--list', '--reporter=json', ...PROJECTS.map((p) => `--project=${p}`)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const report = JSON.parse(out)
  if (report.errors?.length) throw new Error(`playwright --list: ${report.errors[0].message}`)
  return [...testCounts(report)].map(([file, tests]) => ({
    file, tests, group: serialGroup(fs.readFileSync(path.join(BROWSER_DIR, file), 'utf8')),
  }))
}

function readDurations() {
  try { return JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8')) } catch { return {} }
}

function main(argv) {
  if (argv[0] === 'record') {
    const dir = argv[1]
    const reports = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, String(f)), 'utf8')))
    const secs = measuredSeconds(reports)
    const kept = Object.fromEntries([...secs].filter(([, s]) => s > 0).sort(([a], [b]) => a.localeCompare(b)).map(([f, s]) => [f, Math.round(s)]))
    fs.writeFileSync(DURATIONS_FILE, `${JSON.stringify(kept, null, 2)}\n`)
    console.error(`spec-durations.json: ${Object.keys(kept).length} files`)
    return
  }
  const i = Number(argv[0]); const n = Number(argv[1])
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) throw new Error('usage: browser-shard.mjs <i> <n> [--explain] | record <reports dir>')
  const shards = assign(listSpecs(), readDurations(), n)
  if (argv.includes('--explain')) {
    shards.forEach((s, k) => console.error(`shard ${k + 1}: ${s.files.length} files, about ${Math.round(s.seconds / 60)} min${Object.keys(s.chains).length ? ` (one at a time: ${Object.entries(s.chains).map(([g, t]) => `${g} ${Math.round(t / 60)} min`).join(', ')})` : ''}`))
  }
  for (const f of shards[i - 1].files) console.log(fileFilter(f))
}

if (import.meta.main) main(process.argv.slice(2))
