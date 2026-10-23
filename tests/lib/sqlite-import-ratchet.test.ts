/**
 * Ratchet: src/ opens SQLite only through src/lib/sqlite.ts. better-sqlite3 is
 * written on V8's C++ API and cannot load on bun at all, so a direct import,
 * require or resolve of it anywhere else breaks Walnut on bun. Only the module
 * itself and the two places that deal with the Node addon as such may name it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

const ALLOWED = new Set([
  'src/lib/sqlite.ts', // the door: better-sqlite3 itself on Node
  'src/core/native-abi-preflight.ts', // checks and rebuilds the Node addon (skipped on bun)
  'src/core/plugins/plugin-storage.ts', // the Node worker's driver path (bun gets the module file)
])

// `from 'better-sqlite3'`, `import('better-sqlite3')`, and any call naming it
// (`require(...)`, `req(...)`, `createRequire(...).resolve(...)`), by its bare
// name, a subpath, or a path into node_modules.
const LOADS = /(?:\bfrom\s+|\b[\w$]+\(\s*)['"](?:[^'"]*\/node_modules\/)?better-sqlite3(?:\/[^'"]*)?['"]/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('better-sqlite3 is loaded only by src/lib/sqlite.ts', () => {
  it('no other source file imports, requires or resolves it', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => LOADS.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the allowed files still exist (a moved one must be re-listed, not silently dropped)', () => {
    for (const rel of ALLOWED) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
  })
})
