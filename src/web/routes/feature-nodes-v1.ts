/**
 * `GET /api/v1/feature-nodes/connections[?node=<id>&since=<ISO>&limit=<n>]`: this server's
 * feature-node connection journal (core/feature-nodes/connection-journal.ts), so an observer
 * tells a server restart from a node that failed. Read only, behind the same device auth as
 * the rest of /api/v1 (op `feature_node_connections`). The companion answers it itself
 * (v1-forward policy.ts): a node's journal lives on the server the node attaches to.
 *
 *   200 { events, truncated, now, current }
 *       events: oldest first, the node's (every node's without `node`) plus this server's
 *       server_started / server_stopping lines; the newest `limit` (default 200) of the span
 *       current: the node's live connection here { nodeId, generation, connectedAt } or null
 *   400 bad_request   a node that is no node id, a since that is no time, a limit outside 1..1000
 *   503 unavailable   the journal did not answer in time (a write is stuck)
 */

import { Router, type Request, type Response } from 'express'
import { identifierSchema } from '../../core/feature-nodes/protocol.js'
import { featureNodeHub, featureNodeJournal } from '../ws/feature-node-runtime.js'

export const featureNodesV1Router = Router()

const READ_DEADLINE_MS = 3_000

function bad(res: Response, message: string): void {
  res.status(400).json({ error: { code: 'bad_request', message } })
}

featureNodesV1Router.get('/feature-nodes/connections', async (req: Request, res: Response) => {
  const node = typeof req.query.node === 'string' && req.query.node !== '' ? req.query.node : undefined
  if (req.query.node !== undefined && (node === undefined || !identifierSchema.safeParse(node).success)) return bad(res, 'node is not a node id')
  let since: number | undefined
  if (req.query.since !== undefined) {
    since = typeof req.query.since === 'string' ? Date.parse(req.query.since) : NaN
    if (!Number.isFinite(since)) return bad(res, 'since is not a time (ISO 8601)')
  }
  let limit: number | undefined
  if (req.query.limit !== undefined) {
    limit = typeof req.query.limit === 'string' && /^\d{1,4}$/.test(req.query.limit) ? Number(req.query.limit) : NaN
    if (!(limit >= 1 && limit <= 1000)) return bad(res, 'limit is a whole number from 1 to 1000')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = await Promise.race([
    featureNodeJournal().read({ nodeId: node, since, limit }).catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_DEADLINE_MS) }),
  ]).finally(() => clearTimeout(timer))
  if (!read) {
    res.status(503).json({ error: { code: 'unavailable', message: 'the connection journal did not answer in time' } })
    return
  }
  let current: { nodeId: string; generation: string; connectedAt: string } | null = null
  if (node) {
    try {
      const live = featureNodeHub().connection(node)
      if (live) current = { nodeId: node, generation: live.generation, connectedAt: new Date(live.connectedAt).toISOString() }
    } catch { /* the feature service is stopped: nothing is connected here */ }
  }
  res.json({ events: read.events, truncated: read.truncated, now: new Date().toISOString(), current })
})
