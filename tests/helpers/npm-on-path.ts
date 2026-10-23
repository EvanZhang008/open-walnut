/**
 * npm, for the few tests that check what npm itself does with a package: the
 * plugin packages' tarballs (`npm pack --dry-run`), `walnut-plugin
 * publish-check`, which outside plugin authors run with their own npm, and the
 * npm channel (a user's `npm install -g open-walnut`).
 *
 * The test tiers run on bun with no Node, so CI's Node-free jobs have no npm and
 * those tests skip there. CI runs them where npm is, in the node-side job
 * (`bun run test:plugin-packages`, `bun run test:npm-channel`), which sets
 * WALNUT_REQUIRE_NPM=1 so a missing npm fails the run instead of skipping it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { realNodeOnPath, withNodeFirst } from '../../scripts/outside-node.mjs'

export { realNodeOnPath }

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

/**
 * The env an npm child gets: the real Node first on PATH, so npm and what it
 * installs run on Node as on a user's machine, not on the bun shim `bun --bun`
 * puts first. Throws when WALNUT_REQUIRE_NPM=1 and there is no Node.
 */
export function npmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const node = realNodeOnPath(env)
  if (node) return withNodeFirst(env, node)
  if (env.WALNUT_REQUIRE_NPM === '1') {
    throw new Error('WALNUT_REQUIRE_NPM=1, and there is no Node on PATH: npm runs on a user\'s Node, so these tests need it')
  }
  return env
}

/**
 * The real Node, when npm and Node are both on PATH (a user's npm channel);
 * null when either is missing. Throws when WALNUT_REQUIRE_NPM=1 and one is.
 */
export function userNode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!npmOnPath(env)) return null
  return realNodeOnPath(npmEnv(env))
}
