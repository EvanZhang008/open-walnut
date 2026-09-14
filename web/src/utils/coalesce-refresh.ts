/**
 * Collapse a burst of "something changed, reload" signals into ONE reload.
 *
 * A plugin update arrives as several signals within a second: one WS `plugin:runtime-changed`
 * per plugin the server reloaded, the client's own plugins-changed event after the POST, and
 * the caller's direct reload. Each used to fetch the same three lists again (11 GETs for one
 * Update, N2-10). Requests made while the timer is pending share one run; a request made while
 * a run is in flight schedules exactly one more run after it, so a change that lands mid-fetch
 * is still read, but never more than once.
 */
export interface CoalescedRefresh {
  /** Ask for a reload; resolves when a reload that started after this call has finished. */
  request(): Promise<void>
  /** Drop a pending timer (unmount). An in-flight run finishes on its own. */
  cancel(): void
}

export function coalesceRefresh(run: () => Promise<void>, delayMs = 250): CoalescedRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let pending: { promise: Promise<void>; resolve: () => void } | null = null

  const settle = () => {
    const waiters = pending
    pending = null
    inFlight = run().catch(() => undefined).finally(() => {
      inFlight = null
      waiters?.resolve()
      // A request that arrived during the run wants a read that started AFTER its change.
      if (pending && timer === null) timer = setTimeout(fire, 0)
    })
  }

  const fire = () => {
    timer = null
    if (inFlight) return // `finally` above re-arms once the run ends
    settle()
  }

  return {
    request() {
      if (!pending) {
        let resolve: () => void = () => undefined
        const promise = new Promise<void>((r) => { resolve = r })
        pending = { promise, resolve }
      }
      if (timer === null && !inFlight) timer = setTimeout(fire, delayMs)
      return pending.promise
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
