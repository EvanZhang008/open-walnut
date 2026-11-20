/**
 * The topics mail bridge: a person (or someone else's bot) outside Walnut takes part in a topic by
 * email.
 *
 * Outbound: one pass a minute mails each ACTIVE person member the messages after
 * `mail.lastSentMessageId`, exactly as each message's plan says (topic-wake.ts): at once when a
 * message lists that person in `mailNow` (the user's message to everyone, a mention by the user or
 * an agent; such a message starts a pass right away), else at most once per
 * `topic.mail.everyMinutes` (15 by default). A person's own message never mails anyone at once. A
 * mail that carries none of the user's own lines counts toward the person's round: after
 * PERSON_MAILS_PER_ROUND of them nothing more goes to that person until the user writes again, and
 * one walnut line says so (two bots that answer every mail would otherwise mail each other through
 * the user's mailbox forever, review 2026-11-20). Each message lists who a mail carrying it really
 * went to (`mailed`). Every mail goes through the mail plugin's one send path
 * (topic-mail-port.ts), so the user's Approvals switch decides whether a letter asks him first. A
 * pending person is never mailed: an outward send to a real person needs the user's own yes.
 *
 * Inbound: topic-mail-inbound.ts decides which arriving mail is a person's reply.
 *
 * Inert with the `topics` flag off, and on a follower; started and stopped with the flag
 * (topics-runtime.ts). On a test or ephemeral server it sends nothing (logged once) unless
 * WALNUT_TOPICS_MAIL_IN_TEST=1: a copy of the user's data holds his real accounts and people.
 */
import path from 'node:path'
import { createSubsystemLogger } from '../../logging/index.js'
import {
  onTopicMailArrivals, topicMailTransport,
  type TopicMailIncoming, type TopicMailSendOutcome, type TopicMailTransport,
} from './topic-mail-port.js'
import { createTopicMailState, lineKey, memberKey, pruneState, type TopicMailState } from './topic-mail-state.js'
import { claimTopicMail, postClaimedMail, type TopicMailClaim } from './topic-mail-inbound.js'
import { canonicalMessageId, topicMailBody, topicMailSubject } from './topic-mail-text.js'
import { authorName, MAIL_EVERY_MINUTES_DEFAULT, USER_FALLBACK_NAME, type Topic, type TopicMember, type TopicMessage } from './topics-model.js'

export const TOPIC_MAIL_PASS_MS = 60_000
export const FAILURE_LINE_AFTER = 3
/** Mails a person gets a round that carry none of the user's own lines; then none until he writes. */
export const PERSON_MAILS_PER_ROUND = 3
/** References carried on a mail: the last few sent to that person. */
const REFERENCES_KEPT = 10

/** What the bridge needs from the topics core (topics-store.ts); injected so tests run without it. */
export interface TopicMailCore {
  listTopics(): Promise<ReadonlyArray<{ id: string }>>
  readTopic(id: string): Promise<Topic | null | undefined>
  appendMemberMessage(topicId: string, memberId: string, text: string, via: 'mail'): Promise<unknown>
  updateMember(topicId: string, memberId: string, patch: { mail: NonNullable<TopicMember['mail']> }): Promise<unknown>
  registerTopicMessageListener(fn: (topic: Topic, message: TopicMessage) => void): (() => void) | void
  /** Appends one `walnut` system line; without it the bridge only logs what it would have said. */
  postSystemLine?(topicId: string, text: string): Promise<unknown>
  /** Records on these messages that a mail carrying them went to the member (`mailed`). */
  markMailed?(topicId: string, memberId: string, messageIds: readonly string[]): Promise<unknown>
}

export interface TopicMailBridgeDeps {
  core: TopicMailCore
  transport: () => TopicMailTransport | null
  state: TopicMailState
  /** The `topics` flag is on and this box is the leader. */
  isOn: () => Promise<boolean>
  /** How the user's own messages are signed in a mail. */
  ownerName: () => Promise<string>
  /** Why this server must send no mail (a test or ephemeral server), or null when it may. */
  heldReason?: () => string | null
  onArrivals?: typeof onTopicMailArrivals
  now?: () => number
  intervalMs?: number
  log?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void }
}

export interface TopicMailBridge {
  /** One outbound pass over every topic. */
  pass(): Promise<void>
  /**
   * Inbound: one poll's arrivals of one account. `onClaimed` gets the cache ids of the mail the
   * bridge takes (before any body is read), so the plugin keeps them from its router; it is always
   * called once, with none when nothing was taken or the run failed.
   */
  handleArrivals(accountId: string, load: () => Promise<TopicMailIncoming[]>, onClaimed?: (messageIds: string[]) => void): Promise<void>
  /** The core's message listener: a mention of a person starts a pass now. */
  onMessage(topic: Topic, message: TopicMessage): void
  start(): void
  stop(): void
}

const emailOf = (member: TopicMember): string => (member.ref.kind === 'person' ? member.ref.email : '')

const isActivePerson = (member: TopicMember): boolean => member.status === 'active' && !!emailOf(member)

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

export function createTopicMailBridge(deps: TopicMailBridgeDeps): TopicMailBridge {
  const now = deps.now ?? Date.now
  const log = deps.log ?? createSubsystemLogger('topic-mail')
  const subscribe = deps.onArrivals ?? onTopicMailArrivals
  let running: Promise<void> | null = null
  let again = false
  /** Members whose send failed in the current run (a pass and its reruns): never retried in it. */
  const failedThisRun = new Set<string>()
  let inbound: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | null = null
  let stops: Array<() => void> = []

  const postLine = async (topicId: string, text: string): Promise<void> => {
    if (!deps.core.postSystemLine) {
      log.warn('topic mail has no way to post a walnut line', { topicId, text })
      return
    }
    await deps.core.postSystemLine(topicId, text).catch((error) => log.warn('topic mail line not posted', { topicId, error: reason(error) }))
  }

  /** A line said once per key, ever (while the topic lives: pruneState). */
  const once = async (what: string, topicId: string, text: string): Promise<void> => {
    const key = lineKey(topicId, what)
    const fresh = await deps.state.update((state) => {
      if (state.lines.includes(key)) return false
      state.lines.push(key)
      return true
    })
    if (fresh) await postLine(topicId, text)
  }

  /** The messages this person has not been mailed: after the last one sent, else since they joined. */
  const unsentFor = (topic: Topic, member: TopicMember): TopicMessage[] => {
    const last = member.mail?.lastSentMessageId
    const at = last ? topic.messages.findIndex((one) => one.id === last) : -1
    if (at >= 0) return topic.messages.slice(at + 1)
    // The last one sent fell off the capped list: everything newer than that mail.
    const sentAt = Date.parse(member.mail?.lastSentAt ?? '')
    if (Number.isFinite(sentAt)) return topic.messages.filter((one) => (Date.parse(one.at) || 0) > sentAt)
    const joined = Date.parse(member.joinedAt ?? '') || 0
    return topic.messages.filter((one) => (Date.parse(one.at) || 0) >= joined)
  }

  /** The lines of `after` a mail to `member` carries: not its own, not Walnut's. */
  const mailLines = (member: TopicMember, after: readonly TopicMessage[]): TopicMessage[] =>
    after.filter((one) => one.author !== member.id && one.author !== 'walnut')

  /** The lines a mail up to `upto` carries (what unsentFor gives, cut at `upto`). */
  const batchUpTo = (topic: Topic, member: TopicMember, upto: string): TopicMessage[] => {
    const after = unsentFor(topic, member)
    const end = after.findIndex((one) => one.id === upto)
    return mailLines(member, end >= 0 ? after.slice(0, end + 1) : after)
  }

  /** A send settled: the member's mark moves to `upto`. `wentOut` false: it may have gone out (never marked as mailed). */
  const settle = async (topic: Topic, member: TopicMember, upto: string, messageId?: string, wentOut = true): Promise<void> => {
    // Read before the member's mark moves: the lines this mail carried.
    const batch = batchUpTo(topic, member, upto)
    const counts = batch.length > 0 && !batch.some((one) => one.author === 'human')
    const mail = {
      ...member.mail,
      lastSentAt: new Date(now()).toISOString(),
      lastSentMessageId: upto,
      ...(messageId ? { threadMessageId: messageId } : {}),
    }
    await deps.core.updateMember(topic.id, member.id, { mail })
    member.mail = mail
    await deps.state.update((state) => {
      const entry = (state.members[memberKey(topic.id, member.id)] ??= {})
      delete entry.pending
      entry.failures = 0
      entry.failureLine = false
      if (counts) {
        entry.roundMails = entry.round === topic.round.n ? (entry.roundMails ?? 0) + 1 : 1
        entry.round = topic.round.n
      }
      if (messageId) state.sent.push({ id: messageId, topicId: topic.id, memberId: member.id })
    })
    if (wentOut && batch.length && deps.core.markMailed) {
      await deps.core.markMailed(topic.id, member.id, batch.map((one) => one.id))
        .catch((error) => log.warn('topic mail could not record who was mailed', { topicId: topic.id, memberId: member.id, error: reason(error) }))
    }
  }

  const failed = async (topic: Topic, member: TopicMember, why: string): Promise<void> => {
    const say = await deps.state.update((state) => {
      const entry = (state.members[memberKey(topic.id, member.id)] ??= {})
      delete entry.pending
      entry.failures = (entry.failures ?? 0) + 1
      if (entry.failures < FAILURE_LINE_AFTER || entry.failureLine) return false
      entry.failureLine = true
      return true
    })
    failedThisRun.add(memberKey(topic.id, member.id))
    log.warn('topic mail send failed', { topicId: topic.id, memberId: member.id, error: why })
    if (say) {
      await postLine(topic.id, `Mail to ${member.name} failed ${FAILURE_LINE_AFTER} times (${why}). Walnut keeps trying every pass.`)
    }
  }

  /** Act on how a send ended. */
  const settleOutcome = async (
    topic: Topic, member: TopicMember, upto: string, outcome: TopicMailSendOutcome, t: TopicMailTransport,
  ): Promise<void> => {
    switch (outcome.state) {
      case 'sent':
        await settle(topic, member, upto, canonicalMessageId(outcome.messageId) || undefined)
        return
      case 'waiting':
        await deps.state.update((state) => {
          ;(state.members[memberKey(topic.id, member.id)] ??= {}).pending = { draftId: outcome.draftId, upto, at: new Date(now()).toISOString() }
        })
        return
      case 'unknown':
        // It may have gone out: never sent again. The user can check the account's Sent folder.
        await settle(topic, member, upto, undefined, false)
        await postLine(topic.id, `Walnut cannot tell whether the mail to ${member.name} went out; check the Sent folder of the mail account.`)
        return
      case 'discarded': {
        // The user said no to these lines: they are not offered again.
        const mail = { ...member.mail, lastSentMessageId: upto }
        await deps.core.updateMember(topic.id, member.id, { mail })
        member.mail = mail
        await deps.state.update((state) => { delete (state.members[memberKey(topic.id, member.id)] ??= {}).pending })
        return
      }
      case 'failed':
        if (outcome.draftId) await t.drop(outcome.draftId)
        await failed(topic, member, outcome.error || 'the mail server refused it')
        return
    }
  }

  const mailMember = async (
    topic: Topic, member: TopicMember, accountId: string, t: TopicMailTransport, owner: string,
  ): Promise<void> => {
    const key = memberKey(topic.id, member.id)
    if (failedThisRun.has(key)) return
    const pending = (await deps.state.read()).members[key]?.pending
    if (pending) {
      // A marker with no draft is an attempt a restart cut off: it may have gone out, so never twice.
      const outcome: TopicMailSendOutcome = pending.draftId
        ? await t.sendState(pending.draftId).catch(() => ({ draftId: pending.draftId, state: 'waiting' as const }))
        : { draftId: '', state: 'unknown' }
      if (outcome.state !== 'waiting') await settleOutcome(topic, member, pending.upto, outcome, t)
      return
    }
    const after = unsentFor(topic, member)
    const lines = mailLines(member, after)
    if (lines.length === 0) return
    // At once only what the plan said (mailNow); the rest waits for the schedule.
    const atOnce = lines.some((one) => one.mailNow?.includes(member.id))
    const every = (topic.mail?.everyMinutes ?? MAIL_EVERY_MINUTES_DEFAULT) * 60_000
    const lastAt = Date.parse(member.mail?.lastSentAt ?? '')
    if (!atOnce && Number.isFinite(lastAt) && now() - lastAt < every) return
    // The round's budget: a mail with none of the user's lines is the person's round; past it, nothing.
    if (!lines.some((one) => one.author === 'human')) {
      const entry = (await deps.state.read()).members[key]
      const used = entry?.round === topic.round.n ? entry.roundMails ?? 0 : 0
      if (used >= PERSON_MAILS_PER_ROUND) {
        const tell = await deps.state.update((state) => {
          const e = (state.members[key] ??= {})
          if (e.budgetTold === topic.round.n) return false
          e.budgetTold = topic.round.n
          return true
        })
        if (tell) await postLine(topic.id, `${member.name} got ${PERSON_MAILS_PER_ROUND} mails this round; nothing more is mailed to them until ${owner} writes again.`)
        return
      }
    }

    const upto = after[after.length - 1]!.id
    const sent = (await deps.state.read()).sent.filter((one) => one.topicId === topic.id && one.memberId === member.id)
    const thread = canonicalMessageId(member.mail?.threadMessageId)
    const references = [...new Set([...sent.map((one) => one.id), ...(thread ? [thread] : [])])].slice(-REFERENCES_KEPT)
    // The marker goes down first, so a restart in the middle of the send can never send twice.
    await deps.state.update((state) => {
      ;(state.members[key] ??= {}).pending = { draftId: '', upto, at: new Date(now()).toISOString() }
    })
    let outcome: TopicMailSendOutcome
    try {
      outcome = await t.send({
        accountId,
        to: { name: member.name, address: emailOf(member) },
        subject: topicMailSubject(topic.title, topic.id),
        text: topicMailBody(lines.map((one) => ({ name: authorName(topic, one.author, owner), text: one.text }))),
        ...(thread ? { inReplyTo: thread, references } : {}),
      })
    } catch (error) {
      // Refused before anything went out (no account, a draft the plugin would not take).
      await failed(topic, member, reason(error))
      return
    }
    await settleOutcome(topic, member, upto, outcome, t)
  }

  let toldHeld = false
  const passOnce = async (): Promise<void> => {
    if (!(await deps.isOn())) return
    const held = deps.heldReason?.() ?? null
    if (held) {
      if (!toldHeld) log.warn('topic mail is held: this server sends no mail (WALNUT_TOPICS_MAIL_IN_TEST=1 lets it)', { why: held })
      toldHeld = true
      return
    }
    const t = deps.transport()
    let accounts: Awaited<ReturnType<TopicMailTransport['accounts']>> | null = null
    let owner: string | null = null
    const listed = new Map<string, { closedAt?: string }>()
    for (const { id } of await deps.core.listTopics()) {
      listed.set(id, {})
      const topic = await deps.core.readTopic(id).catch(() => null)
      if (!topic) continue
      if (topic.closed?.at) listed.set(id, { closedAt: topic.closed.at })
      const persons = topic.members.filter(isActivePerson)
      if (persons.length === 0) continue
      const accountId = topic.mail?.accountId
      if (!accountId) {
        await once('no-account', topic.id, `No mail account is set for this topic, so ${persons.map((one) => one.name).join(', ')} get no mail.`)
        continue
      }
      if (!t) continue // the mail plugin is off or still starting: the next pass tries again
      accounts ??= await t.accounts().catch(() => [])
      const account = accounts.find((one) => one.accountId === accountId)
      if (!account?.canSend) {
        await once(`cannot-send:${accountId}`, topic.id, `The mail account ${account?.address || accountId} cannot send, so this topic's people get no mail.`)
        continue
      }
      owner ??= await deps.ownerName().catch(() => USER_FALLBACK_NAME)
      for (const member of persons) {
        try {
          await mailMember(topic, member, accountId, t, owner)
        } catch (error) {
          log.warn('topic mail pass could not finish a member', { topicId: topic.id, memberId: member.id, error: reason(error) })
        }
      }
    }
    // What belongs to topics gone or closed over a week goes (a write only when something does).
    if (pruneState(structuredClone(await deps.state.read()), listed, now())) {
      await deps.state.update((state) => { pruneState(state, listed, now()) })
    }
  }

  const pass = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await passOnce().catch((error) => log.warn('topic mail pass failed', { error: reason(error) }))
      } while (again)
    })().finally(() => {
      running = null
      failedThisRun.clear()
    })
    return running
  }

  const handleArrivals = (accountId: string, load: () => Promise<TopicMailIncoming[]>, onClaimed?: (messageIds: string[]) => void): Promise<void> => {
    const claimedIds: string[] = []
    let told = false
    const tell = (): void => { if (!told) { told = true; onClaimed?.(claimedIds) } }
    const run = inbound.then(async () => {
      if (!(await deps.isOn())) return
      const t = deps.transport()
      if (!t) return
      const inbound = { readTopic: deps.core.readTopic, appendMemberMessage: deps.core.appendMemberMessage, state: deps.state, log }
      // Claims first, from headers and state only: the plugin's router waits on this, never on a body read.
      const taken: Array<{ mail: TopicMailIncoming; claim: TopicMailClaim }> = []
      for (const raw of await load()) {
        const mail = { ...raw, accountId: raw.accountId || accountId }
        const claim = await claimTopicMail(mail, inbound)
          .catch((error): TopicMailClaim => { log.warn('topic mail reply not read', { accountId, error: reason(error) }); return { claimed: false, why: 'error' } })
        if (!claim.claimed) continue
        claimedIds.push(mail.messageId)
        taken.push({ mail, claim })
      }
      tell()
      for (const { mail, claim } of taken) {
        await postClaimedMail(mail, claim, t, inbound)
          .catch((error) => log.warn('topic mail reply not posted', { accountId, error: reason(error) }))
      }
    }).catch((error) => log.warn('topic mail arrivals not read', { accountId, error: reason(error) }))
      .finally(tell)
    inbound = run
    return run
  }

  /** A message whose plan mails an active person at once starts a pass now. */
  const onMessage = (topic: Topic, message: TopicMessage): void => {
    const atOnce = (message.mailNow ?? []).some((id) => topic.members.some((one) => one.id === id && isActivePerson(one)))
    if (atOnce) void pass()
  }

  return {
    pass,
    handleArrivals,
    onMessage,
    start() {
      if (timer) return
      timer = setInterval(() => { void pass() }, deps.intervalMs ?? TOPIC_MAIL_PASS_MS)
      timer.unref?.()
      stops.push(subscribe((accountId, load) => new Promise<string[]>((claimed) => { void handleArrivals(accountId, load, claimed) })))
      const off = deps.core.registerTopicMessageListener((topic, message) => onMessage(topic, message))
      if (typeof off === 'function') stops.push(off)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const off of stops.splice(0)) off()
      stops = []
    },
  }
}

/** Why this server's bridge sends no mail: a test or ephemeral server, unless WALNUT_TOPICS_MAIL_IN_TEST=1. */
export function topicMailHeldReason(throwaway: () => string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  return env.WALNUT_TOPICS_MAIL_IN_TEST === '1' ? null : throwaway()
}

let active: TopicMailBridge | null = null

/** Starts this server's one bridge on the real topics store and mail port (startup wiring calls it). */
export async function startTopicMailBridge(): Promise<TopicMailBridge> {
  if (active) return active
  const { WALNUT_HOME } = await import('../../constants.js')
  const { getConfig } = await import('../config-manager.js')
  const { isFollower } = await import('../server-role.js')
  const { throwawayServerReason } = await import('../remote-sync-isolation.js')
  const store = await import('./topics-store.js')
  const { walnutLine } = await import('./topics-model.js')
  active = createTopicMailBridge({
    core: {
      listTopics: store.listTopics,
      readTopic: store.readTopic,
      appendMemberMessage: store.appendMemberMessage,
      updateMember: store.updateMember,
      registerTopicMessageListener: store.registerTopicMessageListener,
      // A system line runs no delivery: appended under the topic's lock as the core does its own.
      postSystemLine: (topicId, text) => store.mutateTopic(topicId, (topic) => { topic.messages.push(walnutLine(text)) }),
      markMailed: (topicId, memberId, ids) => store.mutateTopic(topicId, (topic) => {
        const want = new Set(ids)
        for (const m of topic.messages) {
          if (!want.has(m.id) || m.mailed?.some((one) => one === memberId)) continue
          m.mailed = [...(m.mailed ?? []), memberId as TopicMember['id']]
        }
      }, { touch: false }),
    },
    transport: topicMailTransport,
    state: createTopicMailState(path.join(WALNUT_HOME, 'topic-mail', 'state.json')),
    isOn: async () => !isFollower() && (await store.topicsEnabled()),
    heldReason: () => topicMailHeldReason(throwawayServerReason),
    ownerName: async () => (await getConfig()).user?.name || USER_FALLBACK_NAME,
  })
  active.start()
  return active
}

export function stopTopicMailBridge(): void {
  active?.stop()
  active = null
}
