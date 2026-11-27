/**
 * The ONE place `provider.send` is called, and the state machine that keeps it once.
 *
 * Three gates stand between an approval and the transport, and none of them is redundant,
 * because the plugin database has no multi-statement transaction: every step here has to be
 * individually safe to repeat.
 *
 *   1. `approveDraft` (in `approvals.ts`): one conditional UPDATE naming the exact revision.
 *   2. `sends.idempotency_key` UNIQUE on `<draftId>:<revision>`: a duplicate INSERT loses, and
 *      the loser reads the winner's row and sends nothing.
 *   3. `claimSendAttempt` here: only a row still in `approved` may reach the transport, so a
 *      reaper tick, a retry route or a second answer that somehow got past gate 1 finds the row
 *      already claimed and stops.
 *
 * The other half of the design is the OUTCOME vocabulary, and it is the reason this file refuses
 * to be clever. SMTP has no dedupe: if we cannot tell whether the server took the message, no
 * amount of retry logic can make it safe, so an ambiguous failure becomes `unknown`, is never
 * retried automatically, and says so in plain words to the human who has the one thing this
 * process does not: the Sent folder.
 */
import {
  callProvider,
  MailServiceError,
  providerErrorCode,
  reasonOf,
  SEND_DEADLINE_MS,
  SEND_STUCK_MS,
  type SendDto,
  type SendState,
} from './contract.js'
import type { MailDrafts } from './drafts.js'
import type { MailEvents } from './events.js'
import { walnutLetterLanguage } from '../../core/human-inbox/walnut-letters/languages.js'
import { MAIL_APPROVAL_WORDS, type MailApprovalNote } from '../../core/human-inbox/walnut-letters/mail-approval.js'
import { renderOutgoingHtml } from './render.js'
import { beginOutwardSend, knownOpState, reportOutwardSend, type KnownOpState } from '../../core/leader/switch/doors.js'
import type { MailService } from './service.js'
import type { DraftRow, MailStore, SendRow } from './store.js'
import type { OutgoingMail } from './types.js'
import { clockTime } from '../../core/time-words.js'

/**
 * Rows the reaper settles per tick.
 *
 * Each one costs three database round trips and a letter reply under the inbox's write lock, and
 * this runs inside the sync tick's 20s budget alongside a poll and a retention sweep. Fifty of them
 * was the whole budget; the rest wait for the next tick, and a row that has been `sending` for five
 * minutes is not in a hurry.
 */
const REAP_BATCH = 10

/** The op id a mail send registers with the witnesses (leader switch): one per ledger key. */
export function mailSendOpId(send: Pick<SendRow, 'idempotency_key'>): string {
  return `mail:${send.idempotency_key}`
}

/** The letters surface this file needs. A subset, so a test can hand over a small spy. */
export interface SendLetters {
  reply(letterId: string, input: { markdown?: string; text?: string }): Promise<void>
}

interface SendLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

/**
 * How far the transport got, which is the only thing that decides whether a retry is allowed.
 *
 * An absent or unrecognised stage reads as `after-data`: the unsafe reading is the correct
 * default, because guessing the other way sends the mail twice.
 */
function stageOf(error: unknown): 'before-data' | 'after-data' {
  const stage = (error as { stage?: unknown } | null)?.stage
  return stage === 'before-data' ? 'before-data' : 'after-data'
}

function recipientCount(mail: OutgoingMail): number {
  // A reply with an empty `To` went to the original sender, whom the provider addressed itself.
  const to = mail.to.length || (mail.inReplyTo ? 1 : 0)
  return to + (mail.cc?.length ?? 0) + (mail.bcc?.length ?? 0)
}


export class MailSends {
  constructor(private readonly deps: {
    store: MailStore
    service: MailService
    drafts: MailDrafts
    letters: SendLetters
    events: MailEvents
    log: SendLogger
    now?: () => number
  }) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Build the wire message from the STORED ROW.
   *
   * Never from a request body: the human approved what is on disk, so that is what goes out. The
   * markdown is both the source of the HTML alternative and the `text/plain` half, which is why
   * no plain-text renderer exists here: markdown IS the readable plain text.
   */
  outgoingFor(row: DraftRow): OutgoingMail {
    const dto = this.deps.drafts.toDto(row)
    const html = renderOutgoingHtml(dto.bodyMarkdown)
    return {
      to: dto.to,
      ...(dto.cc.length ? { cc: dto.cc } : {}),
      ...(dto.bcc.length ? { bcc: dto.bcc } : {}),
      subject: dto.subject,
      bodyMarkdown: dto.bodyMarkdown,
      ...(html ? { bodyHtml: html } : {}),
      ...(dto.inReplyTo ? { inReplyTo: dto.inReplyTo } : {}),
      ...(dto.references?.length ? { references: dto.references } : {}),
    }
  }

  /**
   * Claim a ledger row's one attempt and run it to a settled state.
   *
   * Returns the row as it stands afterwards. A row this call did not claim comes back untouched:
   * that is not an error, it is the gate doing its job.
   */
  async execute(send: SendRow): Promise<SendRow> {
    // The outward door with the op id registered before the claim (leader switch: a no-op with the
    // experiment off). A refusal for want of the permission leaves the row `approved`, for the
    // reconcile of a server that may send; a refusal because the op is known already settles the
    // row by how the op stands (settleKnownOp), and it is never sent again under this id.
    const opId = mailSendOpId(send)
    try {
      await beginOutwardSend('mail-send', opId)
    } catch (error) {
      const known = knownOpState(error)
      if (!known) throw error
      return this.settleKnownOp(send, known, reasonOf(error))
    }
    // What the op is reported as when this attempt ends: 'not-sent' until the provider is asked
    // (a throw before that, the claim or the draft read, sent nothing), then as the ledger row ends.
    let outcome: 'sent' | 'not-sent' | 'unknown' = 'not-sent'
    try {
      const claimed = await this.deps.store.write.claimSendAttempt(send.send_id, this.now)
      if (claimed === 0) {
        this.deps.log.info('mail send attempt already claimed, doing nothing', {
          sendId: send.send_id, state: send.state,
        })
        // This attempt sent nothing; the op is reported as the row stands now, so it does not
        // stay registered with no outcome when the data knows one.
        const now = (await this.deps.store.write.getSend(send.send_id)) ?? send
        outcome = now.state === 'sent' ? 'sent' : now.state === 'failed' || now.state === 'approved' ? 'not-sent' : 'unknown'
        return now
      }
      await this.setDraft(send.draft_id, 'sending')
      this.deps.events.sendSettled(send.send_id, send.draft_id, 'sending')

      const row = await this.deps.drafts.require(send.draft_id)
      const mail = this.outgoingFor(row)
      outcome = 'unknown'
      try {
        const result = await callProvider(
          `a send for ${send.draft_id}`,
          () => this.deps.service.provider(send.account_id).send(
            send.account_id,
            mail,
            { idempotencyKey: send.idempotency_key },
          ),
          SEND_DEADLINE_MS,
        )
        outcome = 'sent'
        await this.settle(send, 'sent', {
          ...(result?.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        })
        await this.reply(send, (w) => w.sentAt(clockTime(result?.acceptedAt || this.now), recipientCount(mail)))
        return (await this.deps.store.write.getSend(send.send_id)) ?? send
      } catch (error) {
        const detail = reasonOf(error).slice(0, 300)
        const safe = stageOf(error) === 'before-data' && providerErrorCode(error) !== undefined
        // A DEADLINE is `after-data` by construction: `callProvider` reports a timeout as
        // `unreachable` with no stage, and a transport we stopped waiting for may well have
        // delivered the message. Only an error the provider explicitly staged before DATA is safe.
        const state: SendState = safe ? 'failed' : 'unknown'
        outcome = safe ? 'not-sent' : 'unknown'
        await this.settle(send, state, { error: detail })
        await this.reply(send, (w) => (state === 'failed' ? w.failed(detail) : w.unknown(detail)))
        this.deps.log.warn('mail send did not succeed', {
          sendId: send.send_id, state, code: providerErrorCode(error) ?? 'unknown', error: detail,
        })
        return (await this.deps.store.write.getSend(send.send_id)) ?? send
      }
    } finally {
      // A throw after the provider was asked and before it answered leaves the row `sending`
      // for the reaper's `unknown`: the op says the same.
      reportOutwardSend(opId, outcome)
    }
  }

  /**
   * The op of this row is known already (the permit refused its begin because of it): the row
   * settles by how the op stands, and it is never sent again under this id.
   *
   * - 'sent': it went out, so the row says sent.
   * - 'not-sent': it surely never left, so the row is failed; the person may send it again (a
   *   retry is a fresh revision, so a fresh key and a fresh op id), nothing resends it by itself.
   * - 'unknown' (an earlier holder registered it and never reported) while the row is still
   *   `approved` in this home's data: provably never sent, so failed as well. `execute` begins
   *   the op BEFORE its claim, and the claim is written before the provider is asked, so a holder
   *   that registered the op and stopped before its claim never asked the provider. That rests on
   *   this home's data being the earlier holder's last word: true in a manual switch (the data
   *   moves with the stopped home, after the earlier holder stopped); an automatic takeover from
   *   a lagging copy would need more (the claim on the witnesses too, or a check of the Sent folder).
   * - 'unknown' with the row claimed (`sending`): it may have gone out, so the row says unknown and
   *   the person is told to check the Sent folder.
   * - 'sending': this process is sending it right now, and that attempt settles the row.
   */
  private async settleKnownOp(send: SendRow, op: KnownOpState, why: string): Promise<SendRow> {
    const row = (await this.deps.store.write.getSend(send.send_id)) ?? send
    if (op === 'sending') return row
    if (row.state !== 'approved' && row.state !== 'sending') return row
    const state: SendState = op === 'sent' ? 'sent'
      : op === 'not-sent' || row.state === 'approved' ? 'failed'
        : 'unknown'
    const detail = op === 'sent' ? undefined
      : op === 'not-sent' ? 'an earlier Walnut server tried this send and it did not go out.'
        : row.state === 'approved' ? 'an earlier Walnut server registered this send but stopped before it started, so it never went out.'
          : 'an earlier Walnut server began this send and never reported whether it went out.'
    this.deps.log.warn('mail send op known already: settled by its state, never sent again', {
      sendId: send.send_id, op, state, why: why.slice(0, 200),
    })
    return this.settleWithoutSending(send, row, state, detail)
  }

  /**
   * An `approved` row that never started and is too old to send without asking again (the
   * reconcile's resume limit): failed with `detail`, nothing sent, and the person may send it again.
   */
  async settleUnsent(send: SendRow, detail: string): Promise<SendRow> {
    const row = (await this.deps.store.write.getSend(send.send_id)) ?? send
    if (row.state !== 'approved') return row
    return this.settleWithoutSending(send, row, 'failed', detail)
  }

  /** Settle an `approved` or `sending` row that this attempt will not send, and say so in its thread. */
  private async settleWithoutSending(send: SendRow, row: SendRow, state: SendState, detail?: string): Promise<SendRow> {
    const reread = async () => (await this.deps.store.write.getSend(send.send_id)) ?? send
    // `settleSend` moves only a claimed row: an approved one is claimed first.
    if (row.state === 'approved' && await this.deps.store.write.claimSendAttempt(send.send_id, this.now) === 0) return reread()
    if (!await this.settle(send, state, detail ? { error: detail } : {})) return reread()
    if (state === 'sent') {
      const mail = await this.deps.drafts.require(send.draft_id).then((d) => this.outgoingFor(d)).catch(() => null)
      if (mail) await this.reply(send, (w) => w.sentAt(clockTime(this.now), recipientCount(mail)))
    } else if (detail) {
      await this.reply(send, (w) => (state === 'failed' ? w.failed(detail) : w.unknown(detail)))
    }
    return reread()
  }

  /**
   * Rows stuck in `sending` past the cutoff: the process died mid-attempt.
   *
   * They become `unknown`, never `failed` and never a fresh attempt. The message may be sitting
   * in the recipient's mailbox already, and this process has no way to find out.
   */
  async reap(deadlineAt?: number): Promise<number> {
    const stuck = await this.deps.store.write.stuckSends(this.now - SEND_STUCK_MS, REAP_BATCH)
    let reaped = 0
    for (const send of stuck) {
      // Inside the tick's own clock. Each row is three database round trips plus a letter reply
      // that takes the human inbox's write lock, and the retention sweep after this one has to be
      // able to run at all.
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) break
      const settled = await this.settle(send, 'unknown', {
        error: 'the server stopped while this send was in flight, so its outcome is unknown',
      })
      if (!settled) continue
      reaped += 1
      await this.reply(send, (w) => w.reaped)
      this.deps.log.warn('mail send reaped as unknown', {
        sendId: send.send_id, attemptedAt: send.attempted_at,
      })
    }
    return reaped
  }

  async list(query: { accountId?: string; draftId?: string; limit: number }): Promise<SendDto[]> {
    return (await this.deps.store.write.listSends(query)).map((row) => toSendDto(row))
  }

  async require(sendId: string): Promise<SendRow> {
    const row = await this.deps.store.write.getSend(sendId)
    if (!row) throw new MailServiceError('unknown_send', `No mail send "${sendId}".`, 404)
    return row
  }

  /**
   * The ledger row and the draft row move together, and the draft moves LAST on purpose.
   *
   * `false` means somebody else settled this row first, and then NOTHING else here may run: the
   * winner already wrote the draft's state, and overwriting it is how a delivered message ends up
   * displayed as `unknown`. The two callers (an attempt finishing, the reaper) can both reach one
   * row, so this is a real race and not a theoretical one.
   */
  private async settle(send: SendRow, state: SendState, outcome: {
    providerMessageId?: string
    error?: string
  }): Promise<boolean> {
    const changed = await this.deps.store.write.settleSend(
      send.send_id, state, { ...outcome, now: this.now },
    )
    if (changed === 0) {
      this.deps.log.info('mail send was already settled by somebody else, leaving it alone', {
        sendId: send.send_id, wanted: state,
      })
      return false
    }
    await this.setDraft(send.draft_id, state, outcome.error)
    this.deps.events.sendSettled(send.send_id, send.draft_id, state)
    return true
  }

  private async setDraft(draftId: string, state: string, error?: string): Promise<void> {
    await this.deps.store.write.setDraftState(draftId, state, this.now, error)
    const row = await this.deps.store.write.getDraft(draftId)
    if (row) this.deps.events.draftChanged(draftId, row.state, row.revision)
  }

  /**
   * Say what happened in the letter's own thread, when a letter is what approved this.
   *
   * A console send has no letter, and inventing one to report an outcome the console is already
   * watching would badge the bell for something the human is looking at.
   */
  private async reply(send: SendRow, note: MailApprovalNote): Promise<void> {
    if (send.approval_kind !== 'letter' || !send.approval_ref) return
    try {
      // In the user's letter language, from the approval letter's template.
      const markdown = note(MAIL_APPROVAL_WORDS[await walnutLetterLanguage()])
      await this.deps.letters.reply(send.approval_ref, { markdown, text: markdown })
    }
    catch (error) {
      // A thread reply is a courtesy; the send already happened or already failed, and the row is
      // the record. Failing here must not turn a settled send into an exception.
      this.deps.log.warn('mail send outcome could not be added to its letter', {
        sendId: send.send_id, letterId: send.approval_ref, error: reasonOf(error).slice(0, 200),
      })
    }
  }
}

export function toSendDto(row: SendRow): SendDto {
  return {
    sendId: row.send_id,
    draftId: row.draft_id,
    accountId: row.account_id,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    approvalKind: row.approval_kind === 'console' ? 'console' : 'letter',
    approvalRef: row.approval_ref ?? '',
    state: row.state as SendState,
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.attempted_at ? { attemptedAt: row.attempted_at } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
  }
}
