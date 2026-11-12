/**
 * Every module a test mocks still exists. vitest accepts a vi.mock() of a path that is gone
 * without a word, so a test that mocked a removed module went on running the real one in its
 * place (2026-11-12: a banner test still mocked the deleted useIsCloudReplica hook, its component
 * now read the role through useServerRole, and the test failed on a log mock deep in the socket
 * code, red on main). This reads each `vi.mock(` that opens a line in tests/ and resolves its
 * path, `@/` (web/src) and relative ones, the way the bundler would.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
/**
 * Mocks of a path that is gone, kept as they are: pointing them at the module's new home
 * changes what the test runs (the real cwd check runs today, and these tests pass with it).
 * Shrink only: drop the mock, or move it together with what the test expects.
 */
const KNOWN_STALE = new Set([
  'tests/providers/spawn-window-send-barrier.test.ts: ../../src/utils/cwd-check.js',
  'tests/providers/effort-pick-during-spawn.test.ts: ../../src/utils/cwd-check.js',
])

const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) testFiles(p, out)
    else if (/\.(test|spec)\.(ts|tsx|mts)$/.test(e.name)) out.push(p)
  }
  return out
}

function resolves(spec: string, fromFile: string): boolean {
  const base = spec.startsWith('@/')
    ? path.join(ROOT, 'web', 'src', spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec)
  const stem = base.replace(/\.(js|mjs|cjs)$/, '')
  return [base, stem].some((b) => EXTS.some((x) => fs.existsSync(b + x)))
}

/** The module paths a file mocks: `vi.mock('<path>'` at the start of a line, `@/` or relative. */
export function mockedPaths(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^\s*vi\.(?:mock|doMock)\(\s*['"]((?:@\/|\.{1,2}\/)[^'"]+)['"]/gm)) out.push(m[1]!)
  return out
}

describe('mocked modules exist', () => {
  it('every vi.mock of a web or relative path names a file that is there', () => {
    const missing: string[] = []
    for (const file of testFiles(path.join(ROOT, 'tests'))) {
      for (const spec of mockedPaths(fs.readFileSync(file, 'utf8'))) {
        const row = `${path.relative(ROOT, file)}: ${spec}`
        if (!resolves(spec, file) && !KNOWN_STALE.has(row)) missing.push(row)
      }
    }
    expect(missing).toEqual([])
  })

  it('reads a mock that opens a line, and not one quoted inside a string', () => {
    expect(mockedPaths("vi.mock('@/hooks/useServerRole', () => ({}))\n  vi.mock('../x.js')")).toEqual(['@/hooks/useServerRole', '../x.js'])
    expect(mockedPaths("w('a.test.ts', \"vi.mock('@/c')\")\nvi.mock('node:fs')")).toEqual([])
  })
})
