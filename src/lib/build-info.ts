/**
 * Which build is running. package.json only changes on an npm release, so a
 * checkout of today's main reports the same version as the last npm install;
 * the commit and build time recorded by scripts/build-info.mjs (as
 * dist/build-info.json) tell them apart in bug reports and support threads.
 *
 * Read once per process. Running from source (tsx, vitest) there is no build,
 * so the answer is the package version with nulls: never a dist left over from
 * an earlier build, which would name a commit this process is not running.
 *
 * Kept dependency-free (fs/path only) because the slim CLI entry imports it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getVersion } from '../core/version.js'

export const BUILD_INFO_FILE = 'build-info.json'

export interface BuildInfo {
  /** package.json version at build time. */
  version: string
  /** Short git sha; null outside a git checkout (e.g. the npm tarball). */
  commit: string | null
  /** Branch name; null outside a checkout or on a detached HEAD. */
  branch: string | null
  /** ISO time of the build; null when running from source. */
  builtAt: string | null
  /** The checkout had uncommitted changes to tracked files. */
  dirty: boolean
}

function unbuilt(version: string): BuildInfo {
  return { version, commit: null, branch: null, builtAt: null, dirty: false }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Parse one build-info file; anything missing or malformed degrades to `fallbackVersion` + nulls. */
export function readBuildInfoFile(file: string, fallbackVersion: string): BuildInfo {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return unbuilt(fallbackVersion)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unbuilt(fallbackVersion)
  const r = raw as Record<string, unknown>
  const builtAt = text(r.builtAt)
  return {
    version: text(r.version) ?? fallbackVersion,
    commit: text(r.commit),
    branch: text(r.branch),
    builtAt: builtAt && !Number.isNaN(Date.parse(builtAt)) ? builtAt : null,
    dirty: r.dirty === true,
  }
}

function isWalnutPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { name?: unknown }
    return pkg.name === 'open-walnut'
  } catch {
    return false
  }
}

/**
 * Walk up from a bundle's directory to `build-info.json` (dist/cli.js → dist/,
 * dist/web/server.js → dist/). The package root ends the walk: the file lives
 * below it in dist/, so reaching the root means this code is not a build.
 */
export function findBuildInfoFile(startDir: string, maxLevels = 5): string | null {
  let dir = startDir
  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(dir, BUILD_INFO_FILE)
    if (fs.existsSync(candidate)) return candidate
    if (isWalnutPackageRoot(dir)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

let cached: BuildInfo | null = null

export function getBuildInfo(): BuildInfo {
  if (cached) return cached
  let file: string | null = null
  try {
    file = findBuildInfoFile(path.dirname(fileURLToPath(import.meta.url)))
  } catch { /* unbuilt below */ }
  cached = file ? readBuildInfoFile(file, getVersion()) : unbuilt(getVersion())
  return cached
}

/** Local calendar date (YYYY-MM-DD) of an ISO time, or null. */
export function buildDate(builtAt: string | null): string | null {
  if (!builtAt) return null
  const d = new Date(builtAt)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `0.4.5 (3942cf7+dirty, 2026-09-24)`; just `0.4.5` when running from source. */
export function formatBuildVersion(info: BuildInfo): string {
  const parts: string[] = []
  if (info.commit) parts.push(info.dirty ? `${info.commit}+dirty` : info.commit)
  const date = buildDate(info.builtAt)
  if (date) parts.push(date)
  return parts.length ? `${info.version} (${parts.join(', ')})` : info.version
}

export function _resetBuildInfoForTest(): void {
  cached = null
}
