/**
 * The first import of every Walnut CLI entry (src/cli.ts, src/cli-fast.ts). ES
 * modules run in import order, so this runs before any other module of the
 * entry loads.
 *
 * Walnut runs on bun, or as the compiled walnut file (which is bun inside).
 * Started on Node (`node dist/cli.js`, an old link, a launcher of an older
 * version), the CLI would answer `--version` and then fail at its first
 * database open, so an install check on Node would pass. Refused here instead,
 * in one line that names what to run. bin/open-walnut.js has the same check for
 * the checkout's bin entry.
 *
 * It also drops BUN_BE_BUN from this process's env (dropBunBeBun below).
 *
 * Keep this file free of Walnut imports: it must run before them.
 */
import fs from 'node:fs'

/** Why this process cannot run Walnut, in one line, or null when it can. */
export function runtimeRefusal(versions: NodeJS.ProcessVersions = process.versions): string | null {
  if (typeof (versions as { bun?: string }).bun === 'string') return null
  return `Walnut runs on bun or as the compiled walnut file, and this is Node ${versions.node}: run the same command with bun (https://bun.sh), or install the walnut file: curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh`
}

/**
 * A walnut file runs a dist build as bun only with BUN_BE_BUN=1 in its env (a
 * companion box's smoke boot of a new build, src/core/companion-build/box-smoke.ts).
 * Left in this process's env, every child would inherit it: the session daemon,
 * and the bun-compiled claude CLI, which would then act as the bun CLI instead
 * of itself. Dropped here, before anything can start a child; a child that must
 * be bun gets it from bunCommand() (src/lib/runtime.ts). Returns whether it was set.
 */
export function dropBunBeBun(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BUN_BE_BUN === undefined) return false
  delete env.BUN_BE_BUN
  return true
}

const refusal = runtimeRefusal()
if (refusal) {
  // Written synchronously: process.exit right after an async write can cut it off.
  fs.writeSync(2, `${refusal}\n`)
  process.exit(1)
}
dropBunBeBun()
