/**
 * Whether this Walnut may change the Mac by itself: Do Not Disturb and Spotify.
 *
 * A test copy of Walnut (an ephemeral server, a fixture with its data in the temp dir)
 * starts from a copy of the real Walnut's state, the running block and the record of the
 * Do Not Disturb that block turned on included. Left to itself it acts on that copy: at the
 * copied block's end it runs "Walnut Focus Off" and turns off the Do Not Disturb of the
 * person's own block on their real Walnut (2026-11-01: a test copy started while the
 * person's 60 minute block ran took that Do Not Disturb as its own). So a test copy reads
 * the Mac but never changes it, unless the test asks for that on purpose with
 * WALNUT_RHYTHM_REAL_MAC=1.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REAL_MAC_ENV = 'WALNUT_RHYTHM_REAL_MAC'

/**
 * Why this Walnut leaves the Mac alone, or null when it may change it. The same signals
 * the core uses to keep a test server off the embedding model (semantic-default.ts):
 * an ephemeral child, a test runner, data in the temp folder or in a Walnut task
 * directory, or a HOME that is not the account's own.
 */
export function testCopyReason(input: {
  dataDir: string
  argv?: readonly string[]
  env?: Record<string, string | undefined>
  tmpRoots?: readonly string[]
  /** The account's own home folder, from the user database (never $HOME). */
  accountHome?: string | null
}): string | null {
  const env = input.env ?? process.env
  if (env[REAL_MAC_ENV] === '1') return null
  const argv = input.argv ?? process.argv
  if (argv.includes('--_ephemeral-child')) return 'an ephemeral test server'
  if (env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === 'test') return 'a test run'
  const roots = input.tmpRoots ?? [os.tmpdir(), '/tmp']
  if (underAny(input.dataDir, roots)) return 'a Walnut with its data in the temp folder'
  const accountHome = input.accountHome !== undefined ? input.accountHome : accountHomeDir()
  const taskRoots = [
    ...(accountHome ? [path.join(env.XDG_STATE_HOME || path.join(accountHome, '.local', 'state'), 'open-walnut', 'tasks')] : []),
    ...(env.WALNUT_TASK_DIR && path.isAbsolute(env.WALNUT_TASK_DIR) ? [env.WALNUT_TASK_DIR] : []),
  ]
  if (underAny(input.dataDir, taskRoots)) return 'a Walnut with its data in a task folder'
  if (env.HOME && accountHome && !sameDir(env.HOME, accountHome)) return 'a Walnut with a stand-in home folder'
  return null
}

function accountHomeDir(): string | null {
  try { return os.userInfo().homedir || null } catch { return null }
}

function sameDir(a: string, b: string): boolean {
  const ra = withReal(a)
  return withReal(b).some((one) => ra.includes(one))
}

function underAny(target: string, roots: readonly string[]): boolean {
  const targets = withReal(target)
  for (const root of roots.flatMap(withReal)) {
    for (const one of targets) {
      const rel = path.relative(root, one)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true
    }
  }
  return false
}

function withReal(p: string): string[] {
  const out = new Set([path.resolve(p)])
  try { out.add(fs.realpathSync(p)) } catch { /* may not exist yet */ }
  return [...out]
}
