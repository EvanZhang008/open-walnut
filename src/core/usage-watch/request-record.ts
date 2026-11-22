/**
 * A finished request into the real-use recorder (web/middleware/request-logger.ts), named by the
 * route template Express matched, never by its URL.
 */
import { registeredTemplate } from './normalize.js'
import { recordHttp } from './record.js'

export function recordRequestUse(method: string, baseUrl: unknown, routePath: unknown, status: number, ms: number, waits: boolean): void {
  try {
    const template = registeredTemplate(baseUrl, routePath)
    // A request no route took (a static file, an unknown path) is no route's to watch.
    if (template === 'unmatched') return
    recordHttp({ method, template, status, ms, waits })
  } catch { /* recording never fails a request */ }
}
