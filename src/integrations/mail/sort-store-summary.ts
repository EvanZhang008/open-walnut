/**
 * The SQL behind each group's one-line summary (sort-group-summary.ts): the unread set per group, the
 * newest mail of each group, and the stored lines (SCHEMA_V11 `mail_group_summaries`).
 *
 * Split from sort-store.ts so that file does not grow further; same rules as there: groups count
 * UNREAD mail only, and Important (`'important'` or NULL) is never a group.
 */
import type { MailDatabase } from './db.js'
import { pairsWhere } from './sort-store.js'
import type { GroupDigest, StoredSummary } from './sort-group-summary.js'
import type { FolderPair } from './sort-types.js'

const UNREAD_GROUPED = "seen = 0 AND sort_group IS NOT NULL AND sort_group <> 'important'"

export interface GroupSampleRow extends Record<string, unknown> {
  grp: string
  from_addr: string
  from_name: string | null
  subject: string
  snippet: string | null
}

export class MailSummaryStore {
  constructor(private readonly db: MailDatabase) {}

  /** Per group: how many unread, and the numbers that say whether that set changed. One GROUP BY. */
  async digests(pairs: ReadonlyArray<FolderPair>): Promise<GroupDigest[]> {
    const scope = pairsWhere(pairs)
    const rows = await this.db.all<{ grp: string; label: string | null; n: number; max_rowid: number; sum_rowid: number }>(
      'SELECT sort_group AS grp, MAX(sort_label) AS label, COUNT(*) AS n, MAX(rowid) AS max_rowid, SUM(rowid) AS sum_rowid'
      + ` FROM messages WHERE ${scope.sql} AND ${UNREAD_GROUPED} GROUP BY sort_group`,
      scope.params,
    )
    return rows.map((row) => ({
      id: row.grp, label: row.label, unread: row.n, newestRowid: row.max_rowid, basis: `${row.n}:${row.max_rowid}:${row.sum_rowid}`,
    }))
  }

  /** The newest `perGroup` unread mails of each named group, newest first. */
  samples(pairs: ReadonlyArray<FolderPair>, groups: ReadonlyArray<string>, perGroup: number): Promise<GroupSampleRow[]> {
    if (groups.length === 0) return Promise.resolve([])
    const scope = pairsWhere(pairs)
    return this.db.all<GroupSampleRow>(
      'SELECT grp, from_addr, from_name, subject, snippet FROM ('
      + " SELECT sort_group AS grp, from_addr, json_extract(payload, '$.from.name') AS from_name, subject, snippet,"
      + ' ROW_NUMBER() OVER (PARTITION BY sort_group ORDER BY COALESCE(received_at, sent_at) DESC, rowid DESC) AS n'
      + ` FROM messages WHERE ${scope.sql} AND ${UNREAD_GROUPED} AND sort_group IN (SELECT value FROM json_each(?))`
      + ') WHERE n <= ? ORDER BY grp, n',
      [...scope.params, JSON.stringify(groups), perGroup],
    )
  }

  /** Each group's newest unread subject in this scope: the line when no model wrote one. */
  async latestSubjects(pairs: ReadonlyArray<FolderPair>): Promise<Map<string, string>> {
    const scope = pairsWhere(pairs)
    const rows = await this.db.all<{ grp: string; subject: string | null }>(
      'SELECT grp, subject FROM ('
      + ' SELECT sort_group AS grp, subject,'
      + ' ROW_NUMBER() OVER (PARTITION BY sort_group ORDER BY COALESCE(received_at, sent_at) DESC, rowid DESC) AS n'
      + ` FROM messages WHERE ${scope.sql} AND ${UNREAD_GROUPED}`
      + ') WHERE n = 1',
      scope.params,
    )
    return new Map(rows.map((row) => [row.grp, row.subject ?? '']))
  }

  async stored(): Promise<Map<string, StoredSummary>> {
    const rows = await this.db.all<{ group_id: string; summary: string; basis: string; newest_rowid: number; updated_at: number }>(
      'SELECT group_id, summary, basis, newest_rowid, updated_at FROM mail_group_summaries',
    )
    return new Map(rows.map((row) => [row.group_id, {
      summary: row.summary, basis: row.basis, newestRowid: row.newest_rowid, updatedAt: row.updated_at,
    }]))
  }

  /** Many lines in ONE statement (the plugin database has no multi-statement transaction). */
  async save(entries: ReadonlyArray<{ id: string; summary: string; basis: string; newestRowid: number }>, at: number): Promise<void> {
    if (entries.length === 0) return
    await this.db.run(
      'INSERT INTO mail_group_summaries (group_id, summary, basis, newest_rowid, updated_at)'
      + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),"
      + " json_extract(value, '$[3]'), ? FROM json_each(?) WHERE true"
      + ' ON CONFLICT(group_id) DO UPDATE SET summary = excluded.summary, basis = excluded.basis,'
      + ' newest_rowid = excluded.newest_rowid, updated_at = excluded.updated_at',
      [at, JSON.stringify(entries.map((one) => [one.id, one.summary, one.basis, one.newestRowid]))],
    )
  }
}
