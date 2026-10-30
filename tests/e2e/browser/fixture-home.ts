/**
 * Gives a browser fixture server its own home directory, for real.
 *
 * Bun reads HOME once when the process starts: `process.env.HOME = dir` afterwards
 * changes what child processes inherit, but `os.homedir()` in the server itself keeps
 * returning the developer's home (2026-10-30: since the fixtures moved to bun on
 * 2026-10-23, the folder picker's Quick access listed the real home, and every one of
 * the server's ~100 `os.homedir()` reads, ~/.claude and ~/.ssh among them, pointed
 * outside the fixture). So the first process starts the same script again with HOME
 * in its environment and waits for it; the second one finds its home already set.
 *
 * tests/scripts/prebuilt-artifact-ratchet.test.ts fails for a fixture server that sets
 * process.env.HOME without this.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

const MARK = 'WALNUT_FIXTURE_HOME'
const REAL_HOME = 'WALNUT_FIXTURE_REAL_HOME'

/**
 * The fixture's home: `wanted` (a path, or a function that makes one, called only
 * in the first process, so a temp dir is made once) on first start; never returns
 * in that process.
 */
export async function fixtureHome(wanted: string | (() => string)): Promise<string> {
  const inherited = process.env[MARK]
  if (inherited) {
    if (os.homedir() !== inherited) throw new Error(`fixture home: expected os.homedir() to be ${inherited}, got ${os.homedir()}`)
    return inherited
  }
  const home = typeof wanted === 'function' ? wanted() : wanted
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [MARK]: home, [REAL_HOME]: os.homedir(), HOME: home, USERPROFILE: home },
  })
  // Playwright's graceful stop signals this process only; the server's own
  // shutdown handler (in the child) is what tears the fixture down.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal) })
  }
  const code = await new Promise<number>((resolve) => {
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    child.on('error', () => resolve(1))
  })
  process.exit(code)
}

/** The developer's own home, where bun and the toolchain live (the fixture's
 *  children that build need it). */
export function fixtureRealHome(): string {
  return process.env[REAL_HOME] || os.homedir()
}
