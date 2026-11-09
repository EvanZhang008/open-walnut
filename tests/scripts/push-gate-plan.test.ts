/**
 * What a push-gate run tests (scripts/push-gate-plan.mjs): the whole tier for a push, a land's
 * own tests for a land, and the whole tier again for a land that touches a foundation, a module
 * the tree stands on, or more than half the tier's cost. And how test-layers.mjs deals a layer's
 * files into the land jobs (--part).
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import * as plan from '../../scripts/push-gate-plan.mjs'
// @ts-expect-error plain .mjs without types
import { partOf } from '../../scripts/test-layers.mjs'

const universe = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c-ratchet.test.ts', 'tests/d.test.ts']
const graph = (importers: Record<string, string[]>, counts: Record<string, number> = {}) => ({
  testsWithin: (changed: string[]) => new Map(changed.flatMap((c) => (importers[c] ?? []).map((t) => [t, 1] as const))),
  importerCount: (f: string) => counts[f] ?? (importers[f] ?? []).length,
})
const opts = (g = graph({ 'src/m.ts': ['tests/a.test.ts'] }), durations: Record<string, number> = { 'tests/a.test.ts': 100_000, 'tests/b.test.ts': 2_000_000, 'tests/c-ratchet.test.ts': 1_000, 'tests/d.test.ts': 2_000_000 }) =>
  ({ universe, durations, graph: g, namedBy: () => new Set<string>(), read: () => '', exists: () => true })

describe('push-gate-plan', () => {
  it('runs CI\'s quick and frontend legs, and the browser specs, for a push', () => {
    const p = plan.planGate('full', ['src/m.ts'], opts())
    expect(p.mode).toBe('full')
    expect(p.include).toEqual(plan.FULL_TIERS)
    expect(p.tiers).toBe(plan.FULL_TIERS.length + 1)
  })

  it('runs only a land\'s own tests, with the frontend tier in its first job, for a land', () => {
    const p = plan.planGate('land', ['src/m.ts'], opts())
    expect(p.mode).toBe('land')
    expect(p.include).toEqual([{ tier: 'land 1/1', cmd: 'bun scripts/test-layers.mjs run land --base HEAD^ --part 1/1 --maxWorkers=1', frontend: true }])
    // the land job, the frontend tier, the browser specs
    expect(p.tiers).toBe(3)
    expect(p.why).toMatch(/2 test files/)
  })

  it('deals a costlier land into more jobs, at most MAX_LAND_PARTS', () => {
    const g = graph({ 'src/m.ts': ['tests/a.test.ts'] })
    const d = { 'tests/a.test.ts': plan.LAND_PART_MS * 2.5, 'tests/b.test.ts': plan.LAND_PART_MS * 100, 'tests/c-ratchet.test.ts': 1, 'tests/d.test.ts': 0 }
    const p = plan.planGate('land', ['src/m.ts'], opts(g, d))
    expect(p.include.map((t: { tier: string }) => t.tier)).toEqual(['land 1/3', 'land 2/3', 'land 3/3'])
    expect(p.include.filter((t: { frontend?: boolean }) => t.frontend)).toHaveLength(1)
    expect(p.tiers).toBe(5)
  })

  it.each([
    ['tests/setup/worker-budget.ts'], ['vitest.quick.config.ts'], ['bun.lock'], ['package.json'], ['tsconfig.json'],
    ['web/package.json'], ['scripts/test-layers.mjs'], ['scripts/push-gate.sh'], ['.github/workflows/push-gate.yml'], ['patches/x.patch'],
  ])('runs the whole tier for a land touching the foundation %s', (f) => {
    const p = plan.planGate('land', ['src/m.ts', f], opts())
    expect(p.mode).toBe('full')
    expect(p.why).toContain(f)
  })

  it('runs the whole tier for a land changing a module the tree stands on', () => {
    const g = graph({ 'src/m.ts': ['tests/a.test.ts'] }, { 'src/core/types.ts': plan.SHARED_IMPORTERS })
    const p = plan.planGate('land', ['src/core/types.ts'], opts(g))
    expect(p.mode).toBe('full')
    expect(p.why).toMatch(/import src\/core\/types\.ts/)
    expect(plan.planGate('land', ['src/m.ts'], opts(graph({ 'src/m.ts': ['tests/a.test.ts'] }, { 'src/m.ts': plan.SHARED_IMPORTERS - 1 }))).mode).toBe('land')
  })

  it('runs the whole tier for a land whose own tests cost over half the tier', () => {
    const g = graph({ 'src/m.ts': ['tests/b.test.ts', 'tests/d.test.ts'] })
    expect(plan.planGate('land', ['src/m.ts'], opts(g)).mode).toBe('full')
  })

  it('runs only the named quick tests in one job for a files gate, the specs left to the browser job', () => {
    const msg = 'push gate: x\n\nWalnut-Gate: files\nWalnut-Gate-Test: tests/core/a.test.ts\nWalnut-Gate-Test: org-page.spec.ts\nWalnut-Gate-Test: tests/$(rm -rf x).ts\nWalnut-Gate-Test: ../up.test.ts\n'
    expect(plan.FILES_MARK.test(msg)).toBe(true)
    expect(plan.namedTests(msg)).toEqual(['tests/core/a.test.ts', 'org-page.spec.ts'])
    const p = plan.planGate('files', [], { tests: plan.namedTests(msg) })
    expect(p.include).toEqual([{ tier: 'files', cmd: 'WALNUT_BASELINE_MIN_FILES=0 bun run test:baseline -- --maxWorkers=1 tests/core/a.test.ts' }])
    expect(p.tiers).toBe(2)
    // Specs alone: a job that passes, never an empty matrix (which fails its job).
    expect(plan.planGate('files', [], { tests: ['org-page.spec.ts'] })).toMatchObject({ include: [{ tier: 'files', cmd: 'echo "no quick-tier test named"' }], tiers: 2 })
  })

  it('reads a land gate from its commit message line, only on a gate commit', () => {
    expect(plan.LAND_MARK.test('push gate: the files of abc\n\nWalnut-Gate: land\n')).toBe(true)
    expect(plan.LAND_MARK.test('push gate: the files of abc\n')).toBe(false)
    expect(plan.GATE_COMMIT.test('push gate: the files of abc\n\nWalnut-Gate: land\n')).toBe(true)
    expect(plan.GATE_COMMIT.test('docs: explain the\n\nWalnut-Gate: land\n')).toBe(false)
  })

  it('runs the whole tier for a land removing a file tests still import', () => {
    const g = graph({ 'src/gone.ts': ['tests/a.test.ts'] })
    expect(plan.planGate('land', ['src/gone.ts'], { ...opts(g), exists: () => false })).toMatchObject({ mode: 'full', why: expect.stringMatching(/removes src\/gone\.ts/) })
    expect(plan.planGate('land', ['src/gone.ts'], { ...opts(g), exists: () => true }).mode).toBe('land')
  })
})

describe('push-gate-plan: the iOS build', () => {
  // 2026-11-09: a Swift compile error passed every land check and the gate onto main.
  it('adds the iOS build tier when the change touches ios-native/, and only then', () => {
    const land = plan.planGate('land', ['src/m.ts'], opts())
    const withIos = plan.addIosBuild(land, ['ios-native/Walnut/App.swift'])
    expect(withIos.ios).toBe(true)
    expect(withIos.tiers).toBe(land.tiers + 1)
    expect(withIos.why).toMatch(/the iOS app is built \(1 file in ios-native\/\)/)
    expect(plan.addIosBuild(land, [])).toEqual({ ...land, ios: false })
    const full = plan.planGate('full', [], opts())
    expect(plan.addIosBuild(full, ['ios-native/a.swift', 'ios-native/b.swift']).tiers).toBe(full.tiers + 1)
  })

  it('builds nothing for a files gate, which re-runs named tests only', () => {
    const files = plan.planGate('files', [], { ...opts(), tests: ['tests/a.test.ts'] })
    expect(plan.addIosBuild(files, ['ios-native/a.swift'])).toEqual({ ...files, ios: false })
  })
})

describe('test-layers --part', () => {
  const durations = { a: 50, b: 40, c: 30, d: 20, e: 10 }
  const files = ['a', 'b', 'c', 'd', 'e']
  it('puts every file in exactly one part, the parts near equal by measured time, slow files in part 1', () => {
    const parts = [1, 2].map((i) => partOf(files, ['slow'], `${i}/2`, durations))
    expect(parts.flatMap((p) => p.files).sort()).toEqual(files)
    const cost = (fs: string[]) => fs.reduce((s, f) => s + durations[f as keyof typeof durations], 0)
    expect(Math.abs(cost(parts[0].files) - cost(parts[1].files))).toBeLessThanOrEqual(10)
    expect(parts.map((p) => p.slowFiles)).toEqual([['slow'], []])
    expect(partOf(files, [], '1/1', durations).files).toEqual(files)
  })
  it('refuses a part that is not i/n with 1 <= i <= n', () => {
    for (const bad of ['0/2', '3/2', '2', 'x/y']) expect(() => partOf(files, [], bad, durations)).toThrow(/--part/)
  })
})
