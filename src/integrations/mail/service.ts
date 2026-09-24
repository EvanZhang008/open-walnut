/**
 * The mail cache as a domain, sitting between the routes and `store.ts`.
 *
 * Everything above this file (routes, the poller, the published service) speaks the shapes
 * `contract.ts` declares; everything below it speaks SQL. Deletes live next door in
 * `retention.ts`. Three rules this file enforces on the way through:
 *
 * - A provider call ALWAYS has a deadline. A stuck IMAP socket must surface as `unreachable`
 *   and never as a pinned HTTP response: one pinned response takes one of the browser's six
 *   connections, and six of those is an app-wide stall that looks like Walnut being broken.
 * - A per-item failure is not an account failure. One unfetchable body answers with a
 *   `bodyError` and leaves account health exactly where it was; only account-level failures
 *   (`auth`, a dead connection) move health, and that is the poller's job, not a read's.
 * - Bodies are fetched LAZILY. A poll stores envelopes; the bytes arrive on the first read or
 *   through the tick's bounded prefetch, so adding an account costs one page of headers rather
 *   than a mailbox-sized download.
 */
import type { MailBodyStore } from './bodies.js'
import { MailBodyTooLargeError, MAX_BODY_BYTES, plainTextOf, snippetOf } from './bodies.js'
import { keyOfMessage } from './message-tasks.js'
import {
  bodyBelongsTo,
  fillAddressesFromBody,
  fillUnsubscribeFromBody,
  filledAddresses,
  payloadForRetiredBody,
  senderForUpdate,
  unsubscribeForUpdate,
  type BodyAddressFill,
} from './service-body.js'
import {
  envelopeToDto,
  parseJson,
  sizeHintOf,
  toDto,
  unsubscribeAvailability,
  unsubscribeListKey,
  type MessagePayload,
  type StoredListUnsubscribe,
} from './service-dto.js'
import { unsubscribeFromBodyHtml } from './unsubscribe-link.js'
import { reconcileUnread, type UnreadReconcileResult } from './unread-reconcile.js'
import {
  MAX_PAGE_CHECKS,
  PAGE_UNREAD_WAIT_MS,
  UnreadChecks,
  type FolderPair,
  type UnreadCheckCandidate,
  type UnreadCheckResult,
  type UnreadCheckSettled,
} from './unread-checks.js'
import {
  callProvider,
  encodeMessageCursor,
  envelopeHashOf,
  ftsMatchFor,
  MailServiceError,
  providerErrorCode,
  providerIdOf,
  threadIdOf,
  type IngestResult,
  type MailAccountDto,
  type MailBodyDto,
  type MailMessageDto,
  type MailUnsubscribeAvailability,
  type MailboxDto,
  type MessagePageCursor,
} from './contract.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MessageScopeRole } from './scope.js'
import { folderKey } from './store.js'
import type { MailStore, MessageRow, MessageWrite, UnreadKeyRow } from './store.js'
import type { UnsubscribeRow } from './store-write.js'
import type {
  MailAccount,
  MailAddress,
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailProviderSpec,
  MailboxRole,
  ProviderErrorCode,
} from './types.js'

/**
 * How long one per-account capability lookup may take, and how long its answer is trusted.
 *
 * Far shorter than `PROVIDER_DEADLINE_MS`: this is a question asked on a polled route, and the
 * cost of a stale-by-a-minute answer is a Send button that is briefly wrong, while the cost of an
 * unbounded one is the console's account list stalling behind a wedged mail server.
 */
const CAPABILITY_DEADLINE_MS = 2_000
const CAPABILITY_TTL_MS = 60_000
/**
 * How long one provider unread list may take. A page no longer waits for it (see `unread-checks.ts`), so
 * this is only the point past which the answer is abandoned and the check counts as failed.
 */
export const UNREAD_LIST_DEADLINE_MS = 8_000

/** How many unread envelopes a background check asks for: one ordinary page. */
const UNREAD_CHECK_LIMIT = 50

/** The `sent_at` column an envelope writes: one definition, so the row and the retire check agree. */
function sentAtOf(envelope: MailEnvelope): number {
  return Number.isFinite(envelope.sentAt) ? envelope.sentAt : 0
}

/**
 * One message, as the unsubscribe ladder needs it: which rung it can be handed to, what the ledger
 * keys it under, and the sender's own links. See `MailService.unsubscribeSubject`.
 */
export interface UnsubscribeSubject {
  /** Canonical ids: a caller may name a message by its RFC Message-ID, the ledger may not. */
  accountId: string
  messageId: string
  listKey: string
  available: MailUnsubscribeAvailability
  held?: StoredListUnsubscribe
  fromAddr: string
  subject: string
}

export class MailService {
  /** Per account: the last `send` verdict and when it was learned. See `sendCapabilityOf`. */
  private readonly sendCache = new Map<string, { send: boolean; at: number }>()

  /** Every provider unread question goes through here: one clock and one call in flight per folder. */
  private readonly unreadChecks: UnreadChecks

  constructor(private readonly deps: {
    store: MailStore
    bodies: MailBodyStore
    providers: MailProviderRegistry
    now?: () => number
    /**
     * Optional: told when an unread check settles that changed rows or that a page said was running. Its
     * own seam rather than the whole `MailEvents`, because this is the only thing a read path announces.
     */
    events?: { unreadReconciled(event: UnreadCheckSettled): void }
    /** Optional: an address a body offered and the base refused (debug), a body retired because its row moved (info). */
    log?: {
      debug(message: string, fields?: Record<string, unknown>): void
      info?(message: string, fields?: Record<string, unknown>): void
    }
  }) {
    this.unreadChecks = new UnreadChecks({
      now: () => this.now,
      run: (accountId, mailboxId, deadlineMs) => this.runUnreadCheck(accountId, mailboxId, deadlineMs),
      settled: (event) => this.deps.events?.unreadReconciled(event),
    })
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  provider(accountId: string): MailProviderSpec {
    const providerId = providerIdOf(accountId)
    const spec = this.deps.providers.get(providerId)
    if (!spec) {
      throw new MailServiceError(
        'provider_unavailable',
        `No mail provider "${providerId}" is registered, so account "${accountId}" cannot be reached right now.`,
        503,
      )
    }
    return spec
  }

  // ── reads ──

  /**
   * Every account, with the numbers a console needs.
   *
   * `capabilities: false` is the SHAPE WITHOUT A PROVIDER CALL, and it exists because this is the
   * most-polled route in the plugin. The per-account `send` verdict can reach the provider, so it is
   * cached, bounded (see `sendCapabilityOf`) and skippable: a caller that only wants names and
   * counts (the agent's context line, the digest, a route whose budget has run out) asks for the
   * cheap shape and touches nothing outside the database.
   */
  async listAccounts(options: { capabilities?: boolean } = {}): Promise<MailAccountDto[]> {
    const rows = await this.deps.store.listAccounts()
    // ONE grouped query for every account's unread count. It used to be one query per account,
    // which is a worker round trip per row on a route the console polls.
    const unread = await this.deps.store.unreadByAccount()
    // Every account's `send` verdict at once. Each one may be a provider call (cheap by contract,
    // but a call), and awaiting them one after another inside the loop would make the console's
    // most-polled route as slow as the sum of them.
    const sends = options.capabilities === false
      ? rows.map(() => undefined)
      : await Promise.all(rows.map((row) => this.sendCapabilityOf(row.account_id, row.provider_id)))
    const out: MailAccountDto[] = []
    for (const [at, row] of rows.entries()) {
      const counts = unread.get(row.account_id)
      const send = sends[at]
      out.push({
        ...parseJson<Partial<MailAccount>>(row.payload, {}),
        accountId: row.account_id,
        providerId: row.provider_id,
        displayName: row.display_name,
        address: row.address,
        state: row.state as MailAccount['state'],
        ...(row.health_json ? { health: parseJson<MailAccount['health']>(row.health_json, undefined) } : {}),
        unread: counts?.total ?? 0,
        unreadInbox: counts?.inbox ?? 0,
        ...(send === undefined ? {} : { capabilities: { send } }),
      })
    }
    return out
  }

  /**
   * Can THIS account send, as far as anything can tell without opening a connection.
   *
   * Gentle on purpose, at four points, and every one of them is about the same thing: `GET /accounts`
   * is polled by every open tab and it must not be as slow as the slowest mail server behind it.
   *
   * - A provider that is off or reloading answers `undefined`, so a cached account whose plugin is
   *   not loaded does not turn the accounts list into a 503.
   * - A provider with no per-account answer contributes its static block, with no call at all.
   * - A provider that THROWS falls back to that static block: it answered, just not usefully.
   * - A provider that does not answer inside `CAPABILITY_DEADLINE_MS` answers `undefined`, which
   *   means "no per-account view" and sends the client to the provider block on its own. The
   *   deadline is two seconds rather than the 15 a provider call normally gets, because N accounts
   *   used to make N calls at 15s with nothing bounding the route: one wedged IMAP server held the
   *   console's accounts request open for a quarter of a minute, and `GET /accounts` is what the
   *   sidebar badge, the agent surface gate and the digest all wait on.
   *
   * The answer is CACHED per account, invalidated by `forgetCapabilities` on an account or provider
   * change and expired by a short TTL as a backstop, so the steady state of a polling console is
   * zero provider calls.
   */
  private async sendCapabilityOf(accountId: string, providerId: string): Promise<boolean | undefined> {
    const spec = this.deps.providers.get(providerId)
    if (!spec) return undefined
    if (!spec.accountCapabilities) return spec.capabilities.send
    const cached = this.sendCache.get(accountId)
    if (cached && cached.at + CAPABILITY_TTL_MS > this.now) return cached.send
    try {
      const caps = await callProvider(
        `capabilities for ${accountId}`,
        async () => spec.accountCapabilities!(accountId),
        CAPABILITY_DEADLINE_MS,
      )
      this.sendCache.set(accountId, { send: caps.send, at: this.now })
      return caps.send
    } catch (error) {
      // A deadline is NOT an answer, so it is neither cached nor turned into the provider's static
      // block: the honest report is "unknown", and an unknown is retried on the next poll.
      if ((error as { code?: string } | null)?.code === 'unreachable') return undefined
      this.sendCache.set(accountId, { send: spec.capabilities.send, at: this.now })
      return spec.capabilities.send
    }
  }

  /**
   * Forget a cached `send` verdict, or all of them.
   *
   * Called on `account-changed` (an account whose SMTP settings were just filled in must not be
   * told for a minute that it cannot send) and on a provider registration change. Everything else
   * relies on the TTL.
   */
  forgetCapabilities(accountId?: string): void {
    if (accountId) this.sendCache.delete(accountId)
    else this.sendCache.clear()
    // Same edges: a provider that registered again has not been asked what is unread yet.
    this.unreadChecks.forget(accountId)
  }

  /**
   * The capabilities that apply to ONE account, which is not always the provider's.
   *
   * IMAP is the case: sending needs SMTP settings the human may not have filled in, so two
   * accounts behind the same provider genuinely differ on `send`. A provider that answers
   * `accountCapabilities` wins over its static block; one that does not is unchanged.
   */
  async capabilitiesFor(accountId: string): Promise<MailCapabilities> {
    const spec = this.provider(accountId)
    if (!spec.accountCapabilities) return spec.capabilities
    return callProvider(
      `capabilities for ${accountId}`,
      async () => spec.accountCapabilities!(accountId),
    )
  }

  async listMailboxes(accountId: string): Promise<MailboxDto[]> {
    const rows = await this.deps.store.listMailboxes(accountId)
    return rows.map((row) => ({
      accountId: row.account_id,
      mailboxId: row.mailbox_id,
      name: row.name,
      role: row.role as MailboxRole,
      unread: row.unread,
      total: row.total,
      ...(row.last_sync_at ? { lastSyncAt: row.last_sync_at } : {}),
    }))
  }

  /**
   * The task backlink for a page of messages, in ONE query, added on the way out.
   *
   * Derived on every read rather than stored on the message row: the task can be deleted or
   * repointed by anything in Walnut, and a copy on the row would be a second truth that goes stale
   * without anybody noticing. Batched because the alternative is a lookup per row, and a 50-row
   * list would then cost 50 worker round trips to decorate an answer it already had.
   */
  private async withTaskIds(messages: MailMessageDto[]): Promise<MailMessageDto[]> {
    if (messages.length === 0) return messages
    const keys = messages.map((message) => keyOfMessage(message))
    const links = await this.deps.store.tasks.messageTasks([...new Set(keys)])
    if (links.size === 0) return messages
    return messages.map((message, index) => {
      const taskId = links.get(keys[index]!)
      return taskId ? { ...message, taskId } : message
    })
  }

  /**
   * Whether each message of a page has already been unsubscribed from, in ONE query.
   *
   * Derived on every read for the same reason `taskId` is (see `MailMessageDto.unsubscribe`): the
   * human can change their mind, the ledger is the only truth about it, and a copy on the message row
   * would be a second one that nothing invalidates. Batched for the same reason too — a fifty-row page
   * must not cost fifty worker round trips to decorate an answer it already holds.
   *
   * Two answers come out of the one statement. A row for THIS message is `scope: 'message'`. A `done`
   * row for any message sharing this one's `list_key` is `scope: 'list'`, which is what lets a
   * newsletter nobody ever clicked say "you left this list on Tuesday" — the person unsubscribed from
   * a list, not from one mail.
   *
   * Takes the ROWS as well as the DTOs because the list key is derived from the stored payload and the
   * sender column, neither of which survives into the DTO: `List-Id` is not a field a client has any
   * use for, and putting it on the wire to let the browser re-derive a server key would be the same
   * second truth in a different place.
   */
  private async withUnsubscribes(
    rows: MessageRow[],
    messages: MailMessageDto[],
  ): Promise<MailMessageDto[]> {
    if (messages.length === 0) return messages
    // The payload is parsed ONCE per row and both answers taken off it: the ledger key, and whether that
    // key came from a `List-Id`. The second one is only a wording question ("this list" against "this
    // sender") but it has to be answered HERE, because `List-Id` is not a field the wire carries and a
    // client re-deriving a server key from the sender's address would be a second truth in a worse place.
    const held = rows.map((row) => parseJson<MessagePayload>(row.payload, {}).listUnsubscribe)
    const keys = rows.map((row, index) => unsubscribeListKey(held[index], row.from_addr, row.message_id))
    const keyedBy = held.map((one) => (one?.listId ? 'list-id' as const : 'sender' as const))
    const groups = new Map<string, { accountId: string; messageIds: Set<string>; listKeys: Set<string> }>()
    rows.forEach((row, index) => {
      const group = groups.get(row.account_id)
        ?? { accountId: row.account_id, messageIds: new Set<string>(), listKeys: new Set<string>() }
      group.messageIds.add(row.message_id)
      group.listKeys.add(keys[index]!)
      groups.set(row.account_id, group)
    })
    const ledger = await this.deps.store.write.unsubscribesFor(
      [...groups.values()].map((group) => ({
        accountId: group.accountId,
        messageIds: [...group.messageIds],
        listKeys: [...group.listKeys],
      })),
    )
    if (ledger.length === 0) return messages

    const own = new Map<string, UnsubscribeRow>()
    const doneByList = new Map<string, UnsubscribeRow>()
    for (const row of ledger) {
      own.set(`${row.account_id}\u0000${row.message_id}`, row)
      // Ordered newest first by the query, so the first `done` seen for a key is the newest one.
      const listKey = `${row.account_id}\u0000${row.list_key}`
      if (row.status === 'done' && !doneByList.has(listKey)) doneByList.set(listKey, row)
    }

    return messages.map((message, index) => {
      const row = rows[index]!
      const mine = own.get(`${row.account_id}\u0000${row.message_id}`)
      const list = doneByList.get(`${row.account_id}\u0000${keys[index]!}`)
      const done = mine?.status === 'done'
        ? { method: mine.method, at: mine.at, scope: 'message' as const }
        // `keyedBy` rides the LIST scope only, because that is the one place the console has to choose a
        // word for what was left. Read off THIS row's own payload, which is right even though the `done`
        // row belongs to a different message: the two matched at all only because their keys are equal.
        : list
          ? { method: list.method, at: list.at, scope: 'list' as const, keyedBy: keyedBy[index]! }
          : undefined
      // Every state except `done`, which the field above already speaks for. Both can be set at once and
      // that is not a contradiction: the human left the list through another mail, and their attempt on
      // THIS one failed. The console prefers `done`; dropping the attempt here would hide the failure.
      const attempt = mine && mine.status !== 'done'
        ? {
          status: mine.status as 'in-flight' | 'needs-human' | 'failed',
          ...(mine.reason ? { reason: mine.reason } : {}),
          at: mine.at,
        }
        : undefined
      if (!done && !attempt) return message
      return {
        ...message,
        unsubscribe: {
          // A row with no capture carries no key, which a client reads as `'none'`; the ledger can
          // still have something to say about it through the list key, so the key is added here.
          available: message.unsubscribe?.available ?? 'none',
          ...(done ? { done } : {}),
          ...(attempt ? { attempt } : {}),
        },
      }
    })
  }

  /** One page of rows as the wire shows them: the task backlink and the unsubscribe ledger. */
  private async decorate(rows: MessageRow[]): Promise<MailMessageDto[]> {
    return this.withUnsubscribes(rows, await this.withTaskIds(rows.map((row) => toDto(row))))
  }

  /** One row, decorated. The single-message read paths all go through this. */
  private async oneWithTaskId(row: MessageRow): Promise<MailMessageDto> {
    const [message] = await this.decorate([row])
    return message!
  }

  /**
   * What the unsubscribe ladder needs to know about one message before it touches the network.
   *
   * Here rather than in `unsubscribe.ts` so the ladder never writes SQL and never parses a payload
   * blob: it is handed the rung this message can be given, the key the ledger is written under, and
   * the sender's own links, all derived by the same pure functions the DTO uses. The message id that
   * comes back is the CANONICAL one, because a caller is allowed to name a message by its RFC
   * Message-ID and the ledger has to be keyed on one thing.
   */
  async unsubscribeSubject(accountId: string, messageId: string): Promise<UnsubscribeSubject> {
    const row = await this.requireMessage(accountId, messageId)
    const held = parseJson<MessagePayload>(row.payload, {}).listUnsubscribe
    return {
      accountId: row.account_id,
      messageId: row.message_id,
      listKey: unsubscribeListKey(held, row.from_addr, row.message_id),
      available: unsubscribeAvailability(held),
      ...(held ? { held } : {}),
      fromAddr: row.from_addr,
      subject: row.subject,
    }
  }

  /**
   * One page of a mailbox, newest first.
   *
   * `unread` is the store's filter and not a pass over the answer: the console's "only unread" has to
   * mean the mailbox, and a page filtered after the fact can only ever narrow the fifty rows it
   * already holds. `nextBefore` therefore pages the UNREAD set, and is still only offered when the
   * page filled, so the end of the unread list ends rather than serving one empty page.
   */
  async listMessages(query: {
    accountId?: string
    mailboxId?: string
    limit: number
    unread?: boolean
    before?: MessagePageCursor
    /**
     * One list across every account holding this role (`scope=role:inbox` and friends).
     *
     * Resolved to (account_id, mailbox_id) pairs from the cached mailbox rows, so it costs one extra
     * indexed read and NO provider call. `accountId` is meaningless with it and the route refuses the
     * combination rather than picking one.
     */
    scope?: MessageScopeRole
    /** A human pressed Refresh: the page's unread checks skip the shared clock (never the one-in-flight rule). */
    fresh?: boolean
  }): Promise<{ messages: MailMessageDto[]; nextBefore?: string; checking?: FolderPair[] }> {
    const roleRows = query.scope ? await this.deps.store.mailboxesByRole(query.scope) : undefined
    const pairs = roleRows?.map((row) => ({ accountId: row.account_id, mailboxId: row.mailbox_id }))
    // The folders this page is made of, which are what its unread checks are about. Only a FIRST page
    // asks: later pages page the cache the first one corrected.
    const first = !query.before
    const pagePairs: FolderPair[] = pairs
      ?? (query.accountId && query.mailboxId ? [{ accountId: query.accountId, mailboxId: query.mailboxId }] : [])
    if (first && pagePairs.length > 0) {
      const badges = roleRows ? new Map(roleRows.map((row) => [folderKey(row.account_id, row.mailbox_id), row.unread])) : undefined
      await this.checkPageUnread(pagePairs, query.limit, !!query.fresh, badges)
    }
    const rows = await this.deps.store.listMessages({ ...query, ...(pairs ? { pairs } : {}) })
    const messages = await this.decorate(rows)
    // Named AFTER the read, so a check that has already finished is not reported as running: whatever it
    // changed is in these rows or, if it landed after them, was announced anyway (a clear always is).
    // From here on each named check announces its end, whatever it finds.
    const checking = first
      ? this.unreadChecks.runningAmong(pagePairs).map(({ accountId, mailboxId }) => ({ accountId, mailboxId }))
      : []
    this.unreadChecks.announce(checking)
    // `nextBefore` is only offered when the page filled: handing one back on a short page
    // makes a console ask for an empty page every time it reaches the end. It carries the
    // whole sort key, so the next page resumes exactly where this one stopped even when
    // several messages share a timestamp.
    const last = rows.length === query.limit ? rows[rows.length - 1]! : undefined
    return {
      messages,
      ...(last
        ? {
          nextBefore: encodeMessageCursor({
            sentAt: last.sent_at,
            messageId: last.message_id,
            // The third segment only on a scope page: it is what breaks a tie between two accounts
            // that answered with the same id in the same second, and a per-account token that
            // carried it would compare a field its own ORDER BY does not sort on.
            ...(query.scope ? { accountId: last.account_id } : {}),
          }),
        }
        : {}),
      ...(checking.length > 0 ? { checking } : {}),
    }
  }

  /**
   * A thread, oldest first, capped. One indexed query rather than a scan over recent mail.
   *
   * `limit + 1` is not fetched and no "there is more" flag comes back: the caller states its cap
   * and compares, which keeps the honesty about a truncated thread in the one place that renders
   * it. See `mailThread`.
   */
  async threadMessages(accountId: string, threadId: string, limit: number): Promise<MailMessageDto[]> {
    const rows = await this.deps.store.threadMessages(accountId, threadId, limit)
    return this.decorate(rows)
  }

  /**
   * One message plus its body, fetching the body on first read.
   *
   * A body failure is reported as `bodyError` next to the row, never as an error status: the
   * envelope is real data the caller asked for, and losing it because one fetch failed turns a
   * degraded read into a broken screen.
   */
  async readMessage(accountId: string, messageId: string, options: {
    retry?: boolean
  } = {}): Promise<{
    message: MailMessageDto
    body: MailBodyDto | null
    bodyError?: ProviderErrorCode | 'unknown'
  }> {
    const row = await this.requireMessage(accountId, messageId)
    if (row.body_ref) return { message: await this.oneWithTaskId(row), body: await this.readStoredBody(row) }
    // A body the provider already refused (over the cap, gone from the server) is answered from
    // the marker. Re-asking on every open is how one 40 MB message becomes a download per click.
    if (row.body_error && !options.retry) {
      return { message: await this.oneWithTaskId(row), body: null, bodyError: row.body_error as ProviderErrorCode }
    }

    try {
      // Bounded by the PROVIDER deadline, not by the caller's response budget. A route that has
      // given up on waiting still wants this fetch to land on disk, so the next open is local.
      const body = await callProvider(
        `a body for ${messageId}`,
        () => this.provider(accountId).getBody(accountId, messageId, sizeHintOf(row)),
      )
      const stored = await this.storeBody(row, body)
      const message = await this.oneWithTaskId(row)
      // `row` was read BEFORE the body arrived, so anything the body just taught the cache has to
      // ride this answer explicitly or the response that learned it would still not carry it.
      return {
        message: {
          ...message,
          hasBody: true,
          snippet: stored.snippet,
          ...filledAddresses(stored.filled),
          // Same reason as the addresses: the console opens a newsletter, this read is what learns
          // it has an unsubscribe link, and without this the very response that learned it would
          // still say there is none until the next list. Only `available` is restated — `done` and
          // `pending` came from the ledger query above and replacing the whole object would throw
          // away the "already unsubscribed" this very read just looked up.
          ...(stored.unsubscribe
            ? {
              unsubscribe: {
                ...message.unsubscribe,
                available: unsubscribeAvailability(stored.unsubscribe),
              },
            }
            : {}),
        },
        body: stored.body,
      }
    } catch (error) {
      if (error instanceof MailServiceError) throw error
      const code = error instanceof MailBodyTooLargeError
        ? 'too-large'
        : providerErrorCode(error) ?? 'unknown'
      // PERMANENT failures are remembered; transient ones are not. A message over the cap or one
      // the server no longer has will answer the same way forever, and the prefetch would
      // otherwise re-download every one of them on every tick.
      if (code === 'too-large' || code === 'not-found') {
        await this.deps.store.setMessageBodyError(row.rowid, code).catch(() => undefined)
      }
      return { message: await this.oneWithTaskId(row), body: null, bodyError: code }
    }
  }

  /** The cached envelope alone, with no provider call. What a timed-out read degrades to. */
  async readEnvelope(accountId: string, messageId: string): Promise<MailMessageDto> {
    return this.oneWithTaskId(await this.requireMessage(accountId, messageId))
  }

  /**
   * The body as plain text, fetching it when the cache has none.
   *
   * One caller: the note a mail-made task can carry. It goes through `readMessage`, so an
   * unfetchable body is reported the same way it is everywhere else (a `bodyError` and no bytes)
   * rather than as a throw, and the html half is folded to text with the base's OWN extractor, the
   * one that feeds the FTS index, so a note reads like the search hit that found it.
   */
  async bodyTextFor(accountId: string, messageId: string): Promise<string> {
    const read = await this.readMessage(accountId, messageId)
    if (!read.body) return ''
    return plainTextOf({ text: read.body.text ?? '', html: read.body.html ?? '' })
  }

  /**
   * The headers a reply draft copies, read from the CACHED message.
   *
   * `references` and `inReplyTo` live in the payload blob and never reach `MailMessageDto`, which
   * is why this is its own method rather than a field on the DTO: they are threading mechanics,
   * not something a console renders, and the ONE caller is the draft that is about to quote them.
   * Taking them from a request body instead would let a caller aim a reply into a thread it never
   * read, and the cache already holds exactly what the poll stored.
   */
  async replyTarget(accountId: string, messageId: string): Promise<{
    rfcMessageId: string
    references: string[]
    subject: string
    from: MailAddress
  }> {
    const row = await this.requireMessage(accountId, messageId)
    const payload = parseJson<MessagePayload>(row.payload, {})
    const references = [...(payload.references ?? [])]
    if (payload.inReplyTo && !references.includes(payload.inReplyTo)) references.push(payload.inReplyTo)
    return {
      rfcMessageId: row.rfc_message_id,
      references,
      subject: row.subject,
      from: payload.from ?? { address: row.from_addr },
    }
  }

  async search(query: { accountId?: string; q: string; limit: number }): Promise<{
    messages: MailMessageDto[]
    source: 'provider' | 'cache'
  }> {
    // Resolved WITHOUT throwing: a provider plugin that is off or reloading must not turn cache
    // search into a 503. The cache is local, it is the whole point, and it still answers.
    const spec = query.accountId ? this.deps.providers.get(providerIdOf(query.accountId)) : undefined
    if (spec?.capabilities.search && spec.search && query.accountId) {
      const accountId = query.accountId
      const envelopes = await callProvider(
        'a search',
        () => spec.search!(accountId, query.q, query.limit),
      )
      const known = await this.deps.store.knownMessages(accountId, envelopes.map((one) => one.messageId))
      return {
        source: 'provider',
        messages: await this.withTaskIds(envelopes.map(
          (envelope) => envelopeToDto(accountId, envelope, !!known.get(envelope.messageId)?.body_ref),
        )),
      }
    }
    const match = ftsMatchFor(query.q)
    if (!match) return { source: 'cache', messages: [] }
    const rows = await this.deps.store.searchMessages(match, query.accountId ?? '', query.limit)
    return { source: 'cache', messages: await this.decorate(rows) }
  }

  /** `unsupported` is a 409, not a silent local-only flip: the mailbox would drift. */
  async markRead(accountId: string, messageId: string, read: boolean): Promise<MailMessageDto> {
    const row = await this.requireMessage(accountId, messageId)
    const spec = this.provider(accountId)
    if (!spec.capabilities.markRead || !spec.markRead) {
      // The person's own words for it: the ACCOUNT, and what it cannot do. The id (`imap`) is a
      // plugin's internal name that nobody chose, and the old closing clause described this server's
      // own intentions rather than the next step, so a console that shows the sentence verbatim (it
      // does, in the row's note and its hover text) was quoting a token at the reader.
      throw new MailServiceError(
        'unsupported',
        `This account cannot change read flags (${spec.label}).`,
        409,
      )
    }
    await callProvider('a read flag', () => spec.markRead!(accountId, messageId, read))
    const flags = new Set(parseJson<string[]>(row.flags_json, []))
    const wasRead = flags.has('\\Seen')
    if (read) flags.add('\\Seen')
    else flags.delete('\\Seen')
    await this.deps.store.setMessageFlags(row.rowid, JSON.stringify([...flags]), this.now)
    // The mailbox counter follows the flag, and only when the flag actually moved: it is what the
    // badge and the digest count, and leaving it at the provider's last figure made both of them
    // report a mailbox as it was before this very call.
    if (wasRead !== read) {
      await this.deps.store.bumpMailboxUnread(accountId, row.mailbox_id, read ? -1 : 1)
    }
    return { ...(await this.oneWithTaskId(row)), flags: [...flags] }
  }

  // ── writes the poller drives ──

  /** Upsert one page. A page already in the cache is a no-op, down to `updated_at`. */
  async ingestPage(accountId: string, envelopes: MailEnvelope[]): Promise<IngestResult> {
    const result: IngestResult = { added: 0, updated: 0, headlines: [] }
    if (envelopes.length === 0) return result
    // The mirror is checked FIRST, every page. A delete that lands mid-tick removes the account
    // row while this tick still holds a page of envelopes, and inserting them would orphan rows
    // that `retain` (which iterates accounts) can never see again: a leak nothing collects.
    if (!(await this.deps.store.accountExists(accountId))) return result
    const known = await this.deps.store.knownMessages(accountId, envelopes.map((one) => one.messageId))
    for (const envelope of envelopes) {
      const existing = known.get(envelope.messageId)
      const hash = envelopeHashOf(envelope)
      if (existing?.envelope_hash === hash) continue
      if (existing) {
        // The row moved in time, so it is a different message than the one its body was read for
        // (a conversation row after a reply landed: see `bodyBelongsTo`). The old body goes BEFORE
        // the envelope is rewritten, file first and then the columns, the order body-revision.ts
        // uses so a crash leaves a row that still names its file rather than a file nobody names.
        const arrived = { sentAt: sentAtOf(envelope), receivedAt: envelope.receivedAt ?? null }
        const retire = (existing.body_ref !== null || existing.body_error !== null)
          && !bodyBelongsTo(existing, arrived)
        if (retire) {
          if (existing.body_ref) await this.deps.bodies.remove(existing.body_ref)
          await this.deps.store.retireMessageBody(existing.rowid)
          this.deps.log?.info?.('mail body retired: the envelope moved', {
            accountId, messageId: envelope.messageId, storedSentAt: existing.sent_at, sentAt: arrived.sentAt,
          })
        }
        // A retired body's snippet is text from ANOTHER message, so it is not carried forward the
        // way body-revision keeps a mis-decoded one: the preview, when the listing has one, or
        // nothing until the re-fetch.
        const carried = retire
          ? { snippet: '', payload: JSON.stringify(payloadForRetiredBody(parseJson<MessagePayload>(existing.payload, {}))) }
          : existing
        const write = this.toWrite(accountId, envelope, hash, carried)
        await this.deps.store.updateMessage(existing.rowid, write, this.now)
        // Only the envelope fields are re-indexed, and ONLY when there is no stored body: an
        // envelope-only update used to overwrite the FTS row with an empty `body_text`, so a
        // changed subject silently deleted the body from search.
        if (!existing.body_ref || retire) await this.reindex(existing.rowid, write)
        result.updated += 1
        continue
      }
      const write = this.toWrite(accountId, envelope, hash, existing)
      const rowid = await this.deps.store.insertMessage(write, this.now)
      await this.reindex(rowid, write)
      result.added += 1
      result.headlines.push({ from: write.fromAddr, subject: write.subject })
    }
    return result
  }

  /** Bodies for the newest envelopes that have none, bounded by count AND by the tick clock. */
  async prefetchBodies(
    accountId: string,
    mailboxId: string,
    limit: number,
    deadlineAt: number,
  ): Promise<number> {
    const rows = await this.deps.store.bodylessMessages(accountId, mailboxId, limit)
    let fetched = 0
    for (const row of rows) {
      if (Date.now() >= deadlineAt) break
      try {
        const body = await callProvider(
          `a body for ${row.message_id}`,
          () => this.provider(accountId).getBody(accountId, row.message_id, sizeHintOf(row)),
        )
        await this.storeBody(row, body)
        fetched += 1
      } catch (error) {
        // A PERMANENT failure is written down. Without that this loop asks for the same
        // unfetchable bodies on every tick forever, which on a photo-heavy inbox is tens of
        // megabytes an hour against the user's own server. A transient failure is left alone: the
        // read path will try again and report it to whoever actually asked.
        const code = error instanceof MailBodyTooLargeError ? 'too-large' : providerErrorCode(error)
        if (code === 'too-large' || code === 'not-found') {
          await this.deps.store.setMessageBodyError(row.rowid, code).catch(() => undefined)
        }
      }
    }
    return fetched
  }

  // ── internals ──

  /**
   * Ask the provider what is unread in one folder, now, if the shared clock allows it.
   *
   * The poll loop's periodic question, and the reason mail read on another device leaves the cache
   * without anybody opening the list: a provider whose poll never lists an old message again (the
   * Outlook one) has no other way to carry the new read flag. Null when there is nothing to ask:
   * no `listUnread`, a folder with nothing unread on either side, or one asked within the gap. The
   * "nothing unread" skip is what makes the common case free: an empty inbox costs no call at all.
   */
  async checkUnreadInBackground(
    accountId: string, mailboxId: string, deadlineMs: number,
  ): Promise<UnreadCheckResult | null> {
    if (!this.canAskUnread(accountId)) return null
    if (!this.unreadChecks.isDue(accountId, mailboxId)) return null
    const [cachedCounts, providerUnread] = await Promise.all([
      this.deps.store.unreadCounts([{ accountId, mailboxId }]),
      this.deps.store.mailboxUnread(accountId, mailboxId),
    ])
    const cachedUnread = cachedCounts.get(folderKey(accountId, mailboxId)) ?? 0
    if (cachedUnread === 0 && !providerUnread) return null
    return this.unreadChecks.start(accountId, mailboxId, {
      limit: UNREAD_CHECK_LIMIT,
      deadlineMs: Math.max(1, Math.min(UNREAD_LIST_DEADLINE_MS, deadlineMs)),
    })
  }

  private canAskUnread(accountId: string): boolean {
    try {
      return !!this.provider(accountId).listUnread
    } catch {
      return false
    }
  }

  /**
   * The unread checks a first page starts, waits a moment for, and names while they run.
   *
   * Every first page asks, filtered or not: an unfiltered list shows read state as plainly as the unread
   * filter does, and "All Inboxes" is the view a person keeps open. The shared clock is what keeps that
   * cheap, and the folders are chosen most-wrong first (`UnreadChecks.pick`). The page waits
   * `PAGE_UNREAD_WAIT_MS`, not the provider's full deadline; what is still running then is returned so
   * the console can say it is checking, and settles by event.
   */
  private async checkPageUnread(
    pairs: FolderPair[], limit: number, force: boolean,
    /** Folder counts the caller already read (a scope page has them from its role query). */
    badges?: Map<string, number>,
  ): Promise<void> {
    const askable = pairs.filter((pair) => this.canAskUnread(pair.accountId))
    if (askable.length === 0) return
    const [counts, cachedCounts] = await Promise.all([
      badges
        ? Promise.resolve(askable.map((pair) => badges.get(folderKey(pair.accountId, pair.mailboxId))))
        : Promise.all(askable.map((pair) => this.deps.store.mailboxUnread(pair.accountId, pair.mailboxId))),
      this.deps.store.unreadCounts(askable),
    ])
    const candidates: UnreadCheckCandidate[] = askable.map((pair, at) => ({
      ...pair,
      providerUnread: counts[at] ?? 0,
      cachedUnread: cachedCounts.get(folderKey(pair.accountId, pair.mailboxId)) ?? 0,
    }))
    const max = askable.length === 1 ? 1 : MAX_PAGE_CHECKS
    for (const one of this.unreadChecks.pick(candidates, max, force)) {
      this.unreadChecks.start(one.accountId, one.mailboxId, { limit, deadlineMs: UNREAD_LIST_DEADLINE_MS, force })
    }
    const waiting = this.unreadChecks.runningAmong(askable)
    if (waiting.length === 0) return
    // Checks never reject (see `UnreadChecks.start`), so letting them outlive this wait leaves nothing unhandled.
    await Promise.race([
      Promise.all(waiting.map((one) => one.done)),
      new Promise<void>((resolve) => { setTimeout(resolve, PAGE_UNREAD_WAIT_MS).unref?.() }),
    ])
  }

  /**
   * One unread check: upsert the provider's current unread set, then mark read what it proves read.
   *
   * A provider that fails or times out changes nothing: the cache answers as it is, and the failure is
   * logged rather than shown, because the list itself is still a truthful (if possibly stale) answer.
   */
  private async runUnreadCheck(
    accountId: string, mailboxId: string, options: { limit: number; deadlineMs: number },
  ): Promise<UnreadCheckResult> {
    let spec: MailProviderSpec
    try {
      spec = this.provider(accountId)
    } catch {
      return { cleared: 0, failed: true }
    }
    if (!spec.listUnread) return { cleared: 0, failed: false }
    try {
      // Stamped BEFORE the call: everything the answer can speak about was already delivered by now, so a
      // mail that arrives while the provider is thinking is out of scope for it (see `snapshotAt`).
      const snapshotAt = this.now
      const envelopes = await callProvider(
        `the unread list of ${mailboxId}`,
        () => spec.listUnread!(accountId, mailboxId, options.limit),
        options.deadlineMs,
      )
      // Only envelopes of the mailbox asked for: a provider that answers a broader set must not
      // be able to move rows between folders through this door.
      const mine = envelopes.filter((one) => one.mailboxId === mailboxId)
      await this.ingestPage(accountId, mine)
      const plan = await this.clearUnreadTheProviderNoLongerCounts(
        accountId, mailboxId, mine, { limit: options.limit, returned: envelopes.length, snapshotAt },
      )
      return { cleared: plan.cleared, failed: false, ...(plan.basis === 'short-of-badge' ? { badgeStale: true } : {}) }
    } catch (error) {
      // INFO, not debug: a refresh that fails leaves mail read elsewhere showing as unread, and with
      // the line at debug nothing on disk said why (2026-09-23: a dead Outlook helper held 27 read
      // mails on the list for minutes with no trace). Bounded by the shared clock.
      const log = this.deps.log
      const fields = { accountId, mailboxId, error: String(error).slice(0, 200) }
      if (log?.info) log.info('mail could not refresh the unread list from the provider', fields)
      else log?.debug('mail could not refresh the unread list from the provider', fields)
      return { cleared: 0, failed: true }
    }
  }

  /**
   * The half of the unread refresh that an ingest cannot do: mark read what the provider did not name.
   *
   * Ingesting the unread answer teaches the cache about mail it did not know was unread. It cannot
   * teach it the opposite, because a message read in another client simply LEAVES that answer, and an
   * absence writes nothing. Nothing else corrects it either on a provider whose poll walks newest-first
   * down to a watermark (the Outlook one): a conversation already below the line is never listed again,
   * so this is the only listing that can carry the new flag. Measured on a real account on 2026-09-21:
   * the folder badge said 4 unread, the cache listed 12, and eight had been read hours earlier on a
   * phone. IMAP does not have the illness because its poll re-fetches flags for the cached range.
   *
   * `reconcileUnread` decides what an absence proves; this only writes it down. The folder's own badge
   * rides along as the second opinion that keeps an answer of `[]` from being read as "nothing is
   * unread": a provider is allowed to answer that way for a folder it cannot list, and the Outlook one
   * does for every mailbox except the Inbox. Returns how many rows it cleared, and on what basis.
   */
  private async clearUnreadTheProviderNoLongerCounts(
    accountId: string, mailboxId: string, answered: MailEnvelope[],
    window: { limit: number; returned: number; snapshotAt: number },
  ): Promise<{ cleared: number; basis?: UnreadReconcileResult['basis'] }> {
    const [cached, providerUnread] = await Promise.all([
      this.deps.store.unreadKeys(accountId, mailboxId),
      this.deps.store.mailboxUnread(accountId, mailboxId),
    ])
    if (cached.length === 0) return { cleared: 0 }
    const plan = reconcileUnread({
      answered: answered.map((one) => ({ messageId: one.messageId, sentAt: sentAtOf(one) })),
      cached: cached.map((row) => ({ messageId: row.message_id, sentAt: row.sent_at })),
      limit: window.limit,
      returned: window.returned,
      snapshotAt: window.snapshotAt,
      ...(providerUnread === undefined ? {} : { providerUnread }),
    })
    if (plan.readNow.length === 0) return { cleared: 0, basis: plan.basis }
    const wanted = new Set(plan.readNow)
    await this.deps.store.markMessagesSeen(cached.filter((row) => wanted.has(row.message_id)), this.now)
    this.deps.log?.info?.('mail marked read what the provider no longer counts as unread', {
      accountId, mailboxId, cleared: plan.readNow.length, cachedUnread: cached.length,
      answered: answered.length, basis: plan.basis, providerUnread,
    })
    return { cleared: plan.readNow.length, basis: plan.basis }
  }

  private async requireMessage(accountId: string, messageId: string): Promise<MessageRow> {
    // Second door: the handle as a DURABLE id. A provider whose handles carry a folder (one thread
    // cached once per folder it appears in) cannot put a folder on a search hit, because the search
    // api names none, so the hit arrives under the bare durable id. That id is on every row the
    // thread has, and any of them opens the same conversation. Nothing else changes: a handle no
    // row knows in either column is still a 404.
    const row = await this.deps.store.getMessage(accountId, messageId)
      ?? (messageId ? await this.deps.store.getMessageByRfcId(accountId, messageId) : undefined)
    if (!row) {
      throw new MailServiceError('unknown_message', `No cached message "${messageId}" for "${accountId}".`, 404)
    }
    return row
  }

  private async storeBody(row: MessageRow, body: MailBody): Promise<{
    body: MailBodyDto
    snippet: string
    filled: BodyAddressFill
    /** What the body taught about leaving the list, when this row held nothing. */
    unsubscribe?: StoredListUnsubscribe
  }> {
    const declared = body.bytes ?? Buffer.byteLength(body.text ?? body.html ?? '')
    if (declared > MAX_BODY_BYTES) throw new MailBodyTooLargeError(declared)
    const stored = await this.deps.bodies.write(row.account_id, row.message_id, row.sent_at, {
      ...body,
      bytes: declared,
    }, row.subject)
    // A transport that can only name the sender on a body read fills the gaps its listing left,
    // and ONLY the gaps: see service-body.ts.
    const filled = fillAddressesFromBody(
      { fromAddr: row.from_addr, payload: parseJson<MessagePayload>(row.payload, {}) },
      body,
    )
    if (filled.dropped.length > 0) {
      this.deps.log?.debug('mail body offered an address the base cannot use', {
        accountId: row.account_id, messageId: row.message_id, fields: filled.dropped.join(', '),
      })
    }
    // A message cached before the poll asked for the `List-*` headers learns them here, and only
    // when the row holds no header-derived answer already: gap fill, never a correction.
    const unsubscribed = fillUnsubscribeFromBody(filled.payload, body)
    // And the footer, for mail whose headers name no url at all — the only path an account whose
    // transport hands over no headers ever has (see `unsubscribeFromBodyHtml` for when it scans).
    // It reads the html that was just STORED, because what it finds describes those bytes: a retired
    // body takes the link with it.
    const held = unsubscribeFromBodyHtml(unsubscribed.payload.listUnsubscribe, stored.storedHtml)
    const learned = held && held !== unsubscribed.payload.listUnsubscribe ? held : undefined
    const taught = learned ?? unsubscribed.filled
    const payload: MessagePayload = {
      ...unsubscribed.payload,
      ...(held ? { listUnsubscribe: held } : {}),
      bodyFormat: stored.format,
      bodyTruncated: stored.truncated,
    }
    await this.deps.store.setMessageBody(row.rowid, {
      bodyRef: stored.ref,
      bodyBytes: stored.bytes,
      snippet: stored.snippet,
      payload: JSON.stringify(payload),
      ...(filled.fromAddr ? { fromAddr: filled.fromAddr } : {}),
    })
    // The FTS row is rewritten with the whole plain text, which is the only reason cache
    // search can find a word that appears nowhere but deep inside the body. With the FILLED
    // sender, so an address the listing never carried is searchable as soon as it is known.
    await this.deps.store.indexMessage(row.rowid, {
      subject: row.subject,
      fromAddr: filled.fromAddr ?? row.from_addr,
      snippet: stored.snippet,
      bodyText: stored.text,
    })
    // Answered from what was just written, not re-read from disk: the bytes are already here,
    // and two extra file reads per body open is latency for nothing.
    return {
      snippet: stored.snippet,
      filled,
      // Either the body's own headers or the link found in its markup: both are things THIS read
      // taught, and the response that fetched the body has to carry them or the console that just
      // opened the newsletter would still say there is no way out until the next list. `learned`
      // wins when both happened, because it is the fuller value (the headers WITH the link).
      ...(taught ? { unsubscribe: taught } : {}),
      body: {
        format: stored.format,
        ...(stored.storedText !== undefined ? { text: stored.storedText } : {}),
        ...(stored.storedHtml !== undefined ? { html: stored.storedHtml } : {}),
        bytes: stored.bytes,
        truncated: stored.truncated,
      },
    }
  }

  private async readStoredBody(row: MessageRow): Promise<MailBodyDto | null> {
    if (!row.body_ref) return null
    const payload = parseJson<MessagePayload>(row.payload, {})
    const files = await this.deps.bodies.read(row.body_ref)
    // A message whose only content is attachments has a real, empty body: `text: ''` renders as
    // "no text content, N attachments". Answering `null` here made it look like a fetch that
    // never happened, so the reader showed nothing and no `bodyError` explained why.
    return {
      format: payload.bodyFormat ?? (files.html !== undefined ? 'html' : 'text'),
      text: files.text ?? '',
      ...(files.html !== undefined ? { html: files.html } : {}),
      bytes: row.body_bytes ?? 0,
      truncated: payload.bodyTruncated === true,
    }
  }

  private reindex(rowid: number, write: MessageWrite): Promise<void> {
    return this.deps.store.indexMessage(rowid, {
      subject: write.subject,
      fromAddr: write.fromAddr,
      snippet: write.snippet,
      bodyText: '',
    })
  }

  /**
   * One envelope flattened to columns.
   *
   * `existing` is the row already in the cache, when there is one, and the two fields taken from
   * it are the reason this parameter exists: `bodyFormat` and `bodyTruncated` live in the payload
   * blob, and rebuilding that blob from the envelope alone silently downgraded a stored `'both'`
   * body to `'html'` and a truncated one to complete, on nothing more than a changed subject.
   */
  private toWrite(
    accountId: string,
    envelope: MailEnvelope,
    hash: string,
    existing?: { snippet: string; payload: string | null },
  ): MessageWrite {
    const stored = parseJson<MessagePayload>(existing?.payload ?? null, {})
    // Carried forward like the body fields below, and for the same reason: an envelope that cannot
    // name an address must not blank one a body already named. See `senderForUpdate`.
    const from = senderForUpdate(envelope.from, stored)
    const listUnsubscribe = unsubscribeForUpdate(envelope.listUnsubscribe, stored)
    const payload: MessagePayload = {
      from,
      ...(envelope.to ? { to: envelope.to } : {}),
      ...(envelope.cc ? { cc: envelope.cc } : {}),
      ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
      ...(envelope.sentAtHeader ? { sentAtHeader: envelope.sentAtHeader } : {}),
      ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
      ...(envelope.references ? { references: envelope.references } : {}),
      // Carried forward: these describe the BODY on disk, which an envelope knows nothing about.
      ...(stored.bodyFormat ? { bodyFormat: stored.bodyFormat } : {}),
      ...(stored.bodyTruncated !== undefined ? { bodyTruncated: stored.bodyTruncated } : {}),
      ...(envelope.bodyBytes ? { bodyBytesHint: envelope.bodyBytes } : {}),
      // Carried forward too, and it has to be: the envelope hash ignores this field, so the poll
      // that rewrites a row is never ABOUT it, and rebuilding the blob from the envelope alone
      // erased what a body read had taught. See `unsubscribeForUpdate`.
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
    }
    return {
      accountId,
      messageId: envelope.messageId,
      rfcMessageId: envelope.rfcMessageId ?? '',
      mailboxId: envelope.mailboxId,
      threadId: threadIdOf(envelope),
      fromAddr: from?.address ?? '',
      subject: envelope.subject ?? '',
      // An envelope with no preview must not wipe a snippet the body already produced.
      snippet: envelope.snippet ? snippetOf(envelope.snippet) : existing?.snippet ?? '',
      sentAt: sentAtOf(envelope),
      receivedAt: envelope.receivedAt ?? null,
      flagsJson: JSON.stringify(envelope.flags ?? []),
      attachmentsJson: JSON.stringify(envelope.attachments ?? []),
      payload: JSON.stringify(payload),
      envelopeHash: hash,
    }
  }
}
