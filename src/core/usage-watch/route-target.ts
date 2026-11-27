/**
 * A route watch target, read as the route its server records the requests under.
 *
 * Real use names a request by the template its router matched (`GET /api/sessions/:sessionId/history`,
 * request-record.ts). A watch kept its route target as its setter wrote it, and its verdict matched
 * names letter for letter: 2026-11-27, `route:GET /api/sessions/:id/history` ended "No use" with 0
 * uses while that route served 5,687 requests in four days, and `route:GET /api/v1/org/avatars/:id.png`
 * with 0 while `.../:file` served 192. Now:
 *   - a route target is the route this server's own router serves its path with (web/route-template-of.ts,
 *     handed to answeredTemplates at the server's start), when that route has the target's literal parts
 *     where the target has them: a parameter's name, or its shape within one part, never decides; a
 *     literal part only a parameter route takes (`/api/sessions/working-dirs` under
 *     `/api/sessions/:sessionId`) names no route, one a later route of its own serves after the
 *     parameter route hands it on (`GET /api/v1/tasks/enriched`) names that route, while a splat takes the rest of the path as Express
 *     does (`DELETE /api/v1/notes/attachment/*path` is served, and recorded, as `DELETE /api/v1/notes/*path`);
 *   - a target with no method is a route if any method of its path is served;
 *   - with no router to ask (a replica's test, a bare test), parameter names are left out;
 *   - set refuses a target no route serves, and keeps the name the server records (actions.ts).
 */
import { answeredTemplates } from './record.js'

const PARAM_RE = /:[A-Za-z_$][\w$]*/g
const SPLAT_RE = /\*[A-Za-z_$][\w$]*|\*/g
const MAX_CACHED = 500
/** A target no route served is asked again after this long: a plugin's routes may mount later. */
const NONE_KEPT_MS = 10 * 60_000

/** A template with its parameters' names left out: `/api/sessions/:` for both `:id` and `:sessionId`. */
export function routeShape(template: string): string {
  return template.replace(PARAM_RE, ':').replace(SPLAT_RE, '*')
}

/**
 * A path a template stands for, each parameter a sample value: what the router is asked about. The
 * value is shaped like an id (normalize.ts looksLikeId), so a router mounted under a parameter names it
 * `:id` as the recorder does, never by the sample.
 */
const SAMPLE = 'x0000000a1b2'
export function samplePathOf(template: string): string {
  return template.replace(PARAM_RE, SAMPLE).replace(SPLAT_RE, `${SAMPLE}/${SAMPLE}`)
}

export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function methodAndPath(want: string): { method: string; path: string } | null {
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(want)
  return m ? { method: m[1]!, path: m[2]! } : null
}

/** Whether a served template is the route a wanted one names: the same literal parts where it has them. */
function sameRoute(wanted: string, served: string): boolean {
  const a = wanted.replace(/\/+$/, '').split('/')
  const b = served.replace(/\/+$/, '').split('/')
  for (let i = 0; i < a.length; i++) {
    const w = a[i]!
    const s = b[i]
    if (s === undefined) return false
    // A splat takes the rest of the path.
    if (s.startsWith('*')) return true
    const wParam = /[:*]/.test(w)
    const sParam = /[:*]/.test(s)
    if (wParam !== sParam) return false
    if (!wParam && w !== s) return false
  }
  return a.length === b.length
}

const cache = new Map<string, { name: string | null; at: number }>()

/**
 * The name real use records a route target's requests under (`GET /api/sessions/:sessionId/history`
 * for `GET /api/sessions/:id/history`), null when no route of this server serves it, undefined when
 * there is no router to ask or the target names no method.
 */
export function servedRouteName(want: string): string | null | undefined {
  // A target with no method: a route when any method of its path is served (the path is its name).
  if (want.startsWith('/')) {
    const served = ROUTE_METHODS.map((m) => servedRouteName(`${m} ${want}`))
    if (served.every((x) => x === undefined)) return undefined
    return served.some((x) => typeof x === 'string') ? want : null
  }
  const t = methodAndPath(want)
  if (!t) return undefined
  const kept = cache.get(want)
  if (kept && (kept.name !== null || Date.now() - kept.at < NONE_KEPT_MS)) return kept.name
  const served = answeredTemplates.routed(t.method, samplePathOf(t.path))
  if (served === undefined) return undefined
  // The first route the path reaches that is the one named: a parameter route may hand a literal
  // part on to a later route of its own (`next()`), which is the one real use records then.
  const name = served.find((s) => s.startsWith(`${t.method} `) && sameRoute(t.path, s.slice(t.method.length + 1))) ?? null
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(want, { name, at: Date.now() })
  return name
}

/** Whether a recorded route name (`GET /api/x/:id`) is the route a target's text (after `route:`) names. */
export function routeTargetCovers(want: string, name: string): boolean {
  if (name === want) return true
  // A target with no method covers the path under every method.
  if (!want.includes(' ')) return routeShape(name).endsWith(` ${routeShape(want)}`)
  const served = servedRouteName(want)
  if (served) return name === served || routeShape(name) === routeShape(served)
  return routeShape(name) === routeShape(want)
}

export function _resetRouteTargetsForTesting(): void {
  cache.clear()
}
