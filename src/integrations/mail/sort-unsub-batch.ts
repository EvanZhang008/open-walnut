/**
 * Batch unsubscribe (spec 6.3): `POST /unsubscribe/batch` walks the EXISTING ladder once per checked
 * list, strictly one after another.
 *
 * Each item is `MailUnsubscribe.run(accountId, messageId, { method })`, the same entry, ledger and
 * "one attempt in flight per list" guarantee as the row menu's Unsubscribe. Three arguments only: no
 * letter authority is passed, so a mailto rung is authorised exactly as the console's own click is.
 * The ladder announces each settled item (`plugin:mail:unsubscribed`); this file adds one
 * `plugin:mail:unsub-batch` event per item for the checklist row. Stop lets the running item finish
 * and starts no other. Batches live in memory.
 */
import crypto from 'node:crypto'
import { PRIMARY_ONLY, readBody, segmentsAfter } from './contract.js'
import type { MailUnsubBatchEvent } from './events.js'
import type { MailSortWriteDeps } from './sort-types.js'
import { isRequestableUnsubscribeMethod, type UnsubscribeOutcome } from './unsubscribe.js'

export const BATCH_MAX_ITEMS = 50
const BATCH_TTL_MS = 30 * 60_000

export interface BatchItemInput {
  accountId: string
  messageId: string
  method: 'one-click' | 'mailto' | 'link'
}

export type BatchItemStatus = 'waiting' | 'running' | 'done' | 'needs-human' | 'failed' | 'conflict' | 'skipped'

export interface BatchItemState extends BatchItemInput {
  status: BatchItemStatus
  message?: string
  url?: string
  at?: number
}

export interface UnsubBatch {
  batchId: string
  state: 'running' | 'done'
  stopRequested: boolean
  stopped: boolean
  items: BatchItemState[]
  createdAt: number
  finishedAt?: number
}

export interface UnsubBatchDeps {
  run(accountId: string, messageId: string, request: { method: string }): Promise<UnsubscribeOutcome>
  events?: { unsubBatch(event: MailUnsubBatchEvent): void }
  now?: () => number
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

/** Parse the body's items; the first bad one names itself. */
export function parseBatchItems(value: unknown): BatchItemInput[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: 'items must be a non-empty list' }
  if (value.length > BATCH_MAX_ITEMS) return { error: `at most ${BATCH_MAX_ITEMS} lists at a time` }
  const out: BatchItemInput[] = []
  for (const [index, raw] of value.entries()) {
    const item = raw as Record<string, unknown> | null
    if (!item || typeof item.accountId !== 'string' || !item.accountId || typeof item.messageId !== 'string' || !item.messageId) {
      return { error: `item ${index + 1} needs an accountId and a messageId` }
    }
    if (!isRequestableUnsubscribeMethod(item.method)) return { error: `item ${index + 1}: method must be one-click, mailto or link` }
    out.push({ accountId: item.accountId, messageId: item.messageId, method: item.method })
  }
  return out
}

function statusOf(outcome: UnsubscribeOutcome): BatchItemStatus {
  if (outcome.status === 'conflict') return outcome.conflict === 'already' ? 'done' : 'conflict'
  if (outcome.status === 'in-flight') return 'running'
  return outcome.status
}

export class MailUnsubBatches {
  private readonly batches = new Map<string, UnsubBatch>()

  constructor(private readonly deps: UnsubBatchDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  get(batchId: string): UnsubBatch | undefined {
    return this.batches.get(batchId)
  }

  /** Start walking the items, one at a time, in the order given. */
  start(items: BatchItemInput[]): UnsubBatch {
    this.prune()
    const batch: UnsubBatch = {
      batchId: `unsub-${crypto.randomBytes(6).toString('hex')}`,
      state: 'running',
      stopRequested: false,
      stopped: false,
      items: items.map((item) => ({ ...item, status: 'waiting' })),
      createdAt: this.now,
    }
    this.batches.set(batch.batchId, batch)
    void this.run(batch).catch((error) => {
      this.deps.log?.warn('mail unsubscribe batch failed', { batchId: batch.batchId, error: String(error).slice(0, 200) })
      batch.state = 'done'
      batch.finishedAt = this.now
    })
    return batch
  }

  /** The running item finishes; nothing after it starts. */
  stop(batchId: string): UnsubBatch | undefined {
    const batch = this.batches.get(batchId)
    if (batch && batch.state === 'running') batch.stopRequested = true
    return batch
  }

  async idle(): Promise<void> {
    while ([...this.batches.values()].some((one) => one.state === 'running')) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  private async run(batch: UnsubBatch): Promise<void> {
    for (const [index, item] of batch.items.entries()) {
      if (batch.stopRequested) break
      item.status = 'running'
      try {
        const outcome = await this.deps.run(item.accountId, item.messageId, { method: item.method })
        item.status = statusOf(outcome)
        item.message = outcome.message
        if (outcome.url) item.url = outcome.url
      } catch (error) {
        item.status = 'failed'
        item.message = error instanceof Error ? error.message : String(error)
      }
      item.at = this.now
      this.deps.events?.unsubBatch({
        batchId: batch.batchId, index, status: item.status, message: item.message ?? '', ...(item.url ? { url: item.url } : {}),
      })
    }
    batch.stopped = batch.stopRequested && batch.items.some((item) => item.status === 'waiting')
    batch.state = 'done'
    batch.finishedAt = this.now
  }

  private prune(): void {
    const cutoff = this.now - BATCH_TTL_MS
    for (const [id, batch] of this.batches) if (batch.state === 'done' && (batch.finishedAt ?? 0) < cutoff) this.batches.delete(id)
  }
}

export const BATCH_SETTLE_MS = 20_000

/** Wait (bounded) for an in-flight attempt's ledger row to settle, and word the result. */
export async function settled(
  unsubscribe: Pick<MailSortWriteDeps['unsubscribe'], 'ledgerFor'>,
  accountId: string,
  messageId: string,
  outcome: UnsubscribeOutcome,
  budgetMs = BATCH_SETTLE_MS,
): Promise<UnsubscribeOutcome> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const row = await unsubscribe.ledgerFor(accountId, messageId).catch(() => undefined)
    if (!row || row.status === 'in-flight') continue
    const status = row.status as UnsubscribeOutcome['status']
    const message = status === 'done'
      ? 'Unsubscribed by a mail to the list.'
      : row.detail || row.reason || (status === 'needs-human' ? 'Open this mail to finish unsubscribing.' : 'This unsubscribe did not go through.')
    return { ...outcome, status, at: row.at, message }
  }
  return outcome
}

function viewOf(batch: UnsubBatch) {
  return {
    batchId: batch.batchId,
    state: batch.state,
    ...(batch.stopped ? { stopped: true } : {}),
    items: batch.items.map((item) => ({ ...item })),
  }
}

export function registerUnsubBatchRoutes(
  walnut: MailSortWriteDeps['walnut'],
  deps: Pick<MailSortWriteDeps, 'unsubscribe' | 'events'>,
): MailUnsubBatches {
  const batches = new MailUnsubBatches({
    // Exactly three arguments: the console's own authority, never a letter's. A mailto rung answers
    // `in-flight` while its send settles; the batch waits for the ledger so items stay one at a time.
    run: async (accountId, messageId, request) => {
      const outcome = await deps.unsubscribe.run(accountId, messageId, { method: request.method })
      return outcome.status === 'in-flight' ? settled(deps.unsubscribe, accountId, messageId, outcome) : outcome
    },
    events: { unsubBatch: (event) => deps.events.unsubBatch(event) },
    log: walnut.log,
  })
  const unknown = { status: 404, json: { error: 'unknown-batch', message: 'Walnut no longer has this list of unsubscribes.' } }

  walnut.http.route('post', '/unsubscribe/batch', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const items = parseBatchItems(body.items)
    if ('error' in items) return { status: 400, json: { error: 'invalid', message: items.error } }
    const batch = batches.start(items)
    walnut.log.info('mail unsubscribe batch started', { batchId: batch.batchId, items: items.length })
    return { status: 202, json: { batchId: batch.batchId, total: items.length } }
  })

  walnut.http.route('get', '/unsubscribe/batch/:batchId', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const batch = batches.get(segmentsAfter(request, '/unsubscribe/batch/')[0] ?? '')
    return batch ? { json: viewOf(batch) } : unknown
  })

  walnut.http.route('post', '/unsubscribe/batch/:batchId/stop', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const batch = batches.stop(segmentsAfter(request, '/unsubscribe/batch/')[0] ?? '')
    return batch ? { json: viewOf(batch) } : unknown
  })
  return batches
}
