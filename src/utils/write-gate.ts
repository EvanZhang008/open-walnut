/**
 * Two write gates for Walnut's own writes into the data folder: the standby copy's (whole
 * write sections, below) and the pull's (single renames, at the end of this file).
 *
 * The standby gate lets the standby copy (src/core/standby/) wait for Walnut's own writes
 * already under way to finish and hold new ones for an instant, so one batch of the data
 * folder is taken at one moment.
 *
 * Who goes through it: every `withFileLock` section (src/utils/file-lock.ts), which is how
 * the stores do their read-modify-write. Sync writes (SQLite statements, the sync lock
 * variant) cannot wait, and need not: no other code runs while one runs. Writers outside
 * the gate (a plain fs write, another process, the notes app) do not stop, which is why a
 * batch also checks every file it read (src/core/standby/batch.ts): the gate makes a void
 * batch rarer, the check makes a wrong batch impossible.
 *
 * Off (the default, and always while the experiment `switchable_leader` is off): `gated`
 * calls its function straight away, exactly as before the gate existed.
 *
 * Leaf module: no imports but node's.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

let enabled = false
/** Truthy inside a gated section or inside the hold: nested writes pass straight through. */
const inside = new AsyncLocalStorage<true>()
let inFlight = 0
let closed: { promise: Promise<void>; open: () => void } | null = null
let drained: (() => void) | null = null

export function setWriteGateEnabled(on: boolean): void {
  enabled = on
}

export function writeGateEnabled(): boolean {
  return enabled
}

/**
 * Run a write section through the gate. While a hold is on, a new section waits for it to
 * end; a section already inside one (or inside the hold itself) never waits, so nesting
 * cannot deadlock.
 */
export function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (!enabled || inside.getStore()) return fn()
  return (async () => {
    while (closed) await closed.promise
    inFlight++
    try {
      return await inside.run(true, fn)
    } finally {
      inFlight--
      if (inFlight === 0 && drained) drained()
    }
  })()
}

export interface HoldResult<T> {
  /** False when the writes under way did not end within `drainMs`: `fn` did not run. */
  drained: boolean
  result?: T
  /** From the moment new writes were held until they were let go. */
  holdMs: number
  /** How long the wait for the writes under way took. */
  drainMs: number
}

/**
 * Hold new gated writes, wait (at most `drainMs`) for the ones under way, run `fn`, and let
 * them go. Only one hold at a time. With the gate off, `fn` runs at once (nothing is held).
 */
export async function holdWrites<T>(fn: () => Promise<T>, opts: { drainMs: number }): Promise<HoldResult<T>> {
  if (closed) throw new Error('a write hold is already on')
  const start = performance.now()
  let open!: () => void
  closed = { promise: new Promise<void>((resolve) => { open = resolve }), open }
  try {
    if (enabled && inFlight > 0) {
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { drained = null; resolve(false) }, opts.drainMs)
        drained = () => { clearTimeout(timer); drained = null; resolve(true) }
      })
      if (!ok) return { drained: false, holdMs: performance.now() - start, drainMs: performance.now() - start }
    }
    const drainMs = performance.now() - start
    const result = await inside.run(true, fn)
    return { drained: true, result, holdMs: performance.now() - start, drainMs }
  } finally {
    const c = closed
    closed = null
    c.open()
  }
}

/** For tests: the gated sections under way now. */
export function writesInFlight(): number {
  return inFlight
}

// ── The rename gate: a pull moving the data repo's working tree ──
//
// A pull (src/integrations/git-sync-apply.ts) checks each path and replaces it back to back,
// synchronously, so nothing on the event loop can write in between. A rename the app already
// handed to libuv's thread pool can still land there (2026-11-24 review: 215 of 300 trials):
// the app's write succeeds, then the pull replaces it. So a writer brackets its rename with
// enterWrite() and the release it returns, and the pull closes the gate around its whole
// mutation phase: closing waits for every rename under way, and a writer arriving while it is
// closed waits until it opens. Unlike the standby gate it is always on.
//
// Writers outside the gate (about 300 rename sites: plugins, notes, the session stores' own
// paths) keep a window of microseconds; git's own checkout, which the pull ran before, had one
// as wide as the whole checkout.

/** How long a writer waits for a closed gate before it goes ahead (a hung pull never stalls the app). */
export const WRITE_GATE_WAIT_MAX_MS = 30_000

let renamesInFlight = 0
let renameGate: { promise: Promise<void>; open: () => void } | null = null
let renamesDrained: (() => void) | null = null
let overdueListener: ((waitedMs: number) => void) | null = null

/**
 * Enter right before a rename (or any one-step replace) into the data folder; call the
 * returned release right after it settles, success or not. While a pull holds the gate this
 * waits for it, at most `maxWaitMs`, then goes ahead and reports the overdue wait. Never call it
 * from the pull's own code while the gate is closed: it would wait for itself.
 */
export async function enterWrite(maxWaitMs = WRITE_GATE_WAIT_MAX_MS): Promise<() => void> {
  if (renameGate) {
    const start = Date.now()
    while (renameGate) {
      const left = maxWaitMs - (Date.now() - start)
      if (left <= 0) {
        overdueListener?.(Date.now() - start)
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([renameGate.promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, left) })])
      clearTimeout(timer)
    }
  }
  renamesInFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    renamesInFlight--
    if (renamesInFlight === 0) renamesDrained?.()
  }
}

/**
 * Close the gate: new writers wait, and this waits (at most `maxWaitMs`) for the renames under
 * way. False, with the gate open again, when they did not finish in time or the gate is
 * already closed; the caller then writes nothing.
 */
export async function closeWrites(maxWaitMs: number): Promise<boolean> {
  if (renameGate) return false
  let open!: () => void
  renameGate = { promise: new Promise<void>((resolve) => { open = resolve }), open }
  if (renamesInFlight === 0) return true
  const drained = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { renamesDrained = null; resolve(false) }, maxWaitMs)
    renamesDrained = () => { clearTimeout(timer); renamesDrained = null; resolve(true) }
  })
  if (!drained) openWrites()
  return drained
}

/** Open the gate: the writers waiting go on. */
export function openWrites(): void {
  const gate = renameGate
  renameGate = null
  gate?.open()
}

/** Told how long a writer waited when it went ahead through a gate held too long. */
export function setWriteGateOverdueListener(fn: ((waitedMs: number) => void) | null): void {
  overdueListener = fn
}

/** For tests: renames under way inside the gate, and whether it is closed. */
export function renameGateState(): { inFlight: number; closed: boolean } {
  return { inFlight: renamesInFlight, closed: renameGate !== null }
}
