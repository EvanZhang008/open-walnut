/**
 * The topics mail bridge, inbound: which arriving mail is a person's reply, how the poll's tap
 * waits only for the claims, and that a claimed mail is never lost nor delivered twice. In-memory
 * topics core and fake transport (topic-mail-fixture.ts); nothing reaches a mailbox.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { topicMailArrivals, topicMailListening, type TopicMailIncoming } from '../../../src/core/topics/topic-mail-port.js'
import { tapTopicMailArrivals } from '../../../src/integrations/mail/topic-transport.js'
import type { MailIncomingCapture } from '../../../src/integrations/mail/contract.js'
import type { MailHeadline } from '../../../src/integrations/mail/events.js'
import { ACCOUNT, ADA, BOB, TOPIC, env, mailedAda, reply, setup, useMailTestEnv } from './topic-mail-fixture.js'

useMailTestEnv()

describe('inbound replies', () => {
  it('posts a reply to the mail sent to that person, from that person, in the topic\'s account, quote stripped', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'I can take it.\n\nOn Fri, Nov 20, 2026 at 10:00 AM Walnut <walnut@example.org> wrote:\n> Owner: Kickoff\n')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toEqual([{ topicId: TOPIC, memberId: ADA, text: 'I can take it.', via: 'mail' }])
  })

  it('finds the mail it answers by In-Reply-To or References, whatever the subject says', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-2', 'Answer by thread only')
    s.mail.bodies.set('msg-3', 'Answer by references')
    await s.bridge.handleArrivals(ACCOUNT, async () => [
      reply({ messageId: 'msg-2', rfcMessageId: '<r2@example.com>', subject: 'Re: Launch plan', inReplyTo: '<walnut-1@example.org>' }),
      reply({ messageId: 'msg-3', rfcMessageId: '<r3@example.com>', subject: 'Re: something', inReplyTo: undefined, references: ['walnut-1@example.org'] }),
    ])
    expect(s.posted.map((one) => one.text)).toEqual(['Answer by thread only', 'Answer by references'])
  })

  it('a From and a subject token alone are not enough: it must answer a mail sent to that same person, in the topic\'s account', async () => {
    const s = setup()
    // Bob active too, so a mail of his could pass on From alone.
    s.topic.members.find((one) => one.id === BOB)!.status = 'active'
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'spoof')
    await s.bridge.handleArrivals(ACCOUNT, async () => [
      // The subject token, no References: anyone can write that.
      reply({ messageId: 'msg-a', rfcMessageId: '<a@example.com>', inReplyTo: undefined }),
      // Bob answering the mail Ada got (Bob was mailed his own: <walnut-2@example.org>).
      reply({ messageId: 'msg-b', rfcMessageId: '<b@example.com>', from: 'bob@example.com' }),
      // A stranger, answering Ada's mail.
      reply({ messageId: 'msg-c', rfcMessageId: '<c@example.com>', from: 'mallory@example.org' }),
      // Ada's address, but the reply came into another account.
      reply({ messageId: 'msg-d', rfcMessageId: '<d@example.com>', accountId: 'fake:other' }),
      // Answers a mail the bridge never sent.
      reply({ messageId: 'msg-e', rfcMessageId: '<e@example.com>', inReplyTo: '<someone-else@example.org>' }),
    ])
    expect(s.posted).toHaveLength(0)
    expect(s.mail.bodyReads).toHaveLength(0)
  })

  it('never posts an automatic mail (Auto-Submitted, Precedence, an older X-Autoreply), nor the bridge\'s own mail coming back', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'I am out of office.')
    const autos: Array<TopicMailIncoming['bulkHeaders']> = [
      { autoSubmitted: 'auto-replied' }, { autoSubmitted: 'auto-generated' },
      { precedence: 'auto_reply' }, { precedence: 'bulk' }, { precedence: 'junk' }, { precedence: 'list' },
    ]
    autos.forEach((_, i) => s.mail.bodies.set(`auto-${i}`, 'I am out of office.'))
    s.mail.bodies.set('own', 'Owner: Kickoff')
    await s.bridge.handleArrivals(ACCOUNT, async () => [
      ...autos.map((bulkHeaders, i) => reply({ messageId: `auto-${i}`, rfcMessageId: `<auto-${i}@example.com>`, bulkHeaders })),
      // The bridge's own mail, delivered back into the inbox (a copy, a list echo).
      reply({ messageId: 'own', rfcMessageId: '<walnut-1@example.org>' }),
    ])
    expect(s.posted).toHaveLength(0)
    expect(s.mail.bodyReads).toEqual([])
    // "Auto-Submitted: no" is a person's mail.
    s.mail.bodies.set('msg-1', 'Here by hand.')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply({ bulkHeaders: { autoSubmitted: 'no' } })])
    expect(s.posted.map((one) => one.text)).toEqual(['Here by hand.'])
  })

  it('never posts the same mail twice, also after a restart', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'Once only')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    // The same Message-ID under another cache id (the mail moved folders).
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply({ messageId: 'msg-1b' })])
    await s.make().handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toHaveLength(1)
  })

  it('posts nothing for a reply that is only quote: the topic says so and the mail goes back to the router', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', '> Owner: Kickoff\n')
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toHaveLength(0)
    expect(s.lines).toContain('A mail from Ada could not be posted: it held only quoted lines.')
    expect(s.mail.handedBack).toEqual(['msg-1'])
  })

  it('takes arrivals from the mail plugin through the port while started', async () => {
    const s = setup()
    await mailedAda(s)
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

  it('a reply the bridge posts never reaches the mail router, nor is it announced; other mail goes on as before', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'Posted once, in the topic')
    // The body read waits: the router must not wait for it, only for the claim.
    let bodyGo!: () => void
    const bodyGate = new Promise<void>((go) => { bodyGo = go })
    const readBody = s.mail.transport.bodyText
    s.mail.transport.bodyText = async (accountId, messageId) => { await bodyGate; return readBody(accountId, messageId) }
    const routed: string[][] = []
    const router = vi.fn<MailIncomingCapture>(async (_accountId, headlines) => {
      routed.push(headlines.map((one) => one.messageId))
      return async () => undefined
    })
    const rows = [
      { message_id: 'msg-1', rfc_message_id: '<reply-1@example.com>', from_addr: 'ada@example.com', subject: 'Re: Launch plan',
        payload: JSON.stringify({ from: { address: 'Ada@Example.com' }, inReplyTo: '<walnut-1@example.org>', references: [] }) },
      { message_id: 'msg-n', rfc_message_id: '<news@example.com>', from_addr: 'news@example.org', subject: 'Weekly news', payload: '{}' },
    ]
    const tapped = tapTopicMailArrivals(router, { messagesByIds: async () => rows } as never)
    const headlines: MailHeadline[] = [
      { from: 'ada@example.com', subject: 'Re: Launch plan', messageId: 'msg-1' },
      { from: 'news@example.org', subject: 'Weekly news', messageId: 'msg-n' },
    ]
    s.bridge.start()
    try {
      const finish = await tapped(ACCOUNT, headlines, { inbox: true })
      expect(routed).toEqual([['msg-n']])
      expect(s.posted).toHaveLength(0)
      // The poll announces only what is not the topic's.
      expect(await finish()).toEqual([headlines[1]])
      bodyGo()
      await vi.waitFor(() => expect(s.posted.map((one) => one.text)).toEqual(['Posted once, in the topic']))
      // The same reply seen again (an unread refresh, a folder move) is still the topic's.
      await tapped(ACCOUNT, [headlines[0]!], { inbox: true })
      expect(routed).toEqual([['msg-n'], []])
      expect(s.posted).toHaveLength(1)
    } finally {
      s.bridge.stop()
    }
    // With no bridge listening, the router gets everything, unchanged.
    await tapped(ACCOUNT, headlines, { inbox: true })
    expect(routed.at(-1)).toEqual(['msg-1', 'msg-n'])
  })
})

/** A promise and the function that settles it. */
function gate<T = void>(): { wait: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void
  const wait = new Promise<T>((go) => { open = go })
  return { wait, open }
}

const seenKeys = async (): Promise<string[]> => JSON.parse(await fs.readFile(env.stateFile, 'utf-8')).seen

describe('claims never wait on delivery (M1)', () => {
  it('a slow delivery does not delay the next poll\'s claims', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'First reply')
    s.mail.bodies.set('msg-2', 'Second reply')
    // The first reply's post hangs (its body read, as a slow network read or an unreachable host would).
    const body = gate<string>()
    const readBody = s.mail.transport.bodyText
    s.mail.transport.bodyText = (accountId, messageId) => (messageId === 'msg-1' ? body.wait : readBody(accountId, messageId))
    const claimed: string[][] = []
    const first = s.bridge.handleArrivals(ACCOUNT, async () => [reply()], (ids) => { claimed.push(ids) })
    await vi.waitFor(() => expect(claimed).toEqual([['msg-1']]))
    void s.bridge.handleArrivals(ACCOUNT, async () => [reply({ messageId: 'msg-2', rfcMessageId: '<reply-2@example.com>' })], (ids) => { claimed.push(ids) })
    // The second poll is answered while the first delivery still hangs.
    await vi.waitFor(() => expect(claimed).toEqual([['msg-1'], ['msg-2']]))
    expect(s.posted).toHaveLength(0)
    body.open('First reply')
    await first
    // Posts keep their order.
    await vi.waitFor(() => expect(s.posted.map((one) => one.text)).toEqual(['First reply', 'Second reply']))
  })

  it('a claim the tap stopped waiting for is undone: never posted, never marked seen, and the router has the mail', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'Late claim')
    // The claim's topic read hangs past the tap's wait.
    const read = gate()
    const readTopic = s.core.readTopic
    s.core.readTopic = async (id) => { await read.wait; return readTopic(id) }
    s.bridge.start()
    try {
      const taken = await topicMailArrivals(ACCOUNT, async () => [reply()], 20)
      expect([...taken]).toEqual([])
      read.open()
      // The next poll's claims run after the late one's, so this returns once it is undone.
      await s.bridge.handleArrivals(ACCOUNT, async () => [])
      expect(await seenKeys()).toEqual([])
      // Give the bridge every chance to post what it claimed.
      await new Promise((go) => setTimeout(go, 50))
      expect(s.posted).toHaveLength(0)
      expect(s.mail.bodyReads).toEqual([])
    } finally {
      s.bridge.stop()
    }
  })

  it('a claim the tap still waited for is taken and posted once', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'In time')
    s.bridge.start()
    try {
      const taken = await topicMailArrivals(ACCOUNT, async () => [reply()], 5_000)
      expect([...taken]).toEqual(['msg-1'])
      await vi.waitFor(() => expect(s.posted.map((one) => one.text)).toEqual(['In time']))
      expect(await seenKeys()).toHaveLength(1)
    } finally {
      s.bridge.stop()
    }
  })
})

describe('a claimed mail that cannot be posted is never lost (L1)', () => {
  it('the topic closed or the person left meanwhile: one walnut line, and the mail goes back to the router', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.bodies.set('msg-1', 'Too late for the topic')
    s.core.appendMemberMessage = async () => { throw new Error('the topic is closed') }
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.posted).toHaveLength(0)
    expect(s.lines).toEqual(['A mail from Ada could not be posted: the topic is closed.'])
    expect(s.mail.handedBack).toEqual(['msg-1'])
    // It is still the topic's claim: the same mail coming by again is not handed out twice.
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.mail.handedBack).toEqual(['msg-1'])
  })

  it('a body that cannot be read goes back to the router too; a topic that is gone gets no line', async () => {
    const s = setup()
    await mailedAda(s)
    s.mail.transport.bodyText = async () => { throw new Error('the mail server is unreachable') }
    let reads = 0
    const readTopic = s.core.readTopic
    // The claim reads the topic; by the time of the line, it is deleted.
    s.core.readTopic = async (id) => (++reads > 1 ? null : readTopic(id))
    await s.bridge.handleArrivals(ACCOUNT, async () => [reply()])
    expect(s.lines).toEqual([])
    expect(s.mail.handedBack).toEqual(['msg-1'])
  })
})
