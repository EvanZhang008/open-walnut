/**
 * The name of a request a middleware answered before its route, for real use
 * (core/usage-watch, request-logger.ts).
 *
 * Real use names a request by the route Express matched (`req.route`). A middleware that answers
 * before the route, as the companion's copy readers do (replica/companion-copy-routes.ts,
 * companion-note-writes.ts: the phone's skill list, a note save while the Mac is away), leaves no
 * route, and the request was counted nowhere (2026-11-24 review). A router whose middlewares may
 * answer so puts `nameAnswersHere()` first; at the answer's end the logger asks which route of the
 * app the path would have reached, by the routers' own matchers in Express's order, and names the
 * request as that route. A route that did answer names it itself. Only those routers opt in: a
 * guard that answers for every route (a start-up gate, a sign-in check) stays out of the routes'
 * numbers, as before.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

interface RouteLike { path: unknown; methods?: Record<string, boolean> }
type Matcher = (path: string) => false | { path: string }
interface LayerLike { route?: RouteLike; matchers?: Matcher[]; slash?: boolean; handle?: { stack?: LayerLike[] } }

const SEEN = 'walnutNameAnswers'

function handles(route: RouteLike, method: string): boolean {
  const m = route.methods ?? {}
  const name = method.toLowerCase()
  return Boolean(m._all || m[name] || (name === 'head' && m.get))
}

/**
 * The route `method path` reaches in `stack`, as Express dispatches it: a router's mount matches a
 * head of the path and its own stack the rest. The mount part is the path's own text, as
 * `req.baseUrl` is. Matchers only read the path (Layer.prototype.match would store params on the
 * shared layer).
 */
export function routeOf(stack: readonly LayerLike[], method: string, path: string, base = ''): { baseUrl: string; routePath: string } | null {
  for (const layer of stack) {
    const route = layer.route
    if (route) {
      if (!handles(route, method)) continue
      const paths = Array.isArray(route.path) ? route.path : [route.path]
      const matchers = layer.matchers ?? []
      for (let i = 0; i < matchers.length; i++) {
        if (matchers[i]!(path)) return typeof paths[i] === 'string' ? { baseUrl: base, routePath: paths[i] as string } : null
      }
      continue
    }
    const inner = layer.handle?.stack
    if (!Array.isArray(inner)) continue
    let head: string | null = layer.slash ? '' : null
    for (const m of layer.slash ? [] : layer.matchers ?? []) { const hit = m(path); if (hit) { head = hit.path; break } }
    if (head === null) continue
    const rest = path.slice(head.length)
    const found = routeOf(inner, method, rest.startsWith('/') ? rest : `/${rest}`, base + head)
    if (found) return found
  }
  return null
}

/** The first layer of a router whose middlewares may answer before its routes. */
export function nameAnswersHere(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.locals[SEEN] = true
    next()
  }
}

/**
 * Where the request is named: its route; for a route registered with a list of paths (Express gives
 * `req.route.path` as the list: system.ts LIVENESS_ALIASES), the one the path matched; past
 * `nameAnswersHere`, the route it would have reached; else none.
 */
export function answerName(req: Request, res: Response): { baseUrl: string; routePath: unknown } {
  if (req.route && !Array.isArray(req.route.path)) return { baseUrl: req.baseUrl, routePath: req.route.path }
  if (!req.route && res.locals?.[SEEN] !== true) return { baseUrl: req.baseUrl, routePath: undefined }
  const app = req.app as unknown as { router?: { stack?: LayerLike[] } } | undefined
  const found = routeOf(app?.router?.stack ?? [], req.method, (req.originalUrl ?? '').split('?')[0] ?? '')
  return found ?? { baseUrl: req.baseUrl, routePath: undefined }
}
