/**
 * Which JavaScript runtime this process runs on, for the few modules that differ
 * between Node and bun (docs/plan/walnut-single-binary.md): src/lib/sqlite.ts,
 * src/lib/pty.ts, src/lib/transpile.ts. Everything else is the same code on both.
 */

/** True when this process runs on bun. */
export const ON_BUN = typeof (process.versions as { bun?: string }).bun === 'string'

/** bun's global, typed only as far as Walnut uses it (no bun-types in this repo). */
export function bunGlobal<T>(): T {
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (!bun) throw new Error('not running on bun')
  return bun as T
}
