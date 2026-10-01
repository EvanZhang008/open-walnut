/**
 * Bulk read (spec 6.2): in-memory jobs that mark a FIXED list of messages read (or, for Undo, unread).
 *
 * The list is resolved once, when the POST arrives (`MailSortStore.selectBulkRead`), and never
 * re-evaluated: a row that moves in or out of the group while the job runs (a recompute, a new rule)
 * does not change which mail this job touches. Mail that arrived after the button was drawn is outside
 * the watermark and is never selected.
 *
 * Per account, the provider's `markReadMany` when it has one (200 ids a call), otherwise `markRead`
 * one message at a time with a concurrency of two (the Outlook plugin: every call can download a
 * whole conversation, so a thousand of them take minutes and Stop must work). Stop lets the calls in
 * flight finish and starts nothing else. Undo marks back ONLY what this job actually changed, once,
 * within ten minutes. Jobs live in memory: a restart forgets them, and the mail they changed stays
 * changed (it changed on the mail server).
 */
import crypto from 'node:crypto'
import type { MailBulkDoneEvent, MailBulkProgressEvent } from './events.js'
import type { FolderPair } from './sort-types.js'

export const BULK_CHUNK = 200
export const BULK_CONCURRENCY = 2
export const BULK_UNDO_TTL_MS = 10 * 60_000
export const BULK_CHANGED_IDS_MAX = 500
const PROGRESS_MS = 250
const PROGRESS_EVERY = 50

export const RECOMPUTING_MESSAGE = 'Groups are updating. Try again in a moment.'
export const STALE_MESSAGE = 'This group changed. Check the new count and try again.'
export const UNDO_EXPIRED_MESSAGE = 'Undo is no longer available for this change.'

export interface BulkItem {
  accountId: string
  mailboxId: string
  messageId: string
}

export interface BulkFailure {
  accountId: string
  messageId: string
  reason: string
}

export type BulkKind = 'read' | 'unread'

export interface BulkJob {
  id: string
  kind: BulkKind
  /** (scope, group, sender): one job per key at a time. */
  key: string
  state: 'running' | 'done'
  items: BulkItem[]
  done: number
  changed: BulkItem[]
  failed: Array<BulkFailure & { mailboxId: string }>
  stopRequested: boolean
  stopped: boolean
  undone: boolean
  createdAt: number
  finishedAt?: number
  /** The job this one undoes or retries. */
  parentId?: string
}

/** `GET /bulk/:jobId`. */
export interface BulkJobView {
  jobId: string
  state: 'running' | 'done'
  kind: BulkKind
  total: number
  done: number
  changedCount: number
  failed: BulkFailure[]
  undoable: boolean
  stopped?: boolean
}

export interface BulkReadDeps {
  /** Does this account's provider take many ids in one call? */
  hasBulk(accountId: string): boolean
  markMany(accountId: string, messageIds: string[], read: boolean): Promise<Array<{ messageId: string; ok: boolean; reason?: string }>>
  markOne(accountId: string, messageId: string, read: boolean): Promise<void>
  events?: {
    bulkProgress(event: MailBulkProgressEvent): void
    bulkDone(event: MailBulkDoneEvent): void
  }
  /** Told which folders' counts moved once a job settles. */
  groupsChanged?(pairs: FolderPair[]): void
  now?: () => number
  chunk?: number
  concurrency?: number
  undoTtlMs?: number
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200) || 'The mail server refused this change.'
}

export function viewOf(job: BulkJob, now: number, ttlMs: number): BulkJobView {
  return {
    jobId: job.id,
    state: job.state,
    kind: job.kind,
    total: job.items.length,
    done: job.done,
    changedCount: job.changed.length,
    failed: job.failed.map(({ accountId, messageId, reason }) => ({ accountId, messageId, reason })),
    undoable: undoableOf(job, now, ttlMs),
    ...(job.stopped ? { stopped: true } : {}),
  }
}

function undoableOf(job: BulkJob, now: number, ttlMs: number): boolean {
  return job.kind === 'read' && job.state === 'done' && !job.undone && job.changed.length > 0
    && now - (job.finishedAt ?? job.createdAt) <= ttlMs
}

export type UndoOutcome = { job: BulkJob } | { error: 'unknown-job' | 'expired' | 'running' | 'undone' | 'not-undoable' }
export type RetryOutcome = { job: BulkJob } | { error: 'unknown-job' | 'running' | 'nothing-to-retry' }

export class MailBulkRead {
  private readonly jobs = new Map<string, BulkJob>()
  private readonly running = new Map<string, string>()

  constructor(private readonly deps: BulkReadDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get ttl(): number {
    return this.deps.undoTtlMs ?? BULK_UNDO_TTL_MS
  }

  /** The running job for a key, if any (the route answers 409 `in-flight` with it). */
  runningFor(key: string): BulkJob | undefined {
    const id = this.running.get(key)
    return id ? this.jobs.get(id) : undefined
  }

  get(jobId: string): BulkJob | undefined {
    return this.jobs.get(jobId)
  }

  view(job: BulkJob): BulkJobView {
    return viewOf(job, this.now, this.ttl)
  }

  /** Start a job over a fixed list. The returned job is already running (in the background). */
  start(input: { key: string; kind: BulkKind; items: BulkItem[]; parentId?: string }): BulkJob {
    this.prune()
    const job: BulkJob = {
      id: `bulk-${crypto.randomBytes(6).toString('hex')}`,
      kind: input.kind,
      key: input.key,
      state: 'running',
      items: input.items,
      done: 0,
      changed: [],
      failed: [],
      stopRequested: false,
      stopped: false,
      undone: false,
      createdAt: this.now,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    }
    this.jobs.set(job.id, job)
    this.running.set(job.key, job.id)
    void this.run(job).catch((error) => {
      this.deps.log?.warn('mail bulk read job failed', { jobId: job.id, error: reasonOf(error) })
      this.finish(job)
    })
    return job
  }

  /** Stop: calls in flight finish, nothing else starts. */
  stop(jobId: string): BulkJob | undefined {
    const job = this.jobs.get(jobId)
    if (job && job.state === 'running') job.stopRequested = true
    return job
  }

  /** Undo marks unread exactly what the job changed, once, inside the TTL. Itself a job. */
  undo(jobId: string): UndoOutcome {
    const job = this.jobs.get(jobId)
    if (!job) return { error: 'unknown-job' }
    if (job.state === 'running') return { error: 'running' }
    if (job.kind !== 'read') return { error: 'not-undoable' }
    if (job.undone) return { error: 'undone' }
    if (!undoableOf(job, this.now, this.ttl)) return { error: 'expired' }
    job.undone = true
    return { job: this.start({ key: `${job.key}|undo`, kind: 'unread', items: [...job.changed], parentId: job.id }) }
  }

  /** Retry only what failed, in the same direction. */
  retry(jobId: string): RetryOutcome {
    const job = this.jobs.get(jobId)
    if (!job) return { error: 'unknown-job' }
    if (job.state === 'running') return { error: 'running' }
    if (job.failed.length === 0) return { error: 'nothing-to-retry' }
    const items = job.failed.map(({ accountId, mailboxId, messageId }) => ({ accountId, mailboxId, messageId }))
    return { job: this.start({ key: job.key, kind: job.kind, items, parentId: job.id }) }
  }

  /** Resolves when every running job has settled (tests, teardown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  private prune(): void {
    const cutoff = this.now - this.ttl * 2
    for (const [id, job] of this.jobs) {
      if (job.state === 'done' && (job.finishedAt ?? job.createdAt) < cutoff) this.jobs.delete(id)
    }
  }

  private async run(job: BulkJob): Promise<void> {
    const read = job.kind === 'read'
    const progress = this.progressFor(job)
    const byAccount = new Map<string, BulkItem[]>()
    for (const item of job.items) {
      const list = byAccount.get(item.accountId) ?? []
      list.push(item)
      byAccount.set(item.accountId, list)
    }
    for (const [accountId, items] of byAccount) {
      if (job.stopRequested) break
      if (this.deps.hasBulk(accountId)) await this.runBulk(job, accountId, items, read, progress)
      else await this.runEach(job, accountId, items, read, progress)
    }
    this.finish(job)
  }

  private async runBulk(job: BulkJob, accountId: string, items: BulkItem[], read: boolean, progress: () => void): Promise<void> {
    const size = Math.max(1, this.deps.chunk ?? BULK_CHUNK)
    for (let at = 0; at < items.length; at += size) {
      if (job.stopRequested) return
      const chunk = items.slice(at, at + size)
      let outcomes: Array<{ messageId: string; ok: boolean; reason?: string }>
      try {
        outcomes = await this.deps.markMany(accountId, chunk.map((one) => one.messageId), read)
      } catch (error) {
        const reason = reasonOf(error)
        outcomes = chunk.map((one) => ({ messageId: one.messageId, ok: false, reason }))
      }
      const byId = new Map(outcomes.map((one) => [one.messageId, one]))
      for (const item of chunk) {
        const outcome = byId.get(item.messageId)
        if (outcome?.ok) job.changed.push(item)
        else job.failed.push({ ...item, reason: outcome?.reason ?? 'The mail server did not answer for this message.' })
        job.done += 1
      }
      progress()
    }
  }

  private async runEach(job: BulkJob, accountId: string, items: BulkItem[], read: boolean, progress: () => void): Promise<void> {
    let next = 0
    const worker = async () => {
      while (!job.stopRequested && next < items.length) {
        const item = items[next++]!
        try {
          await this.deps.markOne(accountId, item.messageId, read)
          job.changed.push(item)
        } catch (error) {
          job.failed.push({ ...item, reason: reasonOf(error) })
        }
        job.done += 1
        progress()
      }
    }
    const lanes = Math.max(1, this.deps.concurrency ?? BULK_CONCURRENCY)
    await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, worker))
  }

  /** Progress every 250 ms or every 50 mails, whichever comes first. */
  private progressFor(job: BulkJob): () => void {
    let lastAt = this.now
    let lastDone = 0
    return () => {
      const now = this.now
      if (job.done - lastDone < PROGRESS_EVERY && now - lastAt < PROGRESS_MS) return
      lastAt = now
      lastDone = job.done
      this.deps.events?.bulkProgress({ jobId: job.id, done: job.done, failed: job.failed.length, total: job.items.length })
    }
  }

  private finish(job: BulkJob): void {
    if (job.state === 'done') return
    job.state = 'done'
    job.finishedAt = this.now
    job.stopped = job.stopRequested && job.done < job.items.length
    if (this.running.get(job.key) === job.id) this.running.delete(job.key)
    this.deps.events?.bulkProgress({ jobId: job.id, done: job.done, failed: job.failed.length, total: job.items.length })
    this.deps.events?.bulkDone({
      jobId: job.id,
      changedCount: job.changed.length,
      failedCount: job.failed.length,
      ...(job.changed.length <= BULK_CHANGED_IDS_MAX
        ? { changedIds: job.changed.map(({ accountId, messageId }) => ({ accountId, messageId })) }
        : {}),
      ...(job.stopped ? { stopped: true } : {}),
    })
    const pairs = new Map<string, FolderPair>()
    for (const item of job.changed) pairs.set(`${item.accountId}\u0000${item.mailboxId}`, { accountId: item.accountId, mailboxId: item.mailboxId })
    if (pairs.size > 0) this.deps.groupsChanged?.([...pairs.values()])
  }
}
