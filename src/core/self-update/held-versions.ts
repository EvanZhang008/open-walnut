/**
 * Versions an automatic update leaves alone until a newer one is published:
 *
 *   - one that crashed before it served: the startup update went back from it
 *     (startup-update.ts) and marked it bad;
 *   - for a binary install, one the user moved back from: an older version is
 *     linked while the newer one is still installed beside it (a hand-made
 *     link, or install.sh run with an older OPEN_WALNUT_VERSION).
 *
 * The marks:
 *
 *   binary install:  <root>/bad/<version>
 *   npm install:     <WALNUT_HOME>/local/update-bad/<version>  (machine-local, never synced)
 *
 * An update the user asks for (`walnut update` without --auto) installs it
 * anyway and clears the mark.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { InstallInfo } from './install-kind.js'
import { compareVersions } from './version-compare.js'

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Where this install's bad marks live, or null for an install that never updates itself. */
export function badDirFor(install: Pick<InstallInfo, 'kind' | 'binary'>, walnutHome: string): string | null {
  if (install.kind === 'binary' && install.binary) return path.join(install.binary.root, 'bad')
  if (install.kind === 'npm') return path.join(walnutHome, 'local', 'update-bad')
  return null
}

export function markBad(dir: string, version: string, reason: string): void {
  if (!VERSION_RE.test(version)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, version), `${new Date().toISOString()} ${reason}\n`)
}

export function clearBad(dir: string | null, version: string): void {
  if (!dir || !VERSION_RE.test(version)) return
  fs.rmSync(path.join(dir, version), { force: true })
}

/**
 * Why `latest` is held back here, or null when an automatic update may install
 * it. Never throws: an unreadable directory holds nothing back.
 */
export function heldBack(install: Pick<InstallInfo, 'kind' | 'binary'>, latest: string, badDir: string | null): string | null {
  if (badDir && VERSION_RE.test(latest) && fs.existsSync(path.join(badDir, latest))) {
    return `${latest} did not start here before (${path.join(badDir, latest)}); it is skipped until a newer release is published`
  }
  const binary = install.kind === 'binary' ? install.binary : null
  if (!binary) return null
  let names: string[] = []
  try { names = fs.readdirSync(path.join(binary.root, 'versions')) } catch { return null }
  for (const name of names) {
    if (!VERSION_RE.test(name) || !fs.existsSync(path.join(binary.root, 'versions', name, 'walnut'))) continue
    const aboveCurrent = compareVersions(name, binary.version)
    const coversLatest = compareVersions(latest, name)
    if (aboveCurrent !== null && aboveCurrent > 0 && coversLatest !== null && coversLatest <= 0) {
      return `this install was moved back from ${name} to ${binary.version}; it updates again when a release newer than ${name} is published`
    }
  }
  return null
}
