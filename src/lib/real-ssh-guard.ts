/**
 * A server under test never reaches the developer's real ssh.
 *
 * At startup a server reads ~/.ssh/config (its Host blocks become discovered
 * hosts) and sweeps every host it knows for orphaned terminal sessions over
 * ssh, with a ControlMaster (web/terminal/dtach-lifecycle.ts). Run by a test
 * with the developer's own HOME, that opened real ControlMasters to their own
 * machines (a 2026-10-01 gate review watched it happen for two hosts, from a
 * test file that never meant to touch ssh at all).
 *
 * So under a test runner (vitest, NODE_ENV=test, or a Playwright fixture
 * server that says so with WALNUT_TEST_SERVER=1) both steps are off, unless the
 * test isolated itself first: tests/helpers/isolate-ssh.ts points HOME at a
 * throwaway home, puts a refusing ssh first on PATH, and names that home in
 * WALNUT_TEST_SSH_ISOLATED_HOME. Then what the sweep reaches is the stand-in.
 *
 * Zero imports: config-manager and the server both ask it, at startup.
 */

/** Is this process a server under a test runner? */
export function underTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === 'test' || env.WALNUT_TEST_SERVER === '1')
}

/**
 * May this process read ~/.ssh/config and sweep hosts over ssh? Always, outside
 * a test runner. Under one, only with the isolation in place (HOME is the
 * throwaway home the helper made).
 */
export function realSshReachAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!underTestRunner(env)) return true
  const isolated = env.WALNUT_TEST_SSH_ISOLATED_HOME
  return !!isolated && env.HOME === isolated
}
