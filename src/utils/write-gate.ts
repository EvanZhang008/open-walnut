/**
 * The write gate: lets the standby copy (src/core/standby/) wait for Walnut's own writes
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
