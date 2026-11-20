/**
 * The topics mail bridge with an in-memory topics core and a fake mail transport: nothing here
 * reaches a mailbox or a mail server. Addresses are example.com / example.org only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopicMailBridge, type TopicMailBridge, type TopicMailCore } from '../../../src/core/topics/topic-mail.js'
import { MAIL_EVERY_MINUTES_DEFAULT as DEFAULT_EVERY_MINUTES, type Topic, type TopicMessage } from '../../../src/core/topics/topics-model.js'
import { createTopicMailState } from '../../../src/core/topics/topic-mail-state.js'
import {
  topicMailArrivals, topicMailListening,
  type TopicMailIncoming, type TopicMailOutgoing, type TopicMailSendOutcome, type TopicMailTransport,
} from '../../../src/core/topics/topic-mail-port.js'
import { TOPIC_MAIL_FOOTER } from '../../../src/core/topics/topic-mail-text.js'

const TOPIC = 'tp-0123456789ab'
const ADA = 'mb-0000000a'
const BOB = 'mb-0000000b'
const AGENT = 'mb-0000000c'
const ACCOUNT = 'fake:walnut'
const T0 = Date.parse('2026-11-20T10:00:00.000Z')

let clock = T0
let dir = ''
let stateFile = ''

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// Only the fields the bridge reads; the rest of a Topic is the core's.
function makeTopic(over: Partial<Topic> = {}): Topic {
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
    ...over,
  } as unknown as Topic
}

function fakeCore(topic: Topic) {
  const posted: Array<{ topicId: string; memberId: string; text: string; via: string }> = []
  const lines: string[] = []
  let listener: ((topic: Topic, message: TopicMessage) => void) | undefined
  let n = 0
  const add = (author: string, text: string, mentions: string[] = []): TopicMessage => {
    const message = { via: 'ui', id: `tpm-${String(++n).padStart(4, '0')}`, at: iso(clock), author, text, mentions }
    topic.messages.push(message as TopicMessage)
    return message as TopicMessage
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
  }
  return { core, posted, lines, add, emit: (message: TopicMessage) => listener?.(topic, message), hasListener: () => !!listener }
}

function fakeTransport() {
  const sent: TopicMailOutgoing[] = []
  const dropped: string[] = []
  const states = new Map<string, TopicMailSendOutcome>()
  const bodies = new Map<string, string>()
  const bodyReads: string[] = []
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
  }
  return { transport, sent, dropped, states, bodies, bodyReads, control }
}

const quiet = { info: () => undefined, warn: () => undefined }

function setup(over: { topic?: Partial<Topic>; on?: boolean } = {}) {
  const topic = makeTopic(over.topic)
  const core = fakeCore(topic)
  const mail = fakeTransport()
  const flag = { on: over.on ?? true }
  const make = (): TopicMailBridge => createTopicMailBridge({
    core: core.core,
    transport: () => mail.transport,
    state: createTopicMailState(stateFile),
    isOn: async () => flag.on,
    ownerName: async () => 'Owner',
    now: () => clock,
    log: quiet,
  })
  return { topic, ...core, mail, flag, bridge: make(), make }
}

function ada(topic: Topic) {
  return topic.members.find((one) => one.id === ADA)!
}

beforeEach(async () => {
  clock = T0
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-mail-test-'))
  stateFile = path.join(dir, 'topic-mail', 'state.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('outbound schedule', () => {
  it('mails the first new messages at the first pass, then nothing when nothing is new', async () => {
    const s = setup()
    s.add('human', 'Kickoff: who takes the API?')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(s.mail.sent[0]!.to).toEqual({ name: 'Ada', address: 'Ada@Example.com' })
    await s.bridge.pass()
    clock += 60 * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
  })

  it('waits everyMinutes between mails unless a message mentions the person', async () => {
    const s = setup()
    s.add('human', 'First line')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)

    clock += 60_000
    s.add(AGENT, 'An update nobody is called on')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)

    clock += 2 * 60_000
    s.add(AGENT, '@Ada can you check the numbers?', [ADA])
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    // The mention mail carries every unsent line, the quiet one included.
    expect(s.mail.sent[1]!.text).toContain('Planner: An update nobody is called on')
    expect(s.mail.sent[1]!.text).toContain('Planner: @Ada can you check the numbers?')

    clock += 60_000
    s.add(AGENT, 'Another quiet update')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    clock += DEFAULT_EVERY_MINUTES * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(3)
  })

  it('honours a topic-specific everyMinutes', async () => {
    const s = setup({ topic: { mail: { accountId: ACCOUNT, everyMinutes: 5 } } })
    s.add('human', 'one')
    await s.bridge.pass()
    clock += 4 * 60_000
    s.add('human', 'two')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    clock += 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
  })

  it('a message that mentions a person starts a pass at once', async () => {
    const s = setup()
    s.bridge.start()
    try {
      s.add('human', 'earlier line')
      await s.bridge.pass()
      clock += 60_000
      s.emit(s.add(AGENT, '@Ada please confirm', [ADA]))
      await vi.waitFor(() => expect(s.mail.sent).toHaveLength(2))
      // A mention of a task member alone starts nothing.
      clock += 60_000
      s.emit(s.add(ADA, '@Planner thanks', [AGENT]))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(s.mail.sent).toHaveLength(2)
    } finally {
      s.bridge.stop()
    }
  })

  it('never mails a pending or left person, even when mentioned', async () => {
    const s = setup()
    ada(s.topic).status = 'left'
    s.add('human', '@Bob @Ada are you there?', [BOB, ADA])
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(0)
    expect(s.lines).toHaveLength(0)
  })

  it('does not mail a person their own lines or walnut system lines', async () => {
    const s = setup()
    s.add(ADA, 'my own reply by mail')
    s.add('walnut', "This round's 3 member wakes are used up; the rest wait for Evan.")
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(0)
    s.add('human', 'Thanks Ada')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(s.mail.sent[0]!.text).not.toContain('my own reply')
    expect(s.mail.sent[0]!.text).not.toContain('wakes are used up')
  })
})

describe('subject, body and threading', () => {
  it('uses "<title> [topic id]", "Name: text" lines with the footer, and threads each mail on the previous one', async () => {
    const s = setup()
    s.add('human', 'Kickoff')
    s.add(AGENT, 'Plan is drafted')
    await s.bridge.pass()
    const first = s.mail.sent[0]!
    expect(first.subject).toBe('Launch plan [topic tp-0123456789ab]')
    expect(first.accountId).toBe(ACCOUNT)
    expect(first.text).toBe(`Owner: Kickoff\n\nPlanner: Plan is drafted\n\n${TOPIC_MAIL_FOOTER}\n`)
    expect(first.inReplyTo).toBeUndefined()
    expect(ada(s.topic).mail).toEqual({
      lastSentAt: iso(clock),
      lastSentMessageId: s.topic.messages[1]!.id,
      threadMessageId: '<walnut-1@example.org>',
    })

    clock += 60_000
    s.add(AGENT, '@Ada one more', [ADA])
    await s.bridge.pass()
    const second = s.mail.sent[1]!
    expect(second.inReplyTo).toBe('<walnut-1@example.org>')
    expect(second.references).toEqual(['<walnut-1@example.org>'])
    expect(second.text.startsWith('Planner: @Ada one more')).toBe(true)
    expect(ada(s.topic).mail?.threadMessageId).toBe('<walnut-2@example.org>')

    clock += 60_000
    s.add('human', '@Ada last', [ADA])
    await s.bridge.pass()
    expect(s.mail.sent[2]!.inReplyTo).toBe('<walnut-2@example.org>')
    expect(s.mail.sent[2]!.references).toEqual(['<walnut-1@example.org>', '<walnut-2@example.org>'])
  })

  it('says once that a topic with people has no mail account, and sends nothing', async () => {
    const s = setup({ topic: { mail: { everyMinutes: 15 } } })
    s.add('human', 'hello')
    await s.bridge.pass()
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(0)
    expect(s.lines).toEqual(['No mail account is set for this topic, so Ada get no mail.'])
  })
})

describe('approval waits and send outcomes', () => {
  it('a send waiting for the user is never repeated; once it goes out the next one threads on it', async () => {
    const s = setup()
    s.mail.control.mode = 'waiting'
    s.add('human', 'first')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    clock += 60_000
    s.add(AGENT, '@Ada urgent', [ADA])
    await s.bridge.pass()
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(ada(s.topic).mail).toBeUndefined()

    // The user tapped Send: the ledger now says sent.
    s.mail.states.set('dr-1', { draftId: 'dr-1', state: 'sent', messageId: '<approved-1@example.org>' })
    s.mail.control.mode = 'sent'
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(ada(s.topic).mail?.lastSentMessageId).toBe(s.topic.messages[0]!.id)
    expect(ada(s.topic).mail?.threadMessageId).toBe('<approved-1@example.org>')

    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    expect(s.mail.sent[1]!.text).toContain('Planner: @Ada urgent')
    expect(s.mail.sent[1]!.text).not.toContain('Owner: first')
    expect(s.mail.sent[1]!.inReplyTo).toBe('<approved-1@example.org>')
  })

  it('lines the user declined are not offered again', async () => {
    const s = setup()
    s.mail.control.mode = 'waiting'
    s.add('human', 'declined text')
    await s.bridge.pass()
    s.mail.states.set('dr-1', { draftId: 'dr-1', state: 'discarded' })
    await s.bridge.pass()
    clock += 60 * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(ada(s.topic).mail?.lastSentMessageId).toBe(s.topic.messages[0]!.id)
  })

  it('a send a restart cut off is never sent again', async () => {
    const s = setup()
    s.add('human', 'hello')
    await fs.mkdir(path.dirname(stateFile), { recursive: true })
    await fs.writeFile(stateFile, JSON.stringify({
      version: 1, seen: [], sent: [], lines: [],
      members: { [`${TOPIC}/${ADA}`]: { pending: { draftId: '', upto: s.topic.messages[0]!.id, at: iso(clock) } } },
    }))
    const bridge = s.make()
    await bridge.pass()
    await bridge.pass()
    expect(s.mail.sent).toHaveLength(0)
    expect(s.lines.some((line) => line.includes('cannot tell whether the mail to Ada went out'))).toBe(true)
    expect(ada(s.topic).mail?.lastSentMessageId).toBe(s.topic.messages[0]!.id)
  })
})

describe('failures', () => {
  it('retries at each pass, never twice in one pass, and says so once after 3 failures', async () => {
    const s = setup()
    s.mail.control.mode = 'throw'
    s.add('human', 'hello')
    // Two passes asked at the same moment are one run: one attempt.
    await Promise.all([s.bridge.pass(), s.bridge.pass()])
    expect(s.mail.sent).toHaveLength(1)
    await s.bridge.pass()
    expect(s.lines).toHaveLength(0)
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(3)
    expect(s.lines).toEqual(['Mail to Ada failed 3 times (connection refused). Walnut keeps trying every pass.'])
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(4)
    expect(s.lines).toHaveLength(1)

    s.mail.control.mode = 'sent'
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(5)
    expect(ada(s.topic).mail?.threadMessageId).toBe('<walnut-5@example.org>')
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf-8'))
    expect(saved.members[`${TOPIC}/${ADA}`]).toMatchObject({ failures: 0, failureLine: false })
  })

  it('a refused send drops its draft and is retried at the next pass', async () => {
    const s = setup()
    s.mail.control.mode = 'failed'
    s.add('human', 'hello')
    await s.bridge.pass()
    expect(s.mail.dropped).toEqual(['dr-1'])
    s.mail.control.mode = 'sent'
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    expect(ada(s.topic).mail?.lastSentMessageId).toBe(s.topic.messages[0]!.id)
  })
})

function reply(over: Partial<TopicMailIncoming> = {}): TopicMailIncoming {
  return {
    accountId: ACCOUNT,
    messageId: 'msg-1',
    rfcMessageId: '<reply-1@example.com>',
    from: 'Ada Lovelace <ADA@example.COM>',
    subject: 'Re: Launch plan [topic tp-0123456789ab]',
    references: [],
    ...over,
  }
}

describe('inbound replies', () => {
  it('posts a reply that carries the subject token, from an active person, quote stripped', async () => {
    const s = setup()
    s.mail.bodies.set('msg-1', 'I can take it.\n\nOn Fri, Nov 20, 2026 at 10:00 AM Walnut <walnut@example.org> wrote:\n> Owner: Kickoff\n')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toEqual([{ topicId: TOPIC, memberId: ADA, text: 'I can take it.', via: 'mail' }])
  })

  it('finds the topic by In-Reply-To or References when the subject lost its token', async () => {
    const s = setup()
    s.add('human', 'Kickoff')
    await s.bridge.pass()
    s.mail.bodies.set('msg-2', 'Answer by thread only')
    s.mail.bodies.set('msg-3', 'Answer by references')
    await s.bridge.handleArrivals(ACCOUNT, async () => [
      reply({ messageId: 'msg-2', rfcMessageId: '<r2@example.com>', subject: 'Re: Launch plan', inReplyTo: '<walnut-1@example.org>' }),
      reply({ messageId: 'msg-3', rfcMessageId: '<r3@example.com>', subject: 'Re: something', references: ['walnut-1@example.org'] }),
    ])
    expect(s.posted.map((one) => one.text)).toEqual(['Answer by thread only', 'Answer by references'])
  })

  it('ignores a wrong sender, a pending person, and mail about no topic (without reading its body)', async () => {
    const s = setup()
    s.mail.bodies.set('msg-1', 'spoof')
    await s.bridge.handleArrivals(ACCOUNT, async () => [
      reply({ from: 'mallory@example.org' }),
      reply({ messageId: 'msg-b', rfcMessageId: '<b@example.com>', from: 'bob@example.com' }),
      reply({ messageId: 'msg-x', rfcMessageId: '<x@example.com>', subject: 'Lunch?', from: 'ada@example.com' }),
      reply({ messageId: 'msg-y', rfcMessageId: '<y@example.com>', subject: 'Re: [topic tp-ffffffffffff]' }),
    ])
    expect(s.posted).toHaveLength(0)
    expect(s.mail.bodyReads).toHaveLength(0)
  })

  it('never posts the same mail twice, also after a restart', async () => {
    const s = setup()
    s.mail.bodies.set('msg-1', 'Once only')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    // The same Message-ID under another cache id (the mail moved folders).
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply({ messageId: 'msg-1b' })])
    await s.make().handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toHaveLength(1)
  })

  it('posts nothing for a reply that is only quote', async () => {
    const s = setup()
    s.mail.bodies.set('msg-1', '> Owner: Kickoff\n')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toHaveLength(0)
  })

  it('takes arrivals from the mail plugin through the port while started', async () => {
    const s = setup()
    s.mail.bodies.set('msg-1', 'via the port')
    expect(topicMailListening()).toBe(false)
    s.bridge.start()
    try {
      expect(topicMailListening()).toBe(true)
      topicMailArrivals(ACCOUNT, async () => [reply()])
      await vi.waitFor(() => expect(s.posted).toHaveLength(1))
    } finally {
      s.bridge.stop()
    }
    expect(topicMailListening()).toBe(false)
    expect(s.hasListener()).toBe(false)
  })
})

describe('flag off', () => {
  it('sends nothing, says nothing and reads no arrival', async () => {
    const s = setup({ on: false, topic: { mail: { everyMinutes: 15 } } })
    const load = vi.fn(async () => [reply()])
    s.add('human', '@Ada hello', [ADA])
    s.topic.mail = { accountId: ACCOUNT, everyMinutes: 15 }
    await s.bridge.pass()
    s.topic.mail = { everyMinutes: 15 }
    await s.bridge.pass()
    await s.bridge.handleArrivals(ACCOUNT, load)
    expect(s.mail.sent).toHaveLength(0)
    expect(s.lines).toHaveLength(0)
    expect(load).not.toHaveBeenCalled()
    await expect(fs.stat(stateFile)).rejects.toThrow()
  })
})
