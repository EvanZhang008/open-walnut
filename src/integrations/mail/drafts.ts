/**
 * Drafts: rows, versioned by `revision`, and the validation that decides one is sendable.
 *
 * The rule that shapes the file: a draft is DATA, and every decision about it is made from the
 * stored row rather than from the request that arrived. That is not tidiness. The approval
 * letter is rendered from the row, the approval is minted against the row's revision, and the
 * outgoing mail is built from the row, so a request body that says something different from
 * what is on disk can never be the thing that gets sent.
 *
 * `revision` is the only mechanism behind "an edit invalidates an approval". It increments on
 * every edit, the frozen state records the revision it froze, and the one `UPDATE` that mints
 * an approval names that revision. Nothing here may bump a revision without also clearing the
 * approval state, which is why the edit is a single statement in `store.ts`.
 */
import {
  MailServiceError,
  type DraftDto,
  type DraftOrigin,
  type DraftState,
} from './contract.js'
import type { DraftRow, MailStore } from './store.js'
import { EDITABLE_DRAFT_STATES } from './store-write.js'
import type { MailAddress } from './types.js'

/** States a draft may be offered for approval from. See the note on `unknown` below. */
export const REQUESTABLE_DRAFT_STATES = ['composing', 'failed', 'unknown'] as const

/** Recipients per field. A draft is a message, not a mailing list run. */
const MAX_RECIPIENTS = 100

/** Enough for a long mail and far under the letter's own body cap. */
const MAX_BODY_CHARS = 200_000
const MAX_SUBJECT_CHARS = 1_000

interface DraftPayload {
  cc?: MailAddress[]
  bcc?: MailAddress[]
  references?: string[]
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T }
  catch { return fallback }
}

function invalid(message: string): MailServiceError {
  return new MailServiceError('invalid', message, 400)
}

/**
 * One address, checked just enough to be worth putting in front of a human.
 *
 * Deliberately NOT an RFC 5322 validator: that grammar accepts things no mail server will and
 * rejects things some will, and the transport is the authority either way. What is checked is
 * what makes the approval letter honest (a name and an address, no newline that could forge a
 * header) and what makes an obvious typo fail here rather than after the human approved it.
 */
function normalizeAddress(raw: unknown, field: string): MailAddress {
  const value = raw as { name?: unknown; address?: unknown } | string | null
  const address = (typeof value === 'string' ? value : String(value?.address ?? '')).trim()
  const name = typeof value === 'object' && value && typeof value.name === 'string'
    ? value.name.trim()
    : ''
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw invalid(`"${address}" in ${field} is not an email address Walnut can send to.`)
  }
  // A CR or LF in a display name is header injection: it would let a draft add its own Bcc.
  if (/[\r\n]/.test(name)) throw invalid(`the display name in ${field} may not contain a line break`)
  return { ...(name ? { name } : {}), address }
}

function normalizeAddressList(raw: unknown, field: string): MailAddress[] {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length > MAX_RECIPIENTS) {
    throw invalid(`${field} has ${list.length} recipients, over the ${MAX_RECIPIENTS} cap`)
  }
  return list.map((one) => normalizeAddress(one, field))
}

function text(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw : ''
  if (value.length > max) throw invalid(`${field} is over the ${max} character cap`)
  // A subject spanning lines is header injection, same as a display name.
  return field === 'subject' ? value.replace(/[\r\n]+/g, ' ').trim() : value
}

/** `Re:` once, whatever the original already carried. */
export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`.trim()
}

/**
 * The reply headers, from the CACHED message rather than from the request.
 *
 * `References` is the chain plus the message being answered, `In-Reply-To` is that message
 * alone. Building it from the request would let a caller aim a reply into a thread it never
 * read, and the cache already has the headers the poll stored.
 */
export function replyHeaders(target: {
  rfcMessageId: string
  references?: string[]
}): { inReplyTo: string; references: string[] } {
  const chain = [...(target.references ?? [])]
  if (target.rfcMessageId && !chain.includes(target.rfcMessageId)) chain.push(target.rfcMessageId)
  return { inReplyTo: target.rfcMessageId, references: chain }
}

/** Just the one emit this file makes, so a test can hand over a two-line fake. */
export interface DraftEvents {
  draftChanged(draftId: string, state: string, revision: number): void
}

export class MailDrafts {
  constructor(private readonly deps: {
    store: MailStore
    events: DraftEvents
    now?: () => number
  }) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async create(input: {
    accountId: string
    to: unknown
    cc?: unknown
    bcc?: unknown
    subject: unknown
    bodyMarkdown: unknown
    origin?: unknown
    sessionId?: unknown
    /** Copied from the cached message when this is a reply. */
    reply?: { inReplyTo: string; references: string[]; subject: string }
  }): Promise<DraftDto> {
    const to = normalizeAddressList(input.to, 'to')
    const cc = normalizeAddressList(input.cc, 'cc')
    const bcc = normalizeAddressList(input.bcc, 'bcc')
    const subject = input.reply
      ? replySubject(text(input.subject, 'subject', MAX_SUBJECT_CHARS) || input.reply.subject)
      : text(input.subject, 'subject', MAX_SUBJECT_CHARS)
    const bodyMarkdown = text(input.bodyMarkdown, 'bodyMarkdown', MAX_BODY_CHARS)
    const origin: DraftOrigin = input.origin === 'agent' ? 'agent' : 'console'
    const draftId = `dr-${this.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const payload: DraftPayload = {
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(input.reply?.references.length ? { references: input.reply.references } : {}),
    }

    await this.deps.store.write.insertDraft({
      draftId,
      accountId: input.accountId,
      inReplyTo: input.reply?.inReplyTo ?? null,
      toJson: JSON.stringify(to),
      subject,
      bodyMd: bodyMarkdown,
      origin,
      createdBySession: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
      payload: JSON.stringify(payload),
      now: this.now,
    })
    const dto = this.toDto(await this.require(draftId))
    this.deps.events.draftChanged(dto.draftId, dto.state, dto.revision)
    return dto
  }

  async get(draftId: string): Promise<DraftDto> {
    return this.toDto(await this.require(draftId))
  }

  async list(query: { accountId?: string; state?: string; limit: number }): Promise<DraftDto[]> {
    return (await this.deps.store.write.listDrafts(query)).map((row) => this.toDto(row))
  }

  /**
   * Apply an edit: the fields, `revision + 1`, back to `composing`, in ONE statement.
   *
   * Every field the caller did not send keeps its stored value, so a partial PATCH cannot blank
   * a recipient list by omission. The caller is responsible for withdrawing the outstanding
   * letter afterwards; this returns the row it had BEFORE the edit so the caller knows which
   * letter that was.
   */
  async patch(draftId: string, patch: Record<string, unknown>): Promise<{
    draft: DraftDto
    previousLetterId?: string
    wasPendingApproval: boolean
  }> {
    const row = await this.require(draftId)
    if (!(EDITABLE_DRAFT_STATES as readonly string[]).includes(row.state)) {
      throw new MailServiceError(
        'invalid',
        `A draft in "${row.state}" cannot be edited: the message is already on its way or gone.`,
        409,
      )
    }
    const stored = parseJson<DraftPayload>(row.payload, {})
    const to = patch.to === undefined ? this.addresses(row) : normalizeAddressList(patch.to, 'to')
    const cc = patch.cc === undefined ? stored.cc ?? [] : normalizeAddressList(patch.cc, 'cc')
    const bcc = patch.bcc === undefined ? stored.bcc ?? [] : normalizeAddressList(patch.bcc, 'bcc')
    const subject = patch.subject === undefined
      ? row.subject
      : text(patch.subject, 'subject', MAX_SUBJECT_CHARS)
    const bodyMarkdown = patch.bodyMarkdown === undefined
      ? row.body_md
      : text(patch.bodyMarkdown, 'bodyMarkdown', MAX_BODY_CHARS)

    const changed = await this.deps.store.write.patchDraft(draftId, {
      toJson: JSON.stringify(to),
      subject,
      bodyMd: bodyMarkdown,
      payload: JSON.stringify({
        ...stored,
        ...(cc.length ? { cc } : { cc: undefined }),
        ...(bcc.length ? { bcc } : { bcc: undefined }),
      }),
      now: this.now,
    })
    if (changed === 0) {
      // The state moved between the read and the write: something approved or discarded this
      // draft while the edit was being built, and the edit must not win that race.
      throw new MailServiceError('stale', `Draft ${draftId} changed while it was being edited.`, 409)
    }
    const draft = this.toDto(await this.require(draftId))
    this.deps.events.draftChanged(draft.draftId, draft.state, draft.revision)
    return {
      draft,
      ...(row.letter_id ? { previousLetterId: row.letter_id } : {}),
      wasPendingApproval: row.state === 'pending_approval',
    }
  }

  /**
   * Discard. Refused for a draft mid-flight or already sent.
   *
   * `sending` and `sent` are the two states where the row is a SEND's own record: throwing it
   * away would leave a ledger entry pointing at nothing, and for `sending` it would also lose
   * the only thing that tells the reaper what to settle.
   */
  async discard(draftId: string): Promise<{ draft: DraftDto; previousLetterId?: string }> {
    const row = await this.require(draftId)
    const changed = await this.deps.store.write.discardDraft(draftId, this.now)
    if (changed === 0 && row.state !== 'discarded') {
      throw new MailServiceError(
        'invalid',
        `A draft in "${row.state}" cannot be discarded: it is being sent or has already been sent.`,
        409,
      )
    }
    const draft = this.toDto(await this.require(draftId))
    if (changed > 0) this.deps.events.draftChanged(draft.draftId, draft.state, draft.revision)
    return {
      draft,
      ...(row.letter_id ? { previousLetterId: row.letter_id } : {}),
    }
  }

  /**
   * Everything that must be true before a human is asked to approve a send.
   *
   * Checked HERE, before the letter exists, because a letter whose Send button fails is worse
   * than a refusal: the human has already decided, and the failure arrives as a surprise in a
   * thread reply. `unknown` is on the requestable list on purpose: the automated retry route
   * refuses it (the mail may have gone), but a human who read "check the Sent folder", found
   * nothing, and asked again is making a deliberate decision the base should not block.
   */
  assertSendable(
    row: DraftRow,
    capabilities: { send: boolean },
    /** The console's own Send may also start from a draft that already has a letter out. */
    allowedStates: readonly string[] = REQUESTABLE_DRAFT_STATES,
  ): void {
    if (!allowedStates.includes(row.state)) {
      throw new MailServiceError(
        'invalid',
        `A draft in "${row.state}" is not waiting to be sent.`,
        409,
      )
    }
    if (this.addresses(row).length === 0) {
      throw invalid('a draft needs at least one recipient in `to` before it can be sent')
    }
    if (!row.subject.trim() && !row.body_md.trim()) {
      throw invalid('a draft needs a subject or a body before it can be sent')
    }
    if (!capabilities.send) {
      throw new MailServiceError(
        'unsupported',
        `The account "${row.account_id}" has no outgoing mail configured, so Walnut cannot send `
        + 'from it. Add the SMTP settings to the account and try again.',
        409,
      )
    }
  }

  async require(draftId: string): Promise<DraftRow> {
    const row = await this.deps.store.write.getDraft(draftId)
    if (!row) throw new MailServiceError('unknown_draft', `No mail draft "${draftId}".`, 404)
    return row
  }

  addresses(row: DraftRow): MailAddress[] {
    return parseJson<MailAddress[]>(row.to_json, [])
  }

  toDto(row: DraftRow): DraftDto {
    const payload = parseJson<DraftPayload>(row.payload, {})
    return {
      draftId: row.draft_id,
      accountId: row.account_id,
      to: this.addresses(row),
      cc: payload.cc ?? [],
      bcc: payload.bcc ?? [],
      subject: row.subject,
      bodyMarkdown: row.body_md,
      ...(row.in_reply_to ? { inReplyTo: row.in_reply_to } : {}),
      ...(payload.references?.length ? { references: payload.references } : {}),
      revision: row.revision,
      state: row.state as DraftState,
      origin: (row.origin === 'agent' ? 'agent' : 'console') as DraftOrigin,
      ...(row.created_by_session ? { createdBySession: row.created_by_session } : {}),
      ...(row.letter_id ? { letterId: row.letter_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.error ? { error: row.error } : {}),
    }
  }
}
