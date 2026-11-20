/**
 * The topics mail bridge, outbound and its bookkeeping, with an in-memory topics core and a fake
 * mail transport (topic-mail-fixture.ts): nothing here reaches a mailbox or a mail server.
 * Inbound replies: topic-mail-inbound.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTopicMailBridge, PERSON_MAILS_PER_ROUND } from '../../../src/core/topics/topic-mail.js'
import { MAIL_EVERY_MINUTES_DEFAULT as DEFAULT_EVERY_MINUTES } from '../../../src/core/topics/topics-model.js'
import { createTopicMailState, CLOSED_KEEP_MS, lineKey, pruneState } from '../../../src/core/topics/topic-mail-state.js'
import { TOPIC_MAIL_FOOTER } from '../../../src/core/topics/topic-mail-text.js'
import { ACCOUNT, ADA, AGENT, BOB, T0, TOPIC, ada, env, iso, reply, setup, useMailTestEnv } from './topic-mail-fixture.js'

useMailTestEnv()

describe('outbound schedule', () => {
  it('mails the first new messages at the first pass, then nothing when nothing is new', async () => {
    const s = setup()
    s.add('human', 'Kickoff: who takes the API?')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(s.mail.sent[0]!.to).toEqual({ name: 'Ada', address: 'Ada@Example.com' })
    await s.bridge.pass()
    env.clock += 60 * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
  })

  it('waits everyMinutes between mails unless a message mentions the person', async () => {
    const s = setup()
    s.add('human', 'First line')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)

    env.clock += 60_000
    s.add(AGENT, 'An update nobody is called on')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)

    env.clock += 2 * 60_000
    s.add(AGENT, '@Ada can you check the numbers?', [ADA])
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    // The mention mail carries every unsent line, the quiet one included.
    expect(s.mail.sent[1]!.text).toContain('Planner: An update nobody is called on')
    expect(s.mail.sent[1]!.text).toContain('Planner: @Ada can you check the numbers?')

    env.clock += 60_000
    s.add(AGENT, 'Another quiet update')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    env.clock += DEFAULT_EVERY_MINUTES * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(3)
  })

  it('honours a topic-specific everyMinutes', async () => {
    const s = setup({ topic: { mail: { accountId: ACCOUNT, everyMinutes: 5 } } })
    s.add('human', 'one')
    await s.bridge.pass()
    env.clock += 4 * 60_000
    s.add(AGENT, 'two')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    env.clock += 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
  })

  it('a message that mentions a person starts a pass at once', async () => {
    const s = setup()
    s.bridge.start()
    try {
      s.add('human', 'earlier line')
      await s.bridge.pass()
      env.clock += 60_000
      s.emit(s.add(AGENT, '@Ada please confirm', [ADA]))
      await vi.waitFor(() => expect(s.mail.sent).toHaveLength(2))
      // A mention of a task member alone starts nothing.
      env.clock += 60_000
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
      lastSentAt: iso(env.clock),
      lastSentMessageId: s.topic.messages[1]!.id,
      threadMessageId: '<walnut-1@example.org>',
    })

    env.clock += 60_000
    s.add(AGENT, '@Ada one more', [ADA])
    await s.bridge.pass()
    const second = s.mail.sent[1]!
    expect(second.inReplyTo).toBe('<walnut-1@example.org>')
    expect(second.references).toEqual(['<walnut-1@example.org>'])
    expect(second.text.startsWith('Planner: @Ada one more')).toBe(true)
    expect(ada(s.topic).mail?.threadMessageId).toBe('<walnut-2@example.org>')

    env.clock += 60_000
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
    env.clock += 60_000
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
    env.clock += 60 * 60_000
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(1)
    expect(ada(s.topic).mail?.lastSentMessageId).toBe(s.topic.messages[0]!.id)
  })

  it('a send a restart cut off is never sent again', async () => {
    const s = setup()
    s.add('human', 'hello')
    await fs.mkdir(path.dirname(env.stateFile), { recursive: true })
    await fs.writeFile(env.stateFile, JSON.stringify({
      version: 1, seen: [], sent: [], lines: [],
      members: { [`${TOPIC}/${ADA}`]: { pending: { draftId: '', upto: s.topic.messages[0]!.id, at: iso(env.clock) } } },
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
    const saved = JSON.parse(await fs.readFile(env.stateFile, 'utf-8'))
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

describe('two outside bots never mail each other forever', () => {
  const PIP = 'mb-0000000d'
  /** Ada and Pip are both bots: each answers every mail it gets with "@<other> ok". */
  function bots() {
    const s = setup()
    s.topic.members.push({ id: PIP, ref: { kind: 'person', name: 'Pip', email: 'pip@example.com', bot: true }, name: 'Pip', status: 'active', joinedAt: iso(T0 - 60_000) } as never)
    ada(s.topic).ref = { kind: 'person', name: 'Ada', email: 'Ada@Example.com', bot: true }
    return s
  }
  /** Each mail one bot got is answered at once by a mail reply, posted as that bot (as the inbound path does). */
  async function answerEveryMail(s: ReturnType<typeof bots>, rounds: number): Promise<void> {
    let answered = 0
    for (let i = 0; i < rounds; i++) {
      await s.bridge.pass()
      for (const mail of s.mail.sent.slice(answered)) {
        const me = mail.to.address.toLowerCase() === 'pip@example.com' ? PIP : ADA
        const other = me === PIP ? ADA : PIP
        s.emit(s.add(me, `@${other === PIP ? 'Pip' : 'Ada'} ok`, [other]))
      }
      answered = s.mail.sent.length
      env.clock += DEFAULT_EVERY_MINUTES * 60_000
    }
  }

  it('a person\'s message mails nobody at once, and each person gets at most 3 such mails a round; one line says so', async () => {
    const s = bots()
    s.add('human', 'Kick off, you two.')
    await answerEveryMail(s, 30)
    const per = (address: string) => s.mail.sent.filter((m) => m.to.address.toLowerCase() === address).length
    // The user's message (1 each), then at most PERSON_MAILS_PER_ROUND each with none of his lines.
    expect(per('ada@example.com')).toBe(1 + PERSON_MAILS_PER_ROUND)
    expect(per('pip@example.com')).toBe(1 + PERSON_MAILS_PER_ROUND)
    expect(s.lines.filter((l) => l.includes('mails this round'))).toEqual([
      `Ada got ${PERSON_MAILS_PER_ROUND} mails this round; nothing more is mailed to them until Owner writes again.`,
      `Pip got ${PERSON_MAILS_PER_ROUND} mails this round; nothing more is mailed to them until Owner writes again.`,
    ])
    // A person's line never mails at once.
    expect(s.topic.messages.filter((m) => m.author === ADA || m.author === PIP).every((m) => !m.mailNow?.length)).toBe(true)

    // The user writes again: a new round, and the waiting lines go out with his.
    const before = s.mail.sent.length
    s.add('human', 'Thanks both.')
    await s.bridge.pass()
    expect(s.mail.sent.length).toBe(before + 2)
    expect(s.mail.sent.at(-1)!.text).toContain('Owner: Thanks both.')
  })
})

describe('mail goes exactly as each message\'s plan says (L1)', () => {
  it('the user\'s message to everyone mails at once; a scheduled one waits; `mailed` lists only who really got it', async () => {
    const s = setup()
    s.add('human', 'first')
    await s.bridge.pass()
    env.clock += 60_000
    const toAll = s.add('human', 'To everyone, no mention')
    expect(toAll.mailNow).toEqual([ADA])
    const quiet = s.add(AGENT, 'A quiet agent line')
    expect(quiet.toMail).toEqual([ADA])
    expect(quiet.mailNow).toBeUndefined()
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    expect(s.topic.messages.find((m) => m.id === toAll.id)?.mailed).toEqual([ADA])
    env.clock += 60_000
    const later = s.add(AGENT, 'Another quiet line')
    await s.bridge.pass()
    expect(s.mail.sent).toHaveLength(2)
    expect(s.topic.messages.find((m) => m.id === later.id)?.mailed).toBeUndefined()
    env.clock += DEFAULT_EVERY_MINUTES * 60_000
    await s.bridge.pass()
    expect(s.topic.messages.find((m) => m.id === later.id)?.mailed).toEqual([ADA])
  })
})

describe('the bookkeeping stays small (L5)', () => {
  it('drops the entries and lines of topics that are gone or closed over a week', () => {
    const now = T0
    const state = {
      version: 1 as const, seen: [], sent: [],
      members: { 'tp-aaaaaaaaaaaa/mb-00000001': { failures: 1 }, 'tp-bbbbbbbbbbbb/mb-00000001': { failures: 1 }, 'tp-cccccccccccc/mb-00000001': {} },
      lines: [lineKey('tp-aaaaaaaaaaaa', 'no-account'), lineKey('tp-bbbbbbbbbbbb', 'no-account'), lineKey('tp-cccccccccccc', 'no-account')],
    }
    const topics = new Map([
      ['tp-aaaaaaaaaaaa', {}],
      ['tp-cccccccccccc', { closedAt: iso(now - CLOSED_KEEP_MS - 1) }],
      ['tp-dddddddddddd', { closedAt: iso(now - 60_000) }],
    ])
    expect(pruneState(state, topics, now)).toBe(true)
    expect(Object.keys(state.members)).toEqual(['tp-aaaaaaaaaaaa/mb-00000001'])
    expect(state.lines).toEqual([lineKey('tp-aaaaaaaaaaaa', 'no-account')])
    expect(pruneState(state, topics, now)).toBe(false)
  })

  it('a pass prunes a topic that is gone, and caps the inbound keys', async () => {
    const s = setup()
    await fs.mkdir(path.dirname(env.stateFile), { recursive: true })
    await fs.writeFile(env.stateFile, JSON.stringify({
      version: 1, seen: Array.from({ length: 5200 }, (_, i) => `k${i}`), sent: [], lines: [lineKey('tp-ffffffffffff', 'no-account')],
      members: { 'tp-ffffffffffff/mb-00000001': { failures: 2 } },
    }))
    s.add('human', 'hello')
    await s.make().pass()
    const saved = JSON.parse(await fs.readFile(env.stateFile, 'utf-8'))
    expect(Object.keys(saved.members)).toEqual([`${TOPIC}/${ADA}`])
    expect(saved.lines).toEqual([])
    expect(saved.seen).toHaveLength(5000)
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
    await expect(fs.stat(env.stateFile)).rejects.toThrow()
  })
})

describe('a test or ephemeral server sends no mail (A2)', () => {
  it('a held bridge sends nothing and says it once in the log, never as a topic line', async () => {
    const s = setup()
    const warned: string[] = []
    const bridge = createTopicMailBridge({
      core: s.core, transport: () => s.mail.transport, state: createTopicMailState(env.stateFile),
      isOn: async () => true, ownerName: async () => 'Owner', now: () => env.clock,
      heldReason: () => 'an ephemeral server',
      log: { info: () => undefined, warn: (m) => { warned.push(m) } },
    })
    s.add('human', '@Ada hello', [ADA])
    await bridge.pass()
    await bridge.pass()
    expect(s.mail.sent).toHaveLength(0)
    expect(s.lines).toHaveLength(0)
    expect(warned.filter((w) => w.includes('topic mail is held'))).toHaveLength(1)
  })

  it('is held on a throwaway server unless WALNUT_TOPICS_MAIL_IN_TEST=1', async () => {
    const { topicMailHeldReason } = await import('../../../src/core/topics/topic-mail.js')
    const { throwawayServerReason } = await import('../../../src/core/remote-sync-isolation.js')
    expect(throwawayServerReason()).toBe('test runner (VITEST)')
    expect(topicMailHeldReason(throwawayServerReason, {})).toBe('test runner (VITEST)')
    expect(topicMailHeldReason(throwawayServerReason, { WALNUT_TOPICS_MAIL_IN_TEST: '1' })).toBeNull()
    expect(topicMailHeldReason(() => null, {})).toBeNull()
    const argv = process.argv
    process.argv = [...argv, '--_ephemeral-child']
    try {
      expect(throwawayServerReason()).toBe('an ephemeral server')
    } finally {
      process.argv = argv
    }
  })
})
