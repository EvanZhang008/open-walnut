/**
 * Every Bun module src/ loads (`bun:ffi`, `bun:sqlite`, ...) is external to the server bundle.
 * esbuild cannot resolve them, so one left out fails `web:build` and every production deploy after
 * it (2026-11-22: the leader permit's system clock required 'bun:ffi', and the Mac's deploy failed).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLE_EXTERNAL } from '../../scripts/build-cli-fast.mjs'

const SRC = path.join(__dirname, '..', '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('Bun modules in the server bundle', () => {
  it('each one src/ requires or imports is in BUNDLE_EXTERNAL', () => {
    const named = new Map<string, string>()
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:require|import)\(\s*['"](bun:[a-z]+)['"]|from\s+['"](bun:[a-z]+)['"]/g)) {
        named.set(m[1] ?? m[2], path.relative(SRC, file))
      }
    }
    expect(named.has('bun:ffi'), 'the scan finds the known loaders').toBe(true)
    const missing = [...named].filter(([mod]) => !BUNDLE_EXTERNAL.includes(mod)).map(([mod, file]) => `${mod} (${file})`)
    expect(missing, 'add each to BUNDLE_EXTERNAL in scripts/build-cli-fast.mjs').toEqual([])
  })
})
