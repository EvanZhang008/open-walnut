/**
 * Inbox sorting's SQL: group counts, sender lists, the bulk-read selection, the recompute scan,
 * the model's labels and the late-fetched hints table. The third SQL file of this directory (after
 * store.ts and store-write.ts), split out so neither of those grows further.
 *
 * Three rules every statement here keeps:
 * - A group row counts UNREAD mail only (`unreadGroups`): a group of mail you have read is not
 *   something to act on, so it is not shown.
 * - Important is `(sort_group = 'important' OR sort_group IS NULL)`, never an equality: rows
 *   migrated to v9 are NULL until the recompute reaches them, and hiding them would hide mail.
 * - "Not classified under this revision" is `sort_rev IS NOT ?`. Comparing with `<>` gives NULL
 *   (not true) for every NULL row, so the backfill would select nothing and never run.
 */
import type { MailDatabase } from './db.js'
import type { FolderPair, GroupId, Watermark } from './sort-types.js'

export const IMPORTANT_PREDICATE = "(sort_group = 'important' OR sort_group IS NULL)"

/** `(account_id = ? AND mailbox_id = ?) OR ...`; an empty list matches nothing. */
export function pairsWhere(pairs: ReadonlyArray<FolderPair>, alias = ''): { sql: string; params: string[] } {
  if (pairs.length === 0) return { sql: '0', params: [] }
  const a = alias ? `${alias}.` : ''
  return {
    sql: `(${pairs.map(() => `(${a}account_id = ? AND ${a}mailbox_id = ?)`).join(' OR ')})`,
    params: pairs.flatMap((pair) => [pair.accountId, pair.mailboxId]),
  }
}

/** The group predicate, NULL-safe for Important. */
export function groupWhere(group: GroupId, alias = ''): { sql: string; params: string[] } {
  const a = alias ? `${alias}.` : ''
  if (group === 'important') return { sql: `(${a}sort_group = 'important' OR ${a}sort_group IS NULL)`, params: [] }
  return { sql: `${a}sort_group = ?`, params: [group] }
}

export interface GroupCountRow extends Record<string, unknown> {
  account_id: string
  grp: string
  total: number
  unread: number
  newest_at: number | null
  max_rowid: number | null
}

/** One (account, group) of unread mail: what a group row is built from. */
export interface UnreadGroupRow extends Record<string, unknown> {
  account_id: string
  grp: string
  label: string | null
  unread: number
  newest_at: number | null
  max_rowid: number | null
}

export interface SenderStatRow extends Record<string, unknown> {
  grp: string
  sender_key: string
  total: number
  unread: number
  newest_at: number | null
  max_rowid: number | null
  addr: string | null
  name: string | null
  account_ids: string | null
  unsub_rank: number | null
}

/** A row as the classifier reads it, with its hints joined. */
export interface ScanRow extends Record<string, unknown> {
  rowid: number
  account_id: string
  mailbox_id: string
  message_id: string
  rfc_message_id: string
  from_addr: string
  subject: string
  snippet: string | null
  payload: string | null
  sort_group: string | null
  sort_reason: string | null
  sender_key: string | null
  seen: number
  sent_at: number
  received_at: number | null
  gmail_category: string | null
  list_headers_json: string | null
  /** The model's verdict (SCHEMA_V10); `ai_rev` NULL = never labeled. */
  ai_label: string | null
  ai_important: number | null
  ai_why: string | null
  ai_rev: string | null
  sort_label: string | null
  /** The folder's role (`inbox`, `sent`, ...), NULL when the folder row is gone. */
  mailbox_role: string | null
}

/** The model's answer for one row. All three NULL = asked, nothing usable came back. */
export interface AiVerdict {
  rowid: number
  label: string | null
  important: boolean | null
  why: string | null
  rev: string
}

export interface BulkSelectRow extends Record<string, unknown> {
  rowid: number
  account_id: string
  mailbox_id: string
  message_id: string
}

export interface HintRow extends Record<string, unknown> {
  account_id: string
  mailbox_id: string
  message_id: string
  gmail_category: string | null
  list_headers_json: string | null
  headers_checked_at: number | null
}

export interface UnsubCandidateRow extends ScanRow {
  mails: number
  headers_checked_at: number | null
}

export interface Verdict {
  rowid: number
  group: string
  reason: string
  rev: string
  senderKey: string
  /** What the group is called, stored beside it (`sort_label`). */
  label: string
}

const SCAN_COLUMNS =
  'm.rowid AS rowid, m.account_id AS account_id, m.mailbox_id AS mailbox_id, m.message_id AS message_id,'
  + ' m.rfc_message_id AS rfc_message_id, m.from_addr AS from_addr, m.subject AS subject, m.snippet AS snippet, m.payload AS payload,'
  + ' m.sort_group AS sort_group, m.sort_reason AS sort_reason, m.sender_key AS sender_key, m.seen AS seen,'
  + ' m.sent_at AS sent_at, m.received_at AS received_at, h.gmail_category AS gmail_category,'
  + ' h.list_headers_json AS list_headers_json, m.ai_label AS ai_label, m.ai_important AS ai_important,'
  + ' m.ai_why AS ai_why, m.ai_rev AS ai_rev, m.sort_label AS sort_label, b.role AS mailbox_role'

const HINTS_JOIN =
  ' LEFT JOIN mail_sort_hints h ON h.account_id = m.account_id AND h.mailbox_id = m.mailbox_id'
  + ' AND h.message_id = m.message_id'
  + ' LEFT JOIN mailboxes b ON b.account_id = m.account_id AND b.mailbox_id = m.mailbox_id'

export class MailSortStore {
  constructor(private readonly db: MailDatabase) {}

  /** Per account and group: totals, unread, newest and the highest rowid. One GROUP BY. */
  groupCounts(pairs: ReadonlyArray<FolderPair>): Promise<GroupCountRow[]> {
    const scope = pairsWhere(pairs)
    return this.db.all<GroupCountRow>(
      "SELECT account_id, COALESCE(sort_group, 'important') AS grp, COUNT(*) AS total,"
      + ' SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread,'
      + ' MAX(COALESCE(received_at, sent_at)) AS newest_at, MAX(rowid) AS max_rowid'
      + ` FROM messages WHERE ${scope.sql} GROUP BY account_id, grp`,
      scope.params,
    )
  }

  /** Per account and group, UNREAD mail only, Important excluded: the group rows. */
  unreadGroups(pairs: ReadonlyArray<FolderPair>): Promise<UnreadGroupRow[]> {
    const scope = pairsWhere(pairs)
    return this.db.all<UnreadGroupRow>(
      'SELECT account_id, sort_group AS grp, MAX(sort_label) AS label, COUNT(*) AS unread,'
      + ' MAX(COALESCE(received_at, sent_at)) AS newest_at, MAX(rowid) AS max_rowid'
      + ` FROM messages WHERE ${scope.sql} AND seen = 0 AND sort_group IS NOT NULL AND sort_group <> 'important'`
      + ' GROUP BY account_id, sort_group',
      scope.params,
    )
  }

  /** Unread mail in scope still waiting for the model (it reads as Important meanwhile). */
  async pendingCount(pairs: ReadonlyArray<FolderPair>): Promise<number> {
    const scope = pairsWhere(pairs)
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE ${scope.sql} AND seen = 0 AND sort_reason = 'ai:pending'`,
      scope.params,
    )
    return row?.n ?? 0
  }

  /** max(rowid) in scope: the `seq` half of a watermark. */
  async seq(pairs: ReadonlyArray<FolderPair>): Promise<number> {
    const scope = pairsWhere(pairs)
    const row = await this.db.get<{ n: number | null }>(`SELECT MAX(rowid) AS n FROM messages WHERE ${scope.sql}`, scope.params)
    return row?.n ?? 0
  }

  /** The provider's own numbers for the scope's folders. */
  providerCounts(pairs: ReadonlyArray<FolderPair>): Promise<Array<{ account_id: string; unread: number; total: number }>> {
    const scope = pairsWhere(pairs)
    return this.db.all(
      `SELECT account_id, COALESCE(unread, 0) AS unread, COALESCE(total, 0) AS total FROM mailboxes WHERE ${scope.sql}`,
      scope.params,
    )
  }

  /**
   * Per (group, sender) aggregates for the scope, optionally for one group only. The caller picks
   * top senders from these; one query serves every group row of `/groups`.
   */
  senderStats(pairs: ReadonlyArray<FolderPair>, group?: GroupId, unreadOnly = false): Promise<SenderStatRow[]> {
    const scope = pairsWhere(pairs)
    const only = group ? groupWhere(group) : { sql: '1', params: [] }
    const unread = unreadOnly ? ' AND seen = 0' : ''
    return this.db.all<SenderStatRow>(
      "SELECT COALESCE(sort_group, 'important') AS grp, COALESCE(sender_key, 'unknown') AS sender_key,"
      + ' COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread,'
      + ' MAX(COALESCE(received_at, sent_at)) AS newest_at, MAX(rowid) AS max_rowid,'
      + " MAX(from_addr) AS addr, MAX(json_extract(payload, '$.from.name')) AS name,"
      + ' GROUP_CONCAT(DISTINCT account_id) AS account_ids,'
      + " MAX(CASE WHEN json_extract(payload, '$.listUnsubscribe.oneClick') = 1"
      + "   AND json_array_length(json_extract(payload, '$.listUnsubscribe.https')) > 0 THEN 3"
      + "   WHEN json_array_length(json_extract(payload, '$.listUnsubscribe.mailto')) > 0 THEN 2"
      + "   WHEN json_array_length(json_extract(payload, '$.listUnsubscribe.https')) > 0 THEN 1 ELSE 0 END) AS unsub_rank"
      + ` FROM messages WHERE ${scope.sql} AND ${only.sql}${unread} GROUP BY grp, COALESCE(sender_key, 'unknown')`,
      [...scope.params, ...only.params],
    )
  }

  /** The top `limit` senders of one group by unread, then newest. */
  async topSenders(pairs: ReadonlyArray<FolderPair>, group: GroupId, limit = 3): Promise<SenderStatRow[]> {
    const rows = await this.senderStats(pairs, group)
    return rows.sort(bySenderRank).slice(0, limit)
  }

  /**
   * One page of a group's senders. `minMails` (the Sort senders list) orders by mail count;
   * otherwise newest first. `total`/`mails` describe every sender that passes `minMails`.
   */
  async senders(
    pairs: ReadonlyArray<FolderPair>,
    group: GroupId,
    options: { limit: number; offset: number; minMails?: number },
  ): Promise<{ rows: SenderStatRow[]; total: number; mails: number; groupTotal: number }> {
    const all = await this.senderStats(pairs, group)
    const groupTotal = all.reduce((sum, row) => sum + row.total, 0)
    const min = options.minMails ?? 0
    const kept = all.filter((row) => row.total >= min)
    kept.sort(min > 0
      ? (a, b) => b.total - a.total || (b.newest_at ?? 0) - (a.newest_at ?? 0) || a.sender_key.localeCompare(b.sender_key)
      : (a, b) => (b.newest_at ?? 0) - (a.newest_at ?? 0) || a.sender_key.localeCompare(b.sender_key))
    return {
      rows: kept.slice(options.offset, options.offset + options.limit),
      total: kept.length,
      mails: kept.reduce((sum, row) => sum + row.total, 0),
      groupTotal,
    }
  }

  /**
   * The unread mail a bulk read will touch, FIXED at call time: at or below the watermark's rowid
   * (mail that arrived after the button was drawn is spared) and time (a conversation row moved by
   * a new reply is spared).
   */
  selectBulkRead(
    pairs: ReadonlyArray<FolderPair>,
    group: GroupId,
    sender: string | undefined,
    watermark: Watermark,
  ): Promise<BulkSelectRow[]> {
    const scope = pairsWhere(pairs)
    const only = groupWhere(group)
    return this.db.all<BulkSelectRow>(
      'SELECT rowid, account_id, mailbox_id, message_id FROM messages'
      + ` WHERE ${scope.sql} AND ${only.sql} AND seen = 0 AND rowid <= ? AND COALESCE(received_at, sent_at) <= ?`
      + (sender ? ' AND sender_key = ?' : '')
      + ' ORDER BY rowid',
      [...scope.params, ...only.params, watermark.seq, watermark.at, ...(sender ? [sender] : [])],
    )
  }

  // ── the classifier's scans ──

  /** Rows (with hints) after `afterRowid`, for preview and plan builders. `pairs: null` = all rows. */
  scanScope(pairs: ReadonlyArray<FolderPair> | null, afterRowid: number, limit: number): Promise<ScanRow[]> {
    const scope = pairs ? pairsWhere(pairs, 'm') : { sql: '1', params: [] }
    return this.db.all<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM messages m${HINTS_JOIN}`
      + ` WHERE ${scope.sql} AND m.rowid > ? ORDER BY m.rowid LIMIT ?`,
      [...scope.params, afterRowid, limit],
    )
  }

  /** Rows NOT classified under `rev` (NULL-safe `IS NOT`), rowid ascending. */
  pendingRows(rev: string, afterRowid: number, limit: number): Promise<ScanRow[]> {
    return this.db.all<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM messages m${HINTS_JOIN}`
      + ' WHERE m.rowid > ? AND m.sort_rev IS NOT ? ORDER BY m.rowid LIMIT ?',
      [afterRowid, rev, limit],
    )
  }

  async countPending(rev: string): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE sort_rev IS NOT ?', [rev])
    return row?.n ?? 0
  }

  /** Specific rows (by account + message id), with hints: the reclassify path. */
  rowsByIds(accountId: string, messageIds: ReadonlyArray<string>): Promise<ScanRow[]> {
    if (messageIds.length === 0) return Promise.resolve([])
    return this.db.all<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM messages m${HINTS_JOIN}`
      + ' WHERE m.account_id = ? AND m.message_id IN (SELECT value FROM json_each(?))',
      [accountId, JSON.stringify(messageIds)],
    )
  }

  /**
   * Many verdicts in ONE statement (there is no multi-statement transaction in the plugin
   * database), so a batch is all-or-nothing and costs one worker round trip.
   */
  async applyVerdicts(verdicts: ReadonlyArray<Verdict>): Promise<number> {
    if (verdicts.length === 0) return 0
    const result = await this.db.run(
      'WITH v AS (SELECT json_extract(value, \'$[0]\') AS r, json_extract(value, \'$[1]\') AS g,'
      + ' json_extract(value, \'$[2]\') AS why, json_extract(value, \'$[3]\') AS rev, json_extract(value, \'$[4]\') AS sk,'
      + ' json_extract(value, \'$[5]\') AS lbl'
      + ' FROM json_each(?))'
      + ' UPDATE messages SET sort_group = v.g, sort_reason = v.why, sort_rev = v.rev, sender_key = v.sk, sort_label = v.lbl'
      + ' FROM v WHERE messages.rowid = v.r',
      [JSON.stringify(verdicts.map((one) => [one.rowid, one.group, one.reason, one.rev, one.senderKey, one.label]))],
    )
    return result.changes
  }

  // ── the model's labels ──

  /**
   * Unread inbox mail the model has not labeled under `rev`, newest first, received at or after
   * `since`: the labeler's next batch.
   */
  aiCandidates(rev: string, since: number, limit: number): Promise<ScanRow[]> {
    return this.db.all<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM messages m${HINTS_JOIN}`
      + " WHERE m.seen = 0 AND b.role = 'inbox' AND m.ai_rev IS NOT ? AND COALESCE(m.received_at, m.sent_at) >= ?"
      + ' ORDER BY COALESCE(m.received_at, m.sent_at) DESC, m.rowid DESC LIMIT ?',
      [rev, since, limit],
    )
  }

  /** The model's answers, in ONE statement (see `applyVerdicts`). */
  async applyAiVerdicts(verdicts: ReadonlyArray<AiVerdict>): Promise<number> {
    if (verdicts.length === 0) return 0
    const result = await this.db.run(
      "WITH v AS (SELECT json_extract(value, '$[0]') AS r, json_extract(value, '$[1]') AS l,"
      + " json_extract(value, '$[2]') AS i, json_extract(value, '$[3]') AS w, json_extract(value, '$[4]') AS rev"
      + ' FROM json_each(?))'
      + ' UPDATE messages SET ai_label = v.l, ai_important = v.i, ai_why = v.w, ai_rev = v.rev'
      + ' FROM v WHERE messages.rowid = v.r',
      [JSON.stringify(verdicts.map((one) => [
        one.rowid, one.label, one.important === null ? null : one.important ? 1 : 0, one.why, one.rev,
      ]))],
    )
    return result.changes
  }

  /** Rows whose stored verdict has `reason` (the pending rows, when the model goes down). */
  rowsByReason(reason: string, limit: number): Promise<ScanRow[]> {
    return this.db.all<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM messages m${HINTS_JOIN} WHERE m.sort_reason = ? ORDER BY m.rowid LIMIT ?`,
      [reason, limit],
    )
  }

  /** The model's recent group names, newest first, one per spelling (it is asked to reuse these). */
  async recentLabels(limit: number): Promise<string[]> {
    const rows = await this.db.all<{ label: string }>(
      'SELECT MAX(ai_label) AS label, MAX(rowid) AS r FROM messages WHERE ai_label IS NOT NULL'
      + ' GROUP BY lower(ai_label) ORDER BY r DESC LIMIT ?',
      [limit],
    )
    return rows.map((row) => row.label).filter(Boolean)
  }

  /** The person's renames: group id to their name for it. */
  async labelOverrides(): Promise<Map<string, string>> {
    const rows = await this.db.all<{ group_id: string; label: string }>('SELECT group_id, label FROM mail_sort_labels')
    return new Map(rows.map((row) => [row.group_id, row.label]))
  }

  async setLabelOverride(groupId: string, label: string, at: number): Promise<void> {
    await this.db.run(
      'INSERT INTO mail_sort_labels (group_id, label, updated_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT(group_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at',
      [groupId, label, at],
    )
  }

  /** The stored model verdicts of these rows (ingest keeps them when it re-sorts a row). */
  aiVerdictsOf(accountId: string, messageIds: ReadonlyArray<string>): Promise<Array<{
    message_id: string; ai_label: string | null; ai_important: number | null; ai_why: string | null; ai_rev: string | null
  }>> {
    if (messageIds.length === 0) return Promise.resolve([])
    return this.db.all(
      'SELECT message_id, ai_label, ai_important, ai_why, ai_rev FROM messages'
      + ' WHERE account_id = ? AND message_id IN (SELECT value FROM json_each(?))',
      [accountId, JSON.stringify(messageIds)],
    )
  }

  // ── hints ──

  getHints(accountId: string, mailboxId: string, messageIds: ReadonlyArray<string>): Promise<HintRow[]> {
    if (messageIds.length === 0) return Promise.resolve([])
    return this.db.all<HintRow>(
      'SELECT account_id, mailbox_id, message_id, gmail_category, list_headers_json, headers_checked_at'
      + ' FROM mail_sort_hints WHERE account_id = ? AND mailbox_id = ? AND message_id IN (SELECT value FROM json_each(?))',
      [accountId, mailboxId, JSON.stringify(messageIds)],
    )
  }

  /** Late-fetched list headers; `headers: null` records "checked, nothing there". */
  async setListHeaders(
    accountId: string,
    mailboxId: string,
    entries: ReadonlyArray<{ messageId: string; headers: unknown | null }>,
    at: number,
  ): Promise<void> {
    if (entries.length === 0) return
    await this.db.run(
      'INSERT INTO mail_sort_hints (account_id, mailbox_id, message_id, list_headers_json, headers_checked_at)'
      + " SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ? FROM json_each(?) WHERE true"
      + ' ON CONFLICT(account_id, mailbox_id, message_id) DO UPDATE SET'
      + ' list_headers_json = excluded.list_headers_json, headers_checked_at = excluded.headers_checked_at',
      [accountId, mailboxId, at, JSON.stringify(entries.map((one) => [
        one.messageId, one.headers === null ? null : JSON.stringify(one.headers),
      ]))],
    )
  }

  /**
   * The provider's category lists, intersected with the cache. Returns the message ids whose
   * category actually changed, so only those are reclassified.
   */
  async setGmailCategory(
    accountId: string,
    mailboxId: string,
    lists: { promotions: string[]; social: string[] },
  ): Promise<string[]> {
    const wanted = new Map<string, string>()
    for (const id of lists.social) wanted.set(id, 'social')
    for (const id of lists.promotions) wanted.set(id, 'promotions')
    const cached = await this.db.all<{ message_id: string }>(
      'SELECT message_id FROM messages WHERE account_id = ? AND mailbox_id = ?'
      + ' AND message_id IN (SELECT value FROM json_each(?))',
      [accountId, mailboxId, JSON.stringify([...wanted.keys()])],
    )
    const desired = new Map(cached.map((row) => [row.message_id, wanted.get(row.message_id)!]))
    const current = await this.db.all<{ message_id: string; gmail_category: string }>(
      'SELECT message_id, gmail_category FROM mail_sort_hints'
      + ' WHERE account_id = ? AND mailbox_id = ? AND gmail_category IS NOT NULL',
      [accountId, mailboxId],
    )
    const changes: Array<[string, string | null]> = []
    const have = new Map(current.map((row) => [row.message_id, row.gmail_category]))
    for (const [id, category] of desired) if (have.get(id) !== category) changes.push([id, category])
    for (const [id] of have) if (!desired.has(id)) changes.push([id, null])
    if (changes.length === 0) return []
    await this.db.run(
      'INSERT INTO mail_sort_hints (account_id, mailbox_id, message_id, gmail_category)'
      + " SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true"
      + ' ON CONFLICT(account_id, mailbox_id, message_id) DO UPDATE SET gmail_category = excluded.gmail_category',
      [accountId, mailboxId, JSON.stringify(changes)],
    )
    return changes.map(([id]) => id)
  }

  /**
   * For the unsubscribe plan: the newest mail of each of the group's most recent `limit` senders,
   * with its hints and how many mails that sender has in the group.
   */
  unsubCandidates(pairs: ReadonlyArray<FolderPair>, group: GroupId, limit = 60): Promise<UnsubCandidateRow[]> {
    const scope = pairsWhere(pairs)
    const only = groupWhere(group)
    return this.db.all<UnsubCandidateRow>(
      `SELECT ${SCAN_COLUMNS}, t.mails AS mails, h.headers_checked_at AS headers_checked_at FROM (`
      + " SELECT COALESCE(sender_key, 'unknown') AS k, MAX(rowid) AS r, COUNT(*) AS mails,"
      + ' MAX(COALESCE(received_at, sent_at)) AS newest'
      + ` FROM messages WHERE ${scope.sql} AND ${only.sql} GROUP BY k ORDER BY newest DESC LIMIT ?`
      + ` ) t JOIN messages m ON m.rowid = t.r${HINTS_JOIN} ORDER BY t.newest DESC`,
      [...scope.params, ...only.params, limit],
    )
  }

  // ── identity inputs ──

  /** Recipient lists of cached Sent mail, paged by rowid (correspondents are built from these). */
  sentRecipients(afterRowid: number, limit: number): Promise<Array<{ rowid: number; account_id: string; to_json: string | null; cc_json: string | null }>> {
    return this.db.all(
      "SELECT m.rowid AS rowid, m.account_id AS account_id, json_extract(m.payload, '$.to') AS to_json,"
      + " json_extract(m.payload, '$.cc') AS cc_json FROM messages m JOIN mailboxes b"
      + " ON b.account_id = m.account_id AND b.mailbox_id = m.mailbox_id AND b.role = 'sent'"
      + ' WHERE m.rowid > ? ORDER BY m.rowid LIMIT ?',
      [afterRowid, limit],
    )
  }

  /** Accounts that have ever reported a Cc list apart from To. */
  async accountsWithCc(): Promise<Set<string>> {
    const rows = await this.db.all<{ account_id: string }>(
      "SELECT DISTINCT account_id FROM messages WHERE instr(payload, '\"cc\":[') > 0",
    )
    return new Set(rows.map((row) => row.account_id))
  }
}

/** Unread first, then newest, then key: the order of `topSenders`. */
export function bySenderRank(a: SenderStatRow, b: SenderStatRow): number {
  return b.unread - a.unread || (b.newest_at ?? 0) - (a.newest_at ?? 0) || a.sender_key.localeCompare(b.sender_key)
}
