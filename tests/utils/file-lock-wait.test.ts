/**
 * `withFileLock`'s wait: a caller that can come back later (the revoke queue's
 * drain, judging under the auth lock) passes a short one, and gets a
 * FileLockTimeoutError instead of waiting out a holder that may be waiting on
 * it. The default wait, and its message, are as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileLockTimeoutError, withFileLock } from '../../src/utils/file-lock.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-lock-wait-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('withFileLock timeoutMs', () => {
  it('a short wait on a held lock gives up quickly, and its fn never runs', async () => {
    const file = path.join(dir, 'data.json')
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const holding = new Promise<void>((r) => { acquired = r })
    const holder = withFileLock(file, async () => { acquired(); await held })
    // Only once the holder is inside its lock: a try started earlier can win the
    // lock on a loaded machine.
    await holding
    let ran = false
    const t0 = Date.now()
    const err = await withFileLock(file, async () => { ran = true }, { timeoutMs: 60 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileLockTimeoutError)
    expect((err as Error).message).toBe(`File lock timeout after 60ms: ${file}.lock`)
    // Far under the default wait (10 s), with room for a loaded machine.
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(ran).toBe(false)
    release()
    await holder
    // Free again: the same short wait takes it at once.
    expect(await withFileLock(file, async () => 'mine', { timeoutMs: 60 })).toBe('mine')
  })

  it('a timeout is still an Error, so callers catching Error see it as before', () => {
    const err = new FileLockTimeoutError('/x.lock', 10_000)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('File lock timeout after 10000ms: /x.lock')
  })
})
