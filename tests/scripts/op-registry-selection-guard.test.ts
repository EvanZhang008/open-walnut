/**
 * Guard: a change to an op module selects every test that reads its ops through the op registry
 * (scripts/lib/op-registry-reach.mjs, scripts/test-layers.mjs).
 *
 * 2026-11-25: three reds reached main from commits that changed only an op's text, because no
 * layer picked the tests that read the op through src/ops/index (two import steps from the op
 * module, past the local layer's depth 1) or that sit in the slow tier (tests/mcp):
 * src/ops/host-exec.ts broke tests/mcp/answer-shapes.test.ts, src/ops/org-threads.ts broke
 * tests/scripts/generated-ops-docs.test.ts and tests/core/org/thread-op-size.test.ts.
 *
 * The readers are found here on their own, from the source and the live registry, not by the
 * selection's rules: every test file whose code loads the registry (by import or by a path built
 * at run time), directly or through a test-side helper or script; the ops of each op module are
 * the names the registry gains when that module is imported. A reader of an op module is one
 * that names one of its ops in a string, or reads every op through a listing call. A new reader,
 * a new op module or a new op the selection misses fails this test.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildImportGraph } from '../../scripts/lib/import-graph.mjs'
import { HELPER_MAX_MODULES, opRegistryReach, READS_CHANGED_OP, registryMembers, registryReaders } from '../../scripts/lib/op-registry-reach.mjs'
import { landLayer, localLayer, quickUniverse, slowUniverse } from '../../scripts/test-layers.mjs'
import { listCode } from '../../scripts/test-changed-refs.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const texts = new Map<string, string>()
const read = (f: string): string => {
  if (!texts.has(f)) { let t = ''; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { /* gone */ } texts.set(f, t) }
  return texts.get(f)!
}
const codes = new Map<string, string>()
const code = (f: string): string => {
  if (!codes.has(f)) codes.set(f, read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'))
  return codes.get(f)!
}

// Test-side code: everything outside the product's own trees.
const testSide = listCode(ROOT).filter((f: string) => /\.(?:[mc]?[jt]sx?)$/.test(f) && !/^(?:src|web\/src|packages)\//.test(f))
const EXT = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js']
/** The repo files a file's code imports by a relative path. */
function relImports(f: string): string[] {
  const out: string[] = []
  for (const m of code(f).matchAll(/(?:from\s*|import\s*\(\s*|import\s+|vi\.(?:mock|doMock|importActual)\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1].replace(/\?.*$/, '')))
    const stem = base.replace(/\.(?:js|mjs|cjs|jsx)$/, '')
    const hit = [base, ...EXT.map((x) => stem + x)].find((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile())
    if (hit) out.push(hit)
  }
  return out
}
const LOADS_REGISTRY = /src\/ops(?:\/index(?:\.[jt]s)?)?$/
// import(path.join(repo, 'src', 'ops', 'index.ts')): a script that loads the registry at run time.
const LOADS_BY_PATH = /\bimport\(\s*[^)]*\bsrc['"`/,\s]+ops['"`/,\s]+index\b/
// A call or a value that hands the test every op of the registry.
const EVERY_OP = /\b(?:listOps|listOpEntries|opNames|summarizeGroups|countOwnerOps|listedForRole|generateOpsCatalog)\b/

/** Every test-side file that reaches the registry, with whether it or a file on its way reads every op. */
function readers(): Map<string, boolean> {
  const imports = new Map(testSide.map((f: string) => [f, relImports(f)]))
  const reach = new Map<string, boolean>()
  for (const f of testSide) {
    const c = code(f)
    if (imports.get(f)!.some((t) => LOADS_REGISTRY.test(t.replace(/\.[^./]+$/, ''))) || LOADS_BY_PATH.test(c)) reach.set(f, EVERY_OP.test(c))
  }
  for (let grew = true; grew;) {
    grew = false
    for (const f of testSide) {
      for (const t of imports.get(f)!) {
        if (!reach.has(t)) continue
        const every = reach.get(t)! || EVERY_OP.test(code(f))
        if (!reach.has(f) || (every && !reach.get(f))) { reach.set(f, every); grew = true }
      }
    }
  }
  return new Map([...reach].filter(([f]) => /\.test\.tsx?$/.test(f)))
}

/**
 * The op names each op module adds to the live registry. A module is imported after the op
 * modules it imports itself (src/ops/tasks.ts imports src/ops/core.ts), so each op is counted
 * for the module that defines it.
 */
async function opsByModule(members: string[]): Promise<Map<string, string[]>> {
  const isMember = new Set(members)
  const loaded = new Set<string>()
  const order: string[] = []
  const visit = (f: string, seen = new Set<string>()) => {
    if (seen.has(f)) return
    seen.add(f)
    for (const t of relImports(f)) if (t.startsWith('src/ops/')) visit(t, seen)
    if (isMember.has(f) && !loaded.has(f)) { loaded.add(f); order.push(f) }
  }
  for (const m of members) visit(m)
  const reg = await import('../../src/ops/registry.js')
  const names = () => new Set(reg.listOps({ includeDeprecated: true }).map((op: { name: string }) => op.name))
  const out = new Map<string, string[]>()
  let seen = names()
  for (const m of order) {
    await import(path.join(ROOT, m))
    const now = names()
    out.set(m, [...now].filter((n) => !seen.has(n)))
    seen = now
  }
  return out
}

// The op modules, found here by what they do: every file of src/ops that defines an op.
const opsDir = fs.readdirSync(path.join(ROOT, 'src/ops')).filter((f) => /\.ts$/.test(f)).map((f) => `src/ops/${f}`).sort()
const members = opsDir.filter((f) => f !== 'src/ops/registry.ts' && /\bdefineOp\s*\(/.test(code(f)))

/** The op modules a helper of src/ops serves: those importing it, through other helpers. */
function servedBy(helper: string): string[] {
  const importers = new Map<string, string[]>()
  for (const f of opsDir) for (const t of relImports(f)) importers.set(t, [...(importers.get(t) ?? []), f])
  const found = new Set<string>(), seen = new Set([helper])
  for (let frontier = [helper]; frontier.length;) {
    const next: string[] = []
    for (const f of frontier) for (const g of importers.get(f) ?? []) {
      if (seen.has(g) || g === 'src/ops/index.ts') continue
      seen.add(g)
      if (members.includes(g)) found.add(g); else next.push(g)
    }
    frontier = next
  }
  return [...found]
}

describe('a change to an op module selects every test reading its ops through the registry', () => {
  const graph = buildImportGraph(ROOT)
  const quick = new Set(quickUniverse())
  const slow = new Set(slowUniverse())
  let found: Map<string, boolean>
  let ops: Map<string, string[]>
  let selected: ReturnType<typeof registryReaders>
  beforeAll(async () => {
    found = readers()
    selected = registryReaders({ graph, files: testSide, read })
    ops = await opsByModule(members)
  }, 60_000)

  it('finds the op modules, their ops and the readers (the check is not empty)', () => {
    expect(members.length).toBeGreaterThan(30)
    expect(members).toEqual(expect.arrayContaining(['src/ops/host-exec.ts', 'src/ops/org-threads.ts']))
    expect(ops.get('src/ops/host-exec.ts')).toContain('host_exec_read')
    expect(ops.get('src/ops/org-threads.ts')).toContain('thread_update')
    for (const t of ['tests/mcp/answer-shapes.test.ts', 'tests/scripts/generated-ops-docs.test.ts', 'tests/core/org/thread-op-size.test.ts']) expect(found.has(t), t).toBe(true)
  })


  it('the registry loads every op module, so the selection knows each one', () => {
    expect(registryMembers(read).sort(), 'src/ops/index.ts imports exactly the files of src/ops that define an op').toEqual(members)
  })

  it('every op module defines an op the selection sees', () => {
    const empty = members.filter((m) => !(ops.get(m) ?? []).length)
    // A module the registry loads that defines no op (a side-effect helper) reaches no reader.
    expect(empty.filter((m) => /defineOp\s*\(/.test(read(m))), 'an op module whose ops come out empty').toEqual([])
  })

  it('each op module reaches each of its readers', () => {
    const missed: string[] = []
    for (const m of members) {
      const names = new Set(ops.get(m) ?? [])
      if (!names.size) continue
      const reach = opRegistryReach([m], { root: ROOT, graph, read, readers: selected })
      for (const [t, every] of found) {
        if (!quick.has(t) && !slow.has(t)) continue // e2e and the other own-config dirs: the deep test runs them
        const names_ = [...code(t).matchAll(/['"`]([\w-]+)['"`]/g)].some((x) => names.has(x[1]))
        if ((every || names_) && !reach.has(t)) missed.push(`${m} -> ${t}`)
      }
    }
    expect(missed, 'tests that read a changed op through the registry and that no layer selects').toEqual([])
  })

  it('a helper of a few op modules reaches the readers of their ops', () => {
    // 2026-11-26 review: src/ops/host-exec-shown.ts holds the text and caps host_exec answers with.
    const missed: string[] = []
    let helpers = 0
    for (const h of opsDir.filter((f) => !members.includes(f) && f !== 'src/ops/index.ts')) {
      const served = servedBy(h)
      if (!served.length || served.length > HELPER_MAX_MODULES) continue
      helpers++
      const names = new Set(served.flatMap((m) => ops.get(m) ?? []))
      const reach = opRegistryReach([h], { root: ROOT, graph, read, readers: selected })
      for (const [t, every] of found) {
        if (!quick.has(t) && !slow.has(t)) continue
        if ((every || [...code(t).matchAll(/['"`]([\w-]+)['"`]/g)].some((x) => names.has(x[1]))) && !reach.has(t)) missed.push(`${h} -> ${t}`)
      }
    }
    expect(helpers).toBeGreaterThan(5)
    expect(missed, 'tests reading an op whose helper changed, which no layer selects').toEqual([])
    expect(opRegistryReach(['src/ops/host-exec-shown.ts'], { root: ROOT, graph, read, readers: selected }).has('tests/mcp/answer-shapes.test.ts')).toBe(true)
  })

  it('the layers run them: the land layer all, the local layer the quick ones and the slow ones naming the op', () => {
    for (const [m, reds] of [['src/ops/host-exec.ts', ['tests/mcp/answer-shapes.test.ts']], ['src/ops/org-threads.ts', ['tests/scripts/generated-ops-docs.test.ts', 'tests/core/org/thread-op-size.test.ts']]] as const) {
      const reach = opRegistryReach([m], { root: ROOT, graph, read, readers: selected })
      const opts = { graph, opReaders: () => reach, namedBy: () => new Set<string>() }
      const land = landLayer([m], opts), local = localLayer([m], opts)
      const has = (l: { files: string[]; slowFiles: string[] }, f: string) => l.files.includes(f) || l.slowFiles.includes(f)
      for (const r of reds) { expect(has(land, r), `land ${m} -> ${r}`).toBe(true); expect(has(local, r), `local ${m} -> ${r}`).toBe(true) }
      for (const [t, why] of reach) {
        if (quick.has(t) || slow.has(t)) expect(has(land, t), `land ${m} -> ${t}`).toBe(true)
        if (slow.has(t) && why === READS_CHANGED_OP) expect(local.slowFiles, `local ${m} -> ${t}`).toContain(t)
      }
    }
  })
})
