#!/usr/bin/env bun
/**
 * What one push-gate run tests (.github/workflows/push-gate.yml, its plan job).
 *
 *   full  CI's quick legs and its frontend leg, command for command (FULL_TIERS, pinned to ci.yml
 *         by tests/scripts/push-gate-workflow.test.ts), and the browser specs the change touches.
 *         A push to main always runs this.
 *   land  only the tests the land's change needs: the land layer of scripts/test-layers.mjs (its
 *         own tests, the tests importing or naming a changed file, the scan tests), dealt by
 *         measured time into LAND_PART_MS parts, the frontend tier in the first part's job, and
 *         the browser specs it touches. The gate commit asks for it with a `Walnut-Gate: land`
 *         line (scripts/push-gate.sh --run with WALNUT_PUSH_GATE_MODE=land); its parent holds the
 *         main the land goes onto, so HEAD^..HEAD is the land alone.
 *
 * Why: every land ran the whole quick tier, 11 jobs for 13 to 15 minutes, so about two lands an
 * hour fit GitHub's runners (2026-11-08, the user: "why does landing check eleven machines? eleven
 * for one commit?"). The whole tier still runs on every push of main, which carries the lands
 * since the last push; a red push is traced to the land that caused it.
 *
 *   files a few named test files (`Walnut-Gate: files` and one `Walnut-Gate-Test: <path>` line per
 *         file): walnut-cloud's trace of a red push, which runs a push's failing tests on the
 *         commits it carries to find the land that broke them. Quick-tier paths run in one job
 *         through test-baseline.mjs; browser specs run in the browser job (push-gate.sh --specs).
 *
 * A land runs the full tiers instead when its land layer cannot be trusted to hold what it breaks:
 *   - it touches a foundation (FOUNDATION: the test setup and configs, lockfiles and manifests,
 *     the TypeScript configs, the scripts that pick and run the tests, this gate itself);
 *   - a changed file is a module the tree stands on: SHARED_IMPORTERS or more files import it
 *     directly (src/constants.ts, src/core/types.ts, the logger, the server: 16 files on
 *     2026-11-08). The land layer runs only the tests importing a changed file directly, and
 *     through such a module nearly every test reaches it (every src/core file reaches about 2,090
 *     of the 3,320 quick files in some steps, so a count of that says nothing);
 *   - its land layer costs over COST_SHARE of the whole tier's measured time.
 *
 *   bun scripts/push-gate-plan.mjs [--mode land|full] [--base <ref>] [--changed-from <file>]
 * prints the plan as JSON ({ mode, why, tiers, include }); with GITHUB_OUTPUT set it also writes
 * `matrix` (the test job's include list), `tiers` (statuses the verdict waits for), `mode`, `why`.
 * Without --mode it reads the mode from HEAD's message.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildImportGraph, isTestFile } from './lib/import-graph.mjs'
import { changedFiles, landLayer, quickUniverse, readDurations } from './test-layers.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/** ci.yml's quick and frontend legs, as the full gate runs them. */
export const FULL_TIERS = [
  ...Array.from({ length: 8 }, (_, i) => ({ tier: `quick ${i + 1}/8`, cmd: `bun run test:baseline -- --maxWorkers=1 --shard=${i + 1}/8` })),
  { tier: 'frontend', cmd: 'bun run test:frontend:ci' },
]

export const FOUNDATION = /^(vitest[^/]*\.config\.ts|tests\/setup\/|bun\.lock$|package\.json$|bunfig\.toml$|tsconfig[^/]*\.json$|patches\/|web\/(package\.json|bun\.lock|tsconfig[^/]*\.json|vite\.config\.ts)$|scripts\/(test-layers|test-baseline|test-frontend|test-changed-refs|bun-vitest|push-gate-plan|flaky-log)\.mjs$|scripts\/lib\/import-graph\.mjs$|scripts\/push-gate(-status)?\.sh$|\.github\/workflows\/push-gate\.yml$)/
export const SHARED_IMPORTERS = 150
export const COST_SHARE = 0.5
/**
 * About this much measured test time per land job. The measured times (tests/setup/
 * test-durations.json) run about twice a runner's, so a usual land (its scan tests, about 640 s
 * measured) takes two jobs of about three minutes of tests each.
 */
export const LAND_PART_MS = 400_000
export const MAX_LAND_PARTS = 4
export const LAND_MARK = /^Walnut-Gate: land$/m
export const FILES_MARK = /^Walnut-Gate: files$/m
/** Only a gate commit push-gate.sh --run wrote carries a mode: never a real commit's message. */
export const GATE_COMMIT = /^push gate: the files of /
/** The files a files gate names: paths of plain characters only, never anything a shell reads. */
export function namedTests(message) {
  return [...message.matchAll(/^Walnut-Gate-Test: ([A-Za-z0-9_./-]+)$/gm)].map((m) => m[1]).filter((f) => !f.includes('..'))
}

const landCmd = (i, n) => `bun scripts/test-layers.mjs run land --base HEAD^ --part ${i}/${n} --maxWorkers=1`

/**
 * The plan for a change. `changed`: repo-relative paths; `mode`: what the gate commit asked for.
 * The graph, universe and durations are taken from the tree unless given (tests pass their own,
 * and the land layer's `namedBy` and `read`).
 */
export function planGate(mode, changed, { universe = quickUniverse(), durations = readDurations(), graph, exists = (f) => fs.existsSync(path.join(ROOT, f)), ...rest } = {}) {
  const full = (why) => ({ mode: 'full', why, tiers: FULL_TIERS.length + 1, include: FULL_TIERS })
  if (mode === 'files') {
    const quick = (rest.tests ?? []).filter((f) => f.startsWith('tests/') && !f.endsWith('.spec.ts'))
    // test-baseline refuses a run of fewer files than the tier holds (a broken include glob); a
    // files gate names a few on purpose. With no quick file named, a job that passes: an empty
    // matrix fails its job, which would read as a failure of the commit.
    const include = [{ tier: 'files', cmd: quick.length ? `WALNUT_BASELINE_MIN_FILES=0 bun run test:baseline -- --maxWorkers=1 ${quick.join(' ')}` : 'echo "no quick-tier test named"' }]
    return { mode: 'files', why: `${quick.length} named test file(s), and the named browser specs`, tiers: 2, include }
  }
  if (mode !== 'land') return full('a push of main (or a gate that asked for no land run): the whole tier')
  const found = changed.filter((f) => FOUNDATION.test(f))
  if (found.length) return full(`the land touches ${found.slice(0, 3).join(', ')}${found.length > 3 ? ` and ${found.length - 3} more` : ''}, which every test stands on`)
  const g = graph ?? buildImportGraph(ROOT)
  for (const f of changed.filter((c) => !isTestFile(c))) {
    const n = g.importerCount(f)
    if (n >= SHARED_IMPORTERS) return full(`${n} files import ${f}, which the tree stands on`)
    // A file the land removes that tests still reach: the land layer would run only the ones
    // importing it directly (its importer count reads 0 once it is gone), never the ones reaching it
    // through a file that imports it.
    if (!exists(f) && g.testsWithin([f], Infinity).size) return full(`it removes ${f}, which tests still reach through imports`)
  }
  const plan = landLayer(changed, { ...rest, universe, durations, graph: g })
  const total = universe.reduce((s, f) => s + (durations[f] ?? 0), 0)
  if (total && plan.predictedMs > total * COST_SHARE) return full(`its land tests cost ${Math.round(plan.predictedMs / 1000)} s of the tier's ${Math.round(total / 1000)} s`)
  const n = Math.min(MAX_LAND_PARTS, Math.max(1, Math.ceil(plan.predictedMs / LAND_PART_MS)))
  const include = Array.from({ length: n }, (_, i) => ({ tier: `land ${i + 1}/${n}`, cmd: landCmd(i + 1, n), ...(i === 0 ? { frontend: true } : {}) }))
  const files = plan.files.length + plan.slowFiles.length
  // Each land part, the frontend tier (in part 1's job) and the browser specs write a status.
  return { mode: 'land', why: `${files} test files (${Math.round(plan.predictedMs / 1000)} s measured) in ${n} job(s)`, tiers: n + 2, include }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  let mode = opt('--mode')
  let msg = ''
  try { msg = git(['log', '-1', '--format=%B', 'HEAD']) } catch { /* no commit */ }
  if (!mode) mode = !GATE_COMMIT.test(msg) ? 'full' : FILES_MARK.test(msg) ? 'files' : LAND_MARK.test(msg) ? 'land' : 'full'
  const from = opt('--changed-from')
  let plan
  try {
    const changed = from ? fs.readFileSync(from, 'utf8').split('\n').filter(Boolean) : mode === 'land' ? changedFiles(opt('--base') ?? 'HEAD^') : []
    plan = planGate(mode, changed, mode === 'files' ? { tests: namedTests(msg), universe: [], durations: {}, graph: {} } : {})
  } catch (e) {
    // A plan that cannot be made (no parent to diff against, a broken graph) runs the whole tier.
    plan = planGate('full', [])
    plan.why = `could not plan a land run (${String(e?.message ?? e).split('\n')[0]}): the whole tier`
  }
  console.log(JSON.stringify(plan, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(plan.include)}\ntiers=${plan.tiers}\nmode=${plan.mode}\nwhy=${plan.why.replace(/\n/g, ' ')}\n`)
  }
}
