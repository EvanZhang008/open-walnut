/**
 * "Keep out of the inbox": a rule with `skipInbox` moves the inbox mail it decides to the account's
 * archive, through the provider's `archiveMany`; a filter (a rule with `moveTo`) files it into the
 * folder the person named instead, through `moveMany`, which makes the folder when it is missing. It is the Outlook-rule half of grouping, done by
 * Walnut because neither transport can create a server-side rule (IMAP has no rules at all, and the
 * Outlook tools list has none).
 *
 * What that means, and what the card says about it:
 * - it acts while Walnut runs; mail that lands while it is off waits in the inbox until the next poll
 *   (which moves it then, because the arrival rule reads the mail's own time, not the poll's);
 * - a phone that notifies on arrival may still ping before Walnut moves the mail;
 * - the mail stays UNREAD in the archive (a provider must not touch the read flag), and a move that
 *   fails leaves the mail in the inbox, in the rule's group, so nothing is lost either way.
 *
 * Which mail: new arrivals the rule decides, received after the rule first existed (sort-engine.ts
 * `moveOutRule`), and, when the person asks for it on the card, the unread already in the group. The
 * ledger (store-moves.ts) retries a failure twice (1 min, 5 min) before it gives up, and bounds how
 * often one message may be moved again after it came back to the inbox. A move still waiting when its
 * rule goes (Undo, or the rule deleted) is dropped, never made: a large group on a slow transport is
 * many batches over minutes, and every one of them asks whether the rule is still there.
 *
 * After a move the cached inbox row goes (with its body file), because the server no longer has the
 * mail there; the archive's own poll lists it again if that folder is synced.
 */
import type { MailBodyStore } from './bodies.js'
import { providerIdOf } from './contract.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailStore } from './store.js'
import type { MoveRequest, MoveRow, SettleRow } from './store-moves.js'
import type { FolderPair } from './sort-types.js'

export const MOVE_BATCH = 50
export const MOVE_ATTEMPTS = 3
export const MOVE_DEBOUNCE_MS = 1_500
/**
 * How long one batch's `archiveMany` may take: a floor plus a share per message, because a transport
 * whose moves serialize (Outlook: one call per conversation) needs longer for 50 than for 2. Past it the
 * batch counts as failed and is retried, so this must stay above any provider's own budget.
 */
export const MOVE_CALL_MS = 60_000
export const MOVE_PER_MESSAGE_MS = 2_000
const RETRY_AFTER_MS = [60_000, 5 * 60_000]

export const CANNOT_ARCHIVE = 'This account cannot move mail to an archive.'
export const CANNOT_FILE = 'This account cannot file mail into a folder.'

export interface FilterMoverDeps {
  store: Pick<MailStore, 'moves' | 'deleteMessages' | 'bumpMailboxUnread' | 'withAccountWrite'>
  bodies: Pick<MailBodyStore, 'remove'>
  providers: Pick<MailProviderRegistry, 'get'>
  /** Group counts moved in these folders (the sort engine's `notifyGroupsChanged`). */
  groupsChanged: (pairs: FolderPair[]) => void
  /** One batch settled (an open list drops the moved rows). `folder`: a filter's folder, not the archive. */
  onSettled?: (event: { accountId: string; moved: number; failed: number; messageIds: string[]; folder?: string }) => void
  /** Is this still a rule that keeps mail out of the inbox? Without it every queued move is made. */
  ruleLive?: (ruleId: string) => Promise<boolean>
  /**
   * Where the rule sends its mail now (`{ folder }` for a filter's folder, `{}` for the archive), or
   * null when it no longer keeps mail out of the inbox. Wins over `ruleLive`. Read at move time, so a
   * folder renamed on the rule takes the mail still queued under it.
   */
  ruleTarget?: (ruleId: string) => Promise<{ folder?: string } | null | undefined>
  /**
   * Of these queued moves (one account, one rule), the message ids the rule still decides NOW. A rule
   * edited after the moves were queued (a narrower "From contains", say) keeps the same id, so its
   * presence alone is no answer. Undefined `ruleTarget` or a throw here: the sort engine cannot tell
   * right now, and the rows wait rather than move or drop.
   */
  stillDecides?: (ruleId: string, accountId: string, messageIds: string[]) => Promise<Set<string>>
  timeout?: (handler: () => void, ms: number) => { dispose(): void }
  now?: () => number
  log?: {
    info?(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
}

export class MailFilterMover {
  private timer: { dispose(): void } | null = null
  private timerAt = 0
  private running: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: FilterMoverDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Can this account's mail be moved to an archive at all? (The card says so before it saves.) */
  canArchive(accountId: string): boolean {
    const spec = this.deps.providers.get(providerIdOf(accountId))
    return !!spec?.capabilities.archive && typeof spec.archiveMany === 'function'
  }

  /** Can this account's mail be filed into a named folder? */
  canFile(accountId: string): boolean {
    const spec = this.deps.providers.get(providerIdOf(accountId))
    return !!spec?.capabilities.move && typeof spec.moveMany === 'function'
  }

  /** Queue these moves and run soon. Returns how many were newly queued. */
  async queue(requests: ReadonlyArray<MoveRequest>): Promise<number> {
    if (this.disposed || requests.length === 0) return 0
    const queued = await this.deps.store.moves.enqueue(requests, this.now())
    if (queued > 0) this.schedule(MOVE_DEBOUNCE_MS)
    return queued
  }

  /**
   * One mail to the archive now, for the mail router's noise decision (router-noise.ts): no rule and
   * no move ledger, one provider call, made only while `stillCurrent` says the cached copy is the one
   * the router decided (asked right before the call). A refusal is not retried later: the mail stays
   * in the inbox, read, and the answer says why.
   */
  async archiveNow(accountId: string, messageId: string, stillCurrent: () => Promise<boolean>): Promise<{ ok: boolean; reason?: string }> {
    if (this.disposed) return { ok: false, reason: 'mail is shutting down' }
    if (!this.canArchive(accountId)) return { ok: false, reason: CANNOT_ARCHIVE }
    // After a rule batch already running, so one account never has two moves in flight from here.
    while (this.running) await this.running
    if (!await stillCurrent()) return { ok: false, reason: 'a later delivery replaced the email' }
    const outcome = (await this.move(accountId, [{ message_id: messageId } as MoveRow])).get(messageId) ?? { ok: false, reason: 'no answer' }
    if (!outcome.ok) return { ok: false, reason: (outcome.reason ?? 'the mail server did not move it').slice(0, 200) }
    const pairs = new Map<string, FolderPair>()
    await this.dropCached(accountId, [messageId], pairs)
    if (pairs.size > 0) this.deps.groupsChanged([...pairs.values()])
    this.deps.onSettled?.({ accountId, moved: 1, failed: 0, messageIds: [messageId] })
    return { ok: true }
  }

  /** Run after `delayMs`, unless a run is already due sooner. */
  schedule(delayMs: number): void {
    if (this.disposed) return
    const at = this.now() + delayMs
    if (this.timer && this.timerAt <= at) return
    this.timer?.dispose()
    const timeout = this.deps.timeout ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      return { dispose: () => clearTimeout(handle) }
    })
    this.timerAt = at
    this.timer = timeout(() => {
      this.timer = null
      if (!this.disposed) void this.runNow()
    }, delayMs)
  }

  /** Move everything due now (serialised); resolves when done. Tests await it. */
  runNow(): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      try {
        while (!this.disposed) {
          const rows = await this.deps.store.moves.due(this.now(), MOVE_BATCH)
          if (rows.length === 0) break
          await this.batch(rows)
        }
        const next = await this.deps.store.moves.nextAt()
        if (next !== null && !this.disposed) this.schedule(Math.max(1_000, next - this.now()))
      } catch (error) {
        this.deps.log?.warn('mail filter moves failed', { error: String(error).slice(0, 200) })
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async batch(due: MoveRow[]): Promise<void> {
    const { rows, folderOf } = await this.withLiveRule(due)
    // One provider call per account and destination (the archive, or each filter's folder).
    const byTarget = new Map<string, { accountId: string; folder?: string; list: MoveRow[] }>()
    for (const row of rows) {
      const folder = folderOf.get(row.rule_id)
      const key = `${row.account_id}\u0000${folder ?? ''}`
      const entry = byTarget.get(key) ?? { accountId: row.account_id, ...(folder ? { folder } : {}), list: [] }
      entry.list.push(row)
      byTarget.set(key, entry)
    }
    const pairs = new Map<string, FolderPair>()
    for (const { accountId, folder, list } of byTarget.values()) {
      const outcomes = await this.move(accountId, list, folder)
      const now = this.now()
      const settled: SettleRow[] = []
      const movedIds: string[] = []
      for (const row of list) {
        const outcome = outcomes.get(row.message_id) ?? { ok: false, reason: 'no answer' }
        if (outcome.ok) {
          settled.push([accountId, row.message_id, 'moved', 0, null, now])
          movedIds.push(row.message_id)
          continue
        }
        const attempts = outcome.final ? MOVE_ATTEMPTS : row.attempts + 1
        const reason = (outcome.reason ?? 'refused').slice(0, 200)
        settled.push(attempts >= MOVE_ATTEMPTS
          ? [accountId, row.message_id, 'failed', attempts, reason, now]
          : [accountId, row.message_id, 'queued', attempts, reason, now + RETRY_AFTER_MS[Math.min(attempts, RETRY_AFTER_MS.length) - 1]!])
      }
      await this.dropCached(accountId, movedIds, pairs)
      await this.deps.store.moves.settle(settled)
      const failed = settled.filter((one) => one[2] === 'failed').length
      if (movedIds.length > 0 || failed > 0) {
        this.deps.log?.info?.(folder ? 'mail filter filed mail into a folder' : 'mail filter moved mail to the archive', { accountId, moved: movedIds.length, failed })
        this.deps.onSettled?.({ accountId, moved: movedIds.length, failed, messageIds: movedIds.slice(0, 200), ...(folder ? { folder } : {}) })
      }
    }
    if (pairs.size > 0) this.deps.groupsChanged([...pairs.values()])
  }

  /**
   * The rows whose rule still keeps mail out of the inbox AND still decides that mail, with each
   * rule's folder; rows the rule no longer takes leave the ledger unmoved. When the sort engine cannot
   * answer (it failed to start, a read failed), the rows are put back for a minute, never moved and
   * never dropped.
   */
  private async withLiveRule(rows: MoveRow[]): Promise<{ rows: MoveRow[]; folderOf: Map<string, string> }> {
    const folderOf = new Map<string, string>()
    const { ruleTarget, ruleLive, stillDecides } = this.deps
    if (!ruleTarget && !ruleLive) return { rows, folderOf }
    const live = new Map<string, boolean>()
    const unknown = new Set<string>()
    for (const id of new Set(rows.map((row) => row.rule_id))) {
      if (ruleTarget) {
        const target = await ruleTarget(id).catch(() => undefined)
        if (target === undefined) { unknown.add(id); continue }
        live.set(id, target !== null)
        if (target?.folder) folderOf.set(id, target.folder)
      } else {
        live.set(id, await ruleLive!(id))
      }
    }
    const keep: MoveRow[] = []
    const gone: MoveRow[] = []
    const later: MoveRow[] = []
    const groups = new Map<string, MoveRow[]>()
    for (const row of rows) {
      if (unknown.has(row.rule_id)) { later.push(row); continue }
      if (!live.get(row.rule_id)) { gone.push(row); continue }
      const key = `${row.account_id}\u0000${row.rule_id}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    for (const list of groups.values()) {
      if (!stillDecides) { keep.push(...list); continue }
      const decided = await stillDecides(list[0]!.rule_id, list[0]!.account_id, list.map((row) => row.message_id)).catch(() => null)
      if (decided === null) { later.push(...list); continue }
      for (const row of list) (decided.has(row.message_id) ? keep : gone).push(row)
    }
    if (gone.length > 0) {
      await this.deps.store.moves.drop(gone.map((row) => [row.account_id, row.message_id]))
      this.deps.log?.info?.('mail filter moves dropped, their rule no longer takes that mail', { count: gone.length })
    }
    if (later.length > 0) {
      const at = this.now() + RETRY_AFTER_MS[0]!
      await this.deps.store.moves.settle(later.map((row): SettleRow => [row.account_id, row.message_id, 'queued', row.attempts, row.reason, at]))
      this.deps.log?.warn('mail filter moves held: the sort engine cannot say which rule takes them yet', { count: later.length })
    }
    return { rows: keep, folderOf }
  }

  /** The provider's answer per message; `final` = no retry will help (the account cannot move). */
  private async move(accountId: string, rows: MoveRow[], folder?: string): Promise<Map<string, { ok: boolean; reason?: string; final?: boolean }>> {
    const out = new Map<string, { ok: boolean; reason?: string; final?: boolean }>()
    const spec = this.deps.providers.get(providerIdOf(accountId))
    const call = folder
      ? (spec?.capabilities.move && typeof spec.moveMany === 'function' ? (ids: string[]) => spec.moveMany!(accountId, ids, folder) : null)
      : (spec?.capabilities.archive && typeof spec.archiveMany === 'function' ? (ids: string[]) => spec.archiveMany!(accountId, ids) : null)
    if (!call) {
      for (const row of rows) out.set(row.message_id, { ok: false, reason: folder ? CANNOT_FILE : CANNOT_ARCHIVE, final: true })
      return out
    }
    let clock: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        call(rows.map((row) => row.message_id)),
        new Promise<never>((_, reject) => {
          clock = setTimeout(() => reject(new Error('The mail server took too long.')), MOVE_CALL_MS + rows.length * MOVE_PER_MESSAGE_MS)
        }),
      ])
      for (const one of Array.isArray(answer) ? answer : []) {
        if (one && typeof one.messageId === 'string') out.set(one.messageId, { ok: one.ok === true, ...(one.reason ? { reason: String(one.reason) } : {}) })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const row of rows) out.set(row.message_id, { ok: false, reason })
    } finally {
      if (clock) clearTimeout(clock)
    }
    return out
  }

  /** The moved mail is not in the inbox any more: its cached row and body go, and the counts follow. */
  private async dropCached(accountId: string, messageIds: string[], pairs: Map<string, FolderPair>): Promise<void> {
    if (messageIds.length === 0) return
    // In the account's write gate (the provider call already returned), rows before files.
    await this.deps.store.withAccountWrite(accountId, async () => {
      const rows = await this.deps.store.moves.cachedRows(accountId, messageIds)
      await this.deps.store.deleteMessages(rows.map((row) => row.rowid))
      for (const row of rows) if (row.body_ref) await this.deps.bodies.remove(row.body_ref).catch(() => undefined)
      const unread = new Map<string, number>()
      for (const row of rows) {
        pairs.set(`${accountId}\u0000${row.mailbox_id}`, { accountId, mailboxId: row.mailbox_id })
        if (row.seen === 0) unread.set(row.mailbox_id, (unread.get(row.mailbox_id) ?? 0) + 1)
      }
      for (const [mailboxId, count] of unread) await this.deps.store.bumpMailboxUnread(accountId, mailboxId, -count)
    })
  }

  dispose(): void {
    this.disposed = true
    this.timer?.dispose()
    this.timer = null
  }
}
