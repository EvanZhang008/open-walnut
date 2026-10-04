/**
 * The box's tunnel daemon as a test drives it: which build it runs, a second
 * "release" of that build, and ending its CLIs at teardown.
 *
 * Why a test build: the tunnel daemon of a real box is replaced whenever the
 * companion deploys a new build (LocalDaemon's version check), and that
 * replacement must hand its CLIs to the successor. Proving it needs two
 * daemons that report DIFFERENT versions. A normal build bakes its version in
 * (build-daemon.sh `--define`); this one is compiled from the current source
 * without it, so it reports DAEMON_VERSION from its environment, and one binary
 * plays both releases (stageDaemonRelease). Without bun, callers fall back to
 * the prebuilt dist binary and skip the upgrade case.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BINARY_NAME = `daemon-${process.platform}-${process.arch}`

/** The prebuilt daemon the server itself would pick (build-daemon.sh output). */
export const DIST_DAEMON_BINARY = path.join(REPO_ROOT, 'dist', 'daemon-binaries', BINARY_NAME)

/** bun, found the way scripts/build-daemon.sh finds it; null when absent. */
export function findBun(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'bun')
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next */ }
  }
  return null
}

/** Compile the daemon from the current source, version read at run time. Null without bun. */
export async function buildTestDaemon(outDir: string): Promise<string | null> {
  const bun = findBun()
  if (!bun) return null
  await fsp.mkdir(outDir, { recursive: true })
  const out = path.join(outDir, BINARY_NAME)
  await new Promise<void>((resolve, reject) => {
    execFile(bun, [
      'build', '--compile', `--target=bun-${process.platform}-${process.arch}`, '--minify',
      '--outfile', out, 'src/providers/daemon-standalone.ts',
    ], { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`bun build of the test daemon failed: ${stderr || err.message}`))
      else resolve()
    })
  })
  return out
}

/**
 * One "release" of a runtime-versioned build: the binary under its own dir with
 * a `.version` sidecar, the file LocalDaemon compares the running daemon with.
 * The replica must also run with DAEMON_VERSION=<version>, which its daemon inherits.
 */
export async function stageDaemonRelease(build: string, dir: string, version: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, BINARY_NAME)
  try { await fsp.link(build, target) } catch { await fsp.copyFile(build, target) }
  await fsp.chmod(target, 0o755)
  await fsp.writeFile(`${target}.version`, version)
  return target
}

/**
 * The tunnel daemon keeps its CLIs when it exits (WALNUT_DAEMON_KEEP_SESSIONS),
 * so a test that stops it must end them itself: every live process group named
 * by a `.pgid` in its streams dir. These are the mock CLI, never a real claude.
 */
export function endTunnelSessionGroups(tunnelDir: string): number[] {
  // Same rule as tunnelStreamsDir (src/providers/cloud-tunnel-daemon.ts): a
  // per-owner dir `<base>.by-device/<owner>/daemon` keeps its streams beside it.
  const keyed = path.basename(tunnelDir) === 'daemon' && path.basename(path.dirname(path.dirname(tunnelDir))).endsWith('.by-device')
  const streams = keyed ? path.join(path.dirname(tunnelDir), 'streams') : `${tunnelDir}-streams`
  const ended: number[] = []
  let names: string[] = []
  try { names = fs.readdirSync(streams).filter((f) => f.endsWith('.pgid')) } catch { return ended }
  for (const name of names) {
    const pid = Number(fs.readFileSync(path.join(streams, name), 'utf-8').trim())
    if (!Number.isInteger(pid) || pid <= 1) continue
    try { process.kill(-pid, 'SIGTERM'); ended.push(pid) } catch { /* already gone */ }
  }
  return ended
}
