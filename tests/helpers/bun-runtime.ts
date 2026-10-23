/**
 * The bun a test starts its servers, fixtures and scripts with.
 *
 * Everything in the test pipeline runs on bun except the Playwright runner, which
 * stays on Node. In a bun process (every vitest worker, every fixture server) that
 * is the process's own bun; in the Playwright runner and its configs, the first
 * `bun` on PATH, which is where CI's setup-bun and a developer's pinned bun put it.
 * Never `node`, `tsx` or `npx`: a child that needs one of them fails on a machine
 * with no Node at all, which is what CI's test jobs are.
 */
import fs from 'node:fs'
import path from 'node:path'

let found: string | null = null

/** The absolute path of the bun to run, or a thrown error naming what to install. */
export function bunRuntime(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof process.versions.bun === 'string') return process.execPath
  if (found) return found
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'bun')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      found = fs.realpathSync(candidate)
      return found
    } catch { /* next */ }
  }
  throw new Error('no bun on PATH: every test server runs on bun (curl -fsSL https://bun.sh/install | bash, the version package.json pins)')
}

/** The same, quoted for a shell command line (a Playwright webServer command). */
export function bunCommand(env: NodeJS.ProcessEnv = process.env): string {
  return JSON.stringify(bunRuntime(env))
}
