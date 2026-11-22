/**
 * The route template an Express app WOULD match for a method and URL, without running a request
 * and without changing the router (each layer's matchers are called directly; Layer#match would
 * store params on the shared layer). Used to name a request a page says failed before it ever
 * reached the server: one rejected in the page's connection queue was never answered, so the
 * answered templates alone left it "unknown request" (2026-11-22, right after a restart).
 */
import { registeredTemplate } from '../core/usage-watch/normalize.js'

interface LayerLike {
  slash?: boolean
  matchers?: Array<(path: string) => { path: string } | false>
  route?: { path?: unknown; methods?: Record<string, boolean> }
  handle?: { stack?: LayerLike[] }
}

function matched(layer: LayerLike, path: string): string | null {
  if (layer.slash) return ''
  for (const m of layer.matchers ?? []) {
    const r = m(path)
    if (r) return r.path
  }
  return null
}

function handles(methods: Record<string, boolean> | undefined, method: string): boolean {
  const m = method.toLowerCase()
  return !!methods && (methods[m] || methods._all || (m === 'head' && methods.get)) === true
}

function walk(stack: LayerLike[], method: string, path: string, base: string, depth: number): string | null {
  if (depth > 8) return null
  for (const layer of stack) {
    let at: string | null
    try { at = matched(layer, path) } catch { continue }
    if (at === null) continue
    if (layer.route) {
      if (typeof layer.route.path === 'string' && handles(layer.route.methods, method)) return registeredTemplate(base, layer.route.path)
      continue
    }
    const inner = layer.handle?.stack
    if (!Array.isArray(inner)) continue
    const rest = path.slice(at.length)
    const found = walk(inner, method, rest.startsWith('/') ? rest : `/${rest}`, `${base}${at}`, depth + 1)
    if (found && found !== 'unmatched') return found
  }
  return null
}

/** `GET /api/routines/:id` for (`GET`, `/api/routines/abc?x=1`), or null when no route takes it. */
export function routeTemplateOf(router: unknown, method: string, url: string): string | null {
  const stack = (router as { stack?: LayerLike[] } | null)?.stack
  if (!Array.isArray(stack)) return null
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith('/')) return null
  try {
    const template = walk(stack, method, path, '', 0)
    return template && template !== 'unmatched' ? `${method} ${template}` : null
  } catch {
    return null
  }
}
