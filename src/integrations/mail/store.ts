import type { MailDatabase, MailDbStatus } from './db.js'

/**
 * Every statement the mail base runs, in one place, plus the row shapes they answer with.
 *
 * Split out of `db.ts` only for size: that file owns the schema, the migrations and the
 * deadline machinery, this one owns the queries. Together they are the ONLY two modules in
 * `src/integrations/mail/` that write SQL, which is what keeps a schema change to one place
 * and stops a query being smuggled into a route handler.
 */

// ── Rows, exactly as the tables spell them ──

export interface AccountRow extends Record<string, unknown> {
  account_id: string
  provider_id: string
  display_name: string
  address: string
  state: string
  health_json: string | null
  payload: string | null
}

export interface MailboxRow extends Record<string, unknown> {
  account_id: string
  mailbox_id: string
  name: string
  role: string
  unread: number
  total: number
  cursor: string | null
  last_sync_at: number | null
  payload: string | null
}

export interface MessageRow extends Record<string, unknown> {
  rowid: number
  account_id: string
  message_id: string
  rfc_message_id: string
  mailbox_id: string
  thread_id: string | null
  from_addr: string
  subject: string
  snippet: string
  sent_at: number
  received_at: number | null
  flags_json: string | null
  attachments_json: string | null
  body_ref: string | null
  body_bytes: number | null
  payload: string | null
  updated_at: number
  envelope_hash: string | null
  /** A ProviderErrorCode when this body can never be fetched, else null. See SCHEMA_V3. */
  body_error: string | null
}

/** What one batched "do I already have these?" lookup answers per message. */
export interface KnownMessage extends Record<string, unknown> {
  rowid: number
  envelope_hash: string | null
  body_ref: string | null
  snippet: string
  /** Carried forward by an envelope-only update, so a stored body keeps its real shape. */
  payload: string | null
}

/** What an upsert needs, already flattened to columns by the caller. */
export interface MessageWrite {
  accountId: string
  messageId: string
  rfcMessageId: string
  mailboxId: string
  threadId: string | null
  fromAddr: string
  subject: string
  snippet: string
  sentAt: number
  receivedAt: number | null
  flagsJson: string
  attachmentsJson: string
  payload: string
  envelopeHash: string
}

export interface EvictableRow extends Record<string, unknown> {
  rowid: number
  rfc_message_id: string
  body_ref: string | null
  sent_at: number
}

export interface BodiedRow extends Record<string, unknown> {
  rowid: number
  rfc_message_id: string
  body_ref: string
  body_bytes: number | null
}

const MESSAGE_COLUMNS =
  'rowid, account_id, message_id, rfc_message_id, mailbox_id, thread_id, from_addr, subject,'
  + ' snippet, sent_at, received_at, flags_json, attachments_json, body_ref, body_bytes,'
  + ' payload, updated_at, envelope_hash, body_error'

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

/** `service.ts` composes these calls; nothing above it ever writes SQL. */
export class MailStore {
  constructor(private readonly db: MailDatabase) {}

  get status(): MailDbStatus {
    return this.db.status
  }

  countOrNull(sql: string): Promise<number | undefined> {
    return this.db.countOrNull(sql)
  }

  // ── accounts ──

  listAccounts(): Promise<AccountRow[]> {
    return this.db.all<AccountRow>(
      'SELECT account_id, provider_id, display_name, address, state, health_json, payload'
      + ' FROM accounts ORDER BY account_id',
    )
  }

  getAccount(accountId: string): Promise<AccountRow | undefined> {
    return this.db.get<AccountRow>(
      'SELECT account_id, provider_id, display_name, address, state, health_json, payload'
      + ' FROM accounts WHERE account_id = ?',
      [accountId],
    )
  }

  async upsertAccount(row: {
    accountId: string
    providerId: string
    displayName: string
    address: string
    state: string
    healthJson: string | null
    payload: string
  }): Promise<void> {
    await this.db.run(
      'INSERT INTO accounts (account_id, provider_id, display_name, address, state, health_json, payload)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(account_id) DO UPDATE SET provider_id = excluded.provider_id,'
      + ' display_name = excluded.display_name, address = excluded.address,'
      + ' state = excluded.state, health_json = excluded.health_json, payload = excluded.payload',
      [row.accountId, row.providerId, row.displayName, row.address, row.state, row.healthJson, row.payload],
    )
  }

  async setAccountHealth(accountId: string, state: string, healthJson: string): Promise<void> {
    await this.db.run(
      'UPDATE accounts SET state = ?, health_json = ? WHERE account_id = ?',
      [state, healthJson, accountId],
    )
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.db.run('DELETE FROM accounts WHERE account_id = ?', [accountId])
  }

  // ── mailboxes ──

  listMailboxes(accountId: string): Promise<MailboxRow[]> {
    return this.db.all<MailboxRow>(
      'SELECT account_id, mailbox_id, name, role, unread, total, cursor, last_sync_at, payload'
      + ' FROM mailboxes WHERE account_id = ? ORDER BY role = \'inbox\' DESC, name',
      [accountId],
    )
  }

  /** Never touches `cursor` or `last_sync_at`: a mailbox re-list must not void a cursor. */
  async upsertMailbox(row: {
    accountId: string
    mailboxId: string
    name: string
    role: string
    unread: number
    total: number
  }): Promise<void> {
    await this.db.run(
      'INSERT INTO mailboxes (account_id, mailbox_id, name, role, unread, total)'
      + ' VALUES (?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(account_id, mailbox_id) DO UPDATE SET name = excluded.name,'
      + ' role = excluded.role, unread = excluded.unread, total = excluded.total',
      [row.accountId, row.mailboxId, row.name, row.role, row.unread, row.total],
    )
  }

  async setMailboxCursor(
    accountId: string,
    mailboxId: string,
    cursor: string | null,
    lastSyncAt: number,
  ): Promise<void> {
    await this.db.run(
      'UPDATE mailboxes SET cursor = ?, last_sync_at = ? WHERE account_id = ? AND mailbox_id = ?',
      [cursor, lastSyncAt, accountId, mailboxId],
    )
  }

  /** Unread per account in ONE query: the accounts list used to run this once per account. */
  async unreadByAccount(): Promise<Map<string, number>> {
    const rows = await this.db.all<{ account_id: string; n: number | null }>(
      'SELECT account_id, SUM(unread) AS n FROM mailboxes GROUP BY account_id',
    )
    return new Map(rows.map((row) => [row.account_id, row.n ?? 0]))
  }

  async deleteMailboxes(accountId: string): Promise<void> {
    await this.db.run('DELETE FROM mailboxes WHERE account_id = ?', [accountId])
  }

  // ── messages ──

  /** One query per page, not one per message: the poll loop upserts in batches. */
  async knownMessages(
    accountId: string,
    messageIds: string[],
  ): Promise<Map<string, KnownMessage>> {
    if (messageIds.length === 0) return new Map()
    const rows = await this.db.all<KnownMessage & { message_id: string }>(
      `SELECT rowid, message_id, envelope_hash, body_ref, snippet, payload FROM messages`
      + ` WHERE account_id = ? AND message_id IN (${placeholders(messageIds.length)})`,
      [accountId, ...messageIds],
    )
    return new Map(rows.map((row) => [row.message_id, {
      rowid: row.rowid,
      envelope_hash: row.envelope_hash,
      body_ref: row.body_ref,
      snippet: row.snippet,
      payload: row.payload,
    }]))
  }

  async insertMessage(write: MessageWrite, now: number): Promise<number> {
    const result = await this.db.run(
      'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, thread_id,'
      + ' from_addr, subject, snippet, sent_at, received_at, flags_json, attachments_json,'
      + ' payload, updated_at, envelope_hash)'
      + ` VALUES (${placeholders(15)})`,
      [
        write.accountId, write.messageId, write.rfcMessageId, write.mailboxId, write.threadId,
        write.fromAddr, write.subject, write.snippet, write.sentAt, write.receivedAt,
        write.flagsJson, write.attachmentsJson, write.payload, now, write.envelopeHash,
      ],
    )
    return Number(result.lastInsertRowid)
  }

  async updateMessage(rowid: number, write: MessageWrite, now: number): Promise<void> {
    await this.db.run(
      'UPDATE messages SET rfc_message_id = ?, mailbox_id = ?, thread_id = ?, from_addr = ?,'
      + ' subject = ?, snippet = ?, sent_at = ?, received_at = ?, flags_json = ?,'
      + ' attachments_json = ?, payload = ?, updated_at = ?, envelope_hash = ? WHERE rowid = ?',
      [
        write.rfcMessageId, write.mailboxId, write.threadId, write.fromAddr, write.subject,
        write.snippet, write.sentAt, write.receivedAt, write.flagsJson, write.attachmentsJson,
        write.payload, now, write.envelopeHash, rowid,
      ],
    )
  }

  listMessages(query: {
    accountId?: string
    mailboxId?: string
    limit: number
    before?: number
  }): Promise<MessageRow[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (query.accountId) { where.push('account_id = ?'); params.push(query.accountId) }
    if (query.mailboxId) { where.push('mailbox_id = ?'); params.push(query.mailboxId) }
    if (query.before !== undefined) { where.push('sent_at < ?'); params.push(query.before) }
    params.push(query.limit)
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY sent_at DESC, rowid DESC LIMIT ?',
      params,
    )
  }

  getMessage(accountId: string, messageId: string): Promise<MessageRow | undefined> {
    return this.db.get<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE account_id = ? AND message_id = ?`,
      [accountId, messageId],
    )
  }

  /**
   * Newest inbox envelopes with no body yet: the tick's prefetch step reads this.
   *
   * `body_error IS NULL` is load bearing. A message over the byte cap, or one the server no
   * longer has, will never produce a `body_ref`, so without this the prefetch asks for the same
   * unfetchable bodies on every tick for the life of the account.
   */
  bodylessMessages(accountId: string, mailboxId: string, limit: number): Promise<MessageRow[]> {
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages`
      + ' WHERE account_id = ? AND mailbox_id = ? AND body_ref IS NULL AND body_error IS NULL'
      + ' ORDER BY sent_at DESC LIMIT ?',
      [accountId, mailboxId, limit],
    )
  }

  /** Remember that this body can never arrive, so nothing asks for it again on its own. */
  async setMessageBodyError(rowid: number, code: string): Promise<void> {
    await this.db.run('UPDATE messages SET body_error = ? WHERE rowid = ?', [code, rowid])
  }

  /** A retry (or a re-fetch that worked) clears the marker. */
  async clearMessageBodyError(rowid: number): Promise<void> {
    await this.db.run('UPDATE messages SET body_error = NULL WHERE rowid = ?', [rowid])
  }

  async setMessageBody(rowid: number, body: {
    bodyRef: string
    bodyBytes: number
    snippet: string
    payload: string
  }): Promise<void> {
    await this.db.run(
      'UPDATE messages SET body_ref = ?, body_bytes = ?, snippet = ?, payload = ?,'
      + ' body_error = NULL WHERE rowid = ?',
      [body.bodyRef, body.bodyBytes, body.snippet, body.payload, rowid],
    )
  }

  async setMessageFlags(rowid: number, flagsJson: string, now: number): Promise<void> {
    await this.db.run(
      'UPDATE messages SET flags_json = ?, updated_at = ? WHERE rowid = ?',
      [flagsJson, now, rowid],
    )
  }

  async countMessages(accountId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages WHERE account_id = ?',
      [accountId],
    )
    return row?.n ?? 0
  }

  /**
   * Rowid plus everything a delete has to clean up outside SQLite, NEWEST FIRST.
   *
   * The order is the contract: retention keeps the first `maxRowsPerAccount` entries and drops
   * the tail, so "newest first" is what makes a row cap mean "keep the newest N".
   */
  evictable(accountId: string, mailboxId?: string): Promise<EvictableRow[]> {
    return this.db.all<EvictableRow>(
      'SELECT rowid, rfc_message_id, body_ref, sent_at FROM messages WHERE account_id = ?'
      + (mailboxId ? ' AND mailbox_id = ?' : '')
      + ' ORDER BY sent_at DESC, rowid DESC',
      mailboxId ? [accountId, mailboxId] : [accountId],
    )
  }

  /**
   * Doomed rows for one account, decided in SQL: past the row cap OR older than the cutoff.
   *
   * The cap used to be applied in JS over every row this account owns, which meant reading a
   * 50,000-row account out of the worker on every tick to throw almost all of it away.
   * `LIMIT -1 OFFSET ?` is SQLite's "everything after the first N".
   */
  doomedRows(accountId: string, keep: number, cutoff: number): Promise<EvictableRow[]> {
    return this.db.all<EvictableRow>(
      'SELECT rowid, rfc_message_id, body_ref, sent_at FROM messages'
      + ' WHERE account_id = ? AND (sent_at < ? OR rowid IN ('
      + '   SELECT rowid FROM messages WHERE account_id = ?'
      + '   ORDER BY sent_at DESC, rowid DESC LIMIT -1 OFFSET ?'
      + ' )) ORDER BY sent_at DESC, rowid DESC',
      [accountId, cutoff, accountId, Math.max(0, Math.floor(keep))],
    )
  }

  /** Bytes the body cache occupies, from the rows that own the files. One query, not a walk. */
  async bodyBytesTotal(): Promise<number> {
    const row = await this.db.get<{ n: number | null }>(
      'SELECT SUM(body_bytes) AS n FROM messages WHERE body_ref IS NOT NULL',
    )
    return row?.n ?? 0
  }

  /** Cached bodies across every account, oldest first: the body cache's eviction order. */
  bodiedOldestFirst(limit: number): Promise<BodiedRow[]> {
    return this.db.all<BodiedRow>(
      'SELECT rowid, rfc_message_id, body_ref, body_bytes FROM messages'
      + ' WHERE body_ref IS NOT NULL ORDER BY sent_at ASC, rowid ASC LIMIT ?',
      [limit],
    )
  }

  /** Give the bytes back while keeping the envelope: a body is re-fetchable, a row is not. */
  async clearMessageBody(rowid: number): Promise<void> {
    await this.db.run(
      'UPDATE messages SET body_ref = NULL, body_bytes = NULL WHERE rowid = ?',
      [rowid],
    )
  }

  /** Does this account still have a mirror row? A write for one that does not is a zombie. */
  async accountExists(accountId: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?',
      [accountId],
    )
    return (row?.n ?? 0) > 0
  }

  async deleteMessages(rowids: number[]): Promise<void> {
    if (rowids.length === 0) return
    const list = placeholders(rowids.length)
    // The FTS row goes with the message it indexes. A plain contentless table refuses
    // DELETE, which is why the schema declares contentless_delete=1.
    await this.db.run(`DELETE FROM messages_fts WHERE rowid IN (${list})`, rowids)
    await this.db.run(`DELETE FROM messages WHERE rowid IN (${list})`, rowids)
  }

  /** Every RFC id an in-flight draft is replying to: those messages are never evicted. */
  async draftReplyTargets(): Promise<Set<string>> {
    const rows = await this.db.all<{ in_reply_to: string }>(
      "SELECT DISTINCT in_reply_to FROM drafts WHERE in_reply_to IS NOT NULL AND in_reply_to <> ''",
    )
    return new Set(rows.map((row) => row.in_reply_to))
  }

  // ── full text ──

  /** Re-index, not insert: a body re-fetch must not leave two rows for one rowid. */
  async indexMessage(
    rowid: number,
    fields: { subject: string; fromAddr: string; snippet: string; bodyText: string },
  ): Promise<void> {
    await this.db.run('DELETE FROM messages_fts WHERE rowid = ?', [rowid])
    await this.db.run(
      'INSERT INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)',
      [rowid, fields.subject, fields.fromAddr, fields.snippet, fields.bodyText],
    )
  }

  searchMessages(match: string, accountId: string, limit: number): Promise<MessageRow[]> {
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages`
      + ' WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'
      + (accountId ? ' AND account_id = ?' : '')
      + ' ORDER BY sent_at DESC LIMIT ?',
      accountId ? [match, accountId, limit] : [match, limit],
    )
  }
}
