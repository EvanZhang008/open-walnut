/**
 * Module interop for a vitest run on bun.
 *
 * vitest 3 wraps every external import in its CommonJS interop, which treats a
 * module whose default export carries `__esModule` as a CJS module and hands out
 * that default export instead. On bun every ESM namespace object answers
 * `'__esModule' in ns` with true, so a package whose default export is a namespace
 * (zod: `export { z }; export default z`) loses its named exports: `z` came back
 * undefined in every server module. bun's own import already gives a CJS module
 * its named exports, so the interop is turned off there and the code under test
 * sees exactly what the bun runtime gives it. Node keeps vitest's default.
 */
/**
 * The oldest bun a vitest run is trusted on. With the forks pool, bun 1.3.9 ends
 * a run after its first file whenever a worker is reused, with no summary and
 * often exit 0: a green run that tested one file. Fixed in 1.4.4.
 */
const MIN_BUN = [1, 4, 4]

function olderThan(version: string, min: number[]): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] < min[i]
  }
  return false
}

export function runtimeDeps(): { interopDefault?: boolean } {
  const bun = process.versions.bun
  if (typeof bun !== 'string') return {}
  if (olderThan(bun, MIN_BUN)) {
    throw new Error(`vitest on bun ${bun} silently skips test files; run it on bun ${MIN_BUN.join('.')} or newer (package.json packageManager)`)
  }
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
