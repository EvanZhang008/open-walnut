import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The binary matrix runs the release rehearsal inside bare Linux images with only
// the files scripts/binary-matrix.sh and scripts/binary-old-kernel.sh copy in:
// package.json, scripts/ and the mock CLI. No src/, no node_modules. A static
// import outside that set fails every image before the rehearsal starts
// (2026-10-28: scripts/desktop-smoke.mjs imported ../src/lib/account.ts). The mock
// CLI runs as its own process, so its imports count too (2026-10-28: it began
// importing ./mock-claude-flags.mjs, and every session in every image failed).
const ROOT = path.resolve(__dirname, '../..')
const MOCK = ['tests/providers/mock-claude.mjs', 'tests/providers/mock-claude-flags.mjs']
const SHIPPED = ['package.json', 'scripts', ...MOCK]
const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm

function staticImports(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec))
      else bare.add(spec)
    }
  }
  walk(entry)
  return { files: [...seen].map((f) => path.relative(ROOT, f)), bare: [...bare] }
}

describe('the release rehearsal runs from the files the binary matrix ships', () => {
  it('both matrix scripts copy package.json, scripts/ and the mock CLI', () => {
    for (const script of ['scripts/binary-matrix.sh', 'scripts/binary-old-kernel.sh']) {
      expect(fs.readFileSync(path.join(ROOT, script), 'utf8'), script).toContain(SHIPPED.join(' '))
    }
  })

  for (const [what, entry, min] of [
    ['the rehearsal', 'scripts/release-rehearsal/run.mjs', 5],
    ['the mock CLI', MOCK[0], 1],
  ] as const) {
    it(`every module ${what} loads at start is one of them, or a runtime builtin`, () => {
      const { files, bare } = staticImports(path.join(ROOT, entry))
      expect(files.length).toBeGreaterThan(min)
      const outside = files.filter((f) => !SHIPPED.some((s) => f === s || f.startsWith(`${s}/`)))
      expect(outside).toEqual([])
      expect(bare.filter((s) => !s.startsWith('node:') && !s.startsWith('bun:'))).toEqual([])
    })
  }
})
