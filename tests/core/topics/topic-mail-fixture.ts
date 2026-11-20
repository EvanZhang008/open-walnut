/**
 * Shared fixtures of the topics mail bridge tests: an in-memory topics core and a fake mail
 * transport. Nothing here reaches a mailbox or a mail server. Addresses are example.com / example.org only.
 */
import { afterEach, beforeEach, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopicMailBridge, type TopicMailBridge, type TopicMailCore } from '../../../src/core/topics/topic-mail.js'
import { MAIL_EVERY_MINUTES_DEFAULT as DEFAULT_EVERY_MINUTES, freshRound, type Topic, type TopicMessage } from '../../../src/core/topics/topics-model.js'
import { createTopicMailState } from '../../../src/core/topics/topic-mail-state.js'
import { planDelivery } from '../../../src/core/topics/topic-wake.js'
import type { TopicMailIncoming, TopicMailOutgoing, TopicMailSendOutcome, TopicMailTransport } from '../../../src/core/topics/topic-mail-port.js'

export const TOPIC = 'tp-0123456789ab'
export const ADA = 'mb-0000000a'
export const BOB = 'mb-0000000b'
export const AGENT = 'mb-0000000c'
export const ACCOUNT = 'fake:walnut'
export const T0 = Date.parse('2026-11-20T10:00:00.000Z')

/** The test clock and this test's state file; reset before each test (useMailTestEnv). */
export const env = { clock: T0, dir: '', stateFile: '' }

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// Only the fields the bridge reads; the rest of a Topic is the core's.
export function makeTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: TOPIC,
    title: 'Launch plan',
    mail: { accountId: ACCOUNT, everyMinutes: DEFAULT_EVERY_MINUTES },
    members: [
      { id: AGENT, ref: { kind: 'task', name: 'Planner' }, name: 'Planner', status: 'active', joinedAt: iso(T0 - 60_000) },
      { id: ADA, ref: { kind: 'person', name: 'Ada', email: 'Ada@Example.com' }, name: 'Ada', status: 'active', joinedAt: iso(T0 - 60_000) },
      { id: BOB, ref: { kind: 'person', name: 'Bob', email: 'bob@example.com' }, name: 'Bob', status: 'pending', joinedAt: iso(T0 - 60_000) },
    ],
    messages: [],
    round: freshRound(0, iso(T0 - 60_000)),
    ...over,
  } as unknown as Topic
}

export function fakeCore(topic: Topic) {
  const posted: Array<{ topicId: string; memberId: string; text: string; via: string }> = []
  const lines: string[] = []
  let listener: ((topic: Topic, message: TopicMessage) => void) | undefined
  let n = 0
  const add = (author: string, text: string, mentions: string[] = []): TopicMessage => {
    const message = { via: 'ui', id: `tpm-${String(++n).padStart(12, '0')}`, at: iso(env.clock), author, text, mentions } as TopicMessage
    if (author !== 'walnut') {
      const plan = planDelivery(topic, message)
      if (plan.mail.length) message.toMail = plan.mail
      if (plan.mailNow.length) message.mailNow = plan.mailNow
      topic.round = plan.round
    }
    topic.messages.push(message)
    return message
  }
  const core: TopicMailCore = {
    listTopics: async () => [{ id: topic.id }],
    readTopic: async (id) => (id === topic.id ? structuredClone(topic) : null),
    appendMemberMessage: async (topicId, memberId, text, via) => {
      posted.push({ topicId, memberId, text, via })
      add(memberId, text)
    },
    updateMember: async (_topicId, memberId, patch) => {
      const member = topic.members.find((one) => one.id === memberId)!
      member.mail = { ...patch.mail }
    },
    registerTopicMessageListener: (fn) => {
      listener = fn
      return () => { listener = undefined }
    },
    postSystemLine: async (_topicId, text) => {
      lines.push(text)
      add('walnut', text)
    },
    markMailed: async (_topicId, memberId, ids) => {
      for (const m of topic.messages) if (ids.includes(m.id) && !m.mailed?.includes(memberId as never)) m.mailed = [...(m.mailed ?? []), memberId as never]
    },
  }
  return { core, posted, lines, add, emit: (message: TopicMessage) => listener?.(topic, message), hasListener: () => !!listener }
}

export function fakeTransport() {
  const sent: TopicMailOutgoing[] = []
  const dropped: string[] = []
  const states = new Map<string, TopicMailSendOutcome>()
  const bodies = new Map<string, string>()
  const bodyReads: string[] = []
  const handedBack: string[] = []
  const control = { mode: 'sent' as 'sent' | 'waiting' | 'failed' | 'throw' }
  let n = 0
  const transport: TopicMailTransport = {
    accounts: async () => [{ accountId: ACCOUNT, address: 'walnut@example.org', canSend: true }],
    send: async (mail) => {
      sent.push(structuredClone(mail))
      n += 1
      const draftId = `dr-${n}`
      if (control.mode === 'throw') throw new Error('connection refused')
      const outcome: TopicMailSendOutcome = control.mode === 'sent'
        ? { draftId, state: 'sent', messageId: `<walnut-${n}@example.org>` }
        : control.mode === 'failed' ? { draftId, state: 'failed', error: '550 mailbox unavailable' } : { draftId, state: 'waiting' }
      states.set(draftId, outcome)
      return outcome
    },
    sendState: async (draftId) => states.get(draftId) ?? { draftId, state: 'discarded' },
    drop: async (draftId) => { dropped.push(draftId) },
    bodyText: async (_accountId, messageId) => {
      bodyReads.push(messageId)
      return bodies.get(messageId) ?? ''
    },
    handBack: async (_accountId, messageIds) => { handedBack.push(...messageIds) },
  }
  return { transport, sent, dropped, states, bodies, bodyReads, handedBack, control }
}

export const quiet = { info: () => undefined, warn: () => undefined }

export function setup(over: { topic?: Partial<Topic>; on?: boolean } = {}) {
  const topic = makeTopic(over.topic)
  const core = fakeCore(topic)
  const mail = fakeTransport()
  const flag = { on: over.on ?? true }
  const make = (): TopicMailBridge => createTopicMailBridge({
    core: core.core,
    transport: () => mail.transport,
    state: createTopicMailState(env.stateFile),
    isOn: async () => flag.on,
    ownerName: async () => 'Owner',
    now: () => env.clock,
    log: quiet,
  })
  return { topic, ...core, mail, flag, bridge: make(), make }
}

export function ada(topic: Topic) {
  return topic.members.find((one) => one.id === ADA)!
}

/** Registers the per-test clock and temp state dir; call once at the top of a test file. */
export function useMailTestEnv(): void {
  beforeEach(async () => {
    env.clock = T0
    env.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-mail-test-'))
    env.stateFile = path.join(env.dir, 'topic-mail', 'state.json')
  })
  afterEach(async () => {
    await fs.rm(env.dir, { recursive: true, force: true })
  })
}

export function reply(over: Partial<TopicMailIncoming> = {}): TopicMailIncoming {
  return {
    accountId: ACCOUNT,
    messageId: 'msg-1',
    rfcMessageId: '<reply-1@example.com>',
    from: 'Ada Lovelace <ADA@example.COM>',
    subject: 'Re: Launch plan [topic tp-0123456789ab]',
    inReplyTo: '<walnut-1@example.org>',
    references: [],
    ...over,
  }
}

/** One mail sent to Ada (<walnut-1@example.org>), so a reply has something to answer. */
export async function mailedAda(s: ReturnType<typeof setup>): Promise<void> {
  s.add('human', 'Kickoff')
  await s.bridge.pass()
  expect(s.mail.sent[0]?.to.address).toBe('Ada@Example.com')
}
