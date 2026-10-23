/**
 * Module interop for a vitest run on bun.
 *
 * vitest 3 wraps every external import in its CommonJS interop, which treats a
 * module whose default export carries `__esModule` as a CJS module and hands out
 * that default export instead. On bun every ESM namespace object answers
 * `'__esModule' in ns` with true, so a package whose default export is a namespace
 * (zod: `export { z }; export default z`) loses its named exports: `z` came back
 * undefined in every server module. bun's own import already gives a CJS module
 * its named exports, so the interop is turned off and the code under test sees
 * exactly what the bun runtime gives it.
 */
import fs from 'node:fs'
import { builtSqliteLibrary } from '../../src/lib/sqlite'

/**
 * The oldest bun a vitest run is trusted on. With the forks pool, bun 1.3.9 ends
 * a run after its first file whenever a worker is reused, with no summary and
 * often exit 0: a green run that tested one file. Fixed in 1.4.4.
 */
export const MIN_BUN = [1, 4, 4]

function olderThan(version: string, min: number[]): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] < min[i]
  }
  return false
}

/**
 * Why the test tiers must not run in this process, or null. They run on bun only
 * (docs/plan/walnut-single-binary.md, "One runtime"): Walnut's SQLite, terminal
 * and plugin loader are bun's, so a run on Node tests code no build of Walnut
 * runs. The package scripts start vitest as `bun --bun vitest`; `npx vitest` and
 * `./node_modules/.bin/vitest` start it on Node, whose shebang they follow.
 */
export function testRuntimeProblem(versions: NodeJS.ProcessVersions & { bun?: string } = process.versions): string | null {
  const bun = versions.bun
  if (typeof bun !== 'string') {
    return `the test tiers run on bun, not on Node ${versions.node}: use \`bun run test:quick\` (or another package test script), or \`bun --bun vitest run --config <config>\``
  }
  if (olderThan(bun, MIN_BUN)) {
    return `vitest on bun ${bun} silently skips test files; run it on bun ${MIN_BUN.join('.')} or newer (package.json packageManager)`
  }
  return null
}

/**
 * Why SQLite in this run would not be Walnut's, or null. On macOS bun:sqlite
 * loads the Apple build unless src/lib/sqlite.ts finds the upstream one that
 * scripts/build-sqlite-dylib.mjs compiles (bun install's postinstall runs it).
 * The Apple build fails every query on a database whose file was deleted while
 * open, which every test that resets its home between cases does: a checkout
 * without the dylib failed 876 quick-tier tests with "disk I/O error".
 * WALNUT_SQLITE_LIBRARY=system keeps the Apple build on purpose; a path there
 * must name a file, as src/lib/sqlite.ts requires.
 */
export function testSqliteProblem(
  platform: string = process.platform,
  built: string | null = builtSqliteLibrary(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): string | null {
  if (platform !== 'darwin') return null
  const wanted = env.WALNUT_SQLITE_LIBRARY
  if (wanted === 'system') return null
  if (wanted) return exists(wanted) ? null : `WALNUT_SQLITE_LIBRARY names no file (${wanted}): set it to a built libsqlite3.dylib, or unset it`
  if (built) return null
  return 'the upstream SQLite is not built: run `bun scripts/build-sqlite-dylib.mjs` (bun install runs it). ' +
    'Without it bun:sqlite loads the macOS system build, and every test that deletes an open database fails with "disk I/O error"'
}

/** Throws when the tiers must not run here (testRuntimeProblem, testSqliteProblem). */
export function assertTestRuntime(): void {
  const problem = testRuntimeProblem() ?? testSqliteProblem()
  if (problem) throw new Error(problem)
}

export function runtimeDeps(): { interopDefault?: boolean } {
  assertTestRuntime()
  return { interopDefault: false }
}

/**
 * Module aliases for a vitest run on bun. `#ws` (package.json "imports") names
 * src/lib/ws-npm.ts under the "bun" condition, which vite's resolver does not
 * apply, so on bun the alias says it; Node resolves `#ws` to `ws` itself.
 */
export function runtimeAliases(root: string): Record<string, string> {
  return typeof process.versions.bun === 'string' ? { '#ws': `${root}/src/lib/ws-npm.ts` } : {}
}
