/**
 * The compiled file starts from bytecode (scripts/build-binary.mjs compile()):
 * without it every start parsed the whole ~19 MB bundle, about 700 ms of each
 * `walnut` call an agent makes on a host. A rejected bytecode fails open (the
 * file parses and runs, just slowly), so `walnut __selftest` reports it and the
 * release rehearsal requires it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BYTECODE_PROBE_ENV, bytecodeHit } from '../../src/binary/selftest.js'

const repo = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

/** The text of one top-level function in a script, up to the next one. */
function functionText(source: string, name: string): string {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start + 1)
  const next = rest.search(/^(async )?function |^\/\*\*/m)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('bytecodeHit', () => {
  it('sees the bundle load from its bytecode', () => {
    expect(bytecodeHit('[Disk Cache] Cache hit for sourceCode\n[Disk Cache] Cache miss for sourceCode\n')).toBe(true)
  })

  it('treats only misses (builtins and a parsed bundle) as no bytecode', () => {
    expect(bytecodeHit('[Disk Cache] Cache miss for sourceCode\n[Disk Cache] Cache miss for sourceCode\n')).toBe(false)
    expect(bytecodeHit('')).toBe(false)
  })

  it('reads whole lines only', () => {
    expect(bytecodeHit('error: expected "[Disk Cache] Cache hit for sourceCode"\n')).toBe(false)
    expect(bytecodeHit('[Disk Cache] Cache hit for sourceCode\r\n')).toBe(true)
  })

  it('probes with the variable bun reads', () => {
    expect(BYTECODE_PROBE_ENV).toBe('BUN_JSC_verboseDiskCache')
  })
})

describe('build-binary.mjs', () => {
  const script = read('scripts/build-binary.mjs')

  it('compiles ESM bytecode for top-level code only', () => {
    const compile = functionText(script, 'compile')
    expect(compile).toMatch(/bytecode: true/)
    // CommonJS (bun's default with bytecode) has no top-level await, which main.ts uses.
    expect(compile).toMatch(/format: 'esm'/)
    // Depth 0 keeps nearly all of the gain for +5.5 MB; full depth costs +47 MB.
    expect(compile).toMatch(/bytecodeDepth: 0/)
  })

  it('keeps bytecode out of the shared options, which codeReport() bundles without compile', () => {
    expect(functionText(script, 'buildOptions')).not.toMatch(/bytecode/)
  })
})

describe('release rehearsal', () => {
  it('requires the bytecode check on every target', () => {
    expect(read('scripts/release-rehearsal/binary.mjs')).toMatch(/c\.check === 'bytecode'/)
  })
})
