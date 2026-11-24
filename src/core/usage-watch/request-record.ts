/**
 * A finished request into the real-use recorder (web/middleware/request-logger.ts), named by the
 * route template Express matched on the path its client called, never by its URL.
 */
import { publicTemplate } from './normalize.js'
import { recordHttp } from './record.js'

export function recordRequestUse(method: string, at: { originalUrl: unknown; baseUrl: unknown; routePath: unknown }, status: number, ms: number, how: { waits: boolean; hungUp?: boolean; hostUnreachable?: boolean }): void {
  try {
    const template = publicTemplate(at.originalUrl, at.baseUrl, at.routePath)
    // A request no route took (a static file, an unknown path) is no route's to watch.
    if (template === 'unmatched') return
    recordHttp({ method, template, status, ms, waits: how.waits, ...(how.hungUp ? { hungUp: true } : {}), ...(how.hostUnreachable ? { hostUnreachable: true } : {}) })
  } catch { /* recording never fails a request */ }
}
