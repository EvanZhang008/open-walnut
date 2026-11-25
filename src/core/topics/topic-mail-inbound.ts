/**
 * The topics mail bridge, inbound: which arriving mail is a person's reply to post in a topic.
 *
 * Posted only when ALL hold (review 2026-11-20):
 *   - it arrived in the account the topic emails from (`topic.mail.accountId`);
 *   - its In-Reply-To or References name a mail the bridge sent to that same person, in that topic
 *     (the subject token alone, or a From alone, is not enough: anyone can write either);
 *   - it is from that person's address, an active member;
 *   - it is no automatic mail: `Auto-Submitted` other than "no", `Precedence` auto_reply, bulk, junk
 *     or list (an older responder's `X-Autoreply` / `X-Autorespond` arrives as auto-replied). Two
 *     bots answering every mail would otherwise mail each other through the user's mailbox;
 *   - it is not one of the bridge's own mails coming back (its Message-ID is one the bridge sent).
 * Each mail is posted once (keyed by account and Message-ID, kept on disk), with the quoted part
 * stripped. Authentication results are not read: the mail plugin's cache does not keep them.
 *
 * Two steps, so the mail plugin can keep a reply out of its router (review 2026-11-20: the same
 * reply was posted in the topic and, minutes later, routed to a member task as new mail): the
 * claim decides from the cache's headers and the bridge's own state alone (no body read, no
 * network), and the tap waits only for it; the post then reads the body and appends the line.
 * A mail claimed once (its key in `seen`) stays claimed when it comes by again. A claim the tap
 * no longer waited for is undone (releaseTopicMailClaims): the router has that mail then. A claimed
 * mail that cannot be posted (the topic closed, the person left, only quoted lines, a body that
 * cannot be read) goes back to the router (topic-mail.ts), so a claim never loses a mail.
 */
import type { TopicMailIncoming, TopicMailTransport } from './topic-mail-port.js'
import type { TopicMailState } from './topic-mail-state.js'
import { bareAddress, canonicalMessageId, stripQuotedReply } from './topic-mail-text.js'
import type { Topic, TopicMember } from './topics-model.js'
import { clause } from '../../utils/format.js'

const AUTOMATIC_PRECEDENCE = new Set(['auto_reply', 'bulk', 'junk', 'list'])

/** Whether these headers mark a mail as sent by a machine on its own (an auto-reply, a list, bulk). */
export function automaticMail(headers: TopicMailIncoming['bulkHeaders']): boolean {
  const auto = (headers?.autoSubmitted ?? '').trim().toLowerCase()
  if (auto && auto !== 'no') return true
  return AUTOMATIC_PRECEDENCE.has((headers?.precedence ?? '').trim().toLowerCase())
}

export interface TopicMailInboundDeps {
  readTopic(id: string): Promise<Topic | null | undefined>
  appendMemberMessage(topicId: string, memberId: string, text: string, via: 'mail'): Promise<unknown>
  state: TopicMailState
  log: { info(message: string, meta?: Record<string, unknown>): void; warn?(message: string, meta?: Record<string, unknown>): void }
}

const emailOf = (member: TopicMember): string => (member.ref.kind === 'person' ? member.ref.email : '')

/**
 * What the bridge makes of one arrival: not its mail (`why` says why), its mail already taken
 * (`seen`), or a reply it takes now for that topic and member. A claim is marked on disk first: a
 * reply posted twice is worse than one a crash lost.
 */
export type TopicMailClaim =
  | { claimed: false; why: string }
  | { claimed: true; seen: true }
  | { claimed: true; seen?: false; topicId: string; memberId: string; key: string }

/** Decides whether the bridge takes this mail; never throws for a bad mail. */
export async function claimTopicMail(mail: TopicMailIncoming, deps: TopicMailInboundDeps): Promise<TopicMailClaim> {
  const rfc = canonicalMessageId(mail.rfcMessageId)
  const seenKey = `${mail.accountId}|${rfc || `id:${mail.messageId}`}`
  const no = (why: string): TopicMailClaim => ({ claimed: false, why })
  const state = await deps.state.read()
  if (state.seen.includes(seenKey)) return { claimed: true, seen: true }
  if (rfc && state.sent.some((one) => one.id === rfc)) return no('own mail')
  if (automaticMail(mail.bulkHeaders)) {
    deps.log.info('topic mail ignored an automatic mail', { accountId: mail.accountId, ...mail.bulkHeaders })
    return no('automatic')
  }
  const replied = new Set([mail.inReplyTo, ...mail.references].map((one) => canonicalMessageId(one)).filter(Boolean))
  const answered = state.sent.filter((one) => replied.has(one.id))
  if (answered.length === 0) return no('not a reply')
  const from = bareAddress(mail.from)
  let target: { topic: Topic; member: TopicMember } | undefined
  for (const topicId of new Set(answered.map((one) => one.topicId))) {
    const topic = await deps.readTopic(topicId).catch(() => null)
    if (!topic || topic.mail?.accountId !== mail.accountId) continue
    const member = topic.members.find((one) => one.status === 'active' && !!emailOf(one) && bareAddress(emailOf(one)) === from
      && answered.some((s) => s.topicId === topicId && s.memberId === one.id))
    if (member) { target = { topic, member }; break }
  }
  if (!target) {
    deps.log.info('topic mail ignored a reply that answers no mail sent to its sender from this account', { accountId: mail.accountId })
    return no('not this person\'s reply')
  }
  const fresh = await deps.state.update((s) => {
    if (s.seen.includes(seenKey)) return false
    s.seen.push(seenKey)
    return true
  })
  if (!fresh) return { claimed: true, seen: true }
  return { claimed: true, topicId: target.topic.id, memberId: target.member.id, key: seenKey }
}

/** Undoes claims the tap no longer waited for: those mails were handed to the router, so they are not the topic's. */
export async function releaseTopicMailClaims(state: TopicMailState, claims: readonly TopicMailClaim[]): Promise<void> {
  const keys = new Set(claims.flatMap((one) => (one.claimed && !one.seen ? [one.key] : [])))
  if (keys.size === 0) return
  await state.update((s) => { s.seen = s.seen.filter((key) => !keys.has(key)) })
}

/**
 * Posts a claimed reply: its body without the quote. Never throws: answers why a claimed mail was
 * not posted (the caller hands it back to the router), or undefined when it was (or was posted before).
 */
export async function postClaimedMail(mail: TopicMailIncoming, claim: TopicMailClaim, t: TopicMailTransport, deps: TopicMailInboundDeps): Promise<string | undefined> {
  if (!claim.claimed || claim.seen) return undefined
  try {
    const text = stripQuotedReply(await t.bodyText(mail.accountId, mail.messageId))
    if (!text) return 'it held only quoted lines'
    await deps.appendMemberMessage(claim.topicId, claim.memberId, text, 'mail')
    return undefined
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200) || 'unknown error'
  }
}

/**
 * Posts one poll's claimed mails in order. One that cannot be posted gets one walnut line in its
 * topic (while the topic exists) and goes back to the mail router through the transport, so a
 * claimed mail is never lost (review 2026-11-20). Never throws.
 */
export async function postClaimedMails(
  taken: ReadonlyArray<{ mail: TopicMailIncoming; claim: TopicMailClaim }>,
  t: TopicMailTransport,
  deps: TopicMailInboundDeps & { postLine(topicId: string, text: string): Promise<void> },
): Promise<void> {
  for (const { mail, claim } of taken) {
    const why = await postClaimedMail(mail, claim, t, deps)
    if (!why || !claim.claimed || claim.seen) continue
    deps.log.warn?.('topic mail reply not posted; it goes back to the mail router', { accountId: mail.accountId, topicId: claim.topicId, error: why })
    const topic = await deps.readTopic(claim.topicId).catch(() => null)
    if (topic) {
      const name = topic.members.find((one) => one.id === claim.memberId)?.name || 'a person'
      await deps.postLine(topic.id, `A mail from ${name} could not be posted: ${clause(why)}.`).catch(() => undefined)
    }
    await t.handBack(mail.accountId, [mail.messageId]).catch(() => undefined)
  }
}
