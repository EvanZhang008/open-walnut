/**
 * Guard: a test that replaces React with a hand-written mock provides every React hook the
 * hooks it runs call.
 *
 * Several suites run a hook (useTasks, useShowPriority, ...) with a `vi.mock` of React that
 * holds only the hooks they needed when written. A hook calls each of its hooks on every
 * render (the rules of hooks), so a new call anywhere down its chain fails every case of the
 * suite: 2026-11-03, useTasks began mirroring its list through useCommittedRef, which writes
 * in a layout effect, and five folder-registry cases failed in CI with
 * `No "useLayoutEffect" export is defined on the ".../react" mock`.
 *
 * The class, enumerated from the source: for each test file with such a mock, every hook it
 * imports from web/src, and every hook those call, followed through web/src imports (a module
 * the test mocks itself is not followed). Each React hook found must be a key of the mock.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '../..')
const WEB_SRC = path.join(ROOT, 'web/src')
const TESTS = path.join(ROOT, 'tests/web')

function resolveModule(spec: string, from: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(WEB_SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null
  base = base.replace(/\.js$/, '')
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (c.startsWith(WEB_SRC) && fs.existsSync(c)) return c
  }
  return null
}

/** Each named import of a file and the module it comes from, `const { a } = await import(...)` included. */
export function namedImports(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/import\s*(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!
      if (name) out.set(name, m[2]!)
    }
  }
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s*:\s*/).pop()!
      if (name) out.set(name, m[2]!)
    }
  }
  return out
}

/** The keys of a test's hand-written React mock, or null when it has none. */
export function reactMockKeys(text: string): Set<string> | null {
  const m = /vi\.mock\(\s*['"]((?:\.\.\/)*web\/node_modules\/react|react)['"]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\(\{([\s\S]*?)\n\}\)\)/.exec(text)
  if (!m) return null
  return new Set([...m[2]!.matchAll(/^\s{2}(\w+)\s*[:,(]/gm)].map((k) => k[1]!))
}

/** React hooks the hooks a test imports from web/src call, down their whole chain. */
export function reactHooksRun(testFile: string, text: string): Set<string> {
  const mocked = new Set([...text.matchAll(/vi\.mock\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!))
  const need = new Set<string>()
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = fs.readFileSync(file, 'utf8')
    const imported = namedImports(src)
    for (const call of new Set([...src.matchAll(/\b(use[A-Z]\w*)\s*[(<]/g)].map((m) => m[1]!))) {
      const spec = imported.get(call)
      if (spec === 'react') need.add(call)
      else if (spec && !mocked.has(spec)) {
        const next = resolveModule(spec, file)
        if (next) walk(next)
      }
    }
  }
  for (const [name, spec] of namedImports(text)) {
    if (!/^use[A-Z]/.test(name) || mocked.has(spec)) continue
    const file = resolveModule(spec, testFile)
    if (file) walk(file)
  }
  return need
}

describe('a hand-written React mock holds every hook the hooks under test call', () => {
  it('finds a hook two levels down and skips a module the test mocks', () => {
    const text = [
      "vi.mock('../../web/node_modules/react', () => ({",
      '  useState: () => [0, () => {}],',
      '}))',
      "const { useTasks } = await import('@/hooks/useTasks')",
    ].join('\n')
    expect(reactMockKeys(text)).toEqual(new Set(['useState']))
    // useTasks calls useCommittedRef, which calls useLayoutEffect.
    expect([...reactHooksRun(path.join(TESTS, 'probe.test.ts'), text)]).toContain('useLayoutEffect')
    // A hook the test mocks itself runs none of its real hooks.
    const mockedHook = `${text}\nvi.mock('@/hooks/useTasks', () => ({ useTasks: () => ({}) }))`
    expect([...reactHooksRun(path.join(TESTS, 'probe.test.ts'), mockedHook)]).toEqual([])
  })

  it('every such mock in tests/web provides them', () => {
    const missing: string[] = []
    let mocks = 0
    for (const name of fs.readdirSync(TESTS).filter((n) => /\.test\.tsx?$/.test(n))) {
      const file = path.join(TESTS, name)
      const text = fs.readFileSync(file, 'utf8')
      const keys = reactMockKeys(text)
      if (!keys) continue
      mocks++
      const lacks = [...reactHooksRun(file, text)].filter((hook) => !keys.has(hook))
      if (lacks.length) missing.push(`tests/web/${name}: ${lacks.join(', ')}`)
    }
    expect(mocks, 'the scan found no React mock at all: the matcher broke').toBeGreaterThan(0)
    expect(missing, 'React hooks the hooks under test call that the React mock lacks').toEqual([])
  })
})
