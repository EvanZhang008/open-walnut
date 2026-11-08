/**
 * The send acceptance rule (web/src/api/session-send.ts) and what it does to a
 * bubble and the error line (web/src/components/sessions/send-acceptance.ts).
 *
 * 2026-11-11 review (F3): the server kept a message and the CLI answered it, but
 * the send's answer was lost. The composer read a refusal: its words came back, so
 * Enter sent them twice, and a red line stayed over the answered conversation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ws = vi.hoisted(() => ({
  events: new Map<string, (data: unknown) => void>(),
  queue: [] as Array<Record<string, unknown>>,
  sendAnswer: 'ok' as 'ok' | 'lost' | 'refused',
  sends: [] as Array<Record<string, unknown>>,
  queueReads: 0,
}))
vi.mock('@/api/ws', () => ({
  wsClient: {
    onEvent: (name: string, cb: (data: unknown) => void) => { ws.events.set(name, cb) },
    sendRpc: async (method: string, payload: Record<string, unknown>) => {
      if (method === 'session:get-queue') { ws.queueReads++; return { messages: ws.queue } }
      if (method !== 'session:send') return {}
      ws.sends.push(payload)
      if (ws.sendAnswer === 'refused') throw new Error('Session is not running')
      // The server took it: its row and its queued event exist; only the answer is lost.
      const row = { id: `qm-${ws.sends.length}`, message: payload.message, status: 'pending', userUuid: payload.userUuid, enqueuedAt: '2026-11-11T10:00:00.000Z' }
      ws.queue.push(row)
      if (ws.sendAnswer === 'lost') throw new Error('Acceptance acknowledgement was lost; the server kept this message.')
      return { messageId: row.id, enqueuedAt: row.enqueuedAt }
    },
  },
}))

import { confirmKept, keptRowOf, noteKept, onKept, sendSessionMessage } from '../../web/src/api/session-send'
import { acceptedBubble, applyLateKept, shownSendError, type AcceptableBubble } from '../../web/src/components/sessions/send-acceptance'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const bubble = (over: Partial<AcceptableBubble> = {}): AcceptableBubble => ({ queueId: 'temp-1', status: 'pending', userUuid: U1, ...over })

beforeEach(() => {
  ws.queue = []
  ws.sends = []
  ws.queueReads = 0
  ws.sendAnswer = 'ok'
})

describe('acceptedBubble: the answer, or its stand-in', () => {
  it('a plain answer: the server id, Queued', () => {
    expect(acceptedBubble(bubble(), { messageId: 'qm-a', enqueuedAt: 'T' })).toMatchObject({ queueId: 'qm-a', status: 'received', timestamp: 'T' })
  })
  it('a delivery that named the id first: Delivered', () => {
    expect(acceptedBubble(bubble(), { messageId: 'qm-a' }, true).status).toBe('delivered')
  })
  it('a lost answer whose line already ran: Delivered, error gone', () => {
    const m = acceptedBubble(bubble({ status: 'failed', failedError: 'lost' }), { messageId: 'qm-a', alreadyDelivered: true })
    expect(m.status).toBe('delivered')
    expect(m.failedError).toBeUndefined()
  })
  it('a lost answer for a row the server parked: failed with its reason and Retry', () => {
    const m = acceptedBubble(bubble(), { messageId: 'qm-a', recovered: { sessionId: 's', userUuid: U1, messageId: 'qm-a', parked: { reason: 'Folder gone' } } })
    expect(m).toMatchObject({ queueId: 'qm-a', status: 'failed', parked: true, serverUndelivered: true, failedError: 'Folder gone' })
  })
  it('keeps the dedup text the server enqueued', () => {
    expect(acceptedBubble(bubble(), { messageId: 'qm-a', dedupText: '[Images attached]\nhi' }).dedupText).toBe('[Images attached]\nhi')
  })
})

describe('applyLateKept: a refusal the server proves it kept', () => {
  const row = { sessionId: 's', userUuid: U1, messageId: 'qm-9' }
  it('accepts the failed bubble of that line and lists it as settled', () => {
    const before = [bubble({ status: 'failed', failedError: 'lost' }), bubble({ queueId: 'temp-2', userUuid: U2, status: 'failed' })]
    const { next, settled } = applyLateKept(before, row)
    expect(next[0]).toMatchObject({ queueId: 'qm-9', status: 'received' })
    expect(next[0].failedError).toBeUndefined()
    expect(next[1]).toBe(before[1])
    expect(settled).toEqual([before[0]])
  })
  it('never revives a bubble the server reported undelivered, nor a parked one', () => {
    const before = [bubble({ status: 'failed', serverUndelivered: true }), bubble({ status: 'failed', parked: true })]
    const out = applyLateKept(before, row)
    expect(out.next).toBe(before)
    expect(out.settled).toEqual([])
  })
  it('leaves a send still waiting on its answer to that answer', () => {
    const before = [bubble({ status: 'pending' })]
    expect(applyLateKept(before, row).next).toBe(before)
  })
  it('a kept row read as taken makes it Delivered', () => {
    expect(applyLateKept([bubble({ status: 'failed' })], { ...row, delivered: true }).next[0].status).toBe('delivered')
  })
})

describe('shownSendError: the red line goes with its send', () => {
  it('shows while its send is failed, and goes once that send is accepted', () => {
    const err = { text: 'Acceptance acknowledgement was lost', userUuid: U1 }
    expect(shownSendError(err, [bubble({ status: 'failed' })])).toBe(err.text)
    expect(shownSendError(err, [bubble({ status: 'received', queueId: 'qm-1' })])).toBeNull()
    expect(shownSendError(err, [])).toBeNull()
  })
  it('an earlier failure still failed does not keep a later accepted send\'s line', () => {
    const err = { text: 'second', userUuid: U2 }
    expect(shownSendError(err, [bubble({ status: 'failed' }), bubble({ userUuid: U2, status: 'delivered' })])).toBeNull()
  })
  it('an error with no send (a paste upload) stays', () => {
    expect(shownSendError({ text: 'Large paste upload failed' }, [])).toBe('Large paste upload failed')
    expect(shownSendError(null, [])).toBeNull()
  })
})

describe('sendSessionMessage: accepted means the answer, or the server holding the line', () => {
  it('a plain answer, with a user line minted for it', async () => {
    const res = await sendSessionMessage({ sessionId: 's-ok', message: 'hello' })
    expect(res.messageId).toBe('qm-1')
    expect(res.recovered).toBeUndefined()
    expect(ws.sends[0].userUuid).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('a lost answer: the queue read finds the line, and the send resolves accepted', async () => {
    ws.sendAnswer = 'lost'
    const res = await sendSessionMessage({ sessionId: 's-lost', message: 'hello', userUuid: U1 })
    expect(res).toMatchObject({ messageId: 'qm-1', recovered: { messageId: 'qm-1', userUuid: U1 } })
    expect(keptRowOf('s-lost', U1)?.messageId).toBe('qm-1')
  })
  it('a lost answer after the queued event: no queue read needed', async () => {
    // The listener is in place since the first send of this file.
    ws.sendAnswer = 'refused'
    const U3 = '33333333-3333-4333-8333-333333333333'
    ws.events.get('session:message-queued')!({ sessionId: 's-event', messageId: 'qm-ev', userUuid: U3 })
    const res = await sendSessionMessage({ sessionId: 's-event', message: 'hi', userUuid: U3 })
    expect(res.messageId).toBe('qm-ev')
    expect(ws.queueReads).toBe(0)
  })
  it('a real refusal: nothing holds the line, the error stands', async () => {
    ws.sendAnswer = 'refused'
    await expect(sendSessionMessage({ sessionId: 's-no', message: 'hi', userUuid: U1 })).rejects.toThrow('Session is not running')
    expect(ws.queueReads).toBe(1)
  })
  it('an engine switch\'s send keeps no line, so its error is final', async () => {
    ws.sendAnswer = 'lost'
    await expect(sendSessionMessage({ sessionId: 's-sw', message: 'hi', switchEngine: { engine: 'codex' } })).rejects.toThrow()
    expect(ws.sends[0].userUuid).toBeUndefined()
    expect(ws.queueReads).toBe(0)
  })
  it('a slow answer counts as lost when the caller set a deadline', async () => {
    vi.useFakeTimers()
    try {
      const slow = new Promise<never>(() => {})
      const orig = (await import('@/api/ws')).wsClient.sendRpc
      const client = (await import('@/api/ws')).wsClient as { sendRpc: typeof orig }
      client.sendRpc = (async (method: string, payload: Record<string, unknown>) => {
        if (method === 'session:send') { ws.queue.push({ id: 'qm-slow', message: 'x', status: 'processing', userUuid: payload.userUuid }); return slow }
        return orig(method, payload)
      }) as typeof orig
      const p = sendSessionMessage({ sessionId: 's-slow', message: 'x', userUuid: U1 }, { timeoutMs: 15_000 })
      await vi.advanceTimersByTimeAsync(15_001)
      await expect(p).resolves.toMatchObject({ messageId: 'qm-slow', alreadyDelivered: true })
      client.sendRpc = orig
    } finally { vi.useRealTimers() }
  })
})

describe('the kept record', () => {
  it('tells a listener once per change, and confirmKept reads it first', async () => {
    const seen: string[] = []
    const off = onKept((r) => seen.push(`${r.messageId}:${r.delivered ? 'd' : 'q'}`))
    noteKept({ sessionId: 's-rec', userUuid: U1, messageId: 'qm-r' })
    noteKept({ sessionId: 's-rec', userUuid: U1, messageId: 'qm-r' })
    noteKept({ sessionId: 's-rec', userUuid: U1, messageId: 'qm-r', delivered: true })
    off()
    expect(seen).toEqual(['qm-r:q', 'qm-r:d'])
    expect((await confirmKept('s-rec', U1))?.messageId).toBe('qm-r')
    expect(ws.queueReads).toBe(0)
  })
  it('a queue row of another line proves nothing', async () => {
    ws.queue = [{ id: 'qm-x', message: 'other', status: 'pending', userUuid: U2 }]
    expect(await confirmKept('s-other', U1)).toBeUndefined()
  })
})
