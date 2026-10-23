/**
 * The build a host server runs: this Mac's own dist, packed for the host
 * (docs/plan/walnut-servers-everywhere.md, "Lifecycle"). The host installs its
 * npm dependencies itself (they are native to its system), once per set of
 * dependencies; the build itself is this tarball.
 *
 *   <id>.tgz  package/dist/**  without source maps, precompressed copies and
 *             the daemon binaries (a host server never starts a daemon)
 *
 * The cloud companion gets the same build plus the session daemon for its own
 * platform, since it starts session daemons (docs/plan/walnut-companion-unified-replica.md,
 * stage 1):
 *
 *   <id>-companion-<platform>-<arch>.tgz  the host package plus
 *             package/dist/daemon-binaries without other platforms' binaries
 *
 * Built once per build id and kept in the data dir's cache.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WALNUT_HOME } from '../../constants.js'
import { findBuildInfoFile, readBuildInfoFile } from '../../lib/build-info.js'
import { buildIdOf } from '../companion-build/wire.js'
import { singleFile } from '../../lib/single-file.js'

export interface HostAppPackage {
  /** Names this build on the host: version, commit, and a mark for a dirty tree. */
  id: string
  version: string
  /** The npm dependencies this build needs, and their hash (one install per hash). */
  dependencies: Record<string, string>
  depsHash: string
  /** The `package.json` the build's directory gets on the host. */
  appPackageJson: string
  tgz: Buffer
}

export interface CompanionAppPackage extends HostAppPackage {
  /** The package's optionalDependencies ({} when it has none); the companion installs them too. */
  optionalDependencies: Record<string, string>
  /** One install per set of dependencies AND optional dependencies. */
  companionDepsHash: string
}


/** Keep the newest few packages of each family (host, companion). */
const KEEP_PER_FAMILY = 3
/** The clock a dirty build without a build time is marked with: one id per process, not per call. */
const PROCESS_STARTED = Date.now()

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** The dist this server runs from, and the package root above it. */
export function runningDist(start = path.dirname(fileURLToPath(import.meta.url))): { distDir: string; root: string } | null {
  // The compiled file's unpacked tree has a build-info but no code to install on a host.
  if (singleFile()) return null
  const file = findBuildInfoFile(start)
  if (!file) return null
  const distDir = path.dirname(file)
  const root = path.dirname(distDir)
  return fs.existsSync(path.join(root, 'package.json')) ? { distDir, root } : null
}

function noBuildMessage(where: string): string {
  return singleFile()
    ? `This is the compiled walnut file, which cannot install Walnut on ${where} yet: run a Node build of Walnut for that.`
    : `This server is not running from a build, so there is nothing to install on ${where} (run \`npm run build\`).`
}

function tar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`tar failed: ${String(stderr || err.message).trim().slice(-300)}`))
      else resolve()
    })
  })
}

interface BuildFacts {
  id: string
  version: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  depsHash: string
  appPackageJson: string
}

async function readBuild(dist: { distDir: string; root: string }): Promise<BuildFacts> {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(dist.root, 'package.json'), 'utf8')) as {
    name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>
  }
  const info = readBuildInfoFile(path.join(dist.distDir, 'build-info.json'), pkg.version ?? '0.0.0')
  const dependencies = pkg.dependencies ?? {}
  return {
    id: buildIdOf(info, PROCESS_STARTED),
    version: info.version,
    dependencies,
    optionalDependencies: pkg.optionalDependencies ?? {},
    depsHash: sha(JSON.stringify(Object.entries(dependencies).sort())).slice(0, 16),
    appPackageJson: JSON.stringify({ name: pkg.name ?? 'open-walnut', version: info.version, private: true, type: 'module' }, null, 2),
  }
}

/** The id this server's own build has (what buildHostAppPackage would name it), or null when not running from a build. */
export async function runningBuildId(dist = runningDist()): Promise<string | null> {
  if (!dist) return null
  return (await readBuild(dist)).id
}

const cacheDir = (): string => path.join(WALNUT_HOME, 'cache', 'host-server')
const COMPANION_FILE = /-companion-[a-z0-9]+-[a-z0-9]+\.tgz$/

/**
 * Keep the newest few of each family. Each family is pruned on its own, so a
 * burst of companion builds never deletes the newest host package, nor the
 * other way round.
 */
async function pruneCache(dir: string): Promise<void> {
  const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.tgz'))
  const aged = await Promise.all(names.map(async (n) => {
    try { return { n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs } } catch { return null }
  }))
  const present = aged.filter((a): a is { n: string; t: number } => a !== null)
  for (const companion of [false, true]) {
    const family = present.filter((a) => COMPANION_FILE.test(a.n) === companion).sort((a, b) => b.t - a.t)
    for (const { n } of family.slice(KEEP_PER_FAMILY)) await fs.promises.rm(path.join(dir, n), { force: true })
  }
}

/** Read the cached tgz, or pack one with `stage(work)` (which lays out work/package) and cache it. */
async function cachedOrPacked(file: string, stage: (work: string) => Promise<string[]>): Promise<Buffer> {
  const dir = cacheDir()
  const cached = path.join(dir, file)
  try { return await fs.promises.readFile(cached) } catch { /* build it */ }
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-host-pack-'))
  try {
    await fs.promises.mkdir(path.join(work, 'package'))
    const extra = await stage(work)
    const out = path.join(work, 'app.tgz')
    // -h follows the links the stage made; both GNU tar and bsdtar take these flags.
    await tar(['-czhf', out, '--exclude=*.map', '--exclude=*.gz', ...extra, 'package'], work)
    const tgz = await fs.promises.readFile(out)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(`${cached}.tmp`, tgz)
    await fs.promises.rename(`${cached}.tmp`, cached)
    await pruneCache(dir)
    return tgz
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true })
  }
}

export async function buildHostAppPackage(dist = runningDist()): Promise<HostAppPackage> {
  if (!dist) throw new Error(noBuildMessage('a host'))
  const facts = await readBuild(dist)
  const tgz = await cachedOrPacked(`${facts.id}.tgz`, async (work) => {
    await fs.promises.symlink(dist.distDir, path.join(work, 'package', 'dist'))
    return ['--exclude=package/dist/daemon-binaries']
  })
  return { id: facts.id, version: facts.version, dependencies: facts.dependencies, depsHash: facts.depsHash, appPackageJson: facts.appPackageJson, tgz }
}

/** A file in dist/daemon-binaries built for one platform: `daemon-linux-arm64`, `dtach-darwin-x64.source-hash`. */
const PLATFORM_FILE = /^(?:daemon|dtach)-(linux|darwin|win32|freebsd|openbsd|sunos|aix|android)-(x64|arm64|arm|ia32|ppc64|s390x|riscv64|loong64|armv7l)(?:\..+)?$/

/** Does the companion package for platform-arch keep this file of dist/daemon-binaries? */
export function keepsDaemonFile(name: string, platform: string, arch: string): boolean {
  const m = PLATFORM_FILE.exec(name)
  return !m || (m[1] === platform && m[2] === arch)
}

export async function buildCompanionAppPackage(
  target: { platform: string; arch: string },
  dist = runningDist(),
): Promise<CompanionAppPackage> {
  const { platform, arch } = target
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`The cloud companion runs on ${platform}; this Mac only builds for linux or darwin.`)
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`The cloud companion runs on ${arch}; this Mac only builds for x64 or arm64.`)
  if (!dist) throw new Error(noBuildMessage('the companion'))
  const binDir = path.join(dist.distDir, 'daemon-binaries')
  const daemon = `daemon-${platform}-${arch}`
  try {
    await fs.promises.access(path.join(binDir, daemon))
  } catch {
    throw new Error(`this Mac's build has no session daemon for ${platform}-${arch}; run scripts/build-daemon.sh and build again`)
  }
  const facts = await readBuild(dist)
  const tgz = await cachedOrPacked(`${facts.id}-companion-${platform}-${arch}.tgz`, async (work) => {
    // A real dist dir of links: every entry of the build, and a daemon-binaries
    // dir that links only the files this platform keeps.
    const stageDist = path.join(work, 'package', 'dist')
    await fs.promises.mkdir(stageDist)
    for (const name of await fs.promises.readdir(dist.distDir)) {
      if (name === 'daemon-binaries') continue
      await fs.promises.symlink(path.join(dist.distDir, name), path.join(stageDist, name))
    }
    await fs.promises.mkdir(path.join(stageDist, 'daemon-binaries'))
    for (const name of await fs.promises.readdir(binDir)) {
      if (!keepsDaemonFile(name, platform, arch)) continue
      await fs.promises.symlink(path.join(binDir, name), path.join(stageDist, 'daemon-binaries', name))
    }
    return []
  })
  return {
    id: facts.id,
    version: facts.version,
    dependencies: facts.dependencies,
    depsHash: facts.depsHash,
    optionalDependencies: facts.optionalDependencies,
    companionDepsHash: sha(JSON.stringify([Object.entries(facts.dependencies).sort(), Object.entries(facts.optionalDependencies).sort()])).slice(0, 16),
    appPackageJson: facts.appPackageJson,
    tgz,
  }
}
