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
 */
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

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
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

function offenders(dirs: string[], patterns: Record<string, RegExp>): string[] {
  const found: string[] = []
  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      if (path.relative(ROOT, file).split(path.sep).join('/') === NODE_ARCHIVE) continue
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

  it('no script or bin entry loads better-sqlite3 or node-pty', () => {
    expect(offenders(['scripts', 'bin'], NODE_ONLY)).toEqual([])
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
    // Words in prose are not loads.
    expect(NODE_ONLY['better-sqlite3'].test('// the better-sqlite3 API the code was written against')).toBe(false)
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
})
