/**
 * Gauges other modules report to the health monitor (the status check's count).
 * A leaf module with no imports, so a reporter never pulls the monitor in; the
 * last value is kept until the monitor starts and reads it.
 */

type Sink = (key: string, value: number | null) => void

let sink: Sink | null = null
const pending = new Map<string, number | null>()

export function reportGauge(key: string, value: number | null): void {
  if (sink) sink(key, value)
  else pending.set(key, value)
}

/** The running monitor attaches here; `null` detaches. */
export function setGaugeSink(next: Sink | null): void {
  sink = next
  if (next) for (const [k, v] of pending) next(k, v)
  pending.clear()
}
