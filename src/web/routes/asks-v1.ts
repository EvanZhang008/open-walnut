/**
 * GET /api/v1/asks?agentId=&q=&limit=: one agent's asks, exactly as the web
 * console's Ask Walnut drawer lists them (additive, 2026-09).
 *
 * The rules (membership, order, title, state) are NOT here: they are
 * src/core/sessions/ask-list.ts, the same module the browser imports, so a phone
 * that renders this answer and the Mac's drawer agree by construction. This file
 * only gathers the inputs the browser has in its task store: the task list (the
 * same minimal projection `GET /api/tasks?fields=list` serves) and each ask's
 * session status (the same enrichment).
 *
 * B-class on a REPLICA: the pushed task projection carries neither the ask stamp
 * (`walnut_agent` / `agent_id`) nor the activity stamp nor a session id, so a
 * list computed there would silently disagree with the Mac. The replica relays
 * the question to the primary (`server.asks`) and answers `503 bridge_offline`
 * when it cannot, rather than a confident wrong list.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError } from './v1-control-relay.js'
import { SessionControlError } from '../../core/sessions/session-controls.js'

export const asksV1Router = Router()

const SERVER_RELAY_SID = '__server__'

/** Same agent-id shape the conversation routes accept. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export interface AsksQuery {
  agentId: string
  q?: string
  limit: number
}

export interface AsksAnswer {
  agentId: string
  /** The agent's `Ask <name>` project (what the drawer's title reads). */
  project: string
  /** Matches before `limit`, so a capped answer is detectable. */
  total: number
  /**
   * This server launches an ask from `POST /api/v1/sessions { walnutAgent }`
   * (the phone's New chat). Set HERE, on the box that runs the launch, so a
   * replica relaying the list carries the Mac's own answer; the replica cannot
   * know what the Mac behind it supports. A primary that predates the field
   * omits it, which a client reads as "no".
   */
  launch: true
  asks: import('../../core/sessions/ask-list.js').AskRow[]
}

/**
 * Validate the query into the ONE shape both the direct route and the relay
 * handler use (the relay must not accept what the route would refuse).
 * Throws SessionControlError(400) on a malformed agent id, query or limit.
 *
 * A parameter given twice arrives as an array (Express's query parser). That is
 * a 400 for each of them, never a quiet fallback: `agentId=mentor&agentId=x`
 * used to list WALNUT's asks, and a repeated `q` listed everything.
 */
export function parseAsksQuery(raw: Record<string, unknown>): AsksQuery {
  const agentRaw = oneString(raw.agentId, 'agentId') || 'general'
  if (!AGENT_ID_RE.test(agentRaw)) throw new SessionControlError(`Invalid agentId: ${agentRaw}`, 400)
  const q = oneString(raw.q, 'q')?.trim() || undefined
  return { agentId: agentRaw, ...(q ? { q } : {}), limit: parseLimit(raw.limit) }
}

/** Absent stays absent; anything but one string is a 400. */
function oneString(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new SessionControlError(`Invalid ${name}: give it once, as text.`, 400)
  return raw
}

/**
 * Absent: the default. Otherwise a whole number from 1 up; one above the max,
 * however many digits it has, is capped at the max (a capped answer says so
 * through `total`). Anything else is a 400: `limit=0` or `limit=abc` used to
 * become the default without a word, which answered a question the client did
 * not ask. The digits are read as text first, so a value too large for a
 * number (`99999999999999999999`) is capped like `5000` instead of refused.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT
  let n = NaN
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const digits = raw.replace(/^0+/, '')
    n = digits.length > String(MAX_LIMIT).length ? MAX_LIMIT : Number(digits || '0')
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new SessionControlError(
      `Invalid limit: ${String(raw)}. Use a whole number from 1 up (above ${MAX_LIMIT} is capped at ${MAX_LIMIT}).`, 400)
  }
  return Math.min(MAX_LIMIT, n)
}

/**
 * Compute the list on THIS box (the primary). Throws SessionControlError(404)
 * for an agent the drawer does not offer (unknown, or not a console agent).
 */
export async function computeAgentAsks(query: AsksQuery): Promise<AsksAnswer> {
  const { askProjectFor, buildAskList, isAskOf, GENERAL_AGENT_ID } = await import('../../core/sessions/ask-list.js')
  let name = 'Walnut'
  if (query.agentId !== GENERAL_AGENT_ID) {
    const { getConsoleAgent } = await import('../../core/agent-registry.js')
    const def = await getConsoleAgent(query.agentId)
    if (!def) throw new SessionControlError(`Agent not found: ${query.agentId}`, 404)
    name = def.name
  }
  const agent = { id: query.agentId, project: askProjectFor({ id: query.agentId, name }) }

  // The same minimal projection `GET /api/tasks?fields=list` serves the browser,
  // narrowed IN SQL to the rows that could be an ask (a superset), so a request
  // reads a few dozen rows instead of the whole table. The JS rule below is the
  // judge, after the same sentinel exclusion the list query applies.
  const { listTasksSlim, isRetiredSentinelTitle } = await import('../../core/task-manager.js')
  const rows = await listTasksSlim({ minimal: true, askCandidates: true })
  const candidates = (rows as unknown as import('../../core/types.js').Task[])
    .filter((t) => !isRetiredSentinelTitle(t.title) && isAskOf(t, agent))
  // Enrich only the asks: the state reads `session_status`, and the enrichment
  // also heals a task whose session slot lost its link (same pass the board's
  // list gets, so the dot and the session id match what the browser sees).
  const { enrichTasksWithSessionStatus } = await import('./tasks.js')
  const enriched = await enrichTasksWithSessionStatus(candidates)
  const { total, asks } = buildAskList(enriched, agent, { query: query.q, limit: query.limit })
  return { agentId: agent.id, project: agent.project, total, launch: true, asks }
}

asksV1Router.get('/asks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let query: AsksQuery
    try {
      query = parseAsksQuery(req.query as Record<string, unknown>)
    } catch (err) {
      if (err instanceof SessionControlError) {
        sendError(res, err.statusCode, 'bad_request', err.message)
        return
      }
      throw err
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.asks', SERVER_RELAY_SID, { ...query }, 200)
      return
    }
    try {
      res.json(await computeAgentAsks(query))
    } catch (err) {
      if (err instanceof SessionControlError && err.statusCode === 404) {
        sendError(res, 404, 'not_found', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel: unexpected failures keep the frozen v1 shape.
asksV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 asks error', { error: err instanceof Error ? err.message : String(err) })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
