/**
 * The test layers (scripts/test-layers.mjs): which files each layer runs, and the import graph
 * the land layer reads (scripts/lib/import-graph.mjs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error plain .mjs without types
import * as layers from '../../scripts/test-layers.mjs'
// @ts-expect-error plain .mjs without types
import { buildImportGraph } from '../../scripts/lib/import-graph.mjs'
import { QUARANTINED_TEST_FILES } from '../setup/quarantine.js'
import { SLOW_TEST_FILES } from '../setup/slow-tests.js'

/** A stand-in graph: `importers` maps a changed file to the tests that import it directly. */
const fakeGraph = (importers: Record<string, string[]>) => ({
  testsWithin: (changed: string[]) => new Map(changed.flatMap((c) => (importers[c] ?? []).map((t) => [t, 1] as const))),
})

describe('the fast files (test:local --all)', () => {
  it('keeps the quick files measured at most LOCAL_MAX_MS, and counts an unmeasured file as fast', () => {
    const universe = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/new.test.ts']
    const durations = { 'tests/a.test.ts': 200, 'tests/b.test.ts': layers.LOCAL_MAX_MS + 1 }
    expect(layers.fastFiles(universe, durations)).toEqual(['tests/a.test.ts', 'tests/new.test.ts'])
  })
})

describe('the local layer', () => {
  it('is the land layer with fast files only: a slower importer goes to the push gate', () => {
    const universe = ['tests/x.test.ts', 'tests/mid.test.ts', 'tests/z-ratchet.test.ts']
    const durations = { 'tests/mid.test.ts': layers.LOCAL_MAX_MS + 1 }
    const opts = { universe, durations, namedBy: () => new Set<string>(), graph: fakeGraph({ 'src/m.ts': ['tests/x.test.ts', 'tests/mid.test.ts'] }) }
    expect(layers.localLayer(['src/m.ts'], opts).files).toEqual(['tests/x.test.ts', 'tests/z-ratchet.test.ts'])
    expect(layers.landLayer(['src/m.ts'], opts).files).toEqual(['tests/mid.test.ts', 'tests/x.test.ts', 'tests/z-ratchet.test.ts'])
  })
})

describe('the land layer', () => {
  const universe = ['tests/x.test.ts', 'tests/y.test.ts', 'tests/slow-importer.test.ts', 'tests/z-ratchet.test.ts', 'tests/heavy-guard.test.ts', 'tests/other.test.ts']
  const durations = { 'tests/slow-importer.test.ts': 600_000, 'tests/heavy-guard.test.ts': layers.LAND_SCAN_MAX_MS + 1, 'tests/other.test.ts': 100 }

  it('runs the changed tests, every direct importer whatever it costs, and the scan tests: no cut-off', () => {
    const plan = layers.landLayer(['src/m.ts', 'tests/x.test.ts'], { universe, durations, namedBy: () => new Set<string>(), graph: fakeGraph({ 'src/m.ts': ['tests/y.test.ts', 'tests/slow-importer.test.ts'] }) })
    expect(plan.files).toEqual(['tests/slow-importer.test.ts', 'tests/x.test.ts', 'tests/y.test.ts', 'tests/z-ratchet.test.ts'])
    expect(plan.why.get('tests/x.test.ts')).toBe('changed')
    expect(plan.why.get('tests/y.test.ts')).toBe('imports a changed file')
    expect(plan.why.get('tests/z-ratchet.test.ts')).toBe('scan test')
    expect(plan.leftToGate).toEqual([])
  })

  it("the change's own test in the slow tier runs too, with the slow config", () => {
    const plan = layers.landLayer(['tests/own-slow.test.ts', 'src/m.ts'], { universe, slow: ['tests/own-slow.test.ts'], durations, namedBy: () => new Set<string>(), graph: fakeGraph({}) })
    expect(plan.slowFiles).toEqual(['tests/own-slow.test.ts'])
    expect(plan.files).not.toContain('tests/own-slow.test.ts')
  })

  it('never runs a file outside the quick tier (slow, quarantined, e2e), even one the change edits', () => {
    const plan = layers.landLayer(['tests/e2e/flow.test.ts', 'src/m.ts'], { universe, durations, namedBy: () => new Set<string>(), graph: fakeGraph({ 'src/m.ts': ['tests/not-in-tier.test.ts'] }) })
    expect(plan.files).not.toContain('tests/e2e/flow.test.ts')
    // Nor with the slow config, which does not include e2e files (vitest answers "No test files found").
    expect(layers.landLayer(['tests/e2e/flow.test.ts'], { universe, slow: layers.slowUniverse(), durations, namedBy: () => new Set<string>(), graph: fakeGraph({}) }).slowFiles).toEqual([])
    expect(plan.files).not.toContain('tests/not-in-tier.test.ts')
  })

  it('a hub module: the land layer runs all of its importers; the local layer the cheapest 60', () => {
    const many = Array.from({ length: 250 }, (_, i) => `tests/imp-${String(i).padStart(3, '0')}.test.ts`)
    const d: Record<string, number> = Object.fromEntries(many.map((f, i) => [f, 100 + i]))
    const opts = { universe: many, durations: d, namedBy: () => new Set<string>(), read: () => '', graph: fakeGraph({ 'src/hub.ts': [...many].reverse() }) }
    expect(layers.landLayer(['src/hub.ts'], opts).files).toEqual(many)
    expect(layers.localLayer(['src/hub.ts'], opts).files).toEqual(many.slice(0, 60))
  })

  it("a change to the test setup adds the setup's own tests, never the whole tier", () => {
    const u = [...universe, 'tests/setup/quick-tier.test.ts']
    const plan = layers.landLayer(['vitest.quick.config.ts'], { universe: u, durations, namedBy: () => new Set<string>(), graph: fakeGraph({}) })
    expect(plan.files).toContain('tests/setup/quick-tier.test.ts')
    expect(plan.files).not.toContain('tests/other.test.ts')
  })
})

describe('scan tests', () => {
  it('a rule check over the source tree is a scan test whatever its name; one that starts a server is not', () => {
    expect(layers.isScanTest('tests/x-ratchet.test.ts', '')).toBe(true)
    expect(layers.isScanTest('tests/rules.test.ts', "const src = fs.readFileSync(path.join(ROOT, 'src/a.ts'), 'utf8')")).toBe(true)
    expect(layers.isScanTest('tests/wf.test.ts', "fs.readdirSync(path.join(REPO, '.github', 'workflows'))")).toBe(true)
    expect(layers.isScanTest('tests/flow.test.ts', "fs.readFileSync('src/a.ts'); await startServer({ port: 0 })")).toBe(false)
    expect(layers.isScanTest('tests/pure.test.ts', "import { f } from '../src/f.js'")).toBe(false)
  })

  it('the land layer runs the scan tests within its own cost limit, the local layer within a tighter one', () => {
    const universe = ['tests/a-guard.test.ts', 'tests/b-guard.test.ts']
    const durations = { 'tests/a-guard.test.ts': 100, 'tests/b-guard.test.ts': layers.SCAN_MAX_MS + 1 }
    const opts = { universe, durations, namedBy: () => new Set<string>(), graph: fakeGraph({}), read: () => '' }
    expect(layers.localLayer(['src/m.ts'], opts).files).toEqual(['tests/a-guard.test.ts'])
    expect(layers.landLayer(['src/m.ts'], opts).files).toEqual(['tests/a-guard.test.ts', 'tests/b-guard.test.ts'])
  })
})

describe('the quick universe', () => {
  it('leaves out the slow and the quarantined files', () => {
    const u = new Set(layers.quickUniverse())
    expect([...SLOW_TEST_FILES, ...QUARANTINED_TEST_FILES].filter((f) => u.has(f))).toEqual([])
    expect(u.has('tests/scripts/test-layers.test.ts')).toBe(true)
  })
})

describe('the import graph', () => {
  let root: string
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-'))
    const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s) }
    w('vitest.quick.config.ts', "alias: { '@': path.resolve(import.meta.dirname, 'web/src') }")
    w('src/a.ts', 'export const a = 1')
    w('src/b.ts', "import { a } from './a.js'\nexport const b = a")
    w('web/src/c.ts', 'export const c = 1')
    w('tests/a.test.ts', "import { a } from '../src/a.js'")
    w('tests/b.test.ts', "import { b } from '../src/b'")
    w('tests/c.test.ts', "vi.mock('@/c')\nimport { c } from '@/c'")
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('depth 1 is the tests importing a changed file directly; depth 2 one step further', () => {
    const g = buildImportGraph(root)
    expect([...g.testsWithin(['src/a.ts'], 1).keys()]).toEqual(['tests/a.test.ts'])
    expect([...g.testsWithin(['src/a.ts'], 2).keys()].sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])
  })

  it('a deleted or renamed module still selects the tests that import it', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-gone-'))
    const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(r, p)), { recursive: true }); fs.writeFileSync(path.join(r, p), s) }
    w('src/kept.ts', 'export const k = 1')
    w('tests/gone.test.ts', "import { g } from '../src/gone.js'")
    w('tests/gone-dir.test.ts', "import { d } from '../src/pkg'")
    w('tests/via-kept.test.ts', "import { k } from '../src/kept.js'")
    try {
      const g = buildImportGraph(r)
      expect([...g.testsWithin(['src/gone.ts'], 1).keys()]).toEqual(['tests/gone.test.ts'])
      expect([...g.testsWithin(['src/pkg/index.ts'], 1).keys()]).toEqual(['tests/gone-dir.test.ts'])
      expect([...g.testsWithin(['src/never-imported.ts'], 1).keys()]).toEqual([])
    } finally { fs.rmSync(r, { recursive: true, force: true }) }
  })

  it('follows the @/ alias of the quick config', () => {
    expect([...buildImportGraph(root).testsWithin(['web/src/c.ts'], 1).keys()]).toEqual(['tests/c.test.ts'])
  })
})

describe('the default base', () => {
  const fake = (bases: Record<string, string>, ahead: number) => (args: string[]) =>
    args[0] === 'merge-base' ? (bases[args[2]!] ?? '') : args[0] === 'rev-list' ? String(ahead) : ''

  it("is where the branch left the main line, a fork's upstream first", () => {
    expect(layers.defaultBase(fake({ 'upstream/main': 'u1', 'origin/main': 'o1' }, 3))).toBe('u1')
    expect(layers.defaultBase(fake({ 'origin/main': 'o1' }, 3))).toBe('o1')
    expect(layers.defaultBase(fake({ main: 'm1' }, 0))).toBe('m1')
  })

  it('is HEAD with no main line, or one too far behind to be one change', () => {
    expect(layers.defaultBase(fake({}, 0))).toBe('HEAD')
    expect(layers.defaultBase(fake({ 'origin/main': 'o1' }, layers.MAX_BRANCH_COMMITS + 1))).toBe('HEAD')
  })
})

describe('the slow tier as the land layer sees it', () => {
  it('holds only files vitest.slow.config.ts includes: none under tests/e2e', () => {
    const slow = layers.slowUniverse()
    expect(slow.length).toBeGreaterThan(0)
    expect(slow.filter((f: string) => f.startsWith('tests/e2e/'))).toEqual([])
  })
})

describe('slowTierConfig', () => {
  it('runs every slow dir under a config that includes it', () => {
    for (const dir of ['tests/e2e/**', 'tests/commands/**', 'tests/mcp/**']) {
      const file = `${dir.replace(/\*\*$/, '')}x.test.ts`
      const config = fs.readFileSync(path.join(__dirname, '../..', layers.slowTierConfig(file)), 'utf8')
      expect(config, file).toMatch(file.startsWith('tests/e2e/') ? /tests\/e2e\/\*\*\/\*\.test\.ts/ : /SLOW_DIR_GLOBS/)
    }
    expect(layers.slowTierConfig('tests/e2e/op-call-gateway-e2e.test.ts')).toBe('vitest.e2e.config.ts')
    expect(layers.slowTierConfig('tests/mcp/x.test.ts')).toBe('vitest.slow.config.ts')
  })
})
