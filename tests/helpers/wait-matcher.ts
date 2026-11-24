/**
 * The wait_for matcher process (src/providers/host-exec-matcher.ts) as a test starts it: this
 * runtime (bun, which runs the TypeScript source) with -e. The daemon passes its own start
 * (daemon-standalone.ts); a host-exec core given none runs no output wait.
 */
import { fileURLToPath } from 'node:url'
import type { MatcherStart } from '../../src/providers/host-exec-matcher.js'

const MATCHER_FILE = fileURLToPath(new URL('../../src/providers/host-exec-matcher.ts', import.meta.url))

export function testMatcherStart(): MatcherStart {
  return { command: process.execPath, args: ['-e', `require(${JSON.stringify(MATCHER_FILE)}).runWaitMatcher().then(() => process.exit(0))`] }
}
