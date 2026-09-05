/**
 * App version: the build bakes it in (tsup `define`); running from source falls
 * back to the nearest package.json. Cached for the process lifetime.
 *
 * Stays dependency-free on purpose (no logger): callers that care about an unknown
 * version ask `isVersionKnown()` and log it themselves.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedVersion: string | null = null
let versionKnown = false

export function getVersion(): string {
  if (cachedVersion) return cachedVersion
  // Baked in at build time, so a bundle never depends on where package.json landed.
  if (typeof __WALNUT_VERSION__ !== 'undefined' && __WALNUT_VERSION__) {
    cachedVersion = __WALNUT_VERSION__
    versionKnown = true
    return cachedVersion
  }
  try {
    // Walk up from this module (works from both src/ under tsx and dist/ bundles).
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      // Per-ancestor: one malformed package.json must not abort the whole walk.
      try {
        const candidate = path.join(dir, 'package.json')
        if (fs.existsSync(candidate)) {
          const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string }
          if (pkg.version) { cachedVersion = pkg.version; versionKnown = true; return cachedVersion }
        }
      } catch { /* skip this ancestor */ }
      dir = path.dirname(dir)
    }
  } catch { /* fall through */ }
  cachedVersion = '0.0.0'
  versionKnown = false
  return cachedVersion
}

/**
 * False only when `getVersion()` had to fall back to '0.0.0'. A caller comparing
 * the host version against a plugin's range must treat that as "unknown host",
 * never as "version 0.0.0", since every range would fail and blame the plugin.
 */
export function isVersionKnown(): boolean {
  if (!cachedVersion) getVersion()
  return versionKnown
}
