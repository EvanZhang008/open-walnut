/**
 * App version — read once from the nearest package.json (works from both
 * src/ under tsx and dist/ bundles), cached for the process lifetime.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedVersion: string | null = null

export function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    // Walk up from this module (works from both src/ under tsx and dist/ bundles).
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string }
        if (pkg.version) { cachedVersion = pkg.version; return cachedVersion }
      }
      dir = path.dirname(dir)
    }
  } catch { /* fall through */ }
  cachedVersion = '0.0.0'
  return cachedVersion
}
