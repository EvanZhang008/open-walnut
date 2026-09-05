/**
 * The poll loop: one interval, one budget, and a bounded amount of work per tick.
 *
 * Everything here exists to keep a mail sync from being able to hurt the rest of Walnut:
 *
 * - ONE timer for every account. A timer per account is how a poller with ten mailboxes turns
 *   into ten overlapping fetches at the same second every two minutes.
 * - A TICK BUDGET, checked between containers, with retention last. Under pressure the sweep
 *   is the first thing dropped, because a cache that is 200 rows too big is not a problem and
 *   a tick that never ends is.
 * - PUSH AND POLL SHARE ONE FETCH PATH. `provider.watch` hands back a hint; the hint flips a
 *   flag and kicks this loop. No provider callback ever does I/O, so no provider callback can
 *   block the event loop.
 * - PER ACCOUNT BACKOFF, and an `auth` failure STOPS that account. Retrying a wrong password
 *   every two minutes is how an account gets locked out; the account waits for the human, one
 *   recoverable notification says so, and the next good poll retires it.
 * - It does not run on a replica at all. Two boxes polling one mailbox double every fetch and
 *   every write, and only the primary owns the outside account.
 */
import {
  BODY_PREFETCH_LIMIT,
  callProvider,
  DEFAULT_LIMITS,
  MailServiceError,
  providerErrorCode,
  reasonOf,
  type MailSyncHost,
  type MailSyncLimits,
} from './contract.js'
import type { MailEvents } from './events.js'
import type { MailRetention } from './retention.js'
import type { MailService } from './service.js'
import type { MailStore, MailboxRow } from './store.js'
import type { Disposable, MailProviderSpec, MailboxRole } from './types.js'

/** How long one tick may run before it hands the event loop back. */
export const TICK_BUDGET_MS = 20_000

/** The inbox is polled every tick; every other container on every Nth. */
export const NON_INBOX_EVERY = 5

/** Envelopes per poll request. */
export const PAGE_LIMIT = 50

/** Pages one container may take in one tick, so a first backfill spreads over several. */
export const MAX_PAGES_PER_TICK = 20

export const MIN_BACKOFF_MS = 60_000
export const MAX_BACKOFF_MS = 30 * 60_000

export interface TickReport {
  polled: number
  added: number
  updated: number
  skipped: number
  /** True when the budget ran out before every account had its turn. */
  incomplete: boolean
}

interface AccountState {
  /** Per-account tick count, which is what the every-Nth rule counts. */
  polls: number
  failures: number
  /** Backoff gate: no timer-driven poll before this instant. */
  nextAt: number
  /** An `auth` failure parks the account until a human-driven refresh or a good poll. */
  paused: boolean
  /** Containers a watch hint marked, polled on the next tick whatever the Nth rule says. */
  dirty: Set<string>
  /** False until one sync of this account drained every container it looked at. */
  backfilled: boolean
}

function emptyState(): AccountState {
  return { polls: 0, failures: 0, nextAt: 0, paused: false, dirty: new Set(), backfilled: false }
}

export class MailSync {
  private readonly states = new Map<string, AccountState>()
  private readonly watches = new Map<string, Disposable>()
  private timer: Disposable | null = null
  private configWatch: Disposable | null = null
  private kickPending: Disposable | null = null
  private running: Promise<TickReport> | null = null
  private rotation = 0
  private lastTickAt = 0
  private limits: MailSyncLimits = DEFAULT_LIMITS
  private ready: Promise<void> | null = null
  private stopped = false

  constructor(private readonly deps: {
    walnut: MailSyncHost
    store: MailStore
    service: MailService
    retention: MailRetention
    events: MailEvents
    /**
     * The send ledger's reaper. Optional so a test can drive a poll loop without the write path.
     *
     * It rides the tick because a row stuck in `sending` only happens when the process died
     * mid-attempt, so the thing that has to notice is whatever runs next, and the tick is the one
     * timer this plugin owns. It goes FIRST: it is a bounded batch against a handful of rows, and
     * a draft that is stuck showing "sending" is the most alarming thing a mail console can show.
     * Both of these run INSIDE the tick's deadline; before they did not, and between them they
     * could spend the whole budget on letter writes and starve the poll they share it with.
     */
    sends?: { reap(deadlineAt?: number): Promise<number> }
    /** The frozen-draft reconciler: crashes in the approval window, and lost answers. */
    approvals?: { reconcile(deadlineAt?: number): Promise<{ unfrozen: number; resumed: number }> }
  }) {}

  get polling(): boolean {
    return this.timer !== null
  }

  get lastTick(): number {
    return this.lastTickAt
  }

  /** Arms the interval, unless this box is a replica, in which case it arms nothing. */
  start(): void {
    if (this.stopped || this.timer) return
    if (this.deps.walnut.replica) {
      this.deps.walnut.log.info('mail polling stays off on a replica')
      return
    }
    this.ready = this.loadLimits()
    // Not awaited: activation registers and gets out of the way, and the first tick is a
    // whole interval away. `tick()` waits for this promise, so nothing can race it.
    void this.ready.then(() => {
      if (this.stopped || this.timer) return
      this.timer = this.arm()
    })
    this.configWatch = this.deps.walnut.config.onChange(() => {
      const before = this.limits.pollIntervalSeconds
      this.ready = this.loadLimits().then(() => {
        // The interval is baked into the armed timer, so a new value means a new timer. Without
        // this, changing the poll interval in Settings looked like it worked and changed nothing
        // until the next server restart.
        if (this.stopped || this.limits.pollIntervalSeconds === before) return
        this.timer?.dispose()
        this.timer = this.arm()
        this.deps.walnut.log.info('mail poll interval changed', {
          fromSeconds: before, toSeconds: this.limits.pollIntervalSeconds,
        })
      })
      return this.ready
    })
  }

  private arm(): Disposable {
    return this.deps.walnut.timers.interval(
      () => this.runTick({}).then(() => undefined),
      Math.max(5, this.limits.pollIntervalSeconds) * 1_000,
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.timer?.dispose()
    this.timer = null
    this.configWatch?.dispose()
    this.configWatch = null
    this.kickPending?.dispose()
    this.kickPending = null
    for (const watch of this.watches.values()) {
      try { await watch.dispose() }
      catch { /* a provider that fails to unsubscribe is its own problem */ }
    }
    this.watches.clear()
    // Awaited so a dispose cannot leave a tick writing into a database that is closing.
    await this.running?.catch(() => undefined)
  }

  /**
   * Drop everything this loop remembers about an account.
   *
   * Called when the account is deleted. Without it a delete-then-re-add inherits the deleted
   * account's `paused` flag and its backoff, so a freshly added account with a correct password
   * sits parked waiting for a human who has already done the work.
   */
  async forget(accountId: string): Promise<void> {
    this.states.delete(accountId)
    const watch = this.watches.get(accountId)
    if (!watch) return
    this.watches.delete(accountId)
    try { await watch.dispose() }
    catch { /* a provider that fails to unsubscribe is its own problem */ }
  }

  /**
   * A watch hint arrived. NO I/O happens here, by construction: a Map write and a timer.
   *
   * The provider callback runs on whatever the provider's transport calls it from, so anything
   * awaited here would be a fetch on someone else's stack, in the middle of the event loop.
   */
  markDirty(accountId: string, mailboxId?: string): void {
    const state = this.stateFor(accountId)
    if (mailboxId) state.dirty.add(mailboxId)
    // A hint also clears the backoff gate: the server just told us there is something there.
    state.nextAt = 0
    this.kick()
  }

  /**
   * A human asked. Polls every container and ignores both gates, because `force` is checked
   * where the gates are.
   *
   * It deliberately does NOT clear `paused` first. Clicking refresh is not what fixes an
   * account; a poll that succeeds is, and `onGoodPoll` needs to still see the park to know it
   * has something to retire. Clearing it here made the recovery silent: the mirror stayed
   * `auth-required` with a working password behind it.
   */
  async refresh(accountId?: string): Promise<TickReport> {
    if (this.deps.walnut.replica) return { polled: 0, added: 0, updated: 0, skipped: 0, incomplete: false }
    return this.runTick({ force: true, ...(accountId ? { only: accountId } : {}) })
  }

  /**
   * One tick. Also the test seam: a test drives this directly rather than waiting on a timer.
   *
   * Serialized on `this.running`: two overlapping ticks would double every fetch and race
   * every cursor write, and the interval firing while a slow tick is still going is normal.
   */
  runTick(options: { force?: boolean; only?: string }): Promise<TickReport> {
    const previous = this.running ?? Promise.resolve(null)
    const current = previous
      .catch(() => null)
      .then(() => this.tick(options))
    this.running = current
    void current.finally(() => { if (this.running === current) this.running = null }).catch(() => undefined)
    return current
  }

  private async tick(options: { force?: boolean; only?: string }): Promise<TickReport> {
    const report: TickReport = { polled: 0, added: 0, updated: 0, skipped: 0, incomplete: false }
    if (this.stopped || this.deps.walnut.replica) return report
    if (this.ready) await this.ready.catch(() => undefined)

    const startedAt = Date.now()
    this.lastTickAt = startedAt
    const deadlineAt = startedAt + TICK_BUDGET_MS

    if (this.deps.sends) {
      try {
        const reaped = await this.deps.sends.reap(deadlineAt)
        if (reaped > 0) this.deps.walnut.log.warn('mail sends reaped as unknown', { reaped })
      } catch (error) {
        this.deps.walnut.log.warn('mail send reaper failed', { error: reasonOf(error).slice(0, 200) })
      }
    }
    if (this.deps.approvals) {
      try {
        await this.deps.approvals.reconcile(deadlineAt)
      } catch (error) {
        this.deps.walnut.log.warn('mail approval reconciler failed', {
          error: reasonOf(error).slice(0, 200),
        })
      }
    }

    let accounts = (await this.deps.store.listAccounts()).filter((row) => row.state !== 'disabled')
    if (options.only) accounts = accounts.filter((row) => row.account_id === options.only)
    this.pruneWatches(new Set(accounts.map((row) => row.account_id)))

    // Round robin from where the last tick stopped, so a slow first account cannot starve the
    // rest for as long as it stays slow.
    const offset = accounts.length > 0 ? this.rotation % accounts.length : 0
    const ordered = [...accounts.slice(offset), ...accounts.slice(0, offset)]
    let processed = 0

    for (const account of ordered) {
      if (Date.now() >= deadlineAt) { report.incomplete = true; break }
      processed += 1
      const state = this.stateFor(account.account_id)
      if (!options.force && (state.paused || Date.now() < state.nextAt)) {
        report.skipped += 1
        continue
      }
      const outcome = await this.syncAccount(account.account_id, state, deadlineAt, !!options.force)
      report.polled += 1
      report.added += outcome.added
      report.updated += outcome.updated
    }
    this.rotation = accounts.length > 0 ? (offset + processed) % accounts.length : 0

    // LAST, on whatever budget is left. A skipped sweep costs some disk; a sweep that eats the
    // tick costs every account its poll.
    if (Date.now() < deadlineAt) {
      try {
        const swept = await this.deps.retention.retain(this.limits, deadlineAt)
        if (swept.messagesDeleted || swept.bodiesDropped) {
          this.deps.walnut.log.debug('mail retention swept', { ...swept })
        }
      } catch (error) {
        this.deps.walnut.log.warn('mail retention failed', { error: reasonOf(error).slice(0, 200) })
      }
    } else {
      report.incomplete = true
    }
    return report
  }

  private async syncAccount(
    accountId: string,
    state: AccountState,
    deadlineAt: number,
    force: boolean,
  ): Promise<{ added: number; updated: number }> {
    let added = 0
    let updated = 0
    try {
      const spec = this.deps.service.provider(accountId)
      state.polls += 1
      this.ensureWatch(accountId, spec)

      const mailboxes = await this.refreshMailboxes(accountId, spec, state, force)
      const wide = force || state.polls % NON_INBOX_EVERY === 1
      const containers = wide
        ? mailboxes
        : mailboxes.filter((row) => row.role === ('inbox' satisfies MailboxRole) || state.dirty.has(row.mailbox_id))

      const headlines: Array<{ from: string; subject: string }> = []
      let exhausted = true
      // Counted separately from `added`: a message appearing in Sent is one the user sent, and
      // announcing it as "received" is wrong in the one place a human reads the number.
      let received = 0
      for (const mailbox of containers) {
        if (Date.now() >= deadlineAt) { exhausted = false; break }
        const outcome = await this.syncContainer(accountId, mailbox, spec, deadlineAt)
        added += outcome.added
        updated += outcome.updated
        if (mailbox.role === ('inbox' satisfies MailboxRole)) {
          received += outcome.added
          headlines.push(...outcome.headlines)
        }
        exhausted = exhausted && outcome.exhausted
        state.dirty.delete(mailbox.mailbox_id)
      }

      const inbox = mailboxes.find((row) => row.role === 'inbox')
      if (inbox && Date.now() < deadlineAt) {
        await this.deps.service.prefetchBodies(accountId, inbox.mailbox_id, BODY_PREFETCH_LIMIT, deadlineAt)
      }

      // One event per account per tick, and none at all for the first backfill: "you have 4812
      // new messages" is the account being added, not news.
      if (state.backfilled) this.deps.events.messagesReceived(accountId, received, headlines)
      if (exhausted) state.backfilled = true
      await this.onGoodPoll(accountId, state)
    } catch (error) {
      // A provider that is not registered right now is not a failure of this account: its
      // plugin is reloading or off, and the loop picks the account up again when it is back.
      if (error instanceof MailServiceError && error.code === 'provider_unavailable') {
        this.deps.walnut.log.debug('mail account skipped, provider not registered', { accountId })
        return { added, updated }
      }
      await this.onFailedPoll(accountId, state, error)
    }
    return { added, updated }
  }

  private async refreshMailboxes(
    accountId: string,
    spec: MailProviderSpec,
    state: AccountState,
    force: boolean,
  ): Promise<MailboxRow[]> {
    let rows = await this.deps.store.listMailboxes(accountId)
    const stale = rows.length === 0 || force || state.polls % NON_INBOX_EVERY === 1
    if (!stale) return rows
    const listed = await callProvider('a mailbox list', () => spec.listMailboxes(accountId))
    for (const mailbox of listed) {
      await this.deps.store.upsertMailbox({
        accountId,
        mailboxId: mailbox.mailboxId,
        name: mailbox.name,
        role: mailbox.role ?? 'other',
        unread: mailbox.unread ?? 0,
        total: mailbox.total ?? 0,
      })
    }
    rows = await this.deps.store.listMailboxes(accountId)
    return rows
  }

  private async syncContainer(
    accountId: string,
    mailbox: MailboxRow,
    spec: MailProviderSpec,
    deadlineAt: number,
  ): Promise<{ added: number; updated: number; headlines: Array<{ from: string; subject: string }>; exhausted: boolean }> {
    const startedAt = Date.now()
    let cursor = mailbox.cursor ?? undefined
    let added = 0
    let updated = 0
    let exhausted = false
    const headlines: Array<{ from: string; subject: string }> = []

    for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
      if (Date.now() >= deadlineAt) break
      let result
      try {
        const request = { mailbox: mailbox.mailbox_id, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
        result = await callProvider(
          `a poll of ${mailbox.mailbox_id}`,
          () => spec.poll(accountId, request),
        )
      } catch (error) {
        // A container that vanished is not an account failure: the next mailbox list drops it.
        if (providerErrorCode(error) === 'not-found') { exhausted = true; break }
        throw error
      }
      // A reset discovered PAST page 0 stops the container here, without writing the new
      // cursor. The alternative is what this used to do: ignore the reset and store the
      // new-epoch cursor anyway, which leaves the old epoch's rows in the cache forever with a
      // cursor that says everything is fine. Leaving the old cursor makes the next tick meet the
      // same reset at page 0, where it is handled properly.
      if (result.reset && page > 0) {
        this.deps.walnut.log.info('mail container changed epoch mid-page, resyncing next tick', {
          accountId, mailboxId: mailbox.mailbox_id, page,
        })
        break
      }
      // Honoured once per container per tick. A provider that answered `reset` on every page
      // would otherwise delete the rows it just handed us, forever.
      if (result.reset) {
        await this.deps.retention.resetContainer(accountId, mailbox.mailbox_id)
        await this.deps.store.setMailboxCursor(accountId, mailbox.mailbox_id, null, Date.now())
      }
      const ingested = await this.deps.service.ingestPage(accountId, result.messages ?? [])
      added += ingested.added
      updated += ingested.updated
      headlines.push(...ingested.headlines)
      cursor = result.cursor
      await this.deps.store.setMailboxCursor(accountId, mailbox.mailbox_id, cursor ?? null, Date.now())
      if (!result.more) { exhausted = true; break }
    }

    this.deps.events.syncCompleted(
      { accountId, mailboxId: mailbox.mailbox_id, added, updated, tookMs: Date.now() - startedAt },
      cursor ?? null,
    )
    return { added, updated, headlines, exhausted }
  }

  private async onGoodPoll(accountId: string, state: AccountState): Promise<void> {
    const parked = state.failures > 0 || state.paused
    state.failures = 0
    state.paused = false
    state.nextAt = 0
    // The MIRROR gets a vote, not just this process's memory. A restart wipes the in-memory
    // park while the row still says `auth-required`, and then a good poll on a fixed password
    // would leave the account red forever with nothing left that could ever clear it. One row
    // read on a path that runs once per account per tick.
    const row = await this.deps.store.getAccount(accountId)
    // A row that is GONE gets nothing. The delete already happened; an upsert here would
    // resurrect the account as a zombie with no provider config behind it, and its message rows
    // would be orphaned where `retain` can never find them again.
    if (!row) return
    if (!parked && row.state === 'active') return
    // A bare UPDATE, deliberately, not `accounts.mirror()`: mirror is an upsert, and a health
    // write must never be able to CREATE an account row.
    await this.deps.store.setAccountHealth(
      accountId,
      'active',
      JSON.stringify({ state: 'ok', checkedAt: Date.now() }),
    )
    this.deps.events.accountHealth(accountId, 'active')
    // Per plugin, not per account: `recover()` retires every mail error card, so it only fires
    // once nothing is parked. Otherwise fixing one account would clear the other's red.
    if (![...this.states.values()].some((one) => one.paused)) {
      await this.deps.walnut.notifications.recover().catch(() => undefined)
    }
  }

  private async onFailedPoll(accountId: string, state: AccountState, error: unknown): Promise<void> {
    const code = providerErrorCode(error)
    const detail = reasonOf(error).slice(0, 300)
    if (code === 'auth') {
      state.paused = true
      state.failures = 0
      // Same rule as the good-poll path: UPDATE, never upsert. A poll that fails on the very
      // tick the human deleted the account must not put the account back.
      await this.deps.store.setAccountHealth(
        accountId,
        'auth-required',
        JSON.stringify({ state: 'auth-required', checkedAt: Date.now(), detail }),
      )
      if (!(await this.deps.store.accountExists(accountId))) return
      this.deps.events.accountHealth(accountId, 'auth-required')
      // ONE card per account, recoverable: the dedup key is the account, so a parked account
      // does not add a row per tick, and the next good poll retires it.
      await this.deps.walnut.notifications.error({
        title: 'Mail sign-in needed',
        body: `Walnut cannot sign in to ${accountId}. Update the password, then refresh the account. ${detail}`,
        dedupKey: `account-auth:${accountId}`,
      }).catch(() => undefined)
      this.deps.walnut.log.warn('mail account parked, sign-in needed', { accountId })
      return
    }
    state.failures += 1
    const backoff = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (state.failures - 1))
    state.nextAt = Date.now() + backoff
    this.deps.walnut.log.warn('mail poll failed', {
      accountId, failures: state.failures, backoffMs: backoff, code: code ?? 'unknown', error: detail,
    })
  }

  private ensureWatch(accountId: string, spec: MailProviderSpec): void {
    if (!spec.capabilities.watch || !spec.watch || this.watches.has(accountId)) return
    try {
      this.watches.set(accountId, spec.watch(accountId, (hint) => {
        this.markDirty(accountId, hint?.mailbox)
      }))
    } catch (error) {
      this.deps.walnut.log.warn('mail watch could not be armed', {
        accountId, error: reasonOf(error).slice(0, 200),
      })
    }
  }

  private pruneWatches(live: Set<string>): void {
    for (const [accountId, watch] of [...this.watches.entries()]) {
      if (live.has(accountId)) continue
      this.watches.delete(accountId)
      void Promise.resolve(watch.dispose()).catch(() => undefined)
    }
  }

  /** Coalesced: many hints in one burst arm one tick, not one tick each. */
  private kick(): void {
    if (this.stopped || this.kickPending || this.deps.walnut.replica) return
    this.kickPending = this.deps.walnut.timers.timeout(() => {
      this.kickPending = null
      return this.runTick({}).then(() => undefined)
    }, 250)
  }

  private stateFor(accountId: string): AccountState {
    const existing = this.states.get(accountId)
    if (existing) return existing
    const created = emptyState()
    this.states.set(accountId, created)
    return created
  }

  private async loadLimits(): Promise<void> {
    try {
      const config = await this.deps.walnut.config.get<Record<string, unknown>>()
      const number = (key: string, fallback: number): number => {
        const value = config[key]
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
      }
      this.limits = {
        pollIntervalSeconds: number('poll_interval_seconds', DEFAULT_LIMITS.pollIntervalSeconds),
        retentionDays: number('retention_days', DEFAULT_LIMITS.retentionDays),
        maxRowsPerAccount: number('max_rows_per_account', DEFAULT_LIMITS.maxRowsPerAccount),
        bodyCacheMb: number('body_cache_mb', DEFAULT_LIMITS.bodyCacheMb),
      }
    } catch (error) {
      this.deps.walnut.log.warn('mail config could not be read, using defaults', {
        error: reasonOf(error).slice(0, 200),
      })
      this.limits = DEFAULT_LIMITS
    }
  }
}

/**
 * One mail plugin instance per process, so a test can drive a tick without a timer.
 * A reload replaces it; a dispose clears it.
 */
let activeSync: MailSync | null = null

export function setActiveMailSync(sync: MailSync | null): void {
  activeSync = sync
}

/** Test-only: drive `runTick` directly instead of waiting out a poll interval. */
export function mailSyncForTesting(): MailSync | null {
  return activeSync
}
