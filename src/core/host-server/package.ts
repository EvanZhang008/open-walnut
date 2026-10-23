/**
 * The dist this server runs from, with its build id and build info: what the
 * walnut file source (host-file.ts) starts from when this server runs a built
 * checkout rather than the compiled file. Every host server and the cloud
 * companion run the compiled walnut file (host-file.ts, companion-build/package.ts):
 * no dist is packed for any of them.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBuildInfoFile, readBuildInfoFile, type BuildInfo } from '../../lib/build-info.js'
import { buildIdOf } from '../companion-build/wire.js'
import { singleFile } from '../../lib/single-file.js'

/** The clock a dirty build without a build time is marked with: one id per process, not per call. */
const PROCESS_STARTED = Date.now()

/** The dist this server runs from, and the package root above it. */
export function runningDist(start = path.dirname(fileURLToPath(import.meta.url))): { distDir: string; root: string } | null {
  // The compiled file's unpacked tree has a build-info but no code to install on a box.
  if (singleFile()) return null
  const file = findBuildInfoFile(start)
  if (!file) return null
  const distDir = path.dirname(file)
  const root = path.dirname(distDir)
  return fs.existsSync(path.join(root, 'package.json')) ? { distDir, root } : null
}

/** The id and build info of a dist (its package.json and build-info.json). */
export async function readRunningBuild(dist: { distDir: string; root: string }): Promise<{ id: string; info: BuildInfo }> {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(dist.root, 'package.json'), 'utf8')) as { version?: string }
  const info = readBuildInfoFile(path.join(dist.distDir, 'build-info.json'), pkg.version ?? '0.0.0')
  return { id: buildIdOf(info, PROCESS_STARTED), info }
}
