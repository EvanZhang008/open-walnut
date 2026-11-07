/**
 * The repo's import graph, read statically, for choosing which tests a change needs
 * (scripts/test-layers.mjs). No vitest and no transforms: one regex pass over every code file
 * under src/, web/src/, tests/, packages/ and scripts/, resolving relative imports, the quick
 * tier's aliases (@/, @open-walnut/*), package.json "imports" (#ws) and workspace packages.
 *
 * Ported from the land queue's land-reach.mjs so the selection follows the commit being tested
 * instead of the land script's copy. `testsWithin(changed, depth)` answers "which test files
 * import a changed file within `depth` import steps", which is the question the land layer asks:
 * depth 1 is the tests that import the changed module directly.
 */
import fs from 'node:fs'
import path from 'node:path'

const EXT = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx']
const SKIP = new Set(['node_modules', 'dist', 'coverage', 'ios-native', 'desktop', 'build'])
const SCAN = ['src', 'web/src', 'tests', 'packages', 'scripts']
const Q = '["\\x27`]'
// import/export ... from "x", import("x"), import "x", require("x"), vi.mock("x"): any quote kind.
const IMPORT = new RegExp(
  `(?:import|export)\\s[^;"\\x27\`]*?from\\s*${Q}([^"\\x27\`]+)${Q}|import\\s*\\(\\s*${Q}([^"\\x27\`]+)${Q}\\s*\\)|import\\s+${Q}([^"\\x27\`]+)${Q}|require\\(\\s*${Q}([^"\\x27\`]+)${Q}\\s*\\)|vi\\.(?:mock|doMock|importActual)\\(\\s*${Q}([^"\\x27\`]+)${Q}`,
  'g',
)

export const isTestFile = (p) => /\.test\.tsx?$/.test(p)

function walk(dir, out) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
}

/** The quick config's aliases, read as text (importing a vitest config here would load vitest). */
function readAliases(root) {
  const out = []
  const cfg = path.join(root, 'vitest.quick.config.ts')
  if (fs.existsSync(cfg)) {
    const re = /["\x27]([@#][^"\x27]*)["\x27]\s*:\s*path\.resolve\(\s*import\.meta\.dirname\s*,\s*["\x27]([^"\x27]+)["\x27]\s*\)/g
    for (const m of fs.readFileSync(cfg, 'utf8').matchAll(re)) out.push([m[1], path.join(root, m[2])])
  }
  try {
    const imp = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).imports || {}
    for (const [k, v] of Object.entries(imp)) {
      const t = typeof v === 'string' ? v : v && (v.bun || v.import || v.default)
      if (typeof t === 'string' && t.startsWith('.')) out.push([k, path.join(root, t)])
    }
  } catch { /* no imports map */ }
  let pk = []
  try { pk = fs.readdirSync(path.join(root, 'packages')) } catch { /* no workspaces */ }
  for (const d of pk) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'packages', d, 'package.json'), 'utf8'))
      if (j.name) out.push([j.name, path.join(root, 'packages', d), j.exports || null])
    } catch { /* not a package */ }
  }
  return out
}

/** Build the reverse import graph once; returns helpers over it. */
export function buildImportGraph(root) {
  const all = []
  for (const d of SCAN) walk(path.join(root, d), all)
  const known = new Set(all) // any file can be imported (?raw, .json); only code files are read
  const code = all.filter((p) => EXT.some((x) => p.endsWith(x)) && !p.endsWith('.d.ts'))
  const aliases = readAliases(root)

  const first = (cands) => {
    for (const base of cands) {
      const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '')
      for (const t of [base, ...EXT.map((x) => stem + x), ...EXT.map((x) => path.join(base, 'index' + x))]) if (known.has(t)) return t
    }
    return null
  }
  const pkgTarget = (dir, exportsMap, sub) => {
    let t = exportsMap && typeof exportsMap === 'object' ? exportsMap[sub ? './' + sub : '.'] : null
    if (t && typeof t === 'object') t = t.bun || t.import || t.default || t.types
    const c = []
    if (typeof t === 'string') { c.push(path.join(dir, t)); c.push(path.join(dir, t.replace(/^\.\/dist\//, './src/'))) }
    c.push(path.join(dir, 'src', sub || 'index'))
    return first(c)
  }
  const resolve = (from, specIn) => {
    const spec = specIn.startsWith('#') ? specIn : specIn.replace(/\?.*$/, '')
    if (spec.startsWith('.')) return first([path.resolve(path.dirname(from), spec)])
    for (const [k, v, ex] of aliases) {
      if (ex !== undefined) {
        if (spec === k) return pkgTarget(v, ex, '')
        if (spec.startsWith(k + '/')) return pkgTarget(v, ex, spec.slice(k.length + 1))
        continue
      }
      if (spec === k) return first([v])
      if (k === '@' ? spec.startsWith('@/') : spec.startsWith(k + '/')) return first([path.join(v, spec.slice(k.length + 1))])
    }
    return null
  }

  const importers = new Map()
  for (const f of code) {
    let src
    try { src = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const m of src.matchAll(IMPORT)) {
      const t = resolve(f, m[1] || m[2] || m[3] || m[4] || m[5])
      if (!t || t === f) continue
      if (!importers.has(t)) importers.set(t, new Set())
      importers.get(t).add(f)
    }
  }

  /** Test files (repo-relative) within `depth` import steps of each changed file, with their step. */
  function testsWithin(changed, depth) {
    const best = new Map()
    for (const rel of changed) {
      const start = path.join(root, rel)
      if (!known.has(start)) continue
      const level = new Map([[start, 0]])
      let frontier = [start]
      for (let i = 1; frontier.length && i <= depth; i++) {
        const next = []
        for (const f of frontier) for (const g of importers.get(f) || []) if (!level.has(g)) { level.set(g, i); next.push(g) }
        frontier = next
      }
      for (const [p, l] of level) {
        if (!isTestFile(p) || l === 0) continue
        const r = path.relative(root, p)
        if (!best.has(r) || best.get(r) > l) best.set(r, l)
      }
    }
    return best
  }

  return { testsWithin, importerCount: (rel) => (importers.get(path.join(root, rel)) || new Set()).size }
}
