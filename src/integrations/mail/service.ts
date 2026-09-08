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
  fillAddressesFromBody,
  filledAddresses,
  senderForUpdate,
  type BodyAddressFill,
} from './service-body.js'
import {
  envelopeToDto,
  parseJson,
  sizeHintOf,
  toDto,
  type MessagePayload,
} from './service-dto.js'
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
  type MailboxDto,
  type MessagePageCursor,
} from './contract.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailStore, MessageRow, MessageWrite } from './store.js'
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

export class MailService {
  /** Per account: the last `send` verdict and when it was learned. See `sendCapabilityOf`. */
  private readonly sendCache = new Map<string, { send: boolean; at: number }>()

  constructor(private readonly deps: {
    store: MailStore
    bodies: MailBodyStore
    providers: MailProviderRegistry
    now?: () => number
    /** Optional: the only thing logged here is an address a body offered and the base refused. */
    log?: { debug(message: string, fields?: Record<string, unknown>): void }
  }) {}

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

  /** One row, decorated. The single-message read paths all go through this. */
  private async oneWithTaskId(row: MessageRow): Promise<MailMessageDto> {
    const [message] = await this.withTaskIds([toDto(row)])
    return message!
  }

  async listMessages(query: {
    accountId?: string
    mailboxId?: string
    limit: number
    before?: MessagePageCursor
  }): Promise<{ messages: MailMessageDto[]; nextBefore?: string }> {
    const rows = await this.deps.store.listMessages(query)
    const messages = await this.withTaskIds(rows.map((row) => toDto(row)))
    // `nextBefore` is only offered when the page filled: handing one back on a short page
    // makes a console ask for an empty page every time it reaches the end. It carries the
    // whole sort key, so the next page resumes exactly where this one stopped even when
    // several messages share a timestamp.
    const last = rows.length === query.limit ? rows[rows.length - 1]! : undefined
    return {
      messages,
      ...(last ? { nextBefore: encodeMessageCursor({ sentAt: last.sent_at, messageId: last.message_id }) } : {}),
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
    return this.withTaskIds(rows.map((row) => toDto(row)))
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
          ...message, hasBody: true, snippet: stored.snippet, ...filledAddresses(stored.filled),
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
    return { source: 'cache', messages: await this.withTaskIds(rows.map((row) => toDto(row))) }
  }

  /** `unsupported` is a 409, not a silent local-only flip: the mailbox would drift. */
  async markRead(accountId: string, messageId: string, read: boolean): Promise<MailMessageDto> {
    const row = await this.requireMessage(accountId, messageId)
    const spec = this.provider(accountId)
    if (!spec.capabilities.markRead || !spec.markRead) {
      throw new MailServiceError(
        'unsupported',
        `The provider "${spec.id}" cannot change the read flag, so Walnut will not pretend it did.`,
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
      const write = this.toWrite(accountId, envelope, hash, existing)
      if (existing) {
        await this.deps.store.updateMessage(existing.rowid, write, this.now)
        // Only the envelope fields are re-indexed, and ONLY when there is no stored body: an
        // envelope-only update used to overwrite the FTS row with an empty `body_text`, so a
        // changed subject silently deleted the body from search.
        if (!existing.body_ref) await this.reindex(existing.rowid, write)
        result.updated += 1
        continue
      }
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

  private async requireMessage(accountId: string, messageId: string): Promise<MessageRow> {
    const row = await this.deps.store.getMessage(accountId, messageId)
    if (!row) {
      throw new MailServiceError('unknown_message', `No cached message "${messageId}" for "${accountId}".`, 404)
    }
    return row
  }

  private async storeBody(row: MessageRow, body: MailBody): Promise<{
    body: MailBodyDto
    snippet: string
    filled: BodyAddressFill
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
    const payload: MessagePayload = {
      ...filled.payload,
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
      sentAt: Number.isFinite(envelope.sentAt) ? envelope.sentAt : 0,
      receivedAt: envelope.receivedAt ?? null,
      flagsJson: JSON.stringify(envelope.flags ?? []),
      attachmentsJson: JSON.stringify(envelope.attachments ?? []),
      payload: JSON.stringify(payload),
      envelopeHash: hash,
    }
  }
}
