/**
 * The build a host server runs: this Mac's own dist, packed for the host
 * (docs/plan/walnut-servers-everywhere.md, "Lifecycle"). The host installs its
 * npm dependencies itself (they are native to its system), once per set of
 * dependencies; the build itself is this tarball.
 *
 *   <id>.tgz  package/dist/**  without source maps, precompressed copies and
 *             the daemon binaries (a host server never starts a daemon)
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

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** The dist this server runs from, and the package root above it. */
export function runningDist(start = path.dirname(fileURLToPath(import.meta.url))): { distDir: string; root: string } | null {
  const file = findBuildInfoFile(start)
  if (!file) return null
  const distDir = path.dirname(file)
  const root = path.dirname(distDir)
  return fs.existsSync(path.join(root, 'package.json')) ? { distDir, root } : null
}

function tar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`tar failed: ${String(stderr || err.message).trim().slice(-300)}`))
      else resolve()
    })
  })
}

export async function buildHostAppPackage(dist = runningDist()): Promise<HostAppPackage> {
  if (!dist) throw new Error('This server is not running from a build, so there is nothing to install on a host (run `npm run build`).')
  const pkg = JSON.parse(await fs.promises.readFile(path.join(dist.root, 'package.json'), 'utf8')) as {
    name?: string; version?: string; dependencies?: Record<string, string>
  }
  const info = readBuildInfoFile(path.join(dist.distDir, 'build-info.json'), pkg.version ?? '0.0.0')
  const dirtyMark = info.dirty ? `-d${sha(info.builtAt ?? String(Date.now())).slice(0, 6)}` : ''
  const id = `${info.version}-${info.commit ?? 'src'}${dirtyMark}`.replace(/[^A-Za-z0-9._-]/g, '_')
  const dependencies = pkg.dependencies ?? {}
  const depsHash = sha(JSON.stringify(Object.entries(dependencies).sort())).slice(0, 16)
  const appPackageJson = JSON.stringify({ name: pkg.name ?? 'open-walnut', version: info.version, private: true, type: 'module' }, null, 2)

  const cacheDir = path.join(WALNUT_HOME, 'cache', 'host-server')
  const cached = path.join(cacheDir, `${id}.tgz`)
  let tgz: Buffer | null = null
  try { tgz = await fs.promises.readFile(cached) } catch { /* build it */ }
  if (!tgz) {
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-host-pack-'))
    try {
      await fs.promises.mkdir(path.join(work, 'package'))
      await fs.promises.symlink(dist.distDir, path.join(work, 'package', 'dist'))
      const out = path.join(work, 'app.tgz')
      // -h follows the dist link; both GNU tar and bsdtar take these flags.
      await tar(['-czhf', out, '--exclude=*.map', '--exclude=*.gz', '--exclude=package/dist/daemon-binaries', 'package'], work)
      tgz = await fs.promises.readFile(out)
      await fs.promises.mkdir(cacheDir, { recursive: true })
      await fs.promises.writeFile(`${cached}.tmp`, tgz)
      await fs.promises.rename(`${cached}.tmp`, cached)
      // Only the newest few builds are worth keeping.
      const kept = (await fs.promises.readdir(cacheDir)).filter((n) => n.endsWith('.tgz'))
      if (kept.length > 3) {
        const aged = await Promise.all(kept.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(cacheDir, n))).mtimeMs })))
        for (const { n } of aged.sort((a, b) => b.t - a.t).slice(3)) await fs.promises.rm(path.join(cacheDir, n), { force: true })
      }
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true })
    }
  }
  return { id, version: info.version, dependencies, depsHash, appPackageJson, tgz }
}
