/**
 * Meeting invites: where one stands on the calendar, and answering it from the reader.
 *
 * The base owns no calendar. It hands the provider the CACHED message (subject, sender, kind) and
 * relays what the provider's calendar says, capped, because every string in it was written by
 * whoever sent the invite. Three rules shape this file:
 *
 * - An answer is a write the organizer sees, so one invite has at most ONE answer in flight. A
 *   double click, or a second tab, gets a 409 rather than a second RSVP racing the first.
 * - Nothing is cached here. The calendar is the truth and changes without the mail changing (an
 *   answer from the phone, a moved meeting), so every open asks; a provider may cache briefly.
 * - A message the listing never called an invite is refused before the provider is asked, so the
 *   route cannot be used to point a calendar write at an ordinary mail.
 */
import { callProvider, MailServiceError } from './contract.js'
import type { MailService } from './service.js'
import type {
  MailAddress,
  MailInviteDetails,
  MailInviteRequest,
  MailInviteResponse,
  MailProviderSpec,
} from './types.js'

/**
 * A calendar read is one provider call; a cold helper spawn plus a large month view fits in this.
 * Above the provider's own read timeout, so the provider's words win over a generic one.
 */
export const INVITE_READ_DEADLINE_MS = 30_000
/**
 * An answer is a FRESH calendar read and then the write, each under the provider's own timeout. The
 * deadline covers both: one that fired while the write still ran would release the in-flight lock
 * and let a second click race the first answer to the organizer.
 */
export const INVITE_ANSWER_DEADLINE_MS = 60_000

const TEXT_CAP = 300
const NAME_CAP = 200

const RESPONSES = new Set<MailInviteResponse>(['accept', 'tentative', 'decline'])
const STATES = new Set<MailInviteDetails['state']>(['open', 'canceled', 'not-found'])
const ANSWERS = new Set<NonNullable<MailInviteDetails['response']>>([
  'none', 'accepted', 'tentative', 'declined', 'organizer',
])

export function isInviteResponse(value: unknown): value is MailInviteResponse {
  return typeof value === 'string' && RESPONSES.has(value as MailInviteResponse)
}

function capped(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, cap) : undefined
}

function instant(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function address(value: unknown): MailAddress | undefined {
  const shaped = value as { name?: unknown; address?: unknown } | null | undefined
  const name = capped(shaped?.name, NAME_CAP)
  const addr = capped(shaped?.address, NAME_CAP) ?? ''
  return name || addr ? { ...(name ? { name } : {}), address: addr } : undefined
}

/**
 * A provider's answer, reduced to fields a console can render safely.
 *
 * `canRespond` is forced false for anything that is not `open`, and a false one always carries a
 * reason, so the reader never shows disabled buttons it cannot explain.
 */
export function inviteDetailsDto(raw: unknown): MailInviteDetails {
  const shaped = (raw ?? {}) as Record<string, unknown>
  const state = STATES.has(shaped.state as MailInviteDetails['state'])
    ? shaped.state as MailInviteDetails['state']
    : 'not-found'
  const start = instant(shaped.start)
  const end = instant(shaped.end)
  const response = ANSWERS.has(shaped.response as NonNullable<MailInviteDetails['response']>)
    ? shaped.response as MailInviteDetails['response']
    : undefined
  const organizer = address(shaped.organizer)
  const canRespond = state === 'open' && shaped.canRespond === true && response !== 'organizer'
  const reason = capped(shaped.reason, TEXT_CAP)
    ?? (canRespond ? undefined : fallbackReason(state, response))
  return {
    state,
    ...(capped(shaped.subject, TEXT_CAP) ? { subject: capped(shaped.subject, TEXT_CAP)! } : {}),
    ...(start ? { start } : {}),
    ...(end && (!start || end >= start) ? { end } : {}),
    ...(shaped.allDay === true ? { allDay: true } : {}),
    ...(capped(shaped.location, TEXT_CAP) ? { location: capped(shaped.location, TEXT_CAP)! } : {}),
    ...(organizer ? { organizer } : {}),
    ...(response ? { response } : {}),
    ...(shaped.recurring === true ? { recurring: true } : {}),
    canRespond,
    ...(reason && !canRespond ? { reason } : {}),
  }
}

function fallbackReason(state: MailInviteDetails['state'], response: MailInviteDetails['response']): string {
  if (state === 'canceled') return 'This meeting was canceled.'
  if (state === 'not-found') return 'Walnut could not find this meeting on your calendar. Answer it in your mail app.'
  if (response === 'organizer') return 'This is your own meeting.'
  return 'This invite cannot be answered from Walnut. Answer it in your mail app.'
}

export class MailInvites {
  /** `<account>\u0000<message>` -> the answer in flight. One per invite, never two. */
  private readonly answering = new Map<string, MailInviteResponse>()

  constructor(private readonly deps: {
    service: MailService
    log?: { info(message: string, fields?: Record<string, unknown>): void }
  }) {}

  /**
   * The calendar's answer, plus the answer still being sent, when there is one: a reader reopened
   * while its own click is in flight would otherwise show the OLD answer and invite a second click.
   */
  async details(accountId: string, messageId: string): Promise<MailInviteDetails & { answering?: MailInviteResponse }> {
    const { spec, request } = await this.prepare(accountId, messageId)
    if (!spec.inviteDetails) throw this.unsupported(spec)
    const answer = await callProvider(
      'a meeting invite',
      () => spec.inviteDetails!(accountId, request),
      INVITE_READ_DEADLINE_MS,
    )
    const sending = this.answering.get(`${accountId}\u0000${request.messageId}`)
    return { ...inviteDetailsDto(answer), ...(sending ? { answering: sending } : {}) }
  }

  async respond(accountId: string, messageId: string, response: unknown): Promise<MailInviteDetails> {
    if (!isInviteResponse(response)) {
      throw new MailServiceError('invalid', 'response must be accept, tentative or decline', 400)
    }
    const { spec, request } = await this.prepare(accountId, messageId)
    if (!spec.respondToInvite) throw this.unsupported(spec)
    const key = `${accountId}\u0000${request.messageId}`
    if (this.answering.has(key)) {
      throw new MailServiceError('in-flight', 'Walnut is still sending your answer to this invite.', 409)
    }
    this.answering.set(key, response)
    try {
      const answered = await callProvider(
        'an answer to a meeting invite',
        () => spec.respondToInvite!(accountId, request, response),
        INVITE_ANSWER_DEADLINE_MS,
      ).then(inviteDetailsDto)
      this.deps.log?.info('mail invite answered', { accountId, messageId: request.messageId, response })
      return answered
    } finally {
      this.answering.delete(key)
    }
  }

  private async prepare(accountId: string, messageId: string): Promise<{
    spec: MailProviderSpec
    request: MailInviteRequest
  }> {
    const subject = await this.deps.service.inviteSubject(accountId, messageId)
    const spec = this.deps.service.provider(accountId)
    if (!spec.capabilities.rsvp) throw this.unsupported(spec)
    if (!subject.kind) {
      throw new MailServiceError('not-an-invite', 'This message is not a meeting invite.', 409)
    }
    return {
      spec,
      request: {
        messageId: subject.messageId,
        subject: subject.subject,
        from: subject.from,
        sentAt: subject.sentAt,
        kind: subject.kind,
      },
    }
  }

  private unsupported(spec: MailProviderSpec): MailServiceError {
    return new MailServiceError(
      'unsupported',
      `This account cannot answer meeting invites from Walnut (${spec.label}).`,
      409,
    )
  }
}
