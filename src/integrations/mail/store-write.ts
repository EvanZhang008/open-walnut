/**
 * The write half of the plugin database: the `drafts` and `sends` tables, and nothing else.
 *
 * Split from store.ts because the two tables are the approval ledger, and the ledger is the one
 * part of this plugin where a statement's exact WHERE clause IS the safety property. Reading them
 * together, in a file whose only subject is those transitions, is worth more than the convenience
 * of one class.
 *
 * The rules every statement below is written to, each of which is a bug somebody could otherwise
 * introduce in a one-line change:
 *
 * - There is NO multi-statement transaction in the plugin database (each call is its own worker
 *   round trip), so every step has to be individually safe to repeat, and a step that must not
 *   happen twice has to be a CONDITIONAL update whose changed-row count the caller reads.
 * - A state transition names the states it is allowed to come FROM. An unconditional
 *   `SET state = ?` is how a late reaper turns a delivered message into "outcome unknown", so the
 *   two that settle a send both name `sending`.
 * - `idempotency_key` is UNIQUE per `<draftId>:<revision>`. The INSERT is allowed to fail; the
 *   caller re-reads by key rather than parsing an error string.
 */
import type { MailDatabase } from './db.js'
import type { DraftRow, SendRow } from './store.js'

const DRAFT_COLUMNS =
  'draft_id, account_id, in_reply_to, to_json, subject, body_md, revision, state, origin,'
  + ' created_by_session, payload, letter_id, created_at, updated_at, approved_at, discarded_at, error'

const SEND_COLUMNS =
  'send_id, draft_id, account_id, idempotency_key, approval_kind, approval_ref, state,'
  + ' provider_message_id, error, revision, created_at, attempted_at, settled_at'

/** States a draft may still be edited, discarded or offered for approval from. */
export const EDITABLE_DRAFT_STATES = ['composing', 'pending_approval', 'failed', 'unknown'] as const

/**
 * States a freeze can be interrupted in: the draft is committed to a send that has not happened.
 *
 * `pending_approval` is normal and can last days (a human has to answer). `approved` is NOT: it is
 * the two-statement window between minting an approval and writing the ledger row, so a draft
 * sitting there is a process that died in that window. Both are what the tick reconciler looks at.
 */
export const FROZEN_DRAFT_STATES = ['pending_approval', 'approved'] as const

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

/** Every statement that touches `drafts` or `sends`. Nothing above this file writes SQL. */
export class MailWriteStore {
  constructor(private readonly db: MailDatabase) {}

  // ── drafts ──

  async insertDraft(row: {
    draftId: string
    accountId: string
    inReplyTo: string | null
    toJson: string
    subject: string
    bodyMd: string
    origin: string
    createdBySession: string | null
    payload: string
    now: number
  }): Promise<void> {
    await this.db.run(
      'INSERT INTO drafts (draft_id, account_id, in_reply_to, to_json, subject, body_md, revision,'
      + ' state, origin, created_by_session, payload, created_at, updated_at)'
      + ` VALUES (${placeholders(11)}, ?, ?)`,
      [
        row.draftId, row.accountId, row.inReplyTo, row.toJson, row.subject, row.bodyMd, 1,
        'composing', row.origin, row.createdBySession, row.payload, row.now, row.now,
      ],
    )
  }

  getDraft(draftId: string): Promise<DraftRow | undefined> {
    return this.db.get<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE draft_id = ?`,
      [draftId],
    )
  }

  listDrafts(query: { accountId?: string; state?: string; limit: number }): Promise<DraftRow[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (query.accountId) { where.push('account_id = ?'); params.push(query.accountId) }
    if (query.state) { where.push('state = ?'); params.push(query.state) }
    params.push(query.limit)
    return this.db.all<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY updated_at DESC, draft_id DESC LIMIT ?',
      params,
    )
  }

  /**
   * One edit: the fields, `revision + 1`, and back to `composing`, in a single statement.
   *
   * The revision bump and the state reset cannot be separate statements. There is no
   * transaction in the plugin database, so a bump that landed without the reset would leave a
   * draft the ledger still believes is frozen at an approved revision.
   */
  async patchDraft(draftId: string, patch: {
    toJson: string
    subject: string
    bodyMd: string
    payload: string
    now: number
  }): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET to_json = ?, subject = ?, body_md = ?, payload = ?,'
      + ' revision = revision + 1, state = \'composing\', letter_id = NULL, approved_at = NULL,'
      + ' error = NULL, updated_at = ?'
      + ` WHERE draft_id = ? AND state IN (${placeholders(EDITABLE_DRAFT_STATES.length)})`,
      [patch.toJson, patch.subject, patch.bodyMd, patch.payload, patch.now, draftId, ...EDITABLE_DRAFT_STATES],
    )
    return result.changes
  }

  /** The draft this letter is outstanding for, if it still points at that letter. */
  getDraftByLetter(letterId: string): Promise<DraftRow | undefined> {
    return this.db.get<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE letter_id = ?`,
      [letterId],
    )
  }

  /**
   * Freeze for approval. Conditional on the revision, so a concurrent edit wins the race.
   *
   * `letterId` is null for a console send: there is no letter, and the freeze exists only so the
   * one approve statement below has the state it insists on.
   */
  async freezeDraft(
    draftId: string,
    revision: number,
    letterId: string | null,
    now: number,
    fromStates: readonly string[],
  ): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = \'pending_approval\', letter_id = ?, error = NULL, updated_at = ?'
      + ` WHERE draft_id = ? AND revision = ? AND state IN (${placeholders(fromStates.length)})`,
      [letterId, now, draftId, revision, ...fromStates],
    )
    return result.changes
  }

  /**
   * MINT AND CONSUME THE APPROVAL. The one statement exactly-once rests on.
   *
   * Nothing else in this file may move a draft to `approved`. It is conditional on BOTH the
   * frozen state and the exact revision, so a second answer to the same letter, a retry, and an
   * answer to a letter that a later edit superseded all change zero rows, and zero rows is what
   * the caller reads as "nothing was sent now".
   */
  async approveDraft(draftId: string, revision: number, now: number): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = \'approved\', approved_at = ?, updated_at = ?'
      + ' WHERE draft_id = ? AND state = \'pending_approval\' AND revision = ?',
      [now, now, draftId, revision],
    )
    return result.changes
  }

  async setDraftState(draftId: string, state: string, now: number, error?: string): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = ?, error = ?, updated_at = ? WHERE draft_id = ?',
      [state, error ?? null, now, draftId],
    )
    return result.changes
  }

  /** Back to editable without touching the revision: an `edit` answer is not an edit. */
  async unfreezeDraft(draftId: string, now: number): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = \'composing\', letter_id = NULL, approved_at = NULL, updated_at = ?'
      + ' WHERE draft_id = ? AND state = \'pending_approval\'',
      [now, draftId],
    )
    return result.changes
  }

  /**
   * Put a FROZEN draft back into a state a human can act on, whatever that state should be.
   *
   * Two callers, both recovery: a draft frozen against a ledger key that turned out to be spent
   * (restored to that attempt's own outcome), and the tick reconciler's unfreeze of a draft left
   * `approved` by a process that died before it wrote the ledger row (restored to `composing`).
   * Conditional on the frozen states, so it can never disturb a send in flight or a sent draft.
   */
  async unfreezeToState(draftId: string, state: string, now: number): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = ?, letter_id = NULL, approved_at = NULL, updated_at = ?'
      + ` WHERE draft_id = ? AND state IN (${placeholders(FROZEN_DRAFT_STATES.length)})`,
      [state, now, draftId, ...FROZEN_DRAFT_STATES],
    )
    return result.changes
  }

  /**
   * Drafts stuck in a frozen state since before `cutoff`: the tick reconciler's whole input.
   *
   * `pending_approval` rows are usually NOT stuck (a human may take days to answer), so the
   * reconciler checks each one's letter before touching it. An `approved` row always is: it is the
   * two-statement window between minting an approval and writing the ledger row.
   */
  frozenDrafts(cutoff: number, limit: number): Promise<DraftRow[]> {
    return this.db.all<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts`
      + ` WHERE state IN (${placeholders(FROZEN_DRAFT_STATES.length)}) AND updated_at < ?`
      + ' ORDER BY updated_at ASC LIMIT ?',
      [...FROZEN_DRAFT_STATES, cutoff, limit],
    )
  }

  /** A draft mid-flight or already sent is never discarded: the row is the send's own record. */
  async discardDraft(draftId: string, now: number): Promise<number> {
    const result = await this.db.run(
      'UPDATE drafts SET state = \'discarded\', discarded_at = ?, letter_id = NULL, updated_at = ?'
      + ' WHERE draft_id = ? AND state NOT IN (\'sending\', \'sent\', \'discarded\')',
      [now, now, draftId],
    )
    return result.changes
  }

  async clearDraftLetter(draftId: string): Promise<void> {
    await this.db.run('UPDATE drafts SET letter_id = NULL WHERE draft_id = ?', [draftId])
  }

  // ── sends (the approval ledger) ──

  /**
   * The ledger row. `idempotency_key` is UNIQUE, so this throws on a duplicate.
   *
   * The caller catches that and reads the existing row rather than treating it as an error:
   * two callers racing one approved revision is exactly what the constraint is for, and the
   * loser must send nothing.
   */
  async insertSend(row: {
    sendId: string
    draftId: string
    accountId: string
    revision: number
    idempotencyKey: string
    approvalKind: string
    approvalRef: string
    now: number
  }): Promise<void> {
    await this.db.run(
      'INSERT INTO sends (send_id, draft_id, account_id, idempotency_key, approval_kind,'
      + ' approval_ref, state, revision, created_at)'
      + ` VALUES (${placeholders(9)})`,
      [
        row.sendId, row.draftId, row.accountId, row.idempotencyKey, row.approvalKind,
        row.approvalRef, 'approved', row.revision, row.now,
      ],
    )
  }

  getSend(sendId: string): Promise<SendRow | undefined> {
    return this.db.get<SendRow>(`SELECT ${SEND_COLUMNS} FROM sends WHERE send_id = ?`, [sendId])
  }

  getSendByKey(idempotencyKey: string): Promise<SendRow | undefined> {
    return this.db.get<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM sends WHERE idempotency_key = ?`,
      [idempotencyKey],
    )
  }

  listSends(query: { accountId?: string; draftId?: string; limit: number }): Promise<SendRow[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (query.accountId) { where.push('account_id = ?'); params.push(query.accountId) }
    if (query.draftId) { where.push('draft_id = ?'); params.push(query.draftId) }
    params.push(query.limit)
    return this.db.all<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM sends`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at DESC, send_id DESC LIMIT ?',
      params,
    )
  }

  /**
   * Claim the ONE attempt this send row is allowed.
   *
   * The second gate after the approval, and it is not redundant: the ledger row can be reached
   * again by a reaper tick, a route retry or a second letter answer that somehow got past the
   * first gate, and only a row still in `approved` may reach the transport.
   */
  async claimSendAttempt(sendId: string, now: number): Promise<number> {
    const result = await this.db.run(
      'UPDATE sends SET state = \'sending\', attempted_at = ? WHERE send_id = ? AND state = \'approved\'',
      [now, sendId],
    )
    return result.changes
  }

  /**
   * Record an outcome, ONLY on a row that is still in flight.
   *
   * The `state = 'sending'` guard is the whole point and used not to be there. Two writers can
   * reach one row: the attempt that is running it, and the reaper that thinks it died. Unconditional,
   * a reaper tick that was starved for five minutes could overwrite a `sent` row with `unknown` and
   * tell the human to go check the Sent folder for a message that was delivered fine. The caller
   * reads the changed-row count and skips the rest of the settle when it is 0.
   */
  async settleSend(sendId: string, state: string, outcome: {
    providerMessageId?: string
    error?: string
    now: number
  }): Promise<number> {
    const result = await this.db.run(
      'UPDATE sends SET state = ?, provider_message_id = ?, error = ?, settled_at = ?'
      + " WHERE send_id = ? AND state = 'sending'",
      [state, outcome.providerMessageId ?? null, outcome.error ?? null, outcome.now, sendId],
    )
    return result.changes
  }

  /**
   * Rows that have been `sending` since before `cutoff`: the reaper's whole input.
   *
   * `attempted_at IS NOT NULL` rather than `COALESCE(attempted_at, 0)`: the only way to reach
   * `sending` is `claimSendAttempt`, which stamps the timestamp in the same statement, so a row
   * without one is a row some future writer created differently. Coalescing it to 0 would make that
   * row eligible for reaping on the very next tick, before its attempt had a chance to run.
   */
  stuckSends(cutoff: number, limit: number): Promise<SendRow[]> {
    return this.db.all<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM sends`
      + " WHERE state = 'sending' AND attempted_at IS NOT NULL AND attempted_at < ?"
      + ' ORDER BY attempted_at ASC LIMIT ?',
      [cutoff, limit],
    )
  }
}
