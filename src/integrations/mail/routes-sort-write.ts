/**
 * Inbox sorting's WRITE and ACTION routes (spec 6.2 to 6.5), all under `/api/plugins/mail`:
 *
 *   POST /groups/read                       bulk read inside a watermark -> 202 { jobId, total }
 *   POST /groups/archive                    move a group's unread (inside a watermark) to the archive,
 *                                           for a "keep out of the inbox" rule just saved -> 202 { queued }
 *   GET  /bulk/:jobId                       a bulk job's state
 *   POST /bulk/:jobId/stop | undo | retry   stop it, undo exactly what it changed, retry what failed
 *   GET  /groups/:groupId/unsubscribe-plan  the checklist (sort-unsub-plan.ts)
 *   POST /unsubscribe/batch (+ /:id, /:id/stop)  walk the existing ladder per list (sort-unsub-batch.ts)
 *   POST /rules/preview                     what a candidate rule would match and move (sort-preview.ts)
 *   POST /rules/propose                     local drafts, plus the model's when a note was written (sort-propose.ts)
 *
 * Nothing here changes mail before the human's click reaches its POST. Every route answers
 * `PRIMARY_ONLY` on a replica.
 */
import { PRIMARY_ONLY, errorReply, readBody, segmentsAfter } from './contract.js'
import { pairsOf, parseBodyScope, scopeKey } from './routes-sort.js'
import { IMPORTANT, isGroupIdShape } from './sort-classify.js'
import {
  MailBulkRead, RECOMPUTING_MESSAGE, STALE_MESSAGE, UNDO_EXPIRED_MESSAGE, type BulkItem,
} from './sort-bulk-read.js'
import { registerRulePreviewRoutes } from './sort-preview.js'
import { registerRuleProposeRoutes } from './sort-propose.js'
import { productionRuleModel, type RuleModel } from './sort-rule-model.js'
import { registerUnsubBatchRoutes } from './sort-unsub-batch.js'
import { registerUnsubPlanRoutes } from './sort-unsub-plan.js'
import type { MailSortWriteDeps, Watermark } from './sort-types.js'

export type { MailSortWriteDeps }

/** What `registerMailSortWriteRoutes` hands back: the job runners, for tests and teardown. */
export interface MailSortWriteHandles {
  bulk: MailBulkRead
}

function bad(message: string) {
  return { status: 400, json: { error: 'invalid', message } }
}

function watermarkOf(value: unknown): Watermark | undefined {
  const raw = value as { at?: unknown; seq?: unknown } | null
  if (!raw || typeof raw !== 'object') return undefined
  const at = Number(raw.at)
  const seq = Number(raw.seq)
  if (!Number.isFinite(at) || !Number.isFinite(seq) || at < 0 || seq < 0) return undefined
  return { at, seq }
}

/** Make the bulk runner over the service (per message) and the provider (many at once). */
export function createBulkRead(deps: MailSortWriteDeps): MailBulkRead {
  const { service, events, sort, walnut } = deps
  return new MailBulkRead({
    hasBulk: (accountId) => {
      try {
        const spec = service.provider(accountId)
        return !!spec.capabilities.markRead && typeof spec.markReadMany === 'function'
      } catch {
        return false
      }
    },
    markMany: (accountId, ids, read) => service.markReadMany(accountId, ids, read),
    markOne: async (accountId, messageId, read) => { await service.markRead(accountId, messageId, read) },
    events: { bulkProgress: (event) => events.bulkProgress(event), bulkDone: (event) => events.bulkDone(event) },
    groupsChanged: (pairs) => sort.notifyGroupsChanged(pairs),
    log: walnut.log,
  })
}

export function registerMailSortWriteRoutes(
  walnut: MailSortWriteDeps['walnut'],
  deps: MailSortWriteDeps & { ruleModel?: RuleModel },
): MailSortWriteHandles {
  const { store, sort } = deps
  const bulk = createBulkRead(deps)

  walnut.http.route('post', '/groups/read', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return bad('a JSON body is required')
    const scope = parseBodyScope(body.scope)
    if ('error' in scope) return bad(scope.error)
    const group = typeof body.group === 'string' ? body.group : ''
    if (!group) return bad('group is required')
    // Important is never bulk-marked (spec 7): it is the mail that needs the person.
    if (group === IMPORTANT) return bad('Important mail is not marked read in bulk')
    if (!isGroupIdShape(group)) return bad('group must be a group id')
    const sender = typeof body.sender === 'string' && body.sender ? body.sender : undefined
    const watermark = watermarkOf(body.watermark)
    if (!watermark) return bad('watermark { at, seq } is required')
    try {
      await sort.ready()
      if (sort.recomputing()) return { status: 409, json: { error: 'recomputing', message: RECOMPUTING_MESSAGE } }
      if (body.rulesRev !== sort.rulesRev) return { status: 409, json: { error: 'stale', message: STALE_MESSAGE } }
      const key = `${scopeKey(scope)}|${group}|${sender ?? ''}`
      const running = bulk.runningFor(key)
      if (running) return { status: 409, json: { error: 'in-flight', jobId: running.id } }
      const pairs = await pairsOf(store, scope)
      // Resolved ONCE, here: the job touches exactly this list whatever the groups do meanwhile.
      const rows = await store.sort.selectBulkRead(pairs, group, sender, watermark)
      const items: BulkItem[] = rows
        .filter((row) => sort.canMarkRead(row.account_id))
        .map((row) => ({ accountId: row.account_id, mailboxId: row.mailbox_id, messageId: row.message_id }))
      const job = bulk.start({ key, kind: 'read', items })
      walnut.log.info('mail bulk read started', { jobId: job.id, group, total: items.length, skipped: rows.length - items.length })
      return { status: 202, json: { jobId: job.id, total: items.length } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  // The card's "and move the N unread now": the rows the person saw (inside the watermark), queued
  // under the rule they just saved, so the ledger and the rules list count them with the rule's own.
  walnut.http.route('post', '/groups/archive', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const filters = deps.filters
    if (!filters) return { status: 503, json: { error: 'unavailable', message: 'Walnut cannot move mail here.' } }
    const body = await readBody(request)
    if (!body) return bad('a JSON body is required')
    const scope = parseBodyScope(body.scope)
    if ('error' in scope) return bad(scope.error)
    const group = typeof body.group === 'string' ? body.group : ''
    if (!group || group === IMPORTANT || !isGroupIdShape(group)) return bad('group must be a group id other than Important')
    const watermark = watermarkOf(body.watermark)
    if (!watermark) return bad('watermark { at, seq } is required')
    const ruleId = typeof body.ruleId === 'string' ? body.ruleId : ''
    try {
      await sort.ready()
      if (!sort.isFilterRule(ruleId)) return bad('ruleId must name a rule that keeps mail out of the inbox')
      const pairs = await pairsOf(store, scope)
      const rows = await store.sort.selectBulkRead(pairs, group, undefined, watermark)
      const movable = rows.filter((row) => filters.canArchive(row.account_id))
      const queued = await filters.queue(movable.map((row) => ({
        accountId: row.account_id, messageId: row.message_id, mailboxId: row.mailbox_id, ruleId,
      })))
      void filters.runNow()
      walnut.log.info('mail group queued for the archive', { group, ruleId, queued, skipped: rows.length - movable.length })
      return { status: 202, json: { queued, skipped: rows.length - movable.length } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  registerBulkJobRoutes(walnut, bulk)
  const ruleModel = deps.ruleModel ?? productionRuleModel(walnut)
  registerUnsubPlanRoutes(walnut, deps)
  registerUnsubBatchRoutes(walnut, deps)
  registerRulePreviewRoutes(walnut, deps)
  registerRuleProposeRoutes(walnut, { ...deps, ruleModel })
  return { bulk }
}

function registerBulkJobRoutes(walnut: MailSortWriteDeps['walnut'], bulk: MailBulkRead): void {
  const unknown = { status: 404, json: { error: 'unknown-job', message: 'Walnut no longer has this change (it restarted, or the change is old).' } }

  walnut.http.route('get', '/bulk/:jobId', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const job = bulk.get(segmentsAfter(request, '/bulk/')[0] ?? '')
    return job ? { json: bulk.view(job) } : unknown
  })

  walnut.http.route('post', '/bulk/:jobId/stop', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const job = bulk.stop(segmentsAfter(request, '/bulk/')[0] ?? '')
    return job ? { json: bulk.view(job) } : unknown
  })

  walnut.http.route('post', '/bulk/:jobId/undo', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const outcome = bulk.undo(segmentsAfter(request, '/bulk/')[0] ?? '')
    if ('job' in outcome) return { status: 202, json: { jobId: outcome.job.id, total: outcome.job.items.length } }
    switch (outcome.error) {
      case 'unknown-job': return unknown
      case 'expired': return { status: 410, json: { error: 'expired', message: UNDO_EXPIRED_MESSAGE } }
      case 'undone': return { status: 409, json: { error: 'undone', message: 'This change was already undone.' } }
      case 'running': return { status: 409, json: { error: 'running', message: 'This change is still running. Stop it first.' } }
      default: return { status: 409, json: { error: 'not-undoable', message: 'This change cannot be undone.' } }
    }
  })

  walnut.http.route('post', '/bulk/:jobId/retry', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const outcome = bulk.retry(segmentsAfter(request, '/bulk/')[0] ?? '')
    if ('job' in outcome) return { status: 202, json: { jobId: outcome.job.id, total: outcome.job.items.length } }
    if (outcome.error === 'unknown-job') return unknown
    if (outcome.error === 'running') return { status: 409, json: { error: 'running', message: 'This change is still running.' } }
    return { status: 409, json: { error: 'nothing-to-retry', message: 'Nothing failed, so there is nothing to retry.' } }
  })
}
