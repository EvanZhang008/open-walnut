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

/**
 * Problems with a pack listing (`npm pack --json` files: { path, size }), one line each.
 * @param {{ path: string, size: number }[]} files
 * @returns {string[]}
 */
export function packageContentProblems(files) {
  const problems = files
    .filter((f) => f.size > LARGE_FILE_BYTES && !LARGE_BUNDLES.includes(f.path))
    .map((f) => `${f.path} is ${(f.size / 1024 / 1024).toFixed(1)} MB: only ${LARGE_BUNDLES.join(', ')} may be over ${LARGE_FILE_BYTES / 1024 / 1024} MB`);
  // A compiled-file build stages its whole tree here (scripts/build-binary.mjs); it ships as the binaries, never in npm.
  const staged = files.filter((f) => f.path.startsWith('dist/binary-stage/')).length;
  if (staged) problems.push(`${staged} files of dist/binary-stage/, a compiled-file build's staging tree`);
  return problems;
}
