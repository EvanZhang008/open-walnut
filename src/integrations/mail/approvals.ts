/**
 * The approval ledger: how a draft becomes an approved revision, and how exactly one send row
 * comes out of it.
 *
 * The invariant, stated once so every method below can be read against it: NOTHING reaches
 * `provider.send` without a `sends` row, and a `sends` row can only exist for a draft revision
 * that was `pending_approval` at the moment the approval was minted. `letter_id` on the draft is
 * the binding between an outstanding letter and the revision it froze, and it is cleared by
 * exactly the three operations that invalidate an approval: an edit, a discard, and a console
 * send. So an answer to a letter the draft no longer points at cannot mint anything, which is
 * what makes "I edited it, then tapped Send on the old letter" safe.
 *
 * Two things deliberately do NOT happen here:
 *
 * - No automatic retry, ever. `failed` is retried only when a human asks, and `unknown` is not
 *   retried at all. See `sends.ts` for why.
 * - No approval is inferred from a state. A human tapped a button or clicked Send in the
 *   console, and `approval_kind` plus `approval_ref` records which, because "who authorised
 *   this" is the first question anybody asks about a message they did not expect.
 */
import {
  MailServiceError,
  reasonOf,
  type ApprovalKind,
  type DraftDto,
  type SendDto,
} from './contract.js'
import { REQUESTABLE_DRAFT_STATES } from './drafts.js'
import type { MailDrafts } from './drafts.js'
import type { MailEvents } from './events.js'
import { renderApprovalLetter } from './render.js'
import type { MailService } from './service.js'
import { toSendDto } from './sends.js'
import type { MailSends } from './sends.js'
import type { AccountRow, DraftRow, MailStore, SendRow } from './store.js'

/** The letter actions an approval letter offers. Fixed ids: the handler switches on them. */
export const LETTER_ACTIONS = [
  { id: 'send', label: 'Send', description: 'Send this message now, exactly as shown' },
  { id: 'edit', label: 'Edit', description: 'Put it back in the Mail console without sending' },
  { id: 'discard', label: 'Discard', description: 'Throw the draft away without sending' },
] as const

/**
 * How long a draft may sit frozen with no ledger row before the reconciler calls it stuck.
 *
 * Comfortably longer than any single request: an approve, an insert and an SMTP handshake are
 * seconds, so two minutes can only be reached by a process that is no longer running.
 */
export const FROZEN_DRAFT_GRACE_MS = 2 * 60_000

/** Frozen drafts examined per sweep. Bounded because each one can cost a letter read. */
const RECONCILE_BATCH = 20

/** The console path may also start from a draft that already has a letter out. */
const CONSOLE_SENDABLE_STATES = [...REQUESTABLE_DRAFT_STATES, 'pending_approval'] as const

/** The letters surface this file needs, so a test can hand over a small spy. */
export interface ApprovalLetters {
  send(input: {
    subject: string
    markdown?: string
    actions?: Array<{ id: string; label: string; description?: string }>
  }): Promise<{ letterId: string }>
  reply(letterId: string, input: { markdown?: string; text?: string }): Promise<void>
  withdraw(letterId: string, input: { note: string }): Promise<void>
  /**
   * The letter's state, including whether it was answered and with which action.
   *
   * Only the reconciler uses it, and only for a draft that is already stuck: the answer normally
   * arrives as an event, and polling letters would be a worse version of that.
   */
  get(letterId: string): Promise<{
    letterId: string
    answered?: { actionId: string; label: string; at: number }
  } | null>
}

interface ApprovalLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

/** What a letter answer looks like, from `walnut.letters.onAnswered`. */
export interface LetterAnswer {
  letterId: string
  actionId: string
  freeText?: string
}

/**
 * The three things a superseded answer can honestly say. They are different on purpose.
 *
 * The old single message said "already changed or was already sent", which is a guess presented as
 * a fact: a human who reads "already sent" about a message that was never sent stops looking for
 * it. Which one applies is decided by the LEDGER, because a `sends` row is the only proof that a
 * send for this draft ever existed.
 */
const CHANGED_REPLY =
  'This draft changed after the letter went out, so nothing was sent now. Open the Mail console to'
  + ' see where it stands, and ask again from there if you still want it sent.'

const ALREADY_SENT_REPLY =
  'A send for this draft was already under way, so nothing was sent by this answer. Open the Mail'
  + ' console to see how it ended.'

const SUPERSEDED_REPLY =
  'This letter is no longer the one Walnut is waiting on: the draft was edited, discarded, or sent'
  + ' from the console. Nothing was sent by this answer.'

function stale(message: string): MailServiceError {
  return new MailServiceError('stale', message, 409)
}

export class MailApprovals {
  constructor(private readonly deps: {
    store: MailStore
    service: MailService
    drafts: MailDrafts
    sends: MailSends
    letters: ApprovalLetters
    events: MailEvents
    log: ApprovalLogger
    now?: () => number
  }) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Freeze a revision and ask the human, in that order but with the letter first.
   *
   * The letter is created BEFORE the freeze because the freeze has to record its id, and if the
   * freeze then loses a race with an edit, the letter is withdrawn again. The other order would
   * need a placeholder id, which means a window where a draft is frozen against a letter that
   * does not exist, and a crash in that window leaves a draft nobody can ever unfreeze.
   */
  async requestSend(draftId: string, revision: number): Promise<{ draft: DraftDto; letterId: string }> {
    const first = await this.deps.drafts.require(draftId)
    this.assertRevision(first, revision)
    const account = await this.requireActiveAccount(first.account_id)
    this.deps.drafts.assertSendable(first, await this.deps.service.capabilitiesFor(first.account_id))

    // A draft that already tried and settled has to move to a NEW revision before it can be asked
    // about again, because the ledger key is `<draftId>:<revision>` and the old key is spent. Left
    // at the same revision the freeze succeeds, the approve succeeds, and then the ledger hands
    // back the previous attempt's row, which sends nothing and leaves the draft stuck in
    // `approved` with no way out but DELETE. This is the same bump `retry` does, for the same
    // reason, and the answer carries the new revision so the caller can follow it.
    const row = await this.freshRevisionForRetry(first)

    const dto = this.deps.drafts.toDto(row)
    // Rendered from the ROW. A request body that says something else is not what the human is
    // being asked about, and not what `sends.ts` will put on the wire.
    const letter = renderApprovalLetter({
      accountAddress: account.address,
      accountLabel: account.display_name || account.address,
      to: dto.to,
      cc: dto.cc,
      bcc: dto.bcc,
      subject: dto.subject,
      bodyMarkdown: dto.bodyMarkdown,
      isReply: !!dto.inReplyTo,
    })
    const sent = await this.deps.letters.send({
      subject: letter.subject,
      markdown: letter.markdown,
      actions: LETTER_ACTIONS.map((one) => ({ ...one })),
    })

    const frozen = await this.deps.store.write.freezeDraft(
      draftId, row.revision, sent.letterId, this.now, REQUESTABLE_DRAFT_STATES,
    )
    if (frozen === 0) {
      // Somebody edited, discarded or sent this draft between the read and the freeze. The letter
      // is already in the human's inbox, so it is withdrawn rather than left as a live button
      // pointing at a revision that no longer exists.
      await this.withdraw(sent.letterId, 'This draft changed before the letter went out; nothing was sent.')
      throw stale(`Draft ${draftId} changed while the approval letter was being prepared.`)
    }
    const fresh = await this.deps.drafts.require(draftId)
    this.deps.events.draftChanged(draftId, fresh.state, fresh.revision)
    this.deps.log.info('mail draft is waiting for approval', {
      draftId, revision: row.revision, letterId: sent.letterId,
    })
    return { draft: this.deps.drafts.toDto(fresh), letterId: sent.letterId }
  }

  /**
   * The console's own Send: the same ledger, with the human's click as the approval.
   *
   * It freezes first (conditional on the revision, so a wrong one is a 409 rather than a send of
   * something the user was not looking at) and then goes through the identical approve, ledger,
   * execute path. A letter still out for this draft is withdrawn AFTER the approval is minted:
   * withdrawing first would throw away a live letter on a request that might yet be refused.
   */
  async consoleSend(
    draftId: string,
    revision: number,
    /** Called the moment the ledger row exists, which is what the route's 202 reports. */
    onMinted?: (send: SendDto) => void,
    /**
     * What the `sends` row records as the human's own act, when it is not a plain console Send.
     *
     * `'console'` is a click on Send in the Mail console, and it is the default because that is what
     * this method is for. The unsubscribe ladder passes `unsubscribe:<messageId>` for the same
     * reason: a right-click on Unsubscribe IS the authorisation, so the send belongs on this side of
     * the ledger and not behind a letter — but "who authorised this" has to name the click, and a
     * row that said `console` would send somebody looking for an unexpected mail to the composer
     * they never opened. Anything passed here is `approvalKind: 'console'`, which is what keeps it
     * out of the letter branches (see `unfreezeAfterSpentKey` and `sends.reply`).
     */
    approvalRef = 'console',
  ): Promise<{ send: SendDto; draft: DraftDto }> {
    const first = await this.deps.drafts.require(draftId)
    this.assertRevision(first, revision)
    await this.requireActiveAccount(first.account_id)
    this.deps.drafts.assertSendable(
      first,
      await this.deps.service.capabilitiesFor(first.account_id),
      CONSOLE_SENDABLE_STATES,
    )
    // Same reason as `requestSend`: a spent ledger key cannot be reused, and without the bump the
    // console answered 200 carrying the OLD failed row and sent nothing.
    const row = await this.freshRevisionForRetry(first)
    const outstanding = row.letter_id

    const frozen = await this.deps.store.write.freezeDraft(
      draftId, row.revision, null, this.now, CONSOLE_SENDABLE_STATES,
    )
    if (frozen === 0) throw stale(`Draft ${draftId} changed before the console send reached it.`)

    const send = await this.mintAndSend(row, row.revision, 'console', approvalRef, onMinted)
    if (!send) throw stale(`Draft ${draftId} changed before the console send reached it.`)
    if (outstanding) await this.withdraw(outstanding, 'Sent from the console; this letter is no longer needed.')
    return { send: toSendDto(send), draft: this.deps.drafts.toDto(await this.deps.drafts.require(draftId)) }
  }

  /**
   * A draft whose last attempt settled gets a fresh revision before it is asked about again.
   *
   * An empty patch: every stored field keeps its value and only `revision` moves, which is exactly
   * what makes the ledger key new. A draft in any other state is returned untouched.
   */
  private async freshRevisionForRetry(row: DraftRow): Promise<DraftRow> {
    if (row.state !== 'failed' && row.state !== 'unknown') return row
    await this.deps.drafts.patch(row.draft_id, {})
    const fresh = await this.deps.drafts.require(row.draft_id)
    this.deps.log.info('mail draft moved to a fresh revision before asking again', {
      draftId: row.draft_id, from: row.revision, to: fresh.revision, after: row.state,
    })
    return fresh
  }

  /**
   * A letter was answered. The ONE entry point from the human inbox.
   *
   * It never throws: it runs on a bus subscription, so the only person it could report to is the
   * log, and every outcome the human needs to know about goes back into the letter's own thread.
   */
  async onLetterAnswered(answer: LetterAnswer): Promise<void> {
    // Our own withdrawal comes back through the same event. Acting on it would mean an edit or a
    // discard triggering a second round of the thing it just cancelled.
    if (answer.actionId === 'withdrawn') return
    const row = await this.deps.store.write.getDraftByLetter(answer.letterId).catch(() => undefined)
    if (!row) {
      // The draft no longer points at this letter, which is exactly what an edit, a discard or a
      // console send does. Nothing can be minted, and the human is told so in the thread. This
      // branch cannot check the ledger (there is no draft id to check), so it says what it knows
      // and does not guess at "already sent".
      await this.reply(answer.letterId, SUPERSEDED_REPLY)
      this.deps.log.info('mail letter answered for a draft that moved on', {
        letterId: answer.letterId, actionId: answer.actionId,
      })
      return
    }

    try {
      if (answer.actionId === 'send') {
        // `approved` with this letter still bound means a process died between minting the approval
        // and writing the ledger row. The approval is real and this letter is the one that granted
        // it, so the answer RESUMES from where the crash left off instead of reporting a change
        // that never happened. The ledger's UNIQUE key is still the gate.
        const send = row.state === 'approved'
          ? await this.writeLedgerAndRun(row, row.revision, 'letter', answer.letterId)
          : await this.mintAndSend(row, row.revision, 'letter', answer.letterId)
        if (!send) await this.reply(answer.letterId, await this.staleReply(row.draft_id))
        return
      }
      if (answer.actionId === 'edit') {
        await this.deps.store.write.unfreezeDraft(row.draft_id, this.now)
        const fresh = await this.deps.drafts.require(row.draft_id)
        this.deps.events.draftChanged(row.draft_id, fresh.state, fresh.revision)
        await this.reply(
          answer.letterId,
          'Nothing was sent. Edit it in the Mail console; asking again will send a fresh letter.',
        )
        return
      }
      if (answer.actionId === 'discard') {
        await this.deps.store.write.discardDraft(row.draft_id, this.now)
        const fresh = await this.deps.drafts.require(row.draft_id)
        this.deps.events.draftChanged(row.draft_id, fresh.state, fresh.revision)
        await this.reply(answer.letterId, 'Discarded, nothing was sent.')
        return
      }
      this.deps.log.warn('mail letter answered with an action the base does not know', {
        letterId: answer.letterId, actionId: answer.actionId,
      })
    } catch (error) {
      this.deps.log.warn('mail letter answer could not be carried out', {
        letterId: answer.letterId, actionId: answer.actionId, error: reasonOf(error).slice(0, 300),
      })
      await this.reply(
        answer.letterId,
        `Walnut could not carry that out: ${reasonOf(error).slice(0, 300)} Nothing was sent.`,
      )
    }
  }

  /**
   * Retry a `failed` send: a whole fresh approval round, never a second attempt.
   *
   * The revision is bumped by a no-op edit, which is what changes the ledger key, so the retry
   * gets its own `sends` row and its own letter. An `unknown` send is refused outright: the
   * message may already be in the recipient's mailbox, and only the Sent folder can say.
   */
  async retry(sendId: string): Promise<{ draft: DraftDto; letterId: string }> {
    const send = await this.deps.sends.require(sendId)
    if (send.state === 'unknown') {
      throw new MailServiceError(
        'invalid',
        'This send never reported an outcome, so retrying it could deliver the same message twice.'
        + ' Check the Sent folder: if it is not there, send it again from the draft.',
        409,
      )
    }
    if (send.state !== 'failed') {
      throw new MailServiceError(
        'invalid',
        `Only a failed send can be retried, and this one is "${send.state}".`,
        409,
      )
    }
    // The revision bump lives in `requestSend` (a settled draft always gets a fresh ledger key),
    // so a retry is exactly a re-request and there is one code path to get wrong instead of two.
    const row = await this.deps.drafts.require(send.draft_id)
    return this.requestSend(send.draft_id, row.revision)
  }

  /**
   * Put right the drafts a crash left frozen. Runs at activate and inside the sync tick.
   *
   * Two failures need it, and neither can be fixed by the code that caused them, because in both
   * cases that code is gone:
   *
   * - A process that died between minting the approval (`approved`) and writing the ledger row. The
   *   draft is not editable, not requestable, and its letter is still live. Nothing was sent, and
   *   nothing ever will be, so the draft is UNFROZEN and the human is told to ask again. Unfreezing
   *   rather than resuming is the conservative half of the pair: nobody is watching a dead
   *   process's request, and re-asking costs one letter.
   * - An answer that was recorded on the letter but never reached this handler, because
   *   `bus.emit` does not await its subscribers. The letter says Send, the draft says
   *   `pending_approval`, and the human believes the mail went. That one is RESUMED, because the
   *   human's decision is on record and the ledger's gates still apply.
   *
   * Anything with a ledger row for its current revision is left alone: a send exists, and
   * `sends.reap` owns whatever state that send is in.
   */
  async reconcile(deadlineAt?: number): Promise<{ unfrozen: number; resumed: number }> {
    const outcome = { unfrozen: 0, resumed: 0 }
    const rows = await this.deps.store.write.frozenDrafts(
      this.now - FROZEN_DRAFT_GRACE_MS,
      RECONCILE_BATCH,
    )
    for (const row of rows) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) break
      try {
        if (await this.deps.store.write.getSendByKey(`${row.draft_id}:${row.revision}`)) continue
        if (row.state === 'approved') {
          await this.unfreezeStuck(row, 'Nothing was sent: Walnut stopped before the message went'
            + ' out. The draft is editable again, so ask for it to be sent when you are ready.')
          outcome.unfrozen += 1
          continue
        }
        // `pending_approval`: only an ANSWERED letter is stuck. An unanswered one is a human
        // taking their time, which is the normal case and must never be disturbed.
        const letter = row.letter_id ? await this.deps.letters.get(row.letter_id) : null
        if (row.letter_id && !letter) {
          await this.unfreezeStuck(row, '')
          outcome.unfrozen += 1
          continue
        }
        const answered = letter?.answered
        if (row.letter_id && !answered) continue
        if (answered?.actionId === 'send') {
          const send = await this.mintAndSend(row, row.revision, 'letter', row.letter_id!)
          if (send) {
            outcome.resumed += 1
            this.deps.log.warn('mail resumed a send whose letter answer was never handled', {
              draftId: row.draft_id, revision: row.revision, letterId: row.letter_id,
            })
          }
          continue
        }
        await this.unfreezeStuck(row, 'Nothing was sent. The draft is editable again in the Mail'
          + ' console.')
        outcome.unfrozen += 1
      } catch (error) {
        // One bad row must not stop the sweep, and a reconcile failure is never fatal: the row
        // stays frozen and the next tick tries again.
        this.deps.log.warn('mail could not reconcile a frozen draft', {
          draftId: row.draft_id, state: row.state, error: reasonOf(error).slice(0, 200),
        })
      }
    }
    if (outcome.unfrozen || outcome.resumed) {
      this.deps.log.info('mail reconciled frozen drafts', outcome)
    }
    return outcome
  }

  private async unfreezeStuck(row: DraftRow, note: string): Promise<void> {
    const changed = await this.deps.store.write.unfreezeToState(row.draft_id, 'composing', this.now)
    if (changed === 0) return
    const fresh = await this.deps.drafts.require(row.draft_id)
    this.deps.events.draftChanged(row.draft_id, fresh.state, fresh.revision)
    this.deps.log.warn('mail unfroze a draft nobody could finish', {
      draftId: row.draft_id, from: row.state, revision: row.revision,
    })
    if (row.letter_id) {
      await this.withdraw(
        row.letter_id,
        note || 'Walnut stopped before this could be sent; nothing was sent, and the draft is'
          + ' editable again.',
      )
    }
  }

  /** Withdraw the outstanding letter of a draft that was just edited or discarded. */
  async withdrawFor(letterId: string | undefined, note: string): Promise<void> {
    if (!letterId) return
    await this.withdraw(letterId, note)
  }

  /**
   * Mint the approval, then write the ledger row and run the one attempt.
   *
   * `undefined` means the approval could not be minted, which the callers turn into a 409 or a
   * thread reply. The approve statement is the FIRST gate and the only one this method adds; the
   * two below it live in `writeLedgerAndRun` so a resume can use them without re-approving.
   */
  private async mintAndSend(
    draft: DraftRow,
    revision: number,
    approvalKind: ApprovalKind,
    approvalRef: string,
    onMinted?: (send: SendDto) => void,
  ): Promise<SendRow | undefined> {
    const draftId = draft.draft_id
    const approved = await this.deps.store.write.approveDraft(draftId, revision, this.now)
    if (approved === 0) {
      this.deps.log.info('mail approval was not minted, nothing sent', { draftId, revision })
      return undefined
    }
    return this.writeLedgerAndRun(draft, revision, approvalKind, approvalRef, onMinted)
  }

  /**
   * Gates two and three: the UNIQUE ledger key, and the one attempt claimed off the row.
   *
   * Reachable with the approval ALREADY minted (a resume after a crash in the two-statement
   * window), which is safe precisely because neither gate here depends on the draft's state.
   */
  private async writeLedgerAndRun(
    draft: DraftRow,
    revision: number,
    approvalKind: ApprovalKind,
    approvalRef: string,
    onMinted?: (send: SendDto) => void,
  ): Promise<SendRow | undefined> {
    const draftId = draft.draft_id
    const idempotencyKey = `${draftId}:${revision}`
    const existing = await this.deps.store.write.getSendByKey(idempotencyKey)
    if (existing) {
      // A row still in `approved` is an attempt that never started, so it is picked up.
      if (existing.state === 'approved') {
        onMinted?.(toSendDto(existing))
        return this.deps.sends.execute(existing)
      }
      // Anything else means this revision's send ALREADY RAN. Returning that row would report a
      // previous outcome as this request's answer (a spent key used to leave the draft parked in
      // `approved` for good, with the console showing the old failure as fresh). Nothing may be
      // sent now, and the draft must not be left frozen.
      await this.unfreezeAfterSpentKey(draft, existing.state, approvalKind, approvalRef)
      throw stale(
        `Revision ${revision} of this draft was already sent once (that attempt ended`
        + ` "${existing.state}"), so nothing was sent now. The draft is editable again: ask again`
        + ' and Walnut will send a fresh letter for a new revision.',
      )
    }
    const sendId = `sn-${this.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await this.deps.store.write.insertSend({
        sendId,
        draftId,
        accountId: draft.account_id,
        revision,
        idempotencyKey,
        approvalKind,
        approvalRef,
        now: this.now,
      })
    } catch (error) {
      // The UNIQUE index on `idempotency_key` is the second gate. The loser of the race does not
      // guess from the error text: it re-reads by key, and a row there means the winner owns this
      // revision. Only a genuinely missing row is a real failure worth raising.
      const winner = await this.deps.store.write.getSendByKey(idempotencyKey)
      if (!winner) throw error
      this.deps.log.info('mail send ledger already had this revision, sending nothing', {
        draftId, revision, sendId: winner.send_id,
      })
      return winner
    }
    const row = await this.deps.store.write.getSend(sendId)
    if (!row) throw new MailServiceError('internal', 'the send ledger row disappeared', 500)
    onMinted?.(toSendDto(row))
    return this.deps.sends.execute(row)
  }

  /**
   * A frozen draft whose ledger key is spent: put it back where a human can act on it.
   *
   * The ledger row's own state is what this revision really ended as, so the draft is restored to
   * it rather than to `composing`: that is the state it was in before the request, and it is what
   * the console's Retry reads. The letter, if any, is withdrawn, because its Send button now points
   * at a revision that can never be approved again.
   *
   * The last step keys on the KIND, not on the ref's value. It used to read `approvalRef !== 'console'`
   * and treat everything else as a letter id, which was true for exactly as long as `console` was the
   * only non-letter ref there was. The console path now mints refs of its own (`unsubscribe:<messageId>`,
   * see `consoleSend`), and under the old test that spent key would have called `letters.reply` on a
   * letter that never existed: a warning in the log for the human, and nothing at all in the thread
   * they were actually watching. A `console` send has no thread to answer in, whatever its ref says.
   */
  private async unfreezeAfterSpentKey(
    draft: DraftRow,
    sendState: string,
    approvalKind: ApprovalKind,
    approvalRef: string,
  ): Promise<void> {
    const back = sendState === 'sent' ? 'sent' : sendState === 'sending' ? 'sending' : sendState
    await this.deps.store.write.unfreezeToState(draft.draft_id, back, this.now)
    const fresh = await this.deps.drafts.require(draft.draft_id)
    this.deps.events.draftChanged(draft.draft_id, fresh.state, fresh.revision)
    this.deps.log.warn('mail draft was frozen against a ledger key that was already spent', {
      draftId: draft.draft_id, revision: draft.revision, sendState,
    })
    if (draft.letter_id) {
      await this.withdraw(draft.letter_id, 'This revision was already sent once; nothing was sent now.')
    }
    if (approvalKind === 'letter' && approvalRef && approvalRef !== draft.letter_id) {
      await this.reply(approvalRef, ALREADY_SENT_REPLY)
    }
  }

  /** Which "nothing was sent" is true here, decided by the ledger rather than guessed. */
  private async staleReply(draftId: string): Promise<string> {
    const ledger = await this.deps.store.write
      .listSends({ draftId, limit: 1 })
      .catch(() => [] as SendRow[])
    return ledger.length > 0 ? ALREADY_SENT_REPLY : CHANGED_REPLY
  }

  private assertRevision(row: DraftRow, revision: number): void {
    if (!Number.isInteger(revision)) {
      throw new MailServiceError(
        'invalid',
        'a revision is required: it is what pins the approval to the text you actually read',
        400,
      )
    }
    if (row.revision !== revision) {
      throw stale(
        `This draft is at revision ${row.revision} and you asked about ${revision}, so nothing was`
        + ' sent. Reload the draft and try again.',
      )
    }
  }

  private async requireActiveAccount(accountId: string): Promise<AccountRow> {
    const account = await this.deps.store.getAccount(accountId)
    if (!account) {
      throw new MailServiceError('unknown_account', `No mail account "${accountId}".`, 404)
    }
    if (account.state !== 'active') {
      throw new MailServiceError(
        'invalid',
        `The account "${accountId}" is "${account.state}", so Walnut will not try to send from it`
        + ' yet. Fix the account first.',
        409,
      )
    }
    return account
  }

  private async withdraw(letterId: string, note: string): Promise<void> {
    try { await this.deps.letters.withdraw(letterId, { note }) }
    catch (error) {
      this.deps.log.warn('mail approval letter could not be withdrawn', {
        letterId, error: reasonOf(error).slice(0, 200),
      })
    }
  }

  private async reply(letterId: string, markdown: string): Promise<void> {
    try { await this.deps.letters.reply(letterId, { markdown, text: markdown }) }
    catch (error) {
      this.deps.log.warn('mail approval letter could not be replied to', {
        letterId, error: reasonOf(error).slice(0, 200),
      })
    }
  }
}
