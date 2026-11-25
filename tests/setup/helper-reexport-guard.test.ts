/**
 * A test helper that passes a name on (`export { x } from './y.js'`) and also calls it itself must
 * import it too: the re-export binds nothing in the file. tsc does not type-check tests/, so such a
 * helper fails only when a test runs it (2026-11-25: tests/helpers/host-call-rig.ts called a
 * re-exported waitFor; the deep test's host-call-entry twins all failed with "waitFor is not defined").
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../helpers')

const nameOf = (part: string) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()

/** Each re-exported name a file calls outside its export lines without importing it. */
function unbound(src: string): string[] {
  const reexported = new Set<string>()
  const imported = new Set<string>()
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gm)) {
    for (const part of m[1]!.split(',')) if (part.trim() && !part.trim().startsWith('type ')) reexported.add(nameOf(part))
  }
  for (const m of src.matchAll(/^import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+(\w+))?\s*from/gm)) {
    if (m[1]) imported.add(m[1])
    if (m[3]) imported.add(m[3])
    for (const part of (m[2] ?? '').split(',')) if (part.trim()) imported.add(nameOf(part))
  }
  const body = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"].*$/gm, '')
  return [...reexported].filter((n) => !imported.has(n) && new RegExp(`\\b${n}\\s*\\(`).test(body))
}

describe('test helpers bind what they re-export and call', () => {
  it('finds the 2026-11-25 shape', () => {
    expect(unbound("export { waitFor } from './poll-wait.js'\nawait waitFor(() => true)\n")).toEqual(['waitFor'])
    expect(unbound("import { waitFor } from './poll-wait.js'\nexport { waitFor } from './poll-wait.js'\nawait waitFor(() => true)\n")).toEqual([])
    expect(unbound("export { waitFor } from './poll-wait.js'\n")).toEqual([])
  })

  it('no helper calls a name it only re-exports', () => {
    const bad: string[] = []
    for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      for (const n of unbound(fs.readFileSync(path.join(DIR, name), 'utf8'))) bad.push(`tests/helpers/${name}: ${n}`)
    }
    expect(bad).toEqual([])
  })
})
