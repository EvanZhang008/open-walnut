/**
 * Every caller types sharp through src/core/components/sharp-type.ts, the one form
 * that type-checks under both sharp 0.34 (`export =`) and 0.35 (`export default`).
 * `typeof import('sharp')` is the module under one and has no `.default` under the
 * other, so a checkout with an older node_modules failed its type check on main.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ALLOWED = path.join('src', 'core', 'components', 'sharp-type.ts')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') sources(p, out) } else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('sharp type', () => {
  it('no file but sharp-type.ts names the sharp module\'s type', () => {
    const offenders = ['src', 'scripts'].flatMap((d) => sources(path.join(ROOT, d)))
      .map((f) => path.relative(ROOT, f))
      .filter((f) => f !== ALLOWED)
      .filter((f) => /import\(\s*['"]sharp['"]\s*\)\s*(\.default)?\s*[;,)>\]]|import type \w+ from ['"]sharp['"]/.test(
        fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/await import\(\s*['"]sharp['"]\s*\)/g, '')))
    expect(offenders).toEqual([])
  })
})
