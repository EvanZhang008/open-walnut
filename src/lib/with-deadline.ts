/**
 * One deadline helper for "answer degraded instead of hanging".
 *
 * Its clock is cleared the moment the work settles, so `onTimeout` (and any log
 * it writes) runs only when the deadline really passed. A bare
 * `Promise.race([work, new Promise(r => setTimeout(() => { log(...); r() }, ms))])`
 * keeps its clock running after the work wins and logs a false timeout on every
 * call (2026-11-16: "workflow reconstruct timed out" fired 5 s after reads that
 * answered in 3 ms). Ratchet: tests/lib/race-timer-cleared-ratchet.test.ts.
 *
 * Race `p` against a clock. On timeout the caller's fallback answers and the original
 * promise is left to settle on its own (its rejection is swallowed so nothing goes
 * unhandled).
 */
export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      p.catch(() => undefined)
      try {
        resolve(onTimeout())
      } catch (error) {
        reject(error)
      }
    }, ms)
    timer.unref?.()
    p.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
