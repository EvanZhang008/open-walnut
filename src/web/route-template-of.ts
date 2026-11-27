/**
 * The route template an Express app WOULD match for a method and URL, without running a request
 * and without changing the router. Used to name a request a page says failed before it ever
 * reached the server: one rejected in the page's connection queue was never answered, so the
 * answered templates alone left it "unknown request" (2026-11-22, right after a restart); and to
 * read a route watch target as the route its server records (core/usage-watch/route-target.ts).
 *
 * The walk is the one real use names a request a middleware answered by (middleware/answer-name.ts
 * routeOf: each layer's matchers called directly, a route registered with a list of paths named by
 * the one that matched), so a route is named here as its requests are recorded. Until 2026-11-27 this
 * file walked the router its own way and skipped a route with a list of paths (GET /api/health, the
 * liveness aliases): set refused a watch on a route real use counted. A route may hand a path on to a
 * later one (`next()`: task-v1.ts GET /tasks/:id passes `enriched` and `groups` to their own routes),
 * so routeTemplatesOf names every route the path reaches, in Express's order.
 */
import { registeredTemplate } from '../core/usage-watch/normalize.js'
import { routesOf } from './middleware/answer-name.js'

/** `GET /api/routines/:id` for (`GET`, `/api/routines/abc?x=1`), or null when no route takes it. */
export function routeTemplateOf(router: unknown, method: string, url: string): string | null {
  return routeTemplatesOf(router, method, url, 1)[0] ?? null
}

/** Every route template `method url` reaches, first the one Express tries first (at most `max`). */
export function routeTemplatesOf(router: unknown, method: string, url: string, max = 20): string[] {
  const stack = (router as { stack?: Parameters<typeof routesOf>[0] } | null)?.stack
  if (!Array.isArray(stack)) return []
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith('/')) return []
  const out: string[] = []
  try {
    for (const found of routesOf(stack, method, path)) {
      // A pattern route names no template, and nothing after it is named in its place.
      if (!found) break
      const template = registeredTemplate(found.baseUrl, found.routePath)
      if (template === 'unmatched') break
      const name = `${method} ${template}`
      if (!out.includes(name)) out.push(name)
      if (out.length >= max) break
    }
  } catch {
    // A matcher that throws names nothing past it.
  }
  return out
}
