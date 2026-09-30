/**
 * What a self-call acting for a caller OFF this Mac may reach
 * (src/lib/caller-origin.ts says who counts as off this Mac).
 *
 *  1. No Apple Health route, for any op: /api/health/* and /api/v1/health/*.
 *     The routes refuse such a self-call too; this answers first, with the rule.
 *  2. Through the `api` passthrough, no route a `remote: 'deny'` op binds or
 *     declares (`bind`, `routes`), nor the plugin-runtime route that runs that op.
 *     Otherwise the passthrough is a way around every local-only op: a remote
 *     host's `api DELETE /api/tasks/<id>` did what `task_delete` refuses it.
 *
 * The local-only set is DERIVED from the registry on every check, so an op added
 * or tagged later (a plugin's included) is covered without a list to update.
 *
 * Paths are compared in canonical forms. The first is exactly what fetch sends
 * (WHATWG parsing resolves dot segments, `%2e` included), and a differently cased
 * `/API/` prefix is also read as absolute; each further form
 * decodes percent escapes once more and re-parses. The parser reads a backslash
 * as a slash in an http path (WHATWG URL), a raw one or a decoded `%5C` alike, so
 * no step of its own is needed for them.
 * Every form is folded the way Express matches: repeated slashes collapsed,
 * lowercased (routes ignore case), no trailing slash, and the `/api/v1` or `/api`
 * prefix set aside, since legacy and v1 routes share tails. A path is refused
 * when ANY form matches, so the extra decoding can only widen a refusal. A path
 * that is still changing after five rounds is refused outright.
 */

import { listOpEntries, type HttpBinding } from './registry.js'
import { HEALTH_LOCAL_ONLY_MESSAGE, isLocalOrigin } from '../lib/caller-origin.js'

const BASE = 'http://walnut.invalid'
const MAX_ROUNDS = 5

/** The server path an executor `path` addresses (v1-relative unless it starts with /api/). */
function serverPath(path: string): string {
  if (path.startsWith('/api/')) return path
  return `/api/v1${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * The paths to judge: the one the executor sends, and for a differently cased
 * `/API/` prefix (sent v1-relative today) the absolute reading too, so a later
 * executor that ignores case cannot open a hole. A second reading only widens.
 */
function startingPaths(path: string): string[] {
  const sent = serverPath(path)
  return /^\/api\//i.test(path) && sent !== path ? [sent, path] : [sent]
}

function fold(pathname: string): string {
  return pathname.replace(/\/{2,}/g, '/').toLowerCase().replace(/\/+$/, '') || '/'
}

function parsePath(raw: string): string | null {
  try {
    return new URL(`${BASE}${raw.startsWith('/') ? '' : '/'}${raw}`).pathname
  } catch {
    return null
  }
}

/** Every canonical form of `path` (see the header), or null when it cannot be settled. */
export function canonicalForms(path: string): string[] | null {
  const forms: string[] = []
  for (const start of startingPaths(path)) {
    const some = formsFrom(start)
    if (some === null) return null
    forms.push(...some)
  }
  return forms
}

function formsFrom(start: string): string[] | null {
  let current = parsePath(start)
  if (current === null) return null
  const forms = [fold(current)]
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      // A lone `%` (a note named "100%") is literal to Express as well.
      return forms
    }
    // A decoded `?` or `#` ends the path for URL parsing: keep both sides of it.
    // A decoded backslash needs nothing: the parser reads it as a slash.
    const cut = decoded.replace(/[?#][\s\S]*$/, '')
    const next = parsePath(decoded.replace(/[?#]/g, '_'))
    const cutNext = parsePath(cut)
    if (next === null || cutNext === null) return null
    if (cutNext !== next) forms.push(fold(cutNext))
    if (next === current) return forms
    forms.push(fold(next))
    current = next
  }
  return null
}

/** The part after `/api/v1` or `/api`, which is what legacy and v1 routes share. */
function tailOf(canonical: string): string {
  const m = /^\/api(?:\/v1)?(?=\/|$)/.exec(canonical)
  return (m ? canonical.slice(m[0].length) : canonical) || '/'
}

function isHealthForm(form: string): boolean {
  if (!/^\/api(?:\/|$)/.test(form)) return false
  const tail = tailOf(form)
  return tail === '/health' || tail.startsWith('/health/')
}

/** /api/health/* or /api/v1/health/* in any form; a path that cannot be settled counts. */
export function isHealthServerPath(path: string): boolean {
  const forms = canonicalForms(path)
  return forms === null || forms.some(isHealthForm)
}

interface LocalOnlyRoute { op: string; method: HttpBinding['method']; tail: RegExp }

function tailPattern(template: string): RegExp {
  const source = tailOf(fold(serverPath(template)))
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${source}$`)
}

/** Every route a `remote: 'deny'` op binds or declares, plus the plugin-runtime route that runs it. */
export function localOnlyRoutes(): LocalOnlyRoute[] {
  const out: LocalOnlyRoute[] = []
  for (const { op } of listOpEntries()) {
    if (op.tags.remote !== 'deny') continue
    for (const r of [...(op.bind ? [op.bind] : []), ...(op.routes ?? [])]) {
      out.push({ op: op.name, method: r.method, tail: tailPattern(r.path) })
    }
    out.push({ op: op.name, method: 'POST', tail: tailPattern(`/api/plugin-runtime/:plugin/ops/${op.name}`) })
  }
  return out
}

/**
 * Why `opName` may not send `method path` while acting for `origin`, or null.
 * A caller on this Mac is never refused here.
 */
export function selfCallRefusal(opName: string, method: string, path: string, origin: string): string | null {
  if (isLocalOrigin(origin)) return null
  const forms = canonicalForms(path)
  if (forms === null) return `${method} ${path.slice(0, 200)} was refused: the path could not be read`
  if (forms.some(isHealthForm)) return HEALTH_LOCAL_ONLY_MESSAGE
  if (opName !== 'api') return null
  const verb = method.toUpperCase()
  const routes = localOnlyRoutes()
  for (const form of forms) {
    const tail = tailOf(form)
    const hit = routes.find((r) => r.method === verb && r.tail.test(tail))
    if (hit) return `${verb} ${path.slice(0, 200)} is what ${hit.op} does, and ${hit.op} runs only for callers on this Mac`
  }
  return null
}
