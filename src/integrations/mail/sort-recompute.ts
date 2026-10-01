/**
 * The background re-sort: every row whose `sort_rev` is not the current rules revision, in rowid
 * order, 500 rows a batch, yielding the event loop between batches (spec 5.8).
 *
 * Why it looks like this:
 * - `sort_rev IS NOT ?` (see sort-store.ts): after migration v9 every row is NULL, and `<>` would
 *   select none of them.
 * - One statement per batch (`applyVerdicts`): the plugin database has no multi-statement
 *   transaction, so a batch lands whole or not at all, and a restart resumes where it stopped.
 * - `setImmediate` between batches: classification is synchronous JS on the one event loop every
 *   route shares; a 25k-row sync loop would freeze the server for seconds.
 * - ONE runner. A new revision mid-run finishes the current batch, then starts over under the new
 *   revision from the first rowid.
 */
import type { MailSortStore, ScanRow, Verdict } from './sort-store.js'
import type { FolderPair } from './sort-types.js'

export const RECOMPUTE_BATCH = 500

export interface RecomputeDeps {
  store: Pick<MailSortStore, 'pendingRows' | 'countPending' | 'applyVerdicts'>
  /** The verdict for one row under the CURRENT rules. */
  verdictOf: (row: ScanRow) => Verdict
  events?: {
    sortProgress(event: { done: number; total: number; rulesRev: string }): void
    sorted(rulesRev: string): void
    groupsChanged(pairs: FolderPair[]): void
  }
  batchSize?: number
  /** Overridable for tests; the default yields with `setImmediate`. */
  yieldNow?: () => Promise<void>
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export class MailSortRecompute {
  private running: Promise<void> | null = null
  private wanted: string | null = null
  private progressState: { done: number; total: number; rulesRev: string } | null = null
  private disposed = false

  constructor(private readonly deps: RecomputeDeps) {}

  /** `{done, total}` while a run is going, else undefined. */
  progress(): { done: number; total: number } | undefined {
    return this.progressState ? { done: this.progressState.done, total: this.progressState.total } : undefined
  }

  get active(): boolean {
    return this.running !== null
  }

  /** Ask for every row to be sorted under `rev`. Returns the run's promise (tests await it). */
  start(rev: string): Promise<void> {
    this.wanted = rev
    if (!this.running) {
      this.running = this.loop().finally(() => { this.running = null })
    }
    return this.running
  }

  /** Resolves when no run is going. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  dispose(): void {
    this.disposed = true
  }

  private async loop(): Promise<void> {
    const batch = this.deps.batchSize ?? RECOMPUTE_BATCH
    const yieldNow = this.deps.yieldNow ?? defaultYield
    while (!this.disposed && this.wanted) {
      const rev = this.wanted
      let after = 0
      let done = 0
      let total: number
      try {
        total = await this.deps.store.countPending(rev)
      } catch (error) {
        this.deps.log?.warn('mail sort recompute could not count', { error: String(error) })
        break
      }
      if (total === 0) {
        if (this.wanted === rev) this.wanted = null
        this.progressState = null
        continue
      }
      this.progressState = { done: 0, total, rulesRev: rev }
      let restarted = false
      while (!this.disposed) {
        let rows: ScanRow[]
        try {
          rows = await this.deps.store.pendingRows(rev, after, batch)
        } catch (error) {
          this.deps.log?.warn('mail sort recompute batch read failed', { error: String(error) })
          this.progressState = null
          return
        }
        if (rows.length === 0) break
        const verdicts: Verdict[] = []
        const pairs = new Map<string, FolderPair>()
        for (const row of rows) {
          verdicts.push(this.deps.verdictOf(row))
          pairs.set(`${row.account_id}\u0000${row.mailbox_id}`, { accountId: row.account_id, mailboxId: row.mailbox_id })
        }
        await this.deps.store.applyVerdicts(verdicts)
        after = rows[rows.length - 1]!.rowid
        done += rows.length
        this.progressState = { done: Math.min(done, total), total: Math.max(total, done), rulesRev: rev }
        this.deps.events?.sortProgress({ ...this.progressState })
        this.deps.events?.groupsChanged([...pairs.values()])
        await yieldNow()
        if (this.wanted !== rev) { restarted = true; break }
      }
      if (this.disposed) break
      if (!restarted) {
        this.progressState = null
        if (this.wanted === rev) this.wanted = null
        this.deps.events?.sorted(rev)
      }
    }
    this.progressState = null
  }
}
