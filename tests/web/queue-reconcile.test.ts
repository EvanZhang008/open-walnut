/**
 * Queued bubbles follow the server's queue (web/src/hooks/queue-reconcile.ts).
 *
 * 2026-11-09, the user: "everything shows queued, why does every session freeze
 * without any warning" and "the newer message is delivered but the older one is
 * still queued". The queue file lock jammed for ~40 minutes; rows were delivered,
 * taken or gone while each panel kept the Queued badge it drew at send time.
 */
import { describe, it, expect } from 'vitest'
import { adoptSendAnswer, orderByEnqueue, reconcileWithQueue, rowVerdict, type ReconcileContext } from '@/hooks/queue-reconcile'
import { queueRowBubble, type QueueRowWire } from '@/hooks/useSessionSend'
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory'

const bubble = (id: string, over: Partial<OptimisticMessage> = {}): OptimisticMessage => ({
  role: 'user', text: `text ${id}`, timestamp: '2026-11-09T10:00:00.000Z', queueId: id, status: 'received', ...over,
})
const row = (id: string, over: Partial<QueueRowWire> = {}): QueueRowWire => ({
  id, message: `text ${id}`, status: 'pending', stage: 'waiting', delivered: false, enqueuedAt: '2026-11-09T10:00:00.000Z', ...over,
})
const ctx = (over: Partial<ReconcileContext> = {}): ReconcileContext => ({
  known: new Set(), touched: new Set(), retired: new Set(), now: 1_000, toBubble: queueRowBubble, ...over,
})
const statusOf = (list: OptimisticMessage[]) => Object.fromEntries(list.map((m) => [m.queueId, m.status]))

describe('rowVerdict', () => {
  it('only a row that really waits reads waiting', () => {
    expect(rowVerdict(row('a')).kind).toBe('waiting')
    // A processing row the server cannot vouch for as written still waits (a cold resume, a line mid-delivery).
    expect(rowVerdict(row('a', { status: 'processing', stage: 'waiting' })).kind).toBe('waiting')
    // An older server sends no stage: its processing row is on its way.
    expect(rowVerdict(row('a', { status: 'processing', stage: undefined })).kind).toBe('sent')
    expect(rowVerdict(row('a', { status: 'processing', stage: 'written' })).kind).toBe('sent')
    expect(rowVerdict(row('a', { status: 'processing', stage: 'taken', delivered: true })).kind).toBe('sent')
    // The runner's word wins over a queue file whose status write timed out.
    expect(rowVerdict(row('a', { status: 'pending', stage: 'taken', delivered: true })).kind).toBe('sent')
    expect(rowVerdict(row('a', { status: 'processing', heldReason: 'Waiting to confirm the previous message' }))).toEqual({ kind: 'waiting', heldReason: 'Waiting to confirm the previous message' })
    expect(rowVerdict(row('a', { afterTurn: true }))).toEqual({ kind: 'waiting', afterTurn: true })
    expect(rowVerdict(row('a', { status: 'parked', parkedReason: 'folder gone' }))).toEqual({ kind: 'parked', reason: 'folder gone' })
  })
})

describe('reconcileWithQueue', () => {
  it('the older bubble still drawn Queued turns Delivered once its row is taken, with no event for it', () => {
    const prev = [bubble('qm-old'), bubble('qm-new', { status: 'delivered', timestamp: '2026-11-09T10:01:00.000Z' })]
    const rows = [row('qm-old', { status: 'processing', stage: 'taken', delivered: true }), row('qm-new', { status: 'processing', stage: 'written', enqueuedAt: '2026-11-09T10:01:00.000Z' })]
    const next = reconcileWithQueue(prev, rows, ctx({ known: new Set(['qm-old', 'qm-new']) }))
    expect(statusOf(next)).toEqual({ 'qm-old': 'delivered', 'qm-new': 'delivered' })
  })

  it('a bubble whose row is gone leaves the queued list, marked so history is read for it', () => {
    const next = reconcileWithQueue([bubble('qm-a')], [], ctx({ known: new Set(['qm-a']), now: 5_000 }))
    expect(next[0]).toMatchObject({ queueId: 'qm-a', status: 'delivered', leftQueueAt: 5_000 })
  })

  it('a row the read could not have seen is never judged gone', () => {
    // Adopted after the read began (not known), or moved by an event since.
    expect(reconcileWithQueue([bubble('qm-a')], [], ctx())[0].status).toBe('received')
    expect(reconcileWithQueue([bubble('qm-a')], [], ctx({ known: new Set(['qm-a']), touched: new Set(['qm-a']) }))[0].status).toBe('received')
    // A send still waiting for its answer has no server id at all.
    expect(reconcileWithQueue([bubble('temp-1', { status: 'pending' })], [], ctx({ known: new Set(['temp-1']) }))[0].status).toBe('pending')
  })

  it('a Delivered bubble whose row waits again reads Queued again (the event that said so was lost), unless an event moved it since the read began', () => {
    const prev = [bubble('qm-a', { status: 'delivered' })]
    expect(reconcileWithQueue(prev, [row('qm-a')], ctx({ known: new Set(['qm-a']) }))[0].status).toBe('received')
    expect(reconcileWithQueue(prev, [row('qm-a')], ctx({ known: new Set(['qm-a']), touched: new Set(['qm-a']) }))).toBe(prev)
    // A row that is only written or taken stays Delivered.
    expect(reconcileWithQueue(prev, [row('qm-a', { status: 'processing', stage: 'written' })], ctx({ known: new Set(['qm-a']) }))).toBe(prev)
  })

  // Review of 2026-11-09: an older read that says written must not undo a newer delivery-held event.
  it('a read older than the event that held the row never turns it Delivered or drops its reason', () => {
    const prev = [bubble('qm-a', { status: 'received', heldReason: 'Not sent yet: the host did not take it' })]
    const read = [row('qm-a', { status: 'processing', stage: 'written' })]
    expect(reconcileWithQueue(prev, read, ctx({ known: new Set(['qm-a']), touched: new Set(['qm-a']) }))).toBe(prev)
    expect(reconcileWithQueue(prev, read, ctx({ known: new Set(['qm-a']) }))[0].status).toBe('delivered')
  })

  it('a waiting row keeps its bubble Queued and carries the server reason', () => {
    const next = reconcileWithQueue([bubble('qm-a')], [row('qm-a', { status: 'processing', heldReason: 'Not sent yet: the host did not take it' })], ctx({ known: new Set(['qm-a']) }))
    expect(next[0]).toMatchObject({ status: 'received', heldReason: 'Not sent yet: the host did not take it' })
    const after = reconcileWithQueue([bubble('qm-b')], [row('qm-b', { afterTurn: true })], ctx({ known: new Set(['qm-b']) }))
    expect(after[0]).toMatchObject({ status: 'received', afterTurn: true })
  })

  it('a parked row turns its bubble failed, and a parked bubble whose row is gone goes', () => {
    const next = reconcileWithQueue([bubble('qm-a')], [row('qm-a', { status: 'parked', parkedReason: 'folder gone' })], ctx({ known: new Set(['qm-a']) }))
    expect(next[0]).toMatchObject({ status: 'failed', parked: true, failedError: 'folder gone' })
    expect(reconcileWithQueue(next, [], ctx({ known: new Set(['qm-a']) }))).toEqual([])
  })

  it('a failed bubble keeps its Retry while its row waits, and is revived once the row is sent', () => {
    const failed = [bubble('qm-a', { status: 'failed', failedError: 'timeout' })]
    expect(reconcileWithQueue(failed, [row('qm-a')], ctx({ known: new Set(['qm-a']) }))).toBe(failed)
    const sent = reconcileWithQueue(failed, [row('qm-a', { status: 'processing', stage: 'written' })], ctx({ known: new Set(['qm-a']) }))
    expect(sent[0].status).toBe('delivered')
    expect(sent[0].failedError).toBeUndefined()
  })

  it('rows the panel has no bubble for are added, but never ones it retired or the CLI already read', () => {
    const next = reconcileWithQueue([], [row('qm-a'), row('qm-b'), row('qm-c', { status: 'processing', stage: 'taken', delivered: true })], ctx({ retired: new Set(['qm-b']) }))
    expect(next.map((m) => m.queueId)).toEqual(['qm-a'])
  })

  it('returns the same list when nothing changed (no re-render)', () => {
    const prev = [bubble('qm-a')]
    expect(reconcileWithQueue(prev, [row('qm-a')], ctx({ known: new Set(['qm-a']) }))).toBe(prev)
  })

  it('lists the bubbles in the order they were enqueued, as the server does', () => {
    // A reload read rows enqueued BEFORE a send this tab made meanwhile.
    const prev = [bubble('qm-mine', { timestamp: '2026-11-09T10:05:00.000Z' })]
    const rows = [row('qm-first', { enqueuedAt: '2026-11-09T10:01:00.000Z' }), row('qm-second', { enqueuedAt: '2026-11-09T10:02:00.000Z' }), row('qm-mine', { enqueuedAt: '2026-11-09T10:05:00.000Z' })]
    const next = reconcileWithQueue(prev, rows, ctx())
    expect(next.map((m) => m.queueId)).toEqual(['qm-first', 'qm-second', 'qm-mine'])
  })
})

// Review of 2026-11-09: a panel opened in a cold resume read the row Delivered and never polled.
describe('queueRowBubble reads a row as rowVerdict does', () => {
  it('a processing row the server says still waits shows Queued; a written one Delivered; an older server by status', () => {
    expect(queueRowBubble(row('a', { status: 'processing', stage: 'waiting' }))?.status).toBe('received')
    expect(queueRowBubble(row('a', { status: 'processing', stage: 'written' }))?.status).toBe('delivered')
    expect(queueRowBubble(row('a', { status: 'processing', stage: undefined }))?.status).toBe('delivered')
    expect(queueRowBubble(row('a', { status: 'processing', heldReason: 'Waiting to confirm the previous message' }))).toMatchObject({ status: 'received', heldReason: 'Waiting to confirm the previous message' })
    expect(queueRowBubble(row('a', { status: 'parked', parkedReason: 'folder gone' }))).toMatchObject({ status: 'failed', parked: true, failedError: 'folder gone' })
    expect(queueRowBubble(row('a'))?.status).toBe('received')
  })

  it('every row shape gets the same badge from a reload and from a later read', () => {
    const shapes: Partial<QueueRowWire>[] = []
    for (const status of ['pending', 'processing', 'parked'] as const)
      for (const stage of [undefined, 'waiting', 'written'] as const)
        for (const heldReason of [undefined, 'held']) shapes.push({ status, stage, heldReason })
    for (const shape of shapes) {
      const r = row('x', shape)
      const fromReload = queueRowBubble(r)
      const fromRead = reconcileWithQueue([bubble('x', { status: 'received' })], [r], ctx({ known: new Set(['x']) }))[0]
      expect([JSON.stringify(shape), fromReload?.status]).toEqual([JSON.stringify(shape), fromRead.status])
    }
  })
})

describe('orderByEnqueue', () => {
  it('launch prompt first, unanswered sends last in the order made, the rest by enqueue time', () => {
    const list = [
      bubble('temp-2', { status: 'pending', timestamp: '2026-11-09T09:00:00.000Z' }),
      bubble('qm-late', { timestamp: '2026-11-09T10:02:00.000Z' }),
      bubble('launch-1', { launch: true, status: 'delivered', timestamp: '2026-11-09T10:09:00.000Z' }),
      bubble('qm-early', { timestamp: '2026-11-09T10:01:00.000Z' }),
      bubble('temp-3', { status: 'pending' }),
    ]
    expect(orderByEnqueue(list).map((m) => m.queueId)).toEqual(['launch-1', 'qm-early', 'qm-late', 'temp-2', 'temp-3'])
  })

  it('same enqueue time: the server row order decides', () => {
    const list = [bubble('qm-b'), bubble('qm-a')]
    expect(orderByEnqueue(list, new Map([['qm-a', 0], ['qm-b', 1]])).map((m) => m.queueId)).toEqual(['qm-a', 'qm-b'])
  })

  it('an ordered list comes back as itself', () => {
    const list = [bubble('qm-a', { timestamp: '2026-11-09T10:01:00.000Z' }), bubble('qm-b', { timestamp: '2026-11-09T10:02:00.000Z' })]
    expect(orderByEnqueue(list)).toBe(list)
  })
})

describe('adoptSendAnswer', () => {
  it('a queue read that answered before the send keeps no second bubble for the row', () => {
    // The read found the new row and drew it; then the send answered with that id.
    const mine = bubble('temp-1', { status: 'pending', text: 'hello', images: [{ data: 'x', mediaType: 'image/png' } as never] })
    const readCopy = bubble('qm-9', { text: 'hello' })
    const next = adoptSendAnswer([mine, readCopy], 'temp-1', { messageId: 'qm-9', enqueuedAt: '2026-11-09T10:00:05.000Z' }, 'received')
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ queueId: 'qm-9', status: 'received', timestamp: '2026-11-09T10:00:05.000Z' })
    expect(next[0].images).toHaveLength(1)
  })

  it('a copy the read already saw sent keeps the bubble delivered', () => {
    const next = adoptSendAnswer([bubble('temp-1', { status: 'pending' }), bubble('qm-9', { status: 'delivered' })], 'temp-1', { messageId: 'qm-9' }, 'received')
    expect(next.map((m) => [m.queueId, m.status])).toEqual([['qm-9', 'delivered']])
  })

  it('a retry that keeps its id changes only that bubble', () => {
    const prev = [bubble('qm-1', { status: 'pending' }), bubble('qm-2')]
    expect(adoptSendAnswer(prev, 'qm-1', { messageId: 'qm-1' }, 'received').map((m) => m.status)).toEqual(['received', 'received'])
  })
})
