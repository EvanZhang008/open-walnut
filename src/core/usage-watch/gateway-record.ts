/**
 * One gateway tool call into the real-use recorder (capability-router.ts handleToolsCall): every
 * session's Walnut MCP tools and `walnut` CLI calls arrive here, on every host. The client names
 * itself (`client: mcp|cli`); an older one names nothing and is counted as `unknown`. `whole`: the
 * answer was not held to an agent's surface (no session made the call, or it asked for `_full`),
 * so, like a program's read, its size is no agent's read (record.ts OpCall.whole). `uncapped`: the op
 * answers this call whole by its own rule (answer.whole_for), so it is sized and never over a limit.
 */
import { log } from '../../logging/index.js'
import { PROGRAM_CLIENT, answerSize, isToolClient } from '../../lib/tool-answer-size.js'
import { failureClass } from './normalize.js'
import { recordOpCall, recordToolError } from './record.js'
import { SHORT_LIST_OP } from './counters.js'

export function recordGatewayCall(op: string, client: unknown, r: { ok: boolean; result?: unknown; message?: string; invalidArgs?: boolean; unreachable?: boolean; lost?: boolean; fault?: boolean; status?: number; code?: string }, ms: number, whole = false, uncapped = false): void {
  try {
    const c = isToolClient(client) ? client : 'unknown'
    if (r.ok) {
      // The gateway wraps a non-object answer as { value } (handleToolsCall): measure what the client gets.
      const shown = typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result) ? r.result : { value: r.result }
      const { size, overLimit, spilled } = answerSize(shown, c)
      recordOpCall({ op, client: c, cls: 'ok', size, overLimit, ...(spilled ? { spilled } : {}), ...(whole || c === PROGRAM_CLIENT ? { whole: true } : {}), ...(uncapped ? { uncapped: true } : {}), ms })
      return
    }
    const f = failureClass(r)
    const size = (r.message?.length ?? 0) + (r.result === undefined ? 0 : (JSON.stringify(r.result)?.length ?? 0))
    recordOpCall({ op, client: c, cls: f.cls, code: f.code, size, overLimit: false, ms })
  } catch { /* recording never fails a call */ }
}

export { SHORT_LIST_OP } from './counters.js'

/**
 * A Walnut MCP server's word that its session was given fewer Walnut tools than its whole list
 * (walnut-mcp-stdio.ts tellShort), for `ms` until that list came: counted as a failed tool call of
 * the session at the time it began, so `usage_watch errors` says how often a session ran without
 * them, by session and host. The code: tools_away when Walnut was away (its Mac asleep or gone:
 * expected, told apart from a fault), else tools_missing when it had none and tools_short when it
 * lacked some. Null when the word is not one (an older or a foreign caller): nothing is counted.
 */
export function shortListOf(report: unknown): { given: number; full: number; ms: number; why: string } | null {
  const r = (report as { short_list?: unknown } | null)?.short_list as Record<string, unknown> | undefined
  const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null)
  const given = n(r?.given, 10_000), full = n(r?.full, 10_000), ms = n(r?.ms, 7 * 24 * 3_600_000)
  const why = typeof r?.why === 'string' && SHORT_WHYS.has(r.why) ? r.why : 'short'
  return given !== null && full !== null && ms !== null && given < full ? { given, full, ms, why } : null
}

const SHORT_WHYS = new Set(['away', 'slow', 'partial', 'short'])

/** The code a short list is counted under (shortListOf). */
export function shortListCode(short: { given: number; why: string }): string {
  return short.why === 'away' ? 'tools_away' : short.given === 0 ? 'tools_missing' : 'tools_short'
}

export async function recordShortToolList(sid: string, host: string, report: unknown, taskIdOf: (sid: string) => Promise<string | undefined>, now = Date.now()): Promise<boolean> {
  const short = shortListOf(report)
  if (!short || !sid) return false
  try {
    const taskId = await taskIdOf(sid).catch(() => undefined)
    // The Mac's own daemon relays as `__local__`; the session hook names that host `local`.
    const where = !host || host === '__local__' ? 'local' : host
    recordToolError({ at: now - short.ms, sid, ...(taskId ? { taskId } : {}), host: where, op: SHORT_LIST_OP, client: 'mcp', code: shortListCode(short) })
    log.session.info('real use: a session ran without some of its Walnut tools', { sessionId: sid, ...(taskId ? { taskId } : {}), host: where, given: short.given, full: short.full, ms: short.ms, why: short.why })
  } catch { /* recording never fails a call */ }
  return true
}

/**
 * A session's client tells the calls of it that no Walnut answered (lib/no-answer-report.ts: the
 * daemon or the server away, a restart), once a later call got through: each counted as a failed
 * call of the session at the time it failed, unless the session hook already read it live
 * (record.ts matches the two). How many were counted; 0 when the report names none.
 */
export async function recordNoAnswers(sid: string, host: string, report: unknown, taskIdOf: (sid: string) => Promise<string | undefined>, now = Date.now()): Promise<number> {
  const { noAnswersOf } = await import('../../lib/no-answer-report.js')
  const items = noAnswersOf(report)
  if (!items.length || !sid) return 0
  let counted = 0
  try {
    const taskId = await taskIdOf(sid).catch(() => undefined)
    const where = !host || host === '__local__' ? 'local' : host
    for (const n of items) {
      if (recordToolError({ at: now - n.ms, sid, ...(taskId ? { taskId } : {}), host: where, op: n.op, client: n.client, code: n.code }, 'client', n.id)) counted++
    }
    log.session.info('real use: a session told calls no Walnut answered', { sessionId: sid, ...(taskId ? { taskId } : {}), host: where, told: items.length, counted, codes: [...new Set(items.map((n) => n.code))] })
  } catch { /* recording never fails a call */ }
  return counted
}
