/**
 * runPeriodic — the mandatory shape for periodic background work (I2).
 *
 * Every recurring maintenance task in the server process gets, by construction:
 *   1. Reentrancy lock — a tick never starts while the previous one is still
 *      running (the health-monitor starvation incident had 6+ concurrent ticks
 *      stacked by a bare setInterval; one slow tick then snowballs forever).
 *   2. Per-tick budget — the fn receives a budget checker; cooperative tasks
 *      abandon remaining phases once exceeded. Exceeding it also logs a warn
 *      so the event-loop monitor's attribution has a paper trail.
 *   3. markCriticalSection — stalls detected while the tick runs are
 *      attributed to the task by name instead of guessed.
 *   4. ±10% jitter — ticks from multiple periodic tasks don't phase-lock.
 *
 * Interval can be adjusted at runtime via the returned handle (adaptive
 * slow-down when there is nothing to do).
 */

import { log } from '../logging/index.js'
import { markCriticalSection } from './event-loop-monitor.js'

export interface PeriodicHandle {
  stop(): void
  /** Change the base interval for subsequent scheduling (takes effect next tick). */
  setIntervalMs(ms: number): void
  /** Run one tick immediately (respects the reentrancy lock). */
  kick(): void
}

export interface TickContext {
  /** True once the tick has consumed its budget — abandon remaining phases. */
  overBudget(): boolean
  /** ms elapsed since the tick started. */
  elapsedMs(): number
}

export function runPeriodic(
  name: string,
  intervalMs: number,
  budgetMs: number,
  fn: (ctx: TickContext) => Promise<void>,
): PeriodicHandle {
  let baseInterval = intervalMs
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running = false
  let runningSince = 0

  const tick = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      const stuckForMs = Date.now() - runningSince
      const logFn = stuckForMs > 5 * 60_000 ? log.web.error : log.web.warn
      logFn(`periodic ${name}: tick skipped — previous still running`, { stuckForMs })
      schedule()
      return
    }
    running = true
    runningSince = Date.now()
    const t0 = runningSince
    let warned = false
    const ctx: TickContext = {
      elapsedMs: () => Date.now() - t0,
      overBudget: () => {
        const over = Date.now() - t0 > budgetMs
        if (over && !warned) {
          warned = true
          log.web.warn(`periodic ${name}: tick budget exceeded — abandoning remaining phases`, {
            budgetMs, elapsedMs: Date.now() - t0,
          })
        }
        return over
      },
    }
    const endSection = markCriticalSection(name)
    try {
      await fn(ctx)
    } catch (err) {
      log.web.warn(`periodic ${name}: tick failed`, {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      endSection()
      running = false
      schedule()
    }
  }

  const schedule = (): void => {
    // Cancel whatever is already armed BEFORE arming again. schedule() has three
    // callers (construction, every tick's finally, the skipped-tick branch) and
    // kick() runs a tick out of band, so an out-of-band tick used to re-arm on
    // top of the still-pending construction timer: two live timers, i.e. the task
    // firing twice per interval forever, plus one more for every extra kick().
    // Clearing here also keeps stop() correct — `timer` is always the only handle
    // in flight, so cancelling it cancels everything.
    if (timer) { clearTimeout(timer); timer = null }
    if (stopped) return
    const jitter = baseInterval * 0.1 * (Math.random() * 2 - 1)
    timer = setTimeout(() => { void tick() }, Math.max(250, baseInterval + jitter))
    if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  schedule()

  return {
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
    setIntervalMs(ms: number) { baseInterval = ms },
    kick() { void tick() },
  }
}
