/**
 * The bundled Drawing plugin (plugin-store/walnut-drawing) as its fixture server links it:
 * built, and never older than its source. Its dist/ is not committed, so a fresh checkout (a CI
 * runner, a new clone) builds it here, with the repo's own Plugin CLI. Never skips: a build
 * that cannot run is an error that says what to run.
 *
 * Two fixture servers can start at once (two spec files, two workers), so the build holds a
 * lock directory; a lock left by a dead build is taken over after LOCK_STALE_MS.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LOCK_STALE_MS = 5 * 60_000

function newestMtime(target: string): number {
  if (!fs.existsSync(target)) return 0
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of fs.readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, entry)))
  return newest
}

function oldestOutput(files: string[]): number {
  let oldest = Infinity
  for (const file of files) {
    if (!fs.existsSync(file)) return 0
    oldest = Math.min(oldest, fs.statSync(file).mtimeMs)
  }
  return oldest
}

function run(bun: string, args: string[], cwd: string, what: string): void {
  const result = spawnSync(bun, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000 })
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status ?? result.signal}): run \`bun ${args.join(' ')}\` in ${cwd}\n${(result.stdout ?? '').slice(-4000)}${(result.stderr ?? '').slice(-4000)}`)
  }
}

async function withLock<T>(lockDir: string, body: () => T): Promise<T> {
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true })
      else await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  try {
    return body()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

/** Builds the Drawing plugin when its dist is missing or older than its source; returns its directory. */
export async function ensureDrawingPluginBuilt(repoRoot: string, bun: string = process.execPath): Promise<string> {
  const pluginDir = path.join(repoRoot, 'plugin-store', 'walnut-drawing')
  const outputs = [path.join(pluginDir, 'dist', 'web.mjs'), path.join(pluginDir, 'dist', 'server.mjs')]
  const inputs = [path.join(pluginDir, 'src'), path.join(pluginDir, 'manifest.json'), path.join(pluginDir, 'package.json')]
  const fresh = () => oldestOutput(outputs) >= Math.max(...inputs.map(newestMtime))
  if (fresh()) return pluginDir
  await withLock(path.join(pluginDir, '.fixture-build-lock'), () => {
    if (fresh()) return
    const cli = path.join(repoRoot, 'packages', 'plugin-cli', 'dist', 'cli.js')
    // The CLI is a workspace package with no committed build; build:plugins builds it and the API it uses.
    if (!fs.existsSync(cli)) run(bun, ['run', 'build:plugins'], repoRoot, 'Building the Plugin CLI')
    if (!fs.existsSync(cli)) throw new Error(`The Plugin CLI is missing at ${cli} after \`bun run build:plugins\``)
    run(bun, [cli, 'build', '--root', pluginDir], repoRoot, 'Building the Drawing plugin')
    if (!fresh()) throw new Error(`The Drawing plugin build left no fresh ${outputs.join(' and ')}`)
  })
  return pluginDir
}
