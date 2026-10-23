/**
 * npm, for the few tests that check what npm itself does with a package: the
 * plugin packages' tarballs (`npm pack --dry-run`) and `walnut-plugin
 * publish-check`, which outside plugin authors run with their own npm.
 *
 * The test tiers run on bun with no Node, so CI's quick legs have no npm and
 * those tests skip there. CI runs them where npm is, in the node-side job
 * (`bun run test:plugin-packages`), which sets WALNUT_REQUIRE_NPM=1 so a
 * missing npm fails the run instead of skipping it.
 */
import fs from 'node:fs'
import path from 'node:path'

/** True when an executable `npm` is on PATH; throws when WALNUT_REQUIRE_NPM=1 and there is none. */
export function npmOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch { /* next */ }
  }
  if (env.WALNUT_REQUIRE_NPM === '1') {
    throw new Error('WALNUT_REQUIRE_NPM=1, and there is no npm on PATH: these tests check what npm packs, so they need Node and npm')
  }
  return false
}
