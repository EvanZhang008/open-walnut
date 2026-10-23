/**
 * Run fake timers until a condition holds, while the code under test also does
 * real I/O (an fs read, a sqlite query) between them.
 *
 * The usual pump, `advanceTimersByTimeAsync(250)` then one `setImmediate` hop,
 * treats that hop as a turn of real I/O. On Node it is one (a hop is a full
 * libuv loop turn, and an fs call lands within a few hops); on bun a hop costs
 * about 1 us and one fs.stat takes tens to thousands of them, so a fake budget of
 * a million ms was spent in a few real ms while a startup sweep was still
 * reading the test home, and the timers it went on to set were never fired.
 *
 * Here fake time only moves to fire a timer: each step first gives real work a
 * real macrotask (a timer the fakes cannot capture, which runs after I/O is
 * polled on both runtimes), and when no fake timer is pending the code is busy
 * with real work, so the pump waits instead of spending its budget.
 */
import { vi } from 'vitest'

// Captured at import, before a test installs fake timers over the globals.
const realSetTimeout = globalThis.setTimeout
const realNow = performance.now.bind(performance)

const realTurn = (): Promise<void> => new Promise((resolve) => { realSetTimeout(resolve, 0) })

/** The fake clock's time in ms (fake timers must be on). */
export function fakeNow(): number {
  const now = vi.getMockedSystemTime()
  if (!now) throw new Error('fakeNow: fake timers are not installed')
  return now.getTime()
}

/**
 * Fire fake timers in order until `cond()` holds, `maxFakeMs` of fake time has
 * passed, or `maxRealMs` of real time has. Returns the fake ms that passed.
 */
export async function pumpFakeTimers(cond: () => boolean, maxFakeMs: number, maxRealMs = 30_000): Promise<number> {
  const start = fakeNow()
  const deadline = realNow() + maxRealMs
  while (!cond() && fakeNow() - start < maxFakeMs && realNow() < deadline) {
    await realTurn()
    if (cond() || vi.getTimerCount() === 0) continue
    await vi.advanceTimersToNextTimerAsync()
  }
  return fakeNow() - start
}
