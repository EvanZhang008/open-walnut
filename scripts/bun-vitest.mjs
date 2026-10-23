/**
 * How every test script starts vitest: `bun --bun vitest <args>`.
 *
 * The test tiers run on bun, and nothing in them may need Node:
 *
 * - `--bun` runs vitest itself on bun, although its bin says `#!/usr/bin/env node`.
 * - The bare name `vitest` (not `./node_modules/.bin/vitest`) goes through bun's
 *   script runner, which puts bun's own `node` shim first on PATH for the whole run.
 *   So a test or a server that starts `node` gets bun, the same on a developer's
 *   Mac (where a real Node is installed) as on a CI runner with none.
 *
 * The bun is the one running this script (`bun scripts/x.mjs`, `bun run ...`), else
 * the first on PATH. tests/setup/runtime-deps.ts refuses a bun older than the
 * pinned one and refuses Node.
 */

/** The bun to start children with. */
export function bunExecutable(versions = process.versions, execPath = process.execPath) {
  return typeof versions.bun === 'string' ? execPath : 'bun'
}

/** `{ cmd, args }` that run vitest on bun with the given arguments. */
export function vitestCommand(args) {
  return { cmd: bunExecutable(), args: ['--bun', 'vitest', ...args] }
}

/** The same as one display line, for logs. */
export function vitestCommandLine(args) {
  return ['bun', '--bun', 'vitest', ...args].join(' ')
}
