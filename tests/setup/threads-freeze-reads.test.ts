/**
 * Every test run freezes the threads readers share (tests/setup/threads-freeze-reads.ts), and a
 * catch-all on a read path lets the frozen write through in tests (src/core/org/frozen-read.ts):
 *   1. every vitest config that loads the app's setup files loads this one too;
 *   2. this run has it on (unless the person running it opted out with WALNUT_THREADS_FREEZE_READS=0);
 *   3. rethrowFrozenWrite rethrows the TypeError of every kind of frozen write, and nothing else;
 *   4. the three catch-alls that would hide one (nodeView, keepAskOnThread, user-status-sync
 *      `safely`) call it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isFrozenWrite, rethrowFrozenWrite } from '../../src/core/org/frozen-read.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('threads reads frozen in every test run', () => {
  it('every vitest config with the shared setup files loads the freeze', () => {
    const configs = fs.readdirSync(ROOT).filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f))
    const missing = configs.filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return src.includes('tests/setup/quiet-retry-off.ts') && !src.includes('tests/setup/threads-freeze-reads.ts')
    })
    expect(configs.length).toBeGreaterThan(5)
    expect(missing).toEqual([])
  })

  it('is on in this run unless it was turned off for it', () => {
    if (process.env.WALNUT_THREADS_FREEZE_READS === '0') return
    expect(process.env.WALNUT_THREADS_FREEZE_READS).toBe('1')
  })

  it('a frozen write of every kind is rethrown; any other error is not', () => {
    const o = Object.freeze({ a: 1, list: Object.freeze([1, 2]), box: Object.freeze({}) }) as any
    const writes: Array<() => unknown> = [
      () => { o.a = 2 }, () => { o.b = 2 }, () => { delete o.a },
      () => o.list.push(3), () => o.list.pop(), () => o.list.sort(), () => o.list.splice(0, 1),
      () => { o.list.length = 0 }, () => Object.assign(o.box, { x: 1 }),
    ]
    for (const write of writes) {
      let caught: unknown
      try { write() } catch (err) { caught = err }
      expect(isFrozenWrite(caught)).toBe(true)
      expect(() => rethrowFrozenWrite(caught)).toThrow(TypeError)
    }
    for (const other of [new TypeError('x is not a function'), new Error('read only file system'), 'readonly', null]) {
      expect(() => rethrowFrozenWrite(other)).not.toThrow()
    }
  })

  it('the catch-alls on threads read paths let a frozen write through', () => {
    const calls = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('rethrowFrozenWrite(err)').length - 1
    expect(calls('src/core/org/threads-store.ts')).toBeGreaterThanOrEqual(1)
    expect(calls('src/core/org/thread-report-ask.ts')).toBeGreaterThanOrEqual(1)
    expect(calls('src/core/user-status-sync.ts')).toBeGreaterThanOrEqual(1)
  })
})
