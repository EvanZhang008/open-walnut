/**
 * The clocks of one daemon runtime (createDaemonRuntime in daemon-standalone.ts). The daemon's
 * body names `setTimeout`, `setInterval`, `setImmediate` and their clears; inside the runtime
 * those names are these:
 *   - every timer started is tracked, and clearAll() (the runtime's stop()) ends them all: a
 *     daemon that was a whole process never needed it, its exit ended them;
 *   - with `contain` (a runtime inside a server's process), a callback that throws, or returns a
 *     promise that rejects, is reported (onError) and the runtime goes on: there an uncaught error
 *     would end the server. Without it (a daemon program) an error goes on to the process as it
 *     always did: its crash handler writes the breadcrumb, exits, and the restart re-adopts every
 *     CLI, which a clock that keeps failing cannot do;
 *   - contain() gives an event handler (a child's exit, a socket's data) the same rule.
 * Pure wiring around the process's own timers.
 */

type Timer = ReturnType<typeof globalThis.setTimeout>
type Immediate = ReturnType<typeof globalThis.setImmediate>

export interface RuntimeTimers {
  setTimeout: typeof globalThis.setTimeout
  setInterval: typeof globalThis.setInterval
  setImmediate: typeof globalThis.setImmediate
  clearTimeout: typeof globalThis.clearTimeout
  clearInterval: typeof globalThis.clearInterval
  clearImmediate: typeof globalThis.clearImmediate
  /** Timers still pending (tests). */
  readonly pending: number
  /** Ends every timer still pending. */
  clearAll(): void
  /** `fn` as an event handler that reports what it throws or rejects (`what` names it) instead of throwing. */
  contain<A extends unknown[]>(what: string, fn: (...args: A) => unknown): (...args: A) => void
}

export function createRuntimeTimers(
  onError: (what: string, err: unknown) => void,
  /** A callback that held the loop at least `ms`: reported with what it was (its name or its first characters). */
  slow?: { ms: number; report: (what: string, heldMs: number, label: string) => void },
  /** Report and go on (true, the default: in process) or let errors reach the process (a daemon program). */
  contain = true,
): RuntimeTimers {
  const timers = new Set<Timer>()
  const immediates = new Set<Immediate>()
  const guarded = (what: string, fn: (...a: unknown[]) => unknown, args: unknown[]): void => {
    const startedAt = slow ? performance.now() : 0
    try {
      const out = fn(...args)
      if (contain && out && typeof (out as Promise<unknown>).then === 'function') {
        ;(out as Promise<unknown>).then(undefined, (err) => onError(what, err))
      }
    } catch (err) {
      if (!contain) throw err
      onError(what, err)
    } finally {
      if (slow) {
        const held = performance.now() - startedAt
        if (held >= slow.ms) { try { slow.report(what, held, fn.name || String(fn).replace(/\s+/g, ' ').slice(0, 120)) } catch { /* a report never throws */ } }
      }
    }
  }

  const setTimeout = ((fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const t = globalThis.setTimeout(() => { timers.delete(t); guarded('timer', fn, args) }, ms)
    timers.add(t)
    return t
  }) as unknown as typeof globalThis.setTimeout
  const setInterval = ((fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const t = globalThis.setInterval(() => guarded('interval', fn, args), ms)
    timers.add(t)
    return t
  }) as unknown as typeof globalThis.setInterval
  const setImmediate = ((fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
    const i = globalThis.setImmediate(() => { immediates.delete(i); guarded('immediate', fn, args) })
    immediates.add(i)
    return i
  }) as unknown as typeof globalThis.setImmediate
  const clearTimeout = ((t: Parameters<typeof globalThis.clearTimeout>[0]) => {
    timers.delete(t as Timer)
    globalThis.clearTimeout(t)
  }) as typeof globalThis.clearTimeout
  const clearInterval = ((t: Parameters<typeof globalThis.clearInterval>[0]) => {
    timers.delete(t as Timer)
    globalThis.clearInterval(t)
  }) as typeof globalThis.clearInterval
  const clearImmediate = ((i: Parameters<typeof globalThis.clearImmediate>[0]) => {
    immediates.delete(i as Immediate)
    globalThis.clearImmediate(i)
  }) as typeof globalThis.clearImmediate

  return {
    setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate,
    get pending() { return timers.size + immediates.size },
    contain: (what, fn) => (...args) => guarded(what, fn as (...a: unknown[]) => unknown, args),
    clearAll() {
      for (const t of timers) globalThis.clearTimeout(t)
      for (const i of immediates) globalThis.clearImmediate(i)
      timers.clear()
      immediates.clear()
    },
  }
}
