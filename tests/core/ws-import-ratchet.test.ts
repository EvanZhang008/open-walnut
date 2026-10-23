/**
 * WebSocket import ratchet: Walnut code imports `#ws`, never `ws`.
 *
 * `#ws` (package.json "imports") is the npm `ws` package on both runtimes
 * (src/lib/ws-npm.ts says why). A bare `ws` import is the same package on Node,
 * so nothing fails there, but on bun it is bun's own WebSocket, whose sockets
 * count no bytes: the link checks then judge a slow transfer silent and cut it
 * (host-read-silent-link-e2e on bun, 2026-10-22). This test keeps every import
 * on the seam.
 *
 * The daemon twins are exempt: they are separate programs with their own `ws`
 * (the bun-compiled daemon serves with Bun.serve, the JS fallback requires the
 * package at run time), and they read no byte counters.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const EXEMPT = new Set(['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts'])
const BARE_WS = /\bfrom\s+['"]ws['"]|\bimport\s*\(\s*['"]ws['"]\s*\)|^\s*import\s+['"]ws['"]/m

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('ws import ratchet', () => {
  it('no Walnut module imports the bare `ws` package', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((rel) => !EXEMPT.has(rel))
      .filter((rel) => BARE_WS.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    expect(offenders, 'import from \'#ws\' instead (src/lib/ws-npm.ts says why)').toEqual([])
  })

  it('#ws is the npm package on bun and the package itself on Node', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { imports?: Record<string, unknown> }
    expect(pkg.imports?.['#ws']).toEqual({ bun: './src/lib/ws-npm.ts', default: 'ws' })
    expect(fs.existsSync(path.join(ROOT, 'src/lib/ws-npm.ts'))).toBe(true)
  })
})
