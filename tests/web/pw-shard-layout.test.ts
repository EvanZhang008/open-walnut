/**
 * The browser suite's project layout (tests/e2e/browser/pw-shard-layout.ts): a whole sharded
 * run spreads the one-at-a-time host fixture specs over its shards, and no shard ever holds two
 * host fixture parts, which would run at once against the one fixture server and race.
 *
 * Read from the real spec files, so a spec added later that tips a gap fails here, for the
 * shard counts CI uses (16, and 20 once the workflow moves), not on a CI runner as a flaky
 * host test. How the config turns the layout into projects is checked with the other host
 * fixture ratchets (tests/scripts/browser-spec-ratchets.test.ts).
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  declaredTests,
  listSpecFiles,
  runShardTotal,
  shardLayout,
  wholeRunShards,
  type ProjectPart,
  type SpecFile,
} from '../e2e/browser/pw-shard-layout'
import { sideConfigSpecs } from '../e2e/browser/side-config-specs'

const DIR = path.resolve(__dirname, '../e2e/browser')
const side = sideConfigSpecs(DIR)
// As a CI run lists them (playwright.config.ts): no side-config spec, no `*.local.spec.ts`.
const files = listSpecFiles(DIR, (f) => side.includes(`**/${f}`) || f.endsWith('.local.spec.ts'))
const byName = new Map(files.map((f) => [f.name, f]))

/**
 * Playwright's filterForShard over the layout: equal test counts, contiguous, in project order.
 * It cuts by test group, not by test; a group (a serial file) only moves a boundary to its own
 * edge, and every gap is far wider than the largest group, so cutting per test judges the same.
 */
function shardsOf(parts: ProjectPart[], shards: number, scale = (f: SpecFile) => f.tests): Array<Set<number>> {
  const tests: number[] = [] // the part index of every test, in run order
  parts.forEach((p, i) => { for (const f of p.files) for (let n = scale(byName.get(f)!); n > 0; n--) tests.push(i) })
  const sizes = Array.from({ length: shards }, () => Math.floor(tests.length / shards))
  for (let i = 0; i < tests.length - sizes.reduce((a, b) => a + b, 0); i++) sizes[i % shards]!++
  const out: Array<Set<number>> = []
  let from = 0
  for (const size of sizes) { out.push(new Set(tests.slice(from, from + size))); from += size }
  return out
}

const RUN = ['node', 'playwright', 'test']
const CI_RUN = [...RUN, '--project=chromium', '--project=chromium-host-fixture', '--retries=1', '--global-timeout=2700000', '--reporter=line,json']

describe('which runs spread', () => {
  it("CI's whole sharded run does, at any shard total", () => {
    expect(wholeRunShards([...CI_RUN, '--shard=6/16'])).toBe(16)
    expect(wholeRunShards([...CI_RUN, '--shard=20/20'])).toBe(20)
    expect(wholeRunShards([...RUN, '--shard=1/16'])).toBe(16)
  })

  it('a run that is not sharded, or drops tests before the cut, does not', () => {
    expect(wholeRunShards(CI_RUN)).toBeNull()
    expect(wholeRunShards([...CI_RUN, '--shard=6/16', 'keyboard-triage.spec.ts'])).toBeNull()
    expect(wholeRunShards([...CI_RUN, '--shard=6/16', '--grep=Undo'])).toBeNull()
    expect(wholeRunShards([...CI_RUN, '--shard=6/16', '-gUndo'])).toBeNull()
    expect(wholeRunShards([...CI_RUN, '--shard=6/16', '--only-changed'])).toBeNull()
    expect(wholeRunShards([...RUN, '--project=chromium-host-fixture', '--shard=1/4'])).toBeNull()
    // An option's value written apart reads as a spec file filter: that run keeps the two projects.
    expect(wholeRunShards([...RUN, '--shard', '6/16'])).toBeNull()
    // Not a Playwright test run at all (a vitest run that shards its own files).
    expect(wholeRunShards(['node', 'vitest', 'run', '--shard=1/8'])).toBeNull()
  })

  it('the runner hands its total to its workers, which have no --shard of their own', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(runShardTotal(env, [...CI_RUN, '--shard=2/16'])).toBe(16)
    expect(env.WALNUT_PW_SHARDS).toBe('16')
    expect(runShardTotal({ ...env, TEST_WORKER_INDEX: '3' }, ['node', 'worker'])).toBe(16)
    // A runner that does not spread drops a total its own parent left in the environment.
    expect(runShardTotal(env, CI_RUN)).toBeNull()
    expect(env.WALNUT_PW_SHARDS).toBeUndefined()
  })
})

describe('declared tests', () => {
  it('counts each test declaration at the start of a line, and nothing in a comment', () => {
    const src = [
      "test('one', async () => {})",
      '  test.skip("two", async () => {})',
      'test.fixme(`three`, async () => {})',
      "// test('commented out')",
      "test.describe('a group', () => {})",
      'test.beforeEach(async () => {})',
    ].join('\n')
    expect(declaredTests(src)).toBe(3)
  })
})

describe('project layout', () => {
  const hostFiles = files.filter((f) => f.hostFixture).map((f) => f.name)

  it('finds the host fixture specs it knows of', () => {
    expect(hostFiles.length).toBeGreaterThan(10)
    for (const known of ['session-path-selector-hosts.spec.ts', 'notification-host-problems.spec.ts', 'remote-hosts-every-button.spec.ts']) {
      expect(hostFiles).toContain(known)
    }
  })

  it('a run that does not spread keeps the two projects', () => {
    expect(shardLayout(files, null)).toBeNull()
  })

  for (const shards of [1, 2, 4, 8, 16, 20, 32]) {
    it(`${shards} shards: every spec in exactly one project of its kind, and no shard holds two host fixture parts`, () => {
      const parts = shardLayout(files, shards)!
      const seen = parts.flatMap((p) => p.files)
      expect(new Set(seen).size).toBe(seen.length)
      expect([...seen].sort()).toEqual(files.map((f) => f.name).sort())
      for (const p of parts) for (const f of p.files) expect(byName.get(f)!.hostFixture, f).toBe(p.kind === 'host-fixture')
      // The run opens with its long in-order files, if any, then a host fixture part: each starts
      // the first shard at once on a worker of its own.
      const lead = parts[0]!.kind === 'chromium' ? parts[0]!.files : []
      expect(parts[lead.length ? 1 : 0]!.kind).toBe('host-fixture')
      for (const f of lead) expect(byName.get(f)!.serial, f).toBe(true)
      expect(lead.reduce((n, f) => n + byName.get(f)!.tests, 0)).toBeLessThanOrEqual(files.reduce((n, f) => n + f.tests, 0) / shards / 2)
      const hostParts = parts.map((p, i) => (p.kind === 'host-fixture' ? i : -1)).filter((i) => i >= 0)
      // With the estimates as counts, and with every chromium spec holding twice its estimate.
      for (const scale of [(f: SpecFile) => f.tests, (f: SpecFile) => (f.hostFixture ? f.tests : 2 * f.tests)]) {
        for (const shard of shardsOf(parts, shards, scale)) {
          expect(hostParts.filter((i) => shard.has(i)).length).toBeLessThanOrEqual(1)
        }
      }
    })
  }

  it('the shard counts CI uses spread the host fixture specs over several shards', () => {
    // About 50 host fixture tests are about 10 minutes one at a time on a CI runner: a part
    // larger than that is a sign the suite grew past what SHARDS_PER_PART was set for.
    const MOST_PER_PART = 80
    for (const shards of [16, 20]) {
      const hostParts = shardLayout(files, shards)!.filter((p) => p.kind === 'host-fixture')
      expect(hostParts.length, `${shards} shards`).toBeGreaterThanOrEqual(3)
      const sizes = hostParts.map((p) => p.files.reduce((n, f) => n + byName.get(f)!.tests, 0))
      expect(Math.max(...sizes), `${shards} shards, parts of ${sizes.join(', ')} tests: lower SHARDS_PER_PART`).toBeLessThan(MOST_PER_PART)
    }
  })

  it('keyboard-triage, the longest file in order, leads a 16- and a 20-shard run', () => {
    for (const shards of [16, 20]) {
      const head = shardLayout(files, shards)![0]!
      expect(head.kind, `${shards} shards`).toBe('chromium')
      expect(head.files[0], `${shards} shards`).toBe('keyboard-triage.spec.ts')
    }
    // An unsharded run keeps it in the chromium project as before.
    expect(byName.get('keyboard-triage.spec.ts')!.serial).toBe(true)
  })
})
