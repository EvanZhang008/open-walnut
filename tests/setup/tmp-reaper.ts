/**
 * The harness owns the lifetime of every temp directory a test file creates
 * directly under $TMPDIR, so a test that forgets its cleanup no longer leaks.
 *
 * Why the harness and not the tests: 153 test files call mkdtemp; a full suite
 * run on 2026-09-13 left 2,700 directories behind (`walnut-test-*`,
 * `usage-test-*`, `daemon-core-unit-*`, ...), each from a file that either has no
 * afterAll, or whose afterAll a failing test skipped. Fixing them one by one
 * leaves the next file free to repeat it; recording every creation here does not.
 *
 * How: the fs entry points that create directories are wrapped in this worker
 * (each test file runs in its own fork). For anything created under os.tmpdir()
 * the TOP-LEVEL entry (`<tmp>/<name>`) is recorded, and only when this call
 * brought it into existence; paths elsewhere are not our business. Files written
 * straight into the root are covered too, in the same way.
 * An `afterAll` registered from a setup file runs after the test file's own
 * hooks (vitest `sequence.hooks` defaults to "stack"), so a test that does clean
 * up finds nothing left for us, and one that does not is cleaned here. A worker
 * that exits some other way gets a last `exit`-time pass.
 *
 * `syncBuiltinESMExports()` matters: `import { mkdtempSync } from 'node:fs'`
 * binds to the ESM namespace, which only reflects a patched CommonJS export
 * after that call. Without it only `fs.mkdtempSync(...)` call sites are seen.
 *
 * Not covered on purpose: directories made by child processes (the isolated
 * daemon's runtime dir is pid-named and reclaimed by tests/setup/stale-tmp.ts),
 * and a worker killed with SIGKILL (same sweep, next run).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll } from 'vitest'

const recorded = new Set<string>()

/**
 * Both spellings of the temp root. macOS os.tmpdir() is `/var/folders/...`, a
 * symlink to `/private/var/folders/...`; tests use either, and a path whose
 * parent does not exist yet (recursive mkdir) cannot be realpath'd, so this is
 * string matching against both rather than a stat.
 */
const ROOTS = (() => {
  const raw = path.resolve(os.tmpdir())
  let real = raw
  try { real = fs.realpathSync(raw) } catch { /* keep raw */ }
  return [...new Set([real, raw])]
})()
const ROOT = ROOTS[0]

/**
 * Directories under $TMPDIR that are SHARED across workers or runs and therefore
 * never ours to remove, even if a test file happens to `mkdir -p` one of them.
 * The runtime dirs are pid-owned (tests/setup/runtime-dir-isolation.ts) and the
 * global test home is created by the runner for every worker.
 */
const NEVER_OURS = [/^open-walnut-test-runtime-/, /^open-walnut-test-global$/, /^open-walnut-stage\./, /^open-walnut-lkg$/, /^walnut-pw-lease$/, /^walnut-vitest-gate/]

function toString(p: fs.PathLike | undefined): string | null {
  if (typeof p === 'string') return p
  if (Buffer.isBuffer(p)) return p.toString()
  if (p instanceof URL) return p.pathname
  return null
}

/**
 * The entry directly under the temp root that `p` lives in (or is), as
 * `<ROOT>/<name>`; null when `p` is not under the temp root at all.
 * `<ROOT>/a/b/c` → `<ROOT>/a`. The top-level entry is what a test "owns": a
 * mocked WALNUT_HOME is created by the code under test as `<home>/tasks`
 * with `recursive: true`, so the home itself never passes through mkdir.
 */
function topLevelEntry(p: fs.PathLike | undefined): { entry: string; direct: boolean } | null {
  const str = toString(p)
  if (str === null) return null
  const resolved = path.resolve(str)
  for (const r of ROOTS) {
    if (!resolved.startsWith(r + path.sep)) continue
    const rel = resolved.slice(r.length + 1)
    const first = rel.split(path.sep)[0]
    if (!first || NEVER_OURS.some((re) => re.test(first))) return null
    return { entry: path.join(ROOT, first), direct: !rel.includes(path.sep) }
  }
  return null
}

/** What the reaper is holding, for tests of the reaper itself. */
export function recordedTmpDirs(): ReadonlySet<string> {
  return recorded
}

/** Remove every recorded entry that still exists. Returns the paths removed. */
export function reapTmpDirs(): string[] {
  const removed: string[] = []
  for (const entry of recorded) {
    // Belt and braces: never act on anything that is not a direct child of tmp.
    if (path.dirname(entry) !== ROOT) continue
    if (!fs.existsSync(entry)) continue
    try {
      fs.rmSync(entry, { recursive: true, force: true, maxRetries: 2 })
      removed.push(entry)
    } catch {
      /* pinned open or raced; the pid sweep or the next run gets it */
    }
  }
  recorded.clear()
  return removed
}

/**
 * mkdir / writeFile: the top-level entry is ours only if THIS call brought it
 * into existence. A `recursive: true` mkdir on a directory that already existed
 * is not a creation, and recording it would make us delete something another
 * worker may be using. Decide before the call, record after it succeeds.
 */
function claimIfFresh(p: fs.PathLike | undefined): (() => void) | null {
  const top = topLevelEntry(p)
  if (!top || fs.existsSync(top.entry)) return null
  return () => { recorded.add(top.entry) }
}

/** mkdtemp: always a creation, but only a DIRECT child is ours (a nested one sits in someone's dir). */
function claimMkdtemp(created: unknown): void {
  const top = topLevelEntry(created as fs.PathLike)
  if (top?.direct) recorded.add(top.entry)
}

// ── Patch the creators ──

const origMkdtempSync = fs.mkdtempSync
const origMkdtemp = fs.mkdtemp
const origMkdirSync = fs.mkdirSync
const origMkdir = fs.mkdir
const origWriteFileSync = fs.writeFileSync
const origWriteFile = fs.writeFile
const origPMkdtemp = fs.promises.mkdtemp
const origPMkdir = fs.promises.mkdir
const origPWriteFile = fs.promises.writeFile
const origRenameSync = fs.renameSync
const origRename = fs.rename
const origPRename = fs.promises.rename

fs.mkdtempSync = function mkdtempSync(this: unknown, ...args: Parameters<typeof fs.mkdtempSync>) {
  const created = Reflect.apply(origMkdtempSync, this, args) as ReturnType<typeof fs.mkdtempSync>
  claimMkdtemp(created)
  return created
} as typeof fs.mkdtempSync

fs.mkdtemp = function mkdtemp(this: unknown, ...args: unknown[]) {
  const cb = args[args.length - 1]
  if (typeof cb === 'function') {
    args[args.length - 1] = (err: unknown, created: unknown) => {
      if (!err) claimMkdtemp(created)
      ;(cb as (...a: unknown[]) => void)(err, created)
    }
  }
  return Reflect.apply(origMkdtemp, this, args)
} as typeof fs.mkdtemp

fs.promises.mkdtemp = async function mkdtemp(this: unknown, ...args: Parameters<typeof fs.promises.mkdtemp>) {
  const created = await Reflect.apply(origPMkdtemp, this, args)
  claimMkdtemp(created)
  return created
} as typeof fs.promises.mkdtemp

/**
 * Wrap a sync creator: claim decided before, recorded after success. `at` is the
 * argument that names what gets created (0 for mkdir/writeFile, 1 for rename's
 * destination).
 */
function wrapSync<F extends (...a: never[]) => unknown>(orig: F, at = 0): F {
  return function wrapped(this: unknown, ...args: unknown[]) {
    const claim = claimIfFresh(args[at] as fs.PathLike)
    const result = Reflect.apply(orig, this, args)
    claim?.()
    return result
  } as unknown as F
}

/** Wrap a callback creator (last argument is the callback). */
function wrapCallback<F extends (...a: never[]) => unknown>(orig: F, at = 0): F {
  return function wrapped(this: unknown, ...args: unknown[]) {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') {
      const claim = claimIfFresh(args[at] as fs.PathLike)
      args[args.length - 1] = (err: unknown, ...rest: unknown[]) => {
        if (!err) claim?.()
        ;(cb as (...a: unknown[]) => void)(err, ...rest)
      }
    }
    return Reflect.apply(orig, this, args)
  } as unknown as F
}

/** Wrap a promise creator. */
function wrapAsync<F extends (...a: never[]) => Promise<unknown>>(orig: F, at = 0): F {
  return async function wrapped(this: unknown, ...args: unknown[]) {
    const claim = claimIfFresh(args[at] as fs.PathLike)
    const result = await Reflect.apply(orig, this, args)
    claim?.()
    return result
  } as unknown as F
}

fs.mkdirSync = wrapSync(origMkdirSync)
fs.mkdir = wrapCallback(origMkdir)
fs.promises.mkdir = wrapAsync(origPMkdir)
// Files written straight into $TMPDIR (`plugin-updates-cache-<pid>-<rand>.json`)
// are the same leak in a smaller shape; a nested write claims nothing new.
fs.writeFileSync = wrapSync(origWriteFileSync)
fs.writeFile = wrapCallback(origWriteFile)
fs.promises.writeFile = wrapAsync(origPWriteFile)
// The atomic-write idiom (write `<file>.tmp`, rename over `<file>`) creates the
// final name through rename, so the destination is claimed like a creation.
fs.renameSync = wrapSync(origRenameSync, 1)
fs.rename = wrapCallback(origRename, 1)
fs.promises.rename = wrapAsync(origPRename, 1)

syncBuiltinESMExports()

// ── Reap ──

afterAll(() => {
  reapTmpDirs()
})

process.on('exit', () => {
  reapTmpDirs()
})
