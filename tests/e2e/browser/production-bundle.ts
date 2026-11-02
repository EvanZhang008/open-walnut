/**
 * Serve the production build of the SPA to one page of the dev fixture, for the
 * specs that judge main-thread time (C38).
 *
 * The fixture serves the SPA through Vite in development mode, and React's
 * development build is not the product: every component renders twice
 * (StrictMode), and every element captures a debug stack, which with the
 * inspector Playwright attaches costs 30 to 60 µs an element. On 2026-11-01 a
 * Question stack pop read 154 to 206 ms there and 57 to 68 ms in the production
 * build of the same code, where most of the task was style recalc. A long
 * task budget judged on the development build measures React's debugging, so
 * these specs load the bundle users run, with the same budget.
 *
 * The bundle is `dist/web/static` (CI's browser job builds it before the tests:
 * `cd web && bun x vite build`). The document and its static files come from it;
 * everything else (/api, /ws) still reaches the fixture. A build older than the
 * sources would measure other code, so it is refused, with the command that
 * makes a fresh one: a failure when CI is set (CI's job, and every `walnut-dev
 * run`), a skip in a plain local run. The check is by file time, so a dist/ a
 * deploy copied in (scripts/deploy-committed.sh: the committed HEAD's build) can
 * pass for fresh beside uncommitted edits: build again after editing. With
 * PW_BUILT_SPA=1 the fixture serves that build itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, type Page } from '@playwright/test'

const REPO = path.resolve(import.meta.dirname, '../../..')
export const BUNDLE_DIR = path.join(REPO, 'dist/web/static')
// What the bundle is built from: the SPA, and the server modules its aliases
// (web/vite.config.ts `@open-walnut/*`) compile in.
const SOURCES = ['web/src', 'web/index.html', 'web/vite.config.ts', 'web/public', 'src/core', 'src/lib'].map((p) => path.join(REPO, p))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

function newestMtime(p: string): number {
  let st: fs.Stats
  try { st = fs.statSync(p) } catch { return 0 }
  if (!st.isDirectory()) return st.mtimeMs
  let newest = st.mtimeMs
  for (const f of fs.readdirSync(p)) newest = Math.max(newest, newestMtime(path.join(p, f)))
  return newest
}

/** Why the production bundle cannot be used now, or null when it can. */
export function productionBundleProblem(): string | null {
  if (process.env.PW_BUILT_SPA === '1') return null
  const index = path.join(BUNDLE_DIR, 'index.html')
  let built: number
  try { built = fs.statSync(index).mtimeMs } catch {
    return `no production build at ${BUNDLE_DIR}: run \`cd web && bun x vite build\` first`
  }
  const sources = Math.max(...SOURCES.map(newestMtime))
  if (sources > built) return `the production build at ${BUNDLE_DIR} is older than web/src: run \`cd web && bun x vite build\` again`
  return null
}

/**
 * Route this page's document and static files to the production build. Call
 * before the first navigation. A no-op when the fixture serves it already.
 */
export async function serveProductionBundle(page: Page): Promise<void> {
  if (process.env.PW_BUILT_SPA === '1') return
  const problem = productionBundleProblem()
  if (problem && process.env.CI) throw new Error(problem)
  test.skip(!!problem, problem ?? '')
  const index = fs.readFileSync(path.join(BUNDLE_DIR, 'index.html'))
  await page.route((url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return route.fallback()
    const file = path.join(BUNDLE_DIR, decodeURIComponent(url.pathname))
    if (file.startsWith(BUNDLE_DIR + path.sep)) {
      let body: Buffer | undefined
      try { body = fs.readFileSync(file) } catch { /* not a file of the build */ }
      if (body) return route.fulfill({ status: 200, body, headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' } })
    }
    // The SPA's own routes: the page's navigations only (a frame's document,
    // a plugin app say, is the fixture's to answer).
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      return route.fulfill({ status: 200, body: index, headers: { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' } })
    }
    return route.fallback()
  })
}
