/**
 * One gateway tool call into the real-use recorder (capability-router.ts handleToolsCall): every
 * session's Walnut MCP tools and `walnut` CLI calls arrive here, on every host. The client names
 * itself (`client: mcp|cli`); an older one names nothing and is counted as `unknown`.
 */
import { answerSize, isToolClient } from '../../lib/tool-answer-size.js'
import { failureClass } from './normalize.js'
import { recordOpCall } from './record.js'

export function recordGatewayCall(op: string, client: unknown, r: { ok: boolean; result?: unknown; message?: string; invalidArgs?: boolean; unreachable?: boolean; lost?: boolean; status?: number; code?: string }, ms: number): void {
  try {
    const c = isToolClient(client) ? client : 'unknown'
    if (r.ok) {
      // The gateway wraps a non-object answer as { value } (handleToolsCall): measure what the client gets.
      const shown = typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result) ? r.result : { value: r.result }
      const { size, overLimit, spilled } = answerSize(shown, c)
      recordOpCall({ op, client: c, cls: 'ok', size, overLimit, ...(spilled ? { spilled } : {}), ms })
      return
    }
    const f = failureClass(r)
    const size = (r.message?.length ?? 0) + (r.result === undefined ? 0 : (JSON.stringify(r.result)?.length ?? 0))
    recordOpCall({ op, client: c, cls: f.cls, code: f.code, size, overLimit: false, ms })
  } catch { /* recording never fails a call */ }
}
