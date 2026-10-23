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
export function runtimeDeps(): { interopDefault?: boolean } {
  return typeof process.versions.bun === 'string' ? { interopDefault: false } : {}
}
