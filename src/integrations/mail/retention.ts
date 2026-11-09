import type { MailBodyStore } from './bodies.js'
import type { RetentionLimits, RetentionResult } from './contract.js'
import type { MailEvents } from './events.js'
import { messageTaskKey } from './message-tasks.js'
import type { BodiedRow, MailStore } from './store.js'

/**
 * Everything that DELETES: the per-tick sweep, an account purge, and a voided container.
 *
 * Split out of `service.ts` because a read path and a delete path have different failure
 * rules, and keeping them in one class made it easy to forget which is which. The rule every
 * method here obeys: a delete is always BOUNDED and always resumable. Each one takes the
 * caller's deadline, checks it inside its loop rather than at the door, and reports how far it
 * really got, so a sweep of fifty thousand rows gives the event loop back and finishes on the
 * next tick instead of holding it for minutes.
 */
export class MailRetention {
  constructor(private readonly deps: {
    store: MailStore
    bodies: MailBodyStore
    events: MailEvents
    now?: () => number
    /** `JSON.stringify([accountId, messageId])` of every mail the router registry holds; never auto-evicted. */
    protectedRouterItems?: () => Promise<ReadonlySet<string>>
  }) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Read inside the account gate, router first, so a draft or task link made during that await still counts; undefined = router unreadable. */
  private async protectionNow(): Promise<((row: { account_id: string; message_id: string; rfc_message_id: string }) => boolean) | undefined> {
    let routed: ReadonlySet<string>
    try {
      routed = this.deps.protectedRouterItems ? await this.deps.protectedRouterItems() : new Set()
    } catch {
      return undefined
    }
    const drafts = await this.deps.store.draftReplyTargets()
    const linked = await this.deps.store.tasks.taskLinkedKeys()
    return (row) => drafts.has(row.rfc_message_id)
      || linked.has(messageTaskKey(row.account_id, row.rfc_message_id, row.message_id))
      || routed.has(JSON.stringify([row.account_id, row.message_id]))
  }

  /**
   * Retention, oldest first, inside the tick's budget.
   *
   * Ordered by how surprising a loss would be: row caps and the age cutoff drop whole
   * messages, then the body cache gives its bytes back while keeping the envelope. A message
   * an in-flight draft is replying to, or one a TASK points at, is never evicted, whichever rule
   * selected it: a task whose provenance block links back to a message the cache threw away is a
   * task that has lost the thing it is about, and the task can outlive the mailbox by months.
   * Mail the router registry holds is kept the same way; a registry that cannot be read deletes nothing.
   * The body cap takes the 500 oldest bodies but drops them grouped by account, so across accounts it is not strictly oldest first.
   */
  async retain(limits: RetentionLimits, deadlineAt: number): Promise<RetentionResult> {
    const result: RetentionResult = { messagesDeleted: 0, bodiesDropped: 0, incomplete: false }
    const cutoff = this.now - limits.retentionDays * 24 * 60 * 60 * 1_000

    for (const account of await this.deps.store.listAccounts()) {
      if (Date.now() >= deadlineAt) { result.incomplete = true; return result }
      // Selection and delete share the account's write gate, so an ingest cannot rewrite a doomed rowid into a new delivery between them.
      const deleted = await this.deps.store.withAccountWrite(account.account_id, async () => {
        const keep = await this.protectionNow()
        if (!keep) return undefined
        // Selected in SQL rather than filtered in JS: the old shape read every row an account owns
        // out of the worker on every tick to discard almost all of it.
        const rows = await this.deps.store.doomedRows(account.account_id, limits.maxRowsPerAccount, cutoff)
        const doomed = rows.filter((row) => !keep(row))
        return doomed.length === 0 ? 0 : this.dropRowsNow(doomed, deadlineAt)
      })
      if (deleted === undefined) { result.incomplete = true; return result }
      result.messagesDeleted += deleted
    }

    const cap = Math.max(0, limits.bodyCacheMb) * 1024 * 1024
    // One SUM over the rows that own the files, not a stat() per file: the walk was sequential
    // on the libuv pool, ran every tick, and silently under-reported past 50,000 files.
    let used = await this.deps.store.bodyBytesTotal()
    if (used <= cap) return result
    const byAccount = new Map<string, BodiedRow[]>()
    for (const row of await this.deps.store.bodiedOldestFirst(500)) {
      const list = byAccount.get(row.account_id) ?? []
      list.push(row)
      byAccount.set(row.account_id, list)
    }
    for (const [accountId, listed] of byAccount) {
      if (used <= cap) break
      if (Date.now() >= deadlineAt) { result.incomplete = true; break }
      // One gate, one protection read and one row read per account; only the exact ref listed, still unprotected, is dropped, row before file.
      const readable = await this.deps.store.withAccountWrite(accountId, async () => {
        const keep = await this.protectionNow()
        if (!keep) return false
        const fresh = new Map((await this.deps.store.messagesByIds(accountId, listed.map((row) => row.message_id)))
          .map((row) => [row.message_id, row]))
        for (const row of listed) {
          if (used <= cap) break
          if (Date.now() >= deadlineAt) { result.incomplete = true; break }
          const current = fresh.get(row.message_id)
          if (!current || current.rowid !== row.rowid || current.body_ref !== row.body_ref || keep(current)) continue
          await this.deps.store.clearMessageBody(row.rowid)
          await this.deps.bodies.remove(row.body_ref)
          used -= current.body_bytes ?? 0
          result.bodiesDropped += 1
        }
        return true
      })
      if (!readable) { result.incomplete = true; break }
    }
    return result
  }

  /** Everything one account owns: rows, FTS entries, body files, mailboxes, the mirror. */
  purgeAccount(accountId: string, deadlineAt?: number): Promise<{ messages: number; complete: boolean }> {
    return this.deps.store.withAccountWrite(accountId, () => this.purgeAccountNow(accountId, deadlineAt))
  }

  private async purgeAccountNow(accountId: string, deadlineAt?: number): Promise<{ messages: number; complete: boolean }> {
    // The ACCOUNT row goes first, on purpose. It is what `ingestPage` checks, so an in-flight
    // tick stops writing new rows the moment this line lands rather than racing the delete.
    await this.deps.store.deleteAccount(accountId)
    await this.deps.store.deleteMailboxes(accountId)
    // The LEDGER goes too, and the tasks it named do not: those are the human's, and a task about a
    // mail keeps its provenance block whatever happens to the mailbox. Keeping the rows instead
    // would protect evicted-account messages from retention forever, and would hand a stale
    // backlink to a re-added account that happens to mint the same provider handles.
    await this.deps.store.tasks.deleteMessageTasks(accountId)
    const rows = await this.deps.store.evictable(accountId)
    const deleted = await this.dropRowsNow(rows, deadlineAt)
    this.deps.events.forgetAccount(accountId)
    return { messages: deleted, complete: deleted === rows.length }
  }

  /** A voided cursor: the container's rows go before the first page of the resync lands. */
  resetContainer(accountId: string, mailboxId: string): Promise<number> {
    return this.deps.store.withAccountWrite(accountId, async () => {
      const rows = await this.deps.store.evictable(accountId, mailboxId)
      await this.dropRowsNow(rows)
      return rows.length
    })
  }

  /**
   * Delete rows and their body files, in batches, inside a deadline.
   *
   * The clock is checked INSIDE the loop and not only before it: a sweep of 50,000 rows is 250
   * batches plus a file unlink each, which is minutes of work, and a tick budget that is only
   * consulted at the door is not a budget. Returns how many rows really went, so a caller can
   * tell "finished" from "gave the budget back". Caller holds the account's write gate.
   */
  private async dropRowsNow(
    rows: Array<{ rowid: number; body_ref: string | null }>,
    deadlineAt?: number,
  ): Promise<number> {
    let deleted = 0
    for (let at = 0; at < rows.length; at += 200) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) break
      const batch = rows.slice(at, at + 200)
      // Batched so a sweep of thousands of rows is a handful of statements, not one worker
      // round trip per message. Rows before files, so no reader confirms a row whose file is gone.
      await this.deps.store.deleteMessages(batch.map((row) => row.rowid))
      for (const row of batch) {
        if (row.body_ref) await this.deps.bodies.remove(row.body_ref)
      }
      deleted += batch.length
    }
    return deleted
  }
}
