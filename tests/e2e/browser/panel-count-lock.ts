/**
 * One spec at a time drives the app-wide panel count (`ui.session_panels`) on a fixture server.
 *
 * The count is one config value the whole server shares, and `fullyParallel` runs other files
 * against the same server at once: a spec that set 3 and counted columns read 4, or its saved
 * count read 2, because another file's `setPanelMode` landed in between (2026-11-03, CI shard 11:
 * session-panel-lock-grant failed twice while session-panel-count ran on the next worker).
 * Serial within a file never covered that. Every spec that writes the count calls
 * `holdPanelCountLock()` once at its top level; tests/web/panel-count-lock-guard.test.ts fails on
 * one that writes it without.
 *
 *  - a serial file holds it for the whole file (its tests build on each other's count);
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
const LOCK = path.join(os.tmpdir(), `walnut-panel-count-spec-${TEST_PORT}.lock`)
const MAX_WAIT_MS = 25 * 60_000
const STALE_MS = 40 * 60_000

function holder(): number | null {
  try { return Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8')) || null } catch { return null }
}

async function acquire(): Promise<void> {
  const t0 = Date.now()
  // The wait is kept out of the test's time limit, a later test.setTimeout of its own included.
  await waitOutsideBudget(test.info(), MAX_WAIT_MS, async () => {
    for (;;) {
      try {
        fs.mkdirSync(LOCK)
        fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid))
        return
      } catch { /* held */ }
      const pid = holder()
      if (pid === process.pid) return
      try {
        let alive = pid !== null && pid > 1
        // Signal 0 only asks whether the holder still runs; it sends nothing.
        if (alive) { try { process.kill(pid!, 0) } catch { alive = false } }
        if (!alive || Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true })
      } catch { /* racing the holder's release */ }
      if (Date.now() - t0 > MAX_WAIT_MS) throw new Error(`panel count lock still held by pid ${pid}: ${LOCK}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  })
}

function release(): void {
  if (holder() === process.pid) fs.rmSync(LOCK, { recursive: true, force: true })
}

process.once('exit', release)

/** Hold the fixture's panel count for this file (serial) or for each test (any other file). */
export function holdPanelCountLock(scope: 'file' | 'test'): void {
  if (scope === 'file') {
    test.beforeAll(acquire)
    test.afterAll(release)
  } else {
    test.beforeEach(acquire)
    test.afterEach(release)
  }
}
