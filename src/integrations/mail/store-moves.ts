/**
 * The ledger of the mail a "keep out of the inbox" rule moves to the archive (SCHEMA_V11
 * `mail_filter_moves`). One row per message; mail-filter-moves.ts is the only writer.
 *
 * `status`: `queued` (waiting, `at` = not before), `moved`, `failed` (gave up; kept so the rules list
 * can say how many). Two ways a settled row is queued again, each bounded so no loop is possible:
 * - a MOVED message seen in the inbox again (a new reply to an Outlook conversation re-files it
 *   there): queued, but not due before `REMOVE_AFTER_MS` after its last move, and only while it has
 *   been moved fewer than `MAX_MOVES` times. Delayed rather than dropped, because the poll that saw
 *   it does not see it again (an unchanged row is not re-sorted), and dropping it would leave it in
 *   the inbox for good; the same bound stops a move the server silently ignored from repeating;
 * - a FAILED one, an hour later, with a fresh set of attempts.
 */
import type { MailDatabase } from './db.js'

export const REQUEUE_FAILED_AFTER_MS = 60 * 60_000
export const REMOVE_AFTER_MS = 10 * 60_000
export const MAX_MOVES = 5

export interface MoveRow extends Record<string, unknown> {
  account_id: string
  message_id: string
  mailbox_id: string
  rule_id: string
  status: string
  attempts: number
  moves: number
  reason: string | null
  at: number
}

export type SettleRow = [string, string, 'queued' | 'moved' | 'failed', number, string | null, number]

export interface MoveRequest {
  accountId: string
  messageId: string
  mailboxId: string
  ruleId: string
}

export class MailMoveStore {
  constructor(private readonly db: MailDatabase) {}

  /** Queue these (one statement). Returns how many rows are now queued that were not before. */
  async enqueue(requests: ReadonlyArray<MoveRequest>, now: number): Promise<number> {
    if (requests.length === 0) return 0
    const result = await this.db.run(
      'INSERT INTO mail_filter_moves (account_id, message_id, mailbox_id, rule_id, status, attempts, at)'
      + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),"
      + " json_extract(value, '$[3]'), 'queued', 0, ? FROM json_each(?) WHERE true"
      + ' ON CONFLICT(account_id, message_id) DO UPDATE SET'
      + " status = 'queued', attempts = 0, reason = NULL, mailbox_id = excluded.mailbox_id, rule_id = excluded.rule_id,"
      + " at = CASE WHEN mail_filter_moves.status = 'moved' THEN MAX(excluded.at, mail_filter_moves.at + ?) ELSE excluded.at END"
      + " WHERE (mail_filter_moves.status = 'moved' AND mail_filter_moves.moves < ?)"
      + " OR (mail_filter_moves.status = 'failed' AND mail_filter_moves.at < ?)",
      [
        now, JSON.stringify(requests.map((one) => [one.accountId, one.messageId, one.mailboxId, one.ruleId])),
        REMOVE_AFTER_MS, MAX_MOVES, now - REQUEUE_FAILED_AFTER_MS,
      ],
    )
    return result.changes
  }

  /** Forget these queued moves (their rule went away before they ran). Settled rows are kept. */
  async drop(keys: ReadonlyArray<readonly [string, string]>): Promise<void> {
    if (keys.length === 0) return
    await this.db.run(
      "DELETE FROM mail_filter_moves WHERE status = 'queued' AND (account_id, message_id) IN"
      + " (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
      [JSON.stringify(keys)],
    )
  }

  /** Queued rows due now, oldest first. */
  due(now: number, limit: number): Promise<MoveRow[]> {
    return this.db.all<MoveRow>(
      "SELECT * FROM mail_filter_moves WHERE status = 'queued' AND at <= ? ORDER BY at, rowid LIMIT ?",
      [now, limit],
    )
  }

  /** The earliest queued row's time, or null when nothing waits. */
  async nextAt(): Promise<number | null> {
    const row = await this.db.get<{ at: number | null }>("SELECT MIN(at) AS at FROM mail_filter_moves WHERE status = 'queued'")
    return row?.at ?? null
  }

  /**
   * Many outcomes in ONE statement: `[accountId, messageId, status, attempts, reason, at]`. A `moved`
   * outcome also counts one more move.
   */
  async settle(rows: ReadonlyArray<SettleRow>): Promise<void> {
    if (rows.length === 0) return
    await this.db.run(
      "WITH v AS (SELECT json_extract(value, '$[0]') AS a, json_extract(value, '$[1]') AS m,"
      + " json_extract(value, '$[2]') AS s, json_extract(value, '$[3]') AS n, json_extract(value, '$[4]') AS r,"
      + " json_extract(value, '$[5]') AS t FROM json_each(?))"
      + ' UPDATE mail_filter_moves SET status = v.s, attempts = v.n, reason = v.r, at = v.t,'
      + " moves = mail_filter_moves.moves + (CASE WHEN v.s = 'moved' THEN 1 ELSE 0 END)"
      + ' FROM v WHERE mail_filter_moves.account_id = v.a AND mail_filter_moves.message_id = v.m',
      [JSON.stringify(rows)],
    )
  }

  /** The cached rows of these messages (what a move drops from the inbox cache). */
  cachedRows(accountId: string, messageIds: ReadonlyArray<string>): Promise<Array<{
    rowid: number; message_id: string; mailbox_id: string; body_ref: string | null; seen: number
  }>> {
    if (messageIds.length === 0) return Promise.resolve([])
    return this.db.all(
      'SELECT rowid, message_id, mailbox_id, body_ref, seen FROM messages'
      + ' WHERE account_id = ? AND message_id IN (SELECT value FROM json_each(?))',
      [accountId, JSON.stringify(messageIds)],
    )
  }

  /** Per rule: how many moved and how many failed (the rules list's line). */
  async countsByRule(): Promise<Map<string, { moved: number; failed: number; queued: number }>> {
    const rows = await this.db.all<{ rule_id: string; status: string; n: number }>(
      'SELECT rule_id, status, COUNT(*) AS n FROM mail_filter_moves GROUP BY rule_id, status',
    )
    const out = new Map<string, { moved: number; failed: number; queued: number }>()
    for (const row of rows) {
      const entry = out.get(row.rule_id) ?? { moved: 0, failed: 0, queued: 0 }
      if (row.status === 'moved' || row.status === 'failed' || row.status === 'queued') entry[row.status] += row.n
      out.set(row.rule_id, entry)
    }
    return out
  }
}
