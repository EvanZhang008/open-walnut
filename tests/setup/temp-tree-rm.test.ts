/**
 * The harness makes a test's recursive removal of a temp tree retry
 * (tests/setup/temp-tree-rm.ts). 2026-10-07: two quick-tier tests failed in a
 * beforeEach `fs.rm(WALNUT_HOME, { recursive: true, force: true })` with
 * ENOTEMPTY, because a late writer of the code under test landed a file while
 * the tree was being removed.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TEMP_TREE_RETRIES, callerFile, retryingOptions } from './temp-tree-rm'

const HERE = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(HERE), '../..')
const TMP = fs.realpathSync(os.tmpdir())
const A_TEST = path.join(ROOT, 'tests/web/routes/some.test.ts')

describe('retryingOptions', () => {
  it('adds retries to a test\'s recursive removal of a temp tree', () => {
    expect(retryingOptions(path.join(TMP, 'walnut-test-x'), { recursive: true, force: true }, A_TEST))
      .toEqual({ recursive: true, force: true, ...TEMP_TREE_RETRIES })
    expect(retryingOptions(new URL(`file://${path.join(TMP, 'x')}`), { recursive: true }, A_TEST))
      .toEqual({ recursive: true, ...TEMP_TREE_RETRIES })
    expect(retryingOptions(path.join(TMP, 'x'), { recursive: true }, HERE)).toEqual({ recursive: true, ...TEMP_TREE_RETRIES })
  })

  it('leaves everything else exactly as written', () => {
    const opts = { recursive: true, force: true }
    // Code under test removes its own trees as written: its own race still fails its test.
    expect(retryingOptions(path.join(TMP, 'x'), opts, path.join(ROOT, 'src/core/thing.ts'))).toBe(opts)
    // The harness's own removals, and an unknown caller.
    expect(retryingOptions(path.join(TMP, 'x'), opts, path.join(ROOT, 'tests/setup/tmp-reaper.ts'))).toBe(opts)
    expect(retryingOptions(path.join(TMP, 'x'), opts, null)).toBe(opts)
    // Outside the temp root, not recursive, or retries already chosen.
    expect(retryingOptions('/usr/share/walnut-not-tmp', opts, A_TEST)).toBe(opts)
    const flat = { force: true }
    expect(retryingOptions(path.join(TMP, 'x'), flat, A_TEST)).toBe(flat)
    const chosen = { recursive: true, maxRetries: 0 }
    expect(retryingOptions(path.join(TMP, 'x'), chosen, A_TEST)).toBe(chosen)
    expect(retryingOptions(path.join(TMP, 'x'), undefined, A_TEST)).toBeUndefined()
  })
})

describe('callerFile', () => {
  it('reads the frame that called the wrapper, in either spelling node prints', () => {
    const stack = (frame: string) => `Error\n    at rm (${path.join(ROOT, 'tests/setup/temp-tree-rm.ts')}:70:10)\n    ${frame}\n    at next (/x/y.js:1:1)`
    expect(callerFile(stack(`at Context.<anonymous> (${A_TEST}:35:12)`))).toBe(A_TEST)
    expect(callerFile(stack(`at ${A_TEST}:35:12`))).toBe(A_TEST)
    expect(callerFile(stack(`at file://${A_TEST}:35:12`))).toBe(A_TEST)
    expect(callerFile(stack('at async Promise.all (index 0)'))).toBeNull()
    expect(callerFile(undefined)).toBeNull()
  })

  it('names this file when this file calls it', () => {
    const probe = () => callerFile(new Error().stack)
    expect(probe()).toBe(HERE)
  })
})

describe('in a test', () => {
  // A writer that keeps landing new entries while the tree is removed: without
  // retries the final rmdir sees them and fails with ENOTEMPTY.
  async function raceRemoval(remove: (dir: string) => Promise<void>) {
    const dir = fs.mkdtempSync(path.join(TMP, 'temp-tree-rm-'))
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x')
    let n = 0
    const writer = setInterval(() => { try { fs.writeFileSync(path.join(dir, `late${n++}`), 'x') } catch { /* removed */ } }, 1)
    setTimeout(() => clearInterval(writer), 60)
    try {
      await remove(dir)
    } finally {
      clearInterval(writer)
    }
    await new Promise((r) => setTimeout(r, 20))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  }

  it('a removal through the default import and the named import converges', async () => {
    await raceRemoval((dir) => fsp.rm(dir, { recursive: true, force: true }))
    await raceRemoval((dir) => rm(dir, { recursive: true, force: true }))
  })

  it('every vitest config that reaps temp dirs also loads it', () => {
    for (const cfg of ['vitest.config.ts', 'vitest.e2e.config.ts']) {
      const src = fs.readFileSync(path.join(ROOT, cfg), 'utf8')
      expect(src, cfg).toContain("'tests/setup/temp-tree-rm.ts'")
    }
  })
})
