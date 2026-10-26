/**
 * The test-side files that reach a changed file WITHOUT importing it, for
 * scripts/test-changed.mjs.
 *
 * Narrow mode asks vitest which tests' import graph reaches the diff. Many tests
 * here reach code another way: they start it as a child process by path
 * (`spawn(bun, [path.join(ROOT, 'src/providers/daemon-standalone.ts')])`, a fixture
 * child, a shell script) or read it as text (a ratchet). Those edges are not in
 * vitest's graph, so a change to the daemon alone selects none of the twins
 * suites that run it (measured on 2026-10-24: 0 of 92 slow files, against 18).
 *
 * This finds them with a cheap static scan, no vitest and no transforms:
 *   1. every code file under src/, scripts/ and tests/, and its RELATIVE imports;
 *   2. every repo file a file under tests/ names in its text, import specifiers
 *      left out: `src/x.ts`, `../../scripts/x.sh`, a `child.ts` beside it, or a
 *      tail such as `dev-prod.sh` that exactly one tracked file ends with;
 *   3. from the changed files, walk "is imported by" edges; a tests/ file that
 *      NAMES a file on that walk is returned.
 * test-changed.mjs hands them to `vitest related` beside the changed files, and
 * vitest then keeps every tier test whose own import graph reaches one of them.
 * The scan only ever adds tests. A reference it cannot see (a name built at run
 * time, a whole directory a ratchet walks) leaves vitest's own selection as it is.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCAN_DIRS = ['src', 'scripts', 'tests']
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage'])
// A relative module specifier after from / import / import( / require( / export * from.
const IMPORT_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.\.?\/[^'"\n]+)['"]/g
// Any module specifier, removed before the path scan: an import is already an edge
// in vitest's own graph. vi.mock and importActual name imported modules too.
const ANY_IMPORT_RE = /(?:\bfrom|\bimport|\brequire|\bvi\.(?:mock|doMock|unmock|importActual|importMock))\s*\(?\s*['"][^'"\n]+['"]/g
// A quoted path with an extension: `src/a/b.ts`, `../../scripts/x.sh`, `child.ts`.
const NAMED_RE = /['"`]((?:\.\.?\/)*[\w@+-][\w@.+/-]*\.[A-Za-z][A-Za-z0-9]*)['"`]/g

/** Repo-relative paths of the code files under src/, scripts/ and tests/. */
export function listCode(root) {
  const out = []
  const walk = (rel) => {
    let entries
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && CODE.test(e.name)) out.push(child)
    }
  }
  SCAN_DIRS.forEach(walk)
  return out
}

/** Every tracked file, '' when git cannot answer (the scan then knows only code files). */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf-8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** The file a relative specifier resolves to, the way TS and bun map `.js` to `.ts`. */
export function resolveSpecifier(from, spec, has) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  const tries = [base]
  if (base.endsWith('.js')) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'))
  else if (base.endsWith('.mjs')) tries.push(base.replace(/\.mjs$/, '.mts'))
  else if (base.endsWith('.cjs')) tries.push(base.replace(/\.cjs$/, '.cts'))
  else if (!CODE.test(base)) tries.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`)
  return tries.find((t) => has(t)) ?? null
}

/** A lookup over repo files: exact paths, and the files each base name belongs to. */
export function fileIndex(paths) {
  const all = new Set(paths)
  const byBase = new Map()
  for (const p of all) {
    const b = path.posix.basename(p)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(p)
  }
  return { has: (p) => all.has(p), byBase }
}

/** The repo files a tests/ file names in its text, import specifiers left out. */
export function namedPaths(from, text, index) {
  const out = new Set()
  const pick = (p) => (index.has(p) ? p : p.endsWith('.js') && index.has(p.replace(/\.js$/, '.ts')) ? p.replace(/\.js$/, '.ts') : null)
  for (const m of text.replace(ANY_IMPORT_RE, '').matchAll(NAMED_RE)) {
    const raw = m[1]
    const tail = raw.replace(/^(?:\.\.?\/)+/, '')
    const beside = path.posix.normalize(path.posix.join(path.posix.dirname(from), raw))
    let hit = pick(tail) ?? (beside.startsWith('..') ? null : pick(beside))
    if (!hit) {
      // A tail only one tracked file ends with: `dev-prod.sh` from path.join pieces.
      const ends = (index.byBase.get(path.posix.basename(tail)) ?? []).filter((p) => p === tail || p.endsWith(`/${tail}`))
      if (ends.length === 1) hit = ends[0]
    }
    if (hit && hit !== from) out.add(hit)
  }
  return out
}

/**
 * The tests/ files that name a changed file, or a module whose imports reach one,
 * leaving out the changed files themselves. `files`, `tracked` and `read` are
 * injectable for tests.
 */
export function pathReferenceSources(root, changed, {
  files = listCode(root),
  tracked = trackedFiles(root),
  read = (f) => fs.readFileSync(path.join(root, f), 'utf-8'),
} = {}) {
  const code = new Set(files)
  const has = (f) => code.has(f)
  const index = fileIndex([...tracked, ...files, ...changed])
  const importedBy = new Map()
  const namers = new Map() // named file -> the tests/ files naming it
  for (const f of files) {
    let text
    try { text = read(f) } catch { continue }
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(f, m[1], has)
      if (!target || target === f) continue
      if (!importedBy.has(target)) importedBy.set(target, new Set())
      importedBy.get(target).add(f)
    }
    if (!f.startsWith('tests/')) continue
    for (const p of namedPaths(f, text, index)) {
      if (!namers.has(p)) namers.set(p, new Set())
      namers.get(p).add(f)
    }
  }
  // Every file whose import closure holds a changed file, the changed files included.
  const reached = new Set(changed)
  const queue = [...changed]
  while (queue.length) {
    const f = queue.pop()
    for (const importer of importedBy.get(f) ?? []) {
      if (!reached.has(importer)) { reached.add(importer); queue.push(importer) }
    }
  }
  const changedSet = new Set(changed)
  const out = new Set()
  for (const f of reached) for (const namer of namers.get(f) ?? []) if (!changedSet.has(namer)) out.add(namer)
  return [...out].sort()
}
