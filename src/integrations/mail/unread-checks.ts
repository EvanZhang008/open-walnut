/**
 * Who may ask a provider "what is unread in this folder right now", and when.
 *
 * The question is the only way the cache learns about mail read on another device (see
 * `unread-reconcile.ts`), and three callers want to ask it: the poll loop on every tick, a page a human
 * just opened, and the human pressing Refresh. Before this file each of them decided on its own, and the
 * result was the worst of both: the loop never asked, so mail read on a phone stayed unread until
 * somebody opened the list, and the list then waited for a provider round trip before it drew anything.
 *
 * The rules, each of them about cost or about honesty:
 *
 * - ONE CLOCK PER FOLDER, shared by every caller. A folder asked less than `UNREAD_CHECK_GAP_MS` ago is
 *   not asked again, whoever asks. The loop's tick and a page opened a moment later cost one call, not two.
 * - ONE CALL IN FLIGHT PER FOLDER. A second caller joins the running check rather than starting another.
 * - A page never waits long. It waits `PAGE_UNREAD_WAIT_MS` for its checks, answers from the cache, and
 *   names the checks still running (`checking`) so the console can say "Checking…" instead of nothing.
 * - A check a page was told about always SETTLES out loud: `unread-reconciled` goes out when it ends,
 *   whether it cleared rows, cleared none, or failed, because the console is showing "Checking…" until it
 *   hears. A check nobody was told about only speaks when it changed something, so the loop's tick is
 *   silent on the quiet ticks that are almost all of them.
 */

/** How long before the same folder may be asked again, by anyone. */
export const UNREAD_CHECK_GAP_MS = 60_000

/**
 * How long a page waits for its checks before answering from the cache.
 *
 * Short on purpose: the page is on a human's screen and holds one of the browser's six connections, and a
 * provider round trip routinely takes seconds. A check that outlives this is named in the page's
 * `checking` and settles by event.
 */
export const PAGE_UNREAD_WAIT_MS = 1_200

/** Folders one page may ask about, so an "All Inboxes" over many accounts is not N round trips. */
export const MAX_PAGE_CHECKS = 2

export interface UnreadCheckResult {
  /** Cached rows the answer proved read. */
  cleared: number
  /** The provider did not answer (timeout, error). Nothing was changed. */
  failed: boolean
  /**
   * The answer named fewer messages than the folder's own count, so that count may be stale and a
   * fresher one would let the next check conclude more (see `unread-reconcile.ts`, `short-of-badge`).
   */
  badgeStale?: boolean
}

export interface UnreadCheckSettled {
  accountId: string
  mailboxId: string
  cleared: number
  failed?: true
}

/** A folder a page could ask about, with the two counts that say how wrong the cache may be. */
export interface UnreadCheckCandidate {
  accountId: string
  mailboxId: string
  /** The folder's own count, as the provider last reported it. */
  providerUnread: number
  /** Rows the cache holds as unread there. */
  cachedUnread: number
}

export interface FolderPair {
  accountId: string
  mailboxId: string
}

interface Running {
  done: Promise<UnreadCheckResult>
  /** A page answered with this check in its `checking`, so its end must be announced. */
  announced: boolean
}

function keyOf(accountId: string, mailboxId: string): string {
  return `${accountId}\u0000${mailboxId}`
}

export class UnreadChecks {
  private readonly askedAt = new Map<string, number>()
  private readonly running = new Map<string, Running>()

  constructor(private readonly deps: {
    now(): number
    /** The check itself. Must not reject: a failure is `failed: true`. */
    run(accountId: string, mailboxId: string, options: { limit: number; deadlineMs: number }): Promise<UnreadCheckResult>
    settled(event: UnreadCheckSettled): void
  }) {}

  /** Whether this folder may be asked now: not running, and not asked within the gap. */
  isDue(accountId: string, mailboxId: string): boolean {
    const key = keyOf(accountId, mailboxId)
    if (this.running.has(key)) return false
    const last = this.askedAt.get(key)
    return last === undefined || this.deps.now() - last >= UNREAD_CHECK_GAP_MS
  }

  /**
   * Start a check, or join the one already running. Null when the gap says not yet.
   *
   * `force` is a human pressing Refresh: it skips the gap, never the one-in-flight rule. `limit` is the
   * page size the provider is asked for; a caller that joins a running check gets whatever it asked.
   */
  start(
    accountId: string,
    mailboxId: string,
    options: { limit: number; deadlineMs: number; force?: boolean },
  ): Promise<UnreadCheckResult> | null {
    const key = keyOf(accountId, mailboxId)
    const joined = this.running.get(key)
    if (joined) return joined.done
    if (!options.force && !this.isDue(accountId, mailboxId)) return null
    // Stamped at the START: a slow answer must not let a second caller in while it is still thinking.
    this.askedAt.set(key, this.deps.now())
    const entry: Running = { done: Promise.resolve({ cleared: 0, failed: false }), announced: false }
    entry.done = this.deps.run(accountId, mailboxId, { limit: options.limit, deadlineMs: options.deadlineMs })
      .catch((): UnreadCheckResult => ({ cleared: 0, failed: true }))
      .then((result) => {
        if (this.running.get(key) === entry) this.running.delete(key)
        if (result.cleared > 0 || entry.announced) {
          this.deps.settled({
            accountId, mailboxId, cleared: result.cleared, ...(result.failed ? { failed: true as const } : {}),
          })
        }
        return result
      })
    this.running.set(key, entry)
    return entry.done
  }

  /**
   * Which of these a page should start now: disagreeing folders first (the most wrong list on screen),
   * then the one asked longest ago. A folder already running is left out here, since the page joins it
   * through `runningAmong` rather than starting it.
   */
  pick(candidates: readonly UnreadCheckCandidate[], max: number, force = false): UnreadCheckCandidate[] {
    const now = this.deps.now()
    const age = (one: UnreadCheckCandidate): number => now - (this.askedAt.get(keyOf(one.accountId, one.mailboxId)) ?? 0)
    return candidates
      .filter((one) => !this.running.has(keyOf(one.accountId, one.mailboxId)))
      .filter((one) => force || this.isDue(one.accountId, one.mailboxId))
      .sort((a, b) => (
        Math.abs(b.cachedUnread - b.providerUnread) - Math.abs(a.cachedUnread - a.providerUnread)
        || age(b) - age(a)
      ))
      .slice(0, Math.max(0, max))
  }

  /** The checks still running for any of these folders, with their promises, in the order given. */
  runningAmong(pairs: readonly FolderPair[]): Array<FolderPair & { done: Promise<UnreadCheckResult> }> {
    const out: Array<FolderPair & { done: Promise<UnreadCheckResult> }> = []
    for (const pair of pairs) {
      const entry = this.running.get(keyOf(pair.accountId, pair.mailboxId))
      if (entry) out.push({ accountId: pair.accountId, mailboxId: pair.mailboxId, done: entry.done })
    }
    return out
  }

  /** A page is about to tell a console these are running: from now on their end is announced. */
  announce(pairs: readonly FolderPair[]): void {
    for (const pair of pairs) {
      const entry = this.running.get(keyOf(pair.accountId, pair.mailboxId))
      if (entry) entry.announced = true
    }
  }

  /**
   * Forget the clocks, for one account or all of them.
   *
   * A provider registering again (a reload, a new version) has not been asked anything yet, and a clock
   * carried over from its previous instance would make the first page after the reload skip the question.
   * Running checks are left alone: they finish, and announce, as they were going to.
   */
  forget(accountId?: string): void {
    if (!accountId) { this.askedAt.clear(); return }
    for (const key of [...this.askedAt.keys()]) {
      if (key.startsWith(`${accountId}\u0000`)) this.askedAt.delete(key)
    }
  }
}
