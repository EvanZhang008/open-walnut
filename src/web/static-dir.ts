/**
 * Where this server's built web app lives (dist/web/static): the SPA it serves, and the files
 * beside it (downloads/ holds the browser extension's zips). `WALNUT_WEB_STATIC_DIR` wins, and is
 * accepted even when it does not exist: that is how a test exercises the "assets vanished" path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveStaticDir(from: string = import.meta.url): string {
  if (process.env.WALNUT_WEB_STATIC_DIR) return process.env.WALNUT_WEB_STATIC_DIR
  // tsup inlines this into both dist/web/server.js and dist/cli.js, so the caller's
  // import.meta.url varies per bundle: walk up to find dist/web/static/.
  let dir = path.dirname(fileURLToPath(from))
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'web', 'static', 'index.html')
    try { if (fs.statSync(candidate).isFile()) return path.join(dir, 'web', 'static') } catch {}
    // Also check if we're already in dist/web/
    const direct = path.join(dir, 'static', 'index.html')
    try { if (fs.statSync(direct).isFile()) return path.join(dir, 'static') } catch {}
    dir = path.dirname(dir)
  }
  // Fallback: assume dist/web/static relative to cwd
  return path.join(process.cwd(), 'dist', 'web', 'static')
}
