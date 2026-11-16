/**
 * What the npm package may hold, beyond check-publish's lists of required files.
 *
 * The package once carried seven copies of the same 23 MB server bundle: the three entry
 * bundles and one per built-in plugin, which the host never loads (tsup.config.ts says why),
 * so it stood 1.3 MB under the 200 MB limit (2026-11-16). Only the entry bundles below may be
 * that large; any other big file is a bundle nobody meant to ship, named here by its path.
 */

/** The bundles the package runs, each a full copy of the server by design. */
export const LARGE_BUNDLES = ['dist/cli.js', 'dist/cli-fast.js', 'dist/web/server.js'];

/** Bytes above which a packed file must be one of LARGE_BUNDLES. */
export const LARGE_FILE_BYTES = 10 * 1024 * 1024;

/** npm's limit check-publish holds the package to, and the room it must keep under it. */
export const PACKAGE_LIMIT_BYTES = 200 * 1024 * 1024;
export const PACKAGE_MARGIN_BYTES = 20 * 1024 * 1024;

/** Bytes from which two packed files with the same content are a copy nobody meant to ship. */
export const DUPLICATE_FILE_BYTES = 1024 * 1024;

/**
 * Problems with a pack listing (`npm pack --json` files: { path, size }, plus `hash` of the
 * content for files of DUPLICATE_FILE_BYTES or more), one line each.
 * @param {{ path: string, size: number, hash?: string }[]} files
 * @param {number} [unpackedSize] the whole package, as npm counts it
 * @returns {string[]}
 */
export function packageContentProblems(files, unpackedSize) {
  const MB = (n) => (n / 1024 / 1024).toFixed(1);
  const problems = files
    .filter((f) => f.size > LARGE_FILE_BYTES && !LARGE_BUNDLES.includes(f.path))
    .map((f) => `${f.path} is ${MB(f.size)} MB: only ${LARGE_BUNDLES.join(', ')} may be over ${LARGE_FILE_BYTES / 1024 / 1024} MB`);
  const byHash = new Map();
  for (const f of files) {
    if (f.size < DUPLICATE_FILE_BYTES || !f.hash) continue;
    byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f.path]);
  }
  for (const paths of byHash.values()) {
    if (paths.length > 1) problems.push(`${paths.length} copies of one ${MB(files.find((f) => f.path === paths[0]).size)} MB file: ${paths.join(', ')}`);
  }
  // A compiled-file build stages its whole tree here (scripts/build-binary.mjs); it ships as the binaries, never in npm.
  const staged = files.filter((f) => f.path.startsWith('dist/binary-stage/')).length;
  if (staged) problems.push(`${staged} files of dist/binary-stage/, a compiled-file build's staging tree`);
  if (unpackedSize !== undefined && unpackedSize > PACKAGE_LIMIT_BYTES - PACKAGE_MARGIN_BYTES) {
    problems.push(`the package is ${MB(unpackedSize)} MB unpacked, within ${MB(PACKAGE_MARGIN_BYTES)} MB of the ${MB(PACKAGE_LIMIT_BYTES)} MB limit: make it smaller, never raise the limit`);
  }
  return problems;
}
