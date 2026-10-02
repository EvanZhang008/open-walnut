/**
 * No test reaches the machine's real `claude`.
 *
 * Every session starts as `claude <args>` on a daemon, and the daemon finds
 * `claude` the way the user's terminal would: it rebuilds PATH from the login
 * shell and spawns through `$SHELL -c "<source rc>; exec claude"`. So a vitest
 * worker whose server started a session on its own local daemon ran the user's
 * real CLI on the Mac (a real model turn, with the user's credentials and
 * tools), and failed with "claude not found" in CI. A PATH shim in the test
 * process cannot help: the daemon never uses that PATH first.
 *
 * Under vitest, a daemon the test did not hand over (no test daemon URL: the
 * server's own local daemon, or a configured host) is told to run the harness's
 * stand-in instead (WALNUT_TEST_CLAUDE_BIN, which tests/setup/claude-stand-in.ts
 * points at the repo's mock CLI). With no stand-in named, it is told to run a
 * path that does not exist, so the start fails as "claude missing". A daemon the
 * test owns (MockDaemon, the daemon twin) keeps `claude`: that test decides what
 * `claude` is.
 *
 * Server-side one-shot spawns (the claude-cli model adapter, inline subagents)
 * resolve the CLI with resolveClaudeCliExecutable, which under vitest only
 * finds a `claude` a test put in a temp dir (isTestScratchPath): the
 * developer's real install never resolves, as in CI, where there is none.
 *
 * WALNUT_TEST_REAL_CLAUDE=1 lifts the guard (the live tier, vitest.live.config.ts).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Started instead of `claude` when the harness named no stand-in. */
export const NO_TEST_CLAUDE = '/nonexistent/open-walnut-test-runner/claude'

/** True inside a vitest worker. */
export function isVitestWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.VITEST || env.VITEST_WORKER_ID)
}

/** True when this process may not start the real `claude`: vitest, outside the live tier. */
export function realClaudeBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return isVitestWorker(env) && env.WALNUT_TEST_REAL_CLAUDE !== '1'
}

/**
 * The command a test's session runs in place of `claude`, or null when the real
 * one is allowed.
 */
export function testRunnerClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!realClaudeBlocked(env)) return null
  return env.WALNUT_TEST_CLAUDE_BIN || NO_TEST_CLAUDE
}

/**
 * What a server-side spawn runs when no `claude` was resolved: the bare name,
 * which PATH resolves, except under vitest, where it is a path that does not
 * exist (resolveClaudeCliExecutable answers null there, as on a machine without
 * the CLI, so the bare name would find the developer's real one).
 */
export function claudeFallbackCommand(env: NodeJS.ProcessEnv = process.env): string {
  return realClaudeBlocked(env) ? NO_TEST_CLAUDE : 'claude'
}

/**
 * True for a path inside the system temp dir, where tests put their fake
 * installs. A real `claude` never lives there.
 */
export function isTestScratchPath(p: string): boolean {
  const resolved = path.resolve(p)
  const roots = new Set([os.tmpdir(), '/tmp', '/private/tmp'])
  try { roots.add(fs.realpathSync(os.tmpdir())) } catch { /* keep the others */ }
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
  }
  return false
}
