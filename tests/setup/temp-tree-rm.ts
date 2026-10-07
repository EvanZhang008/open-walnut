/**
 * A test's recursive removal of a temp tree retries, the way removeTempTree
 * (tests/helpers/temp-home.ts) does, without every test having to call it.
 *
 * Why the harness and not the tests: `fs.rm(WALNUT_HOME, { recursive: true,
 * force: true })` appears about 900 times in 500 test files, and with Node's
 * default `maxRetries: 0` any of them fails with `ENOTEMPTY` when a
 * fire-and-forget writer of the code under test (a logger flush, an atomic
 * write's tmp file, a backup copy) lands a new entry between rimraf's listing
 * and its final rmdir. 2026-10-07: two quick-tier tests failed that way in a
 * beforeEach, in files the change under test never touched. Fixing them one by
 * one leaves the next one to fail the same way; this does not.
 *
 * Scope, kept narrow on purpose:
 *   - only a call whose direct caller is test code (under tests/, but not the
 *     harness in tests/setup/), so code under test removes its own trees
 *     exactly as written and a race of its own still fails its test;
 *   - only `recursive: true`, only a path inside the temp root, and only when
 *     the caller named no `maxRetries` of its own.
 *
 * `syncBuiltinESMExports()` matters for `import { rm } from 'node:fs/promises'`,
 * as in tests/setup/tmp-reaper.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

/** The same retries removeTempTree uses: ENOTEMPTY and EBUSY are in Node's retry set. */
export const TEMP_TREE_RETRIES = { maxRetries: 10, retryDelay: 25 } as const

const TESTS_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url))) + path.sep
const SETUP_DIR = path.join(TESTS_DIR, 'setup') + path.sep

const ROOTS = (() => {
  const raw = path.resolve(os.tmpdir())
  let real = raw
  try { real = fs.realpathSync(raw) } catch { /* keep raw */ }
  return [...new Set([real, raw])]
})()

/** The file of the frame that called the patched function, from a stack taken inside it. */
export function callerFile(stack: string | undefined): string | null {
  // [0] "Error", [1] the wrapper, [2] its caller.
  const line = (stack ?? '').split('\n')[2] ?? ''
  const m = /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/.exec(line)
  if (!m) return null
  return m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1]
}

/** The options a removal runs with: `opts` itself unless this file's scope applies. */
export function retryingOptions(target: unknown, opts: unknown, caller: string | null): unknown {
  if (!opts || typeof opts !== 'object' || !(opts as fs.RmOptions).recursive) return opts
  if ((opts as fs.RmOptions).maxRetries !== undefined) return opts
  if (!caller || !caller.startsWith(TESTS_DIR)) return opts
  if (caller.startsWith(SETUP_DIR) && !caller.endsWith('.test.ts')) return opts
  const p = typeof target === 'string' ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : null
  if (p === null) return opts
  const resolved = path.resolve(p)
  if (!ROOTS.some((r) => resolved.startsWith(r + path.sep))) return opts
  return { ...(opts as fs.RmOptions), ...TEMP_TREE_RETRIES }
}

const origRm = fs.rm
const origRmSync = fs.rmSync
const origPRm = fs.promises.rm

fs.promises.rm = function rm(this: unknown, target: fs.PathLike, opts?: fs.RmOptions) {
  return Reflect.apply(origPRm, this, [target, retryingOptions(target, opts, callerFile(new Error().stack))])
} as typeof fs.promises.rm

fs.rmSync = function rmSync(this: unknown, target: fs.PathLike, opts?: fs.RmOptions) {
  return Reflect.apply(origRmSync, this, [target, retryingOptions(target, opts, callerFile(new Error().stack))])
} as typeof fs.rmSync

fs.rm = function rm(this: unknown, target: fs.PathLike, ...rest: unknown[]) {
  if (rest.length === 2) rest[0] = retryingOptions(target, rest[0], callerFile(new Error().stack))
  return Reflect.apply(origRm, this, [target, ...rest])
} as typeof fs.rm

syncBuiltinESMExports()
