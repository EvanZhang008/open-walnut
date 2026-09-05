/**
 * The statements behind the two ways mail LEAVES the plugin: the message-to-task ledger, and what
 * the daily digest reads.
 *
 * Split from store.ts because they are one subject and the mailbox reads are another, and because
 * this file holds the one statement in the plugin whose exact form is a safety property: the ledger
 * claim. Two rules it exists to keep visible:
 *
 * - A CLAIM IS NOT AN UPSERT. Two callers making a task from the same message at the same moment
 *   used to write one row twice and orphan one of the two tasks, because an unconditional
 *   `DO UPDATE SET task_id` lets the loser overwrite the winner. `DO NOTHING` plus a re-read makes
 *   the database pick, and both callers then report the same id.
 * - A REPOINT NAMES THE ID IT IS REPLACING. Repointing after the human deleted a task is a
 *   compare-and-swap on the dead id, so a repoint racing a claim cannot undo it.
 *
 * Unread is decided in SQL, never by reading rows and filtering in JS: an account with 50,000
 * cached messages has to answer the digest in ten rows of work, inside the sync tick's shared
 * budget, where a full read of an account is the difference between a digest and a dropped
 * retention pass.
 */
import { MESSAGE_COLUMNS, type MailDatabase } from './db.js'
import type { MessageRow, MessageTaskRow } from './store.js'

/**
 * How a `\Seen` flag looks INSIDE the stored `flags_json` text, computed rather than typed.
 *
 * The flags are stored as a JSON array, so the flag's own backslash is doubled in the text. Writing
 * that pattern by hand means counting backslashes across a JS literal and a SQL literal at the same
 * time, and getting it wrong does not fail loudly: it silently matches nothing, which would report
 * every message as unread.
 */
const SEEN_IN_JSON = JSON.stringify('\\Seen').slice(1, -1)

/** Unread, expressed the only way the cache can: the `\Seen` flag is not in the array. */
const UNREAD_CLAUSE = '(flags_json IS NULL OR flags_json NOT LIKE ?)'

const INBOX_CLAUSE =
  'mailbox_id IN (SELECT mailbox_id FROM mailboxes WHERE account_id = ? AND role = \'inbox\')'

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

/** Reachable as `store.tasks`; see MailStore for why it hangs off the same object. */
export class MailTaskStore {
  constructor(private readonly db: MailDatabase) {}

  // ── the message-to-task ledger ──

  getMessageTask(key: string): Promise<MessageTaskRow | undefined> {
    return this.db.get<MessageTaskRow>(
      'SELECT rfc_message_id, account_id, message_id, task_id, created_at FROM message_tasks'
      + ' WHERE rfc_message_id = ?',
      [key],
    )
  }

  /**
   * The backlink for a whole page of messages in ONE statement.
   *
   * The alternative is a lookup per row, and the read paths this feeds (a 50-row list, a search
   * answer) would then cost 50 worker round trips to decorate an answer they already have.
   */
  async messageTasks(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map()
    const rows = await this.db.all<{ rfc_message_id: string; task_id: string }>(
      'SELECT rfc_message_id, task_id FROM message_tasks'
      + ` WHERE rfc_message_id IN (${placeholders(keys.length)})`,
      keys,
    )
    return new Map(rows.map((row) => [row.rfc_message_id, row.task_id]))
  }

  /**
   * Claim this message for a task, and answer with whoever actually holds it.
   *
   * The return value is the point of the method. `DO NOTHING` means a second caller's INSERT is a
   * no-op instead of an overwrite, and the re-read is what turns "I lost the race" into "here is
   * the id you should report" without either caller having to parse a constraint error. The plugin
   * runs in one process, so `MailMessageTasks` also serializes callers in memory; this is the half
   * that stays correct if that ever stops being true.
   *
   * `replacing` is the repoint path: the caller saw a ledger row whose task no longer exists, and
   * naming that dead id in the WHERE clause is what makes the swap safe against a concurrent claim
   * that already fixed it.
   */
  async claimMessageTask(row: {
    key: string
    accountId: string
    messageId: string
    taskId: string
    now: number
    replacing?: string
  }): Promise<string> {
    if (row.replacing) {
      await this.db.run(
        'UPDATE message_tasks SET account_id = ?, message_id = ?, task_id = ?, created_at = ?'
        + ' WHERE rfc_message_id = ? AND task_id = ?',
        [row.accountId, row.messageId, row.taskId, row.now, row.key, row.replacing],
      )
    }
    // Runs in both cases: a repoint whose row was deleted between the read and the update has to
    // end with a row, and on the ordinary path this IS the claim.
    await this.db.run(
      'INSERT INTO message_tasks (rfc_message_id, account_id, message_id, task_id, created_at)'
      + ' VALUES (?, ?, ?, ?, ?) ON CONFLICT(rfc_message_id) DO NOTHING',
      [row.key, row.accountId, row.messageId, row.taskId, row.now],
    )
    const winner = await this.getMessageTask(row.key)
    return winner?.task_id ?? row.taskId
  }

  /** Every key a task points at. Retention never evicts one of these rows. */
  async taskLinkedKeys(): Promise<Set<string>> {
    const rows = await this.db.all<{ rfc_message_id: string }>(
      'SELECT rfc_message_id FROM message_tasks',
    )
    return new Set(rows.map((row) => row.rfc_message_id))
  }

  /** Removing an account forgets its links. The tasks it made are the human's and stay. */
  async deleteMessageTasks(accountId: string): Promise<void> {
    await this.db.run('DELETE FROM message_tasks WHERE account_id = ?', [accountId])
  }

  // ── what the digest reads ──

  /** Newest unread inbox messages for one account: the items the digest lists. */
  unreadInboxMessages(accountId: string, limit: number): Promise<MessageRow[]> {
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE account_id = ? AND ${UNREAD_CLAUSE} AND ${INBOX_CLAUSE}`
      + ' ORDER BY sent_at DESC, message_id DESC LIMIT ?',
      [accountId, `%${SEEN_IN_JSON}%`, accountId, limit],
    )
  }

  // ── meta: one key/value row per thing the plugin has to remember across restarts ──

  async getMeta(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])
    return row?.value
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    )
  }
}
