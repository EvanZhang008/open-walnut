/**
 * Where the host fixture specs sit in the run, so a sharded run spreads them over its shards.
 *
 * Specs that swap the fixture server's one host fixture (POST /api/test/host-fixture) race each
 * other when two workers run them at once, so they run in project `chromium-host-fixture` with one
 * worker (playwright.config.ts). Playwright's `--shard` cuts the run into slices of equal test
 * COUNT, in project order: one host fixture project at the end put all of its 170 tests (about
 * 32 min one at a time on a CI runner) into the last shard, behind its share of the chromium
 * tests, and that shard ran out of its 45 min every run (2026-11-17, runs 44113286055 and
 * 44183551860: 46 and 11 host fixture tests never ran).
 *
 * A whole sharded run (CI's) cuts the host fixture specs into a few parts instead, each part its
 * own `chromium-host-fixture` project placed ahead of a block of `chromium` specs:
 *
 *   [hosts 1] [chromium block 1] [hosts 2] [chromium block 2] ... [hosts K] [chromium block K]
 *
 * Every project keeps its name, so `--project chromium --project chromium-host-fixture` still
 * selects them all. Two host fixture parts in one shard would run at once (each project has its
 * own one-worker limit), so a chromium block between two parts always holds more tests than a
 * shard does: a shard's slice can then reach at most one part. Test counts here are read from the
 * source (`test('...'` declarations), which never counts more tests than Playwright finds (a loop
 * that declares tests counts once; 2026-11-17: 4,378 read for 5,007 listed), so a block holds at
 * least its estimate, and the shard size is reckoned from the estimates doubled. A layout that
 * cannot keep that gap uses fewer parts, down to one part at the head of the run, which still
 * starts its shard at once on its own worker.
 *
 * A long file whose tests run in order (`mode: 'serial'` or `'default'`) is one job on one worker,
 * started only when the queue reaches it: keyboard-triage.spec.ts (46 tests, half an hour on a
 * loaded CI runner) sat late in its shard and ran it out of time (2026-11-17, shard 6 of both
 * runs). Such a file leads the run instead, the one place whose shard is known to start with it.
 *
 * Only a whole run spreads: a filter (spec files, --grep, --only-changed, one of the two projects)
 * drops tests before the shards are cut, so the gaps would no longer hold. Any other run (no
 * `--shard`, a filtered one, a side config, the Mac app's WebKit run) keeps the two projects.
 */
import fs from 'node:fs'
import path from 'node:path'

/** A spec that loads, swaps or resets the server's host fixture. */
export const HOST_FIXTURE_CALL = /\b(?:loadFixture|hostFixture|resetServerHostFixture)\(/

/** A file-level (unindented) `test.describe.configure({ mode: 'serial' | 'default' })`. */
const IN_ORDER = /^test\.describe\.configure\(\{[^}]*\bmode:\s*['"](?:serial|default)['"]/m

/** The tests a spec's source declares, at least: each `test('title'` call at the start of a line. */
export function declaredTests(source: string): number {
  return source.match(/^\s*test(?:\.(?:only|skip|fixme|fail))?\(\s*['"`]/gm)?.length ?? 0
}

export interface SpecFile {
  name: string
  /** At least this many tests (declaredTests, and at least one). */
  tests: number
  hostFixture: boolean
  /** Its tests run in order on one worker: one job, however many tests. */
  serial: boolean
}

export interface ProjectPart {
  kind: 'chromium' | 'host-fixture'
  files: string[]
}

/** The specs Playwright's default testMatch finds in `dir`, less those `skip` names. */
export function listSpecFiles(dir: string, skip: (name: string) => boolean = () => false): SpecFile[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) && !f.split(path.sep).some((p) => p.startsWith('.') || p === 'node_modules') && !skip(f))
    .sort()
    .map((f) => {
      const source = fs.readFileSync(path.join(dir, f), 'utf8')
      return { name: f, tests: Math.max(1, declaredTests(source)), hostFixture: HOST_FIXTURE_CALL.test(source), serial: IN_ORDER.test(source) }
    })
}

/** Each estimate doubled: the shard size a slice can reach, whatever the source undercounts. */
const UNDERCOUNT_ROOM = 2
/**
 * At most one host fixture part per this many shards. A part's tests run one at a time, so it
 * should be small; four shards per part keeps the gaps near four shards wide on the live suite,
 * twice what the undercount room needs, and each part a few minutes of serial work.
 */
const SHARDS_PER_PART = 4
/** A file in order leads the run when it holds more than this share of a shard's tests. */
const LEAD_SHARE = 1 / 8
/** Options that pick which tests run (most of them before the shards are cut). */
const FILTERS = new Set(['--grep', '-g', '--grep-invert', '--only-changed', '--last-failed', '--test-list', '--test-list-invert'])
const PROJECTS = ['chromium', 'chromium-host-fixture']

/**
 * The `--shard=<i>/<n>` total of a whole `playwright test` run, else null: every argument after
 * `test` is an option (no spec file), none filters, and `--project` (when given) names both
 * projects. An option's value must follow `=`; a run written another way keeps the two projects.
 */
export function wholeRunShards(argv: readonly string[]): number | null {
  const at = argv.indexOf('test')
  if (at < 0) return null
  let total: number | null = null
  const projects: string[] = []
  for (const a of argv.slice(at + 1)) {
    if (!a.startsWith('-')) return null
    const eq = a.indexOf('=')
    const name = eq < 0 ? a : a.slice(0, eq)
    const value = eq < 0 ? undefined : a.slice(eq + 1)
    // A short filter may carry its value attached (`-gfoo`).
    if (FILTERS.has(name) || /^-g./.test(name)) return null
    if (name === '--project') projects.push(value ?? '')
    const m = name === '--shard' ? value?.match(/^\d+\/(\d+)$/) : null
    if (m) total = Number(m[1])
  }
  if (projects.length && !PROJECTS.every((p) => projects.includes(p))) return null
  return total
}

/**
 * The shard total this run spreads over. The runner reads its own command line; a worker loads
 * this config again with none of it, and must build the same projects (it finds its project by
 * id, and ids follow the project list), so the runner hands the total down in its environment,
 * which every worker inherits.
 */
export function runShardTotal(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): number | null {
  if (env.TEST_WORKER_INDEX !== undefined) return Number(env.WALNUT_PW_SHARDS) || null
  const total = wholeRunShards(argv)
  if (total) env.WALNUT_PW_SHARDS = String(total)
  else delete env.WALNUT_PW_SHARDS
  return total
}

/** Cut `files` (in order) into `parts` contiguous runs of about equal test count. */
function cut(files: readonly SpecFile[], parts: number): SpecFile[][] {
  const total = files.reduce((n, f) => n + f.tests, 0)
  const out: SpecFile[][] = Array.from({ length: parts }, () => [])
  let seen = 0
  for (const f of files) {
    // The part this file's midpoint falls in, so a large file goes where most of it belongs.
    const at = Math.min(parts - 1, Math.floor(((seen + f.tests / 2) * parts) / total))
    out[at]!.push(f)
    seen += f.tests
  }
  return out
}

/**
 * The parts in project order for a run spread over `shards` shards, or null for a run that keeps
 * the two projects (every chromium spec, then every host fixture spec).
 */
export function shardLayout(files: readonly SpecFile[], shards: number | null): ProjectPart[] | null {
  const hosts = files.filter((f) => f.hostFixture)
  if (!shards || shards < 1 || hosts.length === 0) return null
  const total = files.reduce((n, f) => n + f.tests, 0)
  // The longest first, and no more of them than half a shard: the rest of the head shard still runs.
  const lead: SpecFile[] = []
  for (const f of files.filter((x) => !x.hostFixture && x.serial && x.tests > (total / shards) * LEAD_SHARE).sort((x, y) => y.tests - x.tests)) {
    if (lead.reduce((n, x) => n + x.tests, 0) + f.tests <= total / shards / 2) lead.push(f)
  }
  const chromium = files.filter((f) => !f.hostFixture && !lead.includes(f))
  if (chromium.length === 0) return null
  const shardSize = Math.ceil((total * UNDERCOUNT_ROOM) / shards)
  const most = Math.max(1, Math.min(hosts.length, Math.floor(shards / SHARDS_PER_PART)))
  for (let parts = most; parts >= 1; parts--) {
    const hostParts = cut(hosts, parts)
    const blocks = cut(chromium, parts)
    // The gap that matters is a block with a host part after it; the last block has none.
    const gapsHold = blocks.slice(0, -1).every((b) => b.reduce((n, f) => n + f.tests, 0) > shardSize)
    if (parts > 1 && (!gapsHold || hostParts.some((p) => p.length === 0) || blocks.some((b) => b.length === 0))) continue
    const head: ProjectPart[] = lead.length ? [{ kind: 'chromium', files: lead.map((f) => f.name) }] : []
    return [...head, ...hostParts.flatMap((h, i) => [
      { kind: 'host-fixture' as const, files: h.map((f) => f.name) },
      { kind: 'chromium' as const, files: blocks[i]!.map((f) => f.name) },
    ])]
  }
  return null
}
