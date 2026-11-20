/**
 * The mail plugin's side of the topics bridge, with fake drafts, approvals, sends and service:
 * every topic mail is a draft sent through `approvals.requestSend` (where the Approvals switch is
 * read), and the arrival tap hands the poll's arrivals over without changing the capture.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTopicMailTransport, tapTopicMailArrivals } from '../../../src/integrations/mail/topic-transport.js'
import { onTopicMailArrivals, topicMailArrivals, type TopicMailIncoming } from '../../../src/core/topics/topic-mail-port.js'
import type { MailIncomingCapture } from '../../../src/integrations/mail/contract.js'

function fakes(asked: () => Promise<unknown>) {
  const created: Array<Record<string, unknown>> = []
  const discarded: string[] = []
  const drafts = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return { draftId: 'dr-1', revision: 1 }
    }),
    get: vi.fn(async (draftId: string) => {
      if (draftId === 'gone') throw new Error('No draft')
      return { draftId, state: draftStates[draftId] ?? 'pending_approval', error: draftId === 'dr-failed' ? 'refused before data' : undefined }
    }),
    discard: vi.fn(async (draftId: string) => { discarded.push(draftId) }),
  }
  const draftStates: Record<string, string> = {}
  const approvals = { requestSend: vi.fn(asked) }
  const sends = { list: vi.fn(async () => [{ state: 'failed' }, { state: 'sent', providerMessageId: '<sent-9@example.org>' }]) }
  const service = {
    listAccounts: vi.fn(async () => [
      { accountId: 'fake:a', address: 'a@example.org', state: 'active', capabilities: { send: true } },
      { accountId: 'fake:b', address: 'b@example.org', state: 'active', capabilities: { send: false } },
      { accountId: 'fake:c', address: 'c@example.org', state: 'active' },
      { accountId: 'fake:d', address: 'd@example.org', state: 'auth-required', capabilities: { send: true } },
    ]),
    capabilitiesFor: vi.fn(async () => ({ send: true })),
    readMessage: vi.fn(async () => ({ message: {}, body: { format: 'html', html: '<p>Hello <b>there</b></p>', bytes: 10, truncated: false } })),
  }
  // The fakes carry only what the adapter touches.
  const transport = createTopicMailTransport({ drafts, approvals, sends, service } as never)
  return { transport, created, discarded, drafts, approvals, draftStates, service }
}

const MAIL = {
  accountId: 'fake:a',
  to: { name: 'Ada', address: 'ada@example.com' },
  subject: 'Launch plan [topic tp-0123456789ab]',
  text: 'Owner: hello\n\nReply to this email to post in the topic. Mention @Name to call someone.\n',
}

describe('topic mail transport', () => {
  it('approvals off: the draft goes out now, and the Message-ID comes back', async () => {
    const f = fakes(async () => ({ draft: {}, letterId: '', sent: { state: 'sent', providerMessageId: '<walnut-1@example.org>' } }))
    const outcome = await f.transport.send(MAIL)
    expect(outcome).toEqual({ draftId: 'dr-1', state: 'sent', messageId: '<walnut-1@example.org>' })
    expect(f.created[0]).toEqual({
      accountId: 'fake:a', to: [{ name: 'Ada', address: 'ada@example.com' }], subject: MAIL.subject,
      bodyMarkdown: MAIL.text, origin: 'agent',
    })
    expect(f.approvals.requestSend).toHaveBeenCalledWith('dr-1', 1)
  })

  it('approvals on: a letter waits for the user, and the send says waiting', async () => {
    const f = fakes(async () => ({ draft: {}, letterId: 'lt-1' }))
    expect(await f.transport.send(MAIL)).toEqual({ draftId: 'dr-1', state: 'waiting' })
  })

  it('carries shape-checked threading headers', async () => {
    const f = fakes(async () => ({ draft: {}, letterId: 'lt-1' }))
    await f.transport.send({ ...MAIL, inReplyTo: 'walnut-1@example.org', references: ['<walnut-0@example.org>', 'not an id'] })
    expect(f.created[0]!.reply).toEqual({
      inReplyTo: '<walnut-1@example.org>', references: ['<walnut-0@example.org>'], subject: MAIL.subject,
    })
  })

  it('a refused request leaves no draft behind and throws', async () => {
    const f = fakes(async () => { throw new Error('account is not active') })
    await expect(f.transport.send(MAIL)).rejects.toThrow('account is not active')
    expect(f.discarded).toEqual(['dr-1'])
  })

  it('maps a draft to where its send stands', async () => {
    const f = fakes(async () => ({}))
    Object.assign(f.draftStates, { 'dr-sent': 'sent', 'dr-failed': 'failed', 'dr-unknown': 'unknown', 'dr-no': 'discarded', 'dr-edit': 'composing' })
    expect(await f.transport.sendState('dr-sent')).toEqual({ draftId: 'dr-sent', state: 'sent', messageId: '<sent-9@example.org>' })
    expect(await f.transport.sendState('dr-failed')).toEqual({ draftId: 'dr-failed', state: 'failed', error: 'refused before data' })
    expect((await f.transport.sendState('dr-unknown')).state).toBe('unknown')
    expect((await f.transport.sendState('dr-no')).state).toBe('discarded')
    expect((await f.transport.sendState('gone')).state).toBe('discarded')
    expect((await f.transport.sendState('dr-edit')).state).toBe('waiting')
    expect((await f.transport.sendState('dr-pending')).state).toBe('waiting')
  })

  it('lists which accounts can send', async () => {
    const f = fakes(async () => ({}))
    expect(await f.transport.accounts()).toEqual([
      { accountId: 'fake:a', address: 'a@example.org', canSend: true },
      { accountId: 'fake:b', address: 'b@example.org', canSend: false },
      { accountId: 'fake:c', address: 'c@example.org', canSend: true },
      { accountId: 'fake:d', address: 'd@example.org', canSend: false },
    ])
  })

  it('reads an html-only body as plain text', async () => {
    const f = fakes(async () => ({}))
    expect((await f.transport.bodyText('fake:a', 'msg-1')).replace(/\s+/g, ' ').trim()).toBe('Hello there')
  })
})

describe('arrival tap', () => {
  const rows = [{
    message_id: 'msg-1', rfc_message_id: '<r1@example.com>', from_addr: 'ada@example.com', subject: 'Re: x [topic tp-0123456789ab]',
    payload: JSON.stringify({ from: { address: 'Ada@example.com' }, inReplyTo: '<walnut-1@example.org>', references: ['<walnut-0@example.org>'] }),
  }, {
    message_id: 'msg-2', rfc_message_id: '<r2@example.com>', from_addr: 'bob@example.com', subject: 'hi', payload: '{broken',
  }]
  const finish = async () => undefined

  it('without a listener, reads nothing and passes the capture through unchanged', async () => {
    const store = { messagesByIds: vi.fn(async () => rows) }
    const capture = vi.fn<MailIncomingCapture>(async () => finish)
    const tapped = tapTopicMailArrivals(capture, store as never)
    const headlines = [{ from: 'ada@example.com', subject: 's', messageId: 'msg-1' }]
    expect(await tapped('fake:a', headlines, { inbox: true })).toBe(finish)
    expect(capture).toHaveBeenCalledWith('fake:a', headlines, { inbox: true })
    expect(store.messagesByIds).not.toHaveBeenCalled()
  })

  it('with a listener, hands over a loader of the arrivals with their threading headers', async () => {
    const store = { messagesByIds: vi.fn(async () => rows) }
    const capture = vi.fn<MailIncomingCapture>(async () => finish)
    const got: Array<{ accountId: string; load: () => Promise<TopicMailIncoming[]> }> = []
    const off = onTopicMailArrivals((accountId, load) => { got.push({ accountId, load }) })
    try {
      const tapped = tapTopicMailArrivals(capture, store as never)
      await tapped('fake:a', [{ from: '', subject: '', messageId: 'msg-1' }, { from: '', subject: '', messageId: 'msg-2' }, { from: '', subject: '' }])
      expect(capture).toHaveBeenCalledTimes(1)
      expect(store.messagesByIds).not.toHaveBeenCalled()
      expect(got).toHaveLength(1)
      expect(await got[0]!.load()).toEqual([
        { accountId: 'fake:a', messageId: 'msg-1', rfcMessageId: '<r1@example.com>', from: 'Ada@example.com', subject: 'Re: x [topic tp-0123456789ab]', inReplyTo: '<walnut-1@example.org>', references: ['<walnut-0@example.org>'] },
        { accountId: 'fake:a', messageId: 'msg-2', rfcMessageId: '<r2@example.com>', from: 'bob@example.com', subject: 'hi', references: [] },
      ])
      expect(store.messagesByIds).toHaveBeenCalledWith('fake:a', ['msg-1', 'msg-2'])
    } finally {
      off()
    }
  })

  it('leaves out of the capture what the bridge takes, and still announces the rest', async () => {
    const store = { messagesByIds: vi.fn(async () => rows) }
    const capture = vi.fn<MailIncomingCapture>(async () => finish)
    const off = onTopicMailArrivals(async () => ['msg-1'])
    try {
      const tapped = tapTopicMailArrivals(capture, store as never)
      const headlines = [{ from: '', subject: '', messageId: 'msg-1' }, { from: '', subject: '', messageId: 'msg-2' }]
      const done = await tapped('fake:a', headlines, { inbox: true })
      expect(capture).toHaveBeenCalledWith('fake:a', [headlines[1]], { inbox: true })
      expect(await done()).toEqual([headlines[1]])
    } finally {
      off()
    }
  })

  it('a listener that fails or answers too late takes nothing: the mail still reaches the router', async () => {
    const offs = [
      onTopicMailArrivals(() => new Promise<string[]>(() => undefined)),
      onTopicMailArrivals(async () => { throw new Error('boom') }),
      onTopicMailArrivals(() => { throw new Error('sync boom') }),
    ]
    try {
      expect([...await topicMailArrivals('fake:a', async () => [], 20)]).toEqual([])
    } finally {
      for (const off of offs) off()
    }
  })

  it('a listener still claiming when the wait ends finds its window aborted; one that answered in time does not', async () => {
    const windows: AbortSignal[] = []
    let answerLate!: (ids: string[]) => void
    const offs = [
      onTopicMailArrivals((_a, _l, window) => { windows.push(window.signal); return Promise.resolve(['msg-1']) }),
      onTopicMailArrivals((_a, _l, window) => { windows.push(window.signal); return new Promise<string[]>((go) => { answerLate = go }) }),
    ]
    try {
      expect([...await topicMailArrivals('fake:a', async () => [], 20)]).toEqual(['msg-1'])
      expect(windows.map((one) => one.aborted)).toEqual([false, true])
      answerLate(['msg-2'])
    } finally {
      for (const off of offs) off()
    }
  })
})

describe('handing a mail back to the router', () => {
  it('passes the ids to the router intake, and never throws when that fails', async () => {
    const got: Array<[string, readonly string[]]> = []
    const transport = createTopicMailTransport({ handBack: async (accountId: string, ids: readonly string[]) => { got.push([accountId, ids]) } } as never)
    await transport.handBack('fake:a', ['msg-1'])
    expect(got).toEqual([['fake:a', ['msg-1']]])
    const failing = createTopicMailTransport({ handBack: async () => { throw new Error('queue file unwritable') } } as never)
    await expect(failing.handBack('fake:a', ['msg-1'])).resolves.toBeUndefined()
  })
})
