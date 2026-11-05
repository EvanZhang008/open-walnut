/**
 * One spec at a time holds one shared thing of a fixture server (spec-lock).
 *
 * Playwright runs other files against the same fixture server at once (`fullyParallel`), and
 * serial within a file never covers that. A spec that drives something the whole server shares
 * (the panel count, the list of waiting approvals) holds that thing's lock:
 *
 *  - a serial file holds it for the whole file (its tests build on each other);
 *  - any other file holds it per test, so its tests spread over workers never wait on each other.
 *
 * A mkdir lock keyed by the fixture port, as layout-record-restart.spec.ts does: the holder's pid
 * is written inside, a dead holder's lock is broken, and the same worker taking it again (a file
 * whose release never ran) is no wait. Time spent waiting is added to the hook's or test's own
 * timeout, and kept there across a later test.setTimeout of the test (wait-budget.ts), so a queue
 * never eats a test's budget.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '@playwright/test'
import { waitOutsideBudget } from './wait-budget'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const MAX_WAIT_MS = 25 * 60_000
const STALE_MS = 40 * 60_000

export interface SpecLock {
  acquire(): Promise<void>
  release(): void
  /** Hold the lock for this file (serial) or for each test (any other file). */
  hold(scope: 'file' | 'test'): void
}

/** The lock named `name` on this fixture port. */
export function specLock(name: string): SpecLock {
  const lock = path.join(os.tmpdir(), `walnut-${name}-spec-${TEST_PORT}.lock`)
  const holder = (): number | null => {
    try { return Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')) || null } catch { return null }
  }
  const acquire = async (): Promise<void> => {
    const t0 = Date.now()
    // The wait is kept out of the test's time limit, a later test.setTimeout of its own included.
    await waitOutsideBudget(test.info(), MAX_WAIT_MS, async () => {
      for (;;) {
        try {
          fs.mkdirSync(lock)
          fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
          return
        } catch { /* held */ }
        const pid = holder()
        if (pid === process.pid) return
        try {
          let alive = pid !== null && pid > 1
          // Signal 0 only asks whether the holder still runs; it sends nothing.
          if (alive) { try { process.kill(pid!, 0) } catch { alive = false } }
          if (!alive || Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true })
        } catch { /* racing the holder's release */ }
        if (Date.now() - t0 > MAX_WAIT_MS) throw new Error(`${name} lock still held by pid ${pid}: ${lock}`)
        await new Promise((r) => setTimeout(r, 500))
      }
    })
  }
  const release = (): void => {
    if (holder() === process.pid) fs.rmSync(lock, { recursive: true, force: true })
  }
  process.once('exit', release)
  return {
    acquire,
    release,
    hold(scope) {
      if (scope === 'file') {
        test.beforeAll(acquire)
        test.afterAll(release)
      } else {
        test.beforeEach(acquire)
        test.afterEach(release)
      }
    },
  }
}
