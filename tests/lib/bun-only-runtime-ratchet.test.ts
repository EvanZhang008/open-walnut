/**
 * Ratchet: Walnut's own code runs only on bun (docs/plan/walnut-single-binary.md,
 * "One runtime"). The modules that existed only for Node are gone, and nothing
 * may bring them back:
 *
 *  - better-sqlite3: written on V8's C++ API, it cannot load on bun at all.
 *    SQLite is src/lib/sqlite.ts over bun:sqlite.
 *  - node-pty: loads on bun but never delivers output. The terminal is
 *    src/lib/pty.ts over bun's built-in one.
 *  - esbuild at runtime: the compiled file carries none. Plugin bundling is
 *    src/lib/transpile.ts over Bun.build. Build tools and tests may still use
 *    it (tsup and vite bring their own), so only src/ is checked for it.
 *
 * And bun:sqlite opens only through src/lib/sqlite.ts: on macOS that module
 * loads Walnut's upstream SQLite before the first database opens, and a direct
 * open elsewhere would load Apple's build for the whole process first.
 *
 * Checked in src/, scripts/, bin/ and packages/, and in every shell script.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** `from 'x'`, `import('x')`, and any call naming it (`require(...)`, `req.resolve(...)`), bare, by a subpath, or by a path into node_modules. */
const loads = (name: string): RegExp =>
  new RegExp(`(?:\\bfrom\\s+|\\b[\\w$]+\\(\\s*)['"](?:[^'"]*/node_modules/)?${name}(?:/[^'"]*)?['"]`)

const NODE_ONLY = {
  'better-sqlite3': loads('better-sqlite3'),
  'node-pty': loads('(?:@[\\w.-]+/)?node-pty[\\w.-]*'),
}
const RUNTIME_ONLY = { esbuild: loads('esbuild') }
const BUN_SQLITE = { 'bun:sqlite': loads('bun:sqlite') }
/** The one module that opens bun:sqlite. */
const SQLITE_SHIM = 'src/lib/sqlite.ts'

/** A shell line that loads or installs a Node-only module: `require('...')` in `node -e`, or npm acting on it. */
const SHELL_NODE_ONLY = /\bnpm\s+(?:rebuild|install|i|ci|add)\b[^\n]*\b(?:better-sqlite3|node-pty)/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Build output of the packages is generated from their src/.
    if (entry.name === 'node_modules' || (entry.name === 'dist' && dir.includes(`${path.sep}packages${path.sep}`))) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The Node archive's builder: it installs a published version with that
 * version's own Node and checks the native modules it finds there. It goes with
 * the archives (docs/reference/releasing.md, "Node archives (to be removed)").
 */
const NODE_ARCHIVE = 'scripts/runtime-bundle/build.mjs'

function offenders(dirs: string[], patterns: Record<string, RegExp>, allowed: string[] = [NODE_ARCHIVE]): string[] {
  const found: string[] = []
  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      if (allowed.includes(path.relative(ROOT, file).split(path.sep).join('/'))) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const [name, re] of Object.entries(patterns)) {
        if (re.test(text)) found.push(`${path.relative(ROOT, file).split(path.sep).join('/')} loads ${name}`)
      }
    }
  }
  return found
}

describe('Walnut runs only on bun', () => {
  it('nothing in src/ loads better-sqlite3, node-pty or esbuild', () => {
    expect(offenders(['src'], { ...NODE_ONLY, ...RUNTIME_ONLY })).toEqual([])
  })

  it('no script, bin entry or package loads better-sqlite3 or node-pty', () => {
    expect(offenders(['scripts', 'bin', 'packages'], NODE_ONLY)).toEqual([])
  })

  it('no shell script loads, rebuilds or installs better-sqlite3 or node-pty', () => {
    const scripts = execFileSync('git', ['ls-files', '-z', '--', '*.sh'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(scripts.length).toBeGreaterThan(20)
    const found: string[] = []
    for (const rel of scripts) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue
      fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        if (SHELL_NODE_ONLY.test(line) || Object.values(NODE_ONLY).some((re) => re.test(line))) found.push(`${rel}:${i + 1}`)
      })
    }
    expect(found).toEqual([])
  })

  it(`only ${SQLITE_SHIM} opens bun:sqlite`, () => {
    expect(offenders(['src', 'scripts', 'bin', 'packages'], BUN_SQLITE, [SQLITE_SHIM])).toEqual([])
    // The shim itself still does: the check is looking at the right thing.
    expect(BUN_SQLITE['bun:sqlite'].test(fs.readFileSync(path.join(ROOT, SQLITE_SHIM), 'utf8'))).toBe(true)
  })

  it('the patterns catch every way of loading a module', () => {
    for (const line of [
      "import Database from 'better-sqlite3'",
      "const D = require('better-sqlite3')",
      "import x from '../node_modules/better-sqlite3/lib/index.js'",
      "createRequire(import.meta.url).resolve('better-sqlite3')",
    ]) expect(NODE_ONLY['better-sqlite3'].test(line), line).toBe(true)
    for (const line of ["await import('@homebridge/node-pty-prebuilt-multiarch')", "require('node-pty')"]) {
      expect(NODE_ONLY['node-pty'].test(line), line).toBe(true)
    }
    for (const line of ["const { build } = await import('esbuild')", "import { transform } from 'esbuild'"]) {
      expect(RUNTIME_ONLY.esbuild.test(line), line).toBe(true)
    }
    for (const line of ["import { Database } from 'bun:sqlite'", "const { Database } = require('bun:sqlite')", "await import('bun:sqlite')"]) {
      expect(BUN_SQLITE['bun:sqlite'].test(line), line).toBe(true)
    }
    for (const line of [
      `node -e "new (require('better-sqlite3'))(':memory:').close()" || npm rebuild better-sqlite3`,
      'npm install --no-save @homebridge/node-pty-prebuilt-multiarch',
    ]) expect(SHELL_NODE_ONLY.test(line) || NODE_ONLY['better-sqlite3'].test(line), line).toBe(true)
    // Words in prose are not loads.
    expect(NODE_ONLY['better-sqlite3'].test('// the better-sqlite3 API the code was written against')).toBe(false)
    expect(BUN_SQLITE['bun:sqlite'].test('// SQLite is `bun:sqlite` (src/lib/sqlite.ts)')).toBe(false)
    expect(SHELL_NODE_ONLY.test('echo "so better-sqlite3 compiles and needs Python"')).toBe(false)
  })

  it('package.json depends on none of them at runtime and names bun as its engine', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      engines?: Record<string, string>
      trustedDependencies?: string[]
    }
    const runtime = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
    expect(runtime.filter((name) => /better-sqlite3|node-pty|^esbuild$/.test(name))).toEqual([])
    expect(pkg.trustedDependencies?.filter((name) => /better-sqlite3|node-pty/.test(name))).toEqual([])
    expect(pkg.engines).toEqual({ bun: expect.any(String) })
  })

  it('no package.json script runs through tsx: bun runs TypeScript itself', () => {
    const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    expect(Object.entries(scripts).filter(([, cmd]) => /(^|[\s;&|(])(npx\s+)?tsx\s/.test(cmd))).toEqual([])
    expect(scripts['search:eval']).toBe('bun scripts/search-eval.mjs')
    expect(scripts['search:robustness']).toBe('bun scripts/search-robustness-eval.mjs')
  })
})
