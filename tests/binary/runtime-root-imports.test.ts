/**
 * The compiled walnut file defines `import.meta.url` as a global that
 * src/binary/runtime-root.ts sets when it runs. Everything runtime-root imports
 * statically is evaluated BEFORE that, so a module in that chain that reads
 * `import.meta.url` gets undefined and the file crashes at start
 * (2026-11-14: first-run.ts imported config-history.ts for one constant, which
 * pulled in the logger and constants; every deploy failed its self-test).
 *
 * This walks the static, non-type imports from runtime-root.ts and fails on any
 * module in that chain that reads `import.meta.url`. Take a constant from a leaf
 * module, or import the heavy module with `await import()` inside a function.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(__dirname, '../..')
const ENTRY = 'src/binary/runtime-root.ts'
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm

function resolve(from: string, spec: string): string | null {
  const base = path.join(path.dirname(from), spec).replace(/\.js$/, '')
  for (const ext of ['.ts', '.tsx', '/index.ts']) {
    if (fs.existsSync(path.join(repo, base + ext))) return base + ext
  }
  return null
}

function closure(entry: string): Map<string, string> {
  const via = new Map<string, string>([[entry, '']])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    const text = fs.readFileSync(path.join(repo, file), 'utf-8')
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = resolve(file, m[1]!)
      if (dep && !via.has(dep)) { via.set(dep, file); queue.push(dep) }
    }
  }
  return via
}

describe('what the compiled file loads before its runtime root is set', () => {
  it('no module runtime-root.ts imports statically reads import.meta.url', () => {
    const via = closure(ENTRY)
    expect(via.size).toBeGreaterThan(5)
    const offenders: string[] = []
    for (const file of via.keys()) {
      const code = fs.readFileSync(path.join(repo, file), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      if (!/import\.meta\.url/.test(code)) continue
      const chain = [file]
      for (let f = via.get(file); f; f = via.get(f)) chain.unshift(f)
      offenders.push(chain.join(' -> '))
    }
    expect(offenders, 'these load before runtime-root.ts sets the bundle URL: take the constant from a leaf module, or import lazily').toEqual([])
  })
})
