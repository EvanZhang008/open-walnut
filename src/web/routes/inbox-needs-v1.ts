/**
 * The inbox as the threads that need him (experiment inbox_needs_threads, core/human-inbox/needs-threads.ts).
 *
 *   GET /api/v1/inbox/needs  -> { enabled, threads: [{ ...thread, node: { task_id, title, org_role? }, urgency: { rank, why, since, due? } }],
 *                                 held_letter_ids, counts: { threads, letters, total } }
 *
 * `threads`: every thread waiting on him across all nodes, the most urgent first (needs-model.ts).
 * Each is answered where it lives: through its node's chat (a send with `threadId`), or, when it
 * holds a decision letter (`letter`), through that letter's answer route. `held_letter_ids`: the
 * letters those threads hold, listed once, as their threads. `counts.total`: what the inbox counts,
 * each thing once. Off: `enabled: false`, no threads, and the counts are the unread letters.
 * Additive; 503 primary_only on a replica (it keeps no Threads).
 */
import { Router, type Request, type Response } from 'express'
import { followerName, isFollower } from '../../core/server-role.js'
import { inboxNeeds } from '../../core/human-inbox/needs-threads.js'
import { sendV1Error } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const inboxNeedsV1Router = Router()

inboxNeedsV1Router.get('/inbox/needs', (req: Request, res: Response) => {
  if (isFollower()) {
    sendV1Error(res, 503, 'primary_only', `${followerName()} could not get the threads from your Mac just now.`)
    return
  }
  inboxNeeds().then((out) => {
    res.json({
      enabled: out.enabled,
      threads: out.threads.map((r) => ({ ...r.thread, node: r.node, urgency: r.urgency })),
      held_letter_ids: out.heldLetterIds,
      counts: out.counts,
    })
  }).catch((err: unknown) => {
    if (sendLinkFailure(req, res, err)) return
    sendV1Error(res, 500, 'internal', err instanceof Error ? err.message : String(err))
  })
})
