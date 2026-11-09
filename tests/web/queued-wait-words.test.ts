/**
 * The words a queued bubble shows (web/src/components/sessions/queued-wait.ts,
 * queued-change-words.ts).
 *
 * 2026-11-09, the user: bubbles read a bare QUEUED for ~40 minutes with no
 * reason, and a Delete on one the session had already taken raised a red error
 * toast. A long wait says why and how long; a Delete or Edit that came too late
 * says so in place.
 */
import { describe, it, expect } from 'vitest'
import { leftQueueLine, queuedWaitLine, waitedFor, QUEUED_WHY_AFTER_MS } from '@/components/sessions/queued-wait'
import { queuedChangeResult } from '@/components/sessions/queued-change-words'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { LeftQueueNote, QueuedWaitNote } from '@/components/sessions/QueuedRowNotes'

const T0 = Date.parse('2026-11-09T10:00:00.000Z')
const at = (msAgo: number) => new Date(T0 - msAgo).toISOString()

describe('queuedWaitLine', () => {
  it('a young waiting bubble says nothing; past the bound it says why and how long', () => {
    expect(queuedWaitLine({ status: 'received', timestamp: at(QUEUED_WHY_AFTER_MS - 1) }, { now: T0, turnRunning: false })).toBeNull()
    const line = queuedWaitLine({ status: 'received', timestamp: at(3 * 60_000) }, { now: T0, turnRunning: false })
    expect(line).toContain('Not sent yet: the session has not taken it.')
    expect(line).toContain('Queued 3 min ago.')
    expect(line).toContain('Walnut sends it when the session is ready')
  })

  it('names the reason it can know', () => {
    const old = { status: 'received', timestamp: at(2 * 60_000) }
    expect(queuedWaitLine({ ...old, afterTurn: true }, { now: T0, turnRunning: true })).toMatch(/^Waiting for the current turn to end\. Queued 2 min ago\./)
    expect(queuedWaitLine(old, { now: T0, turnRunning: true })).toMatch(/busy with a turn/)
    expect(queuedWaitLine(old, { now: T0, turnRunning: false, syncError: 'no answer in 15 s' })).toContain('could not read its queue to check (no answer in 15 s)')
    // The server's own reason shows in the held note: this adds only how long.
    expect(queuedWaitLine({ ...old, heldReason: 'Waiting to confirm the previous message' }, { now: T0, turnRunning: false })).toBe('Queued 2 min ago.')
  })

  it('never for a bubble that is not waiting', () => {
    for (const status of ['delivered', 'failed']) {
      expect(queuedWaitLine({ status, timestamp: at(10 * 60_000) }, { now: T0, turnRunning: false })).toBeNull()
    }
  })

  it('waitedFor reads in plain units', () => {
    expect(waitedFor(45_000)).toBe('45 s')
    expect(waitedFor(3 * 60_000 + 10_000)).toBe('3 min')
    expect(waitedFor(125 * 60_000)).toBe('2 h 5 min')
    expect(waitedFor(120 * 60_000)).toBe('2 h')
  })
})

describe('leftQueueLine', () => {
  it('a bubble that left the queue and that history still lacks says so after the bound', () => {
    expect(leftQueueLine({ status: 'delivered', leftQueueAt: T0 - 10_000 }, T0)).toBeNull()
    expect(leftQueueLine({ status: 'delivered', leftQueueAt: T0 - 61_000 }, T0)).toMatch(/no longer has this message queued/)
    expect(leftQueueLine({ status: 'delivered' }, T0)).toBeNull()
  })
})

describe('queuedChangeResult', () => {
  it('Delete: done or gone removes the bubble; taken says so in place and reads Delivered', () => {
    expect(queuedChangeResult('delete', { ok: true })).toMatchObject({ remove: true })
    expect(queuedChangeResult('delete', { ok: false, outcome: 'gone' })).toMatchObject({ remove: true })
    const taken = queuedChangeResult('delete', { ok: false, outcome: 'taken' })
    expect(taken).toMatchObject({ remove: false, delivered: true })
    expect(taken.notice).toBe('Already sent to the session, so it can’t be deleted now.')
  })

  it('Delete: a queue that did not answer keeps the bubble Queued and says to try again', () => {
    const r = queuedChangeResult('delete', { ok: false, outcome: 'unavailable', error: 'lock timeout' })
    expect(r).toMatchObject({ remove: false, delivered: false })
    expect(r.notice).toContain('(lock timeout)')
    // An older server threw its refusal; that is no error either.
    expect(queuedChangeResult('delete', undefined, 'Message not deletable (already processing or not found)').notice).toMatch(/already on its way/)
  })

  it('Edit: a refused edit shows the words the row still has', () => {
    expect(queuedChangeResult('edit', { ok: true })).toMatchObject({ revertText: false })
    expect(queuedChangeResult('edit', { ok: false, outcome: 'taken' })).toMatchObject({ revertText: true, delivered: true })
    expect(queuedChangeResult('edit', { ok: false, outcome: 'gone' })).toMatchObject({ revertText: true, delivered: false })
  })
})

describe('the notes as drawn (QueuedRowNotes)', () => {
  const noop = () => {}
  const left = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(LeftQueueNote, {
    m: { status: 'delivered', leftQueueAt: Date.now() - 5 * 60_000 }, turnRunning: false, quietSince: 0, onSendAgain: noop, onDismiss: noop, ...over,
  }))

  it('a bubble that left the queue says it is missing only while the session is quiet, and only well after it went quiet', () => {
    expect(left({})).toContain('no longer has this message queued')
    expect(left({})).toContain('Send again')
    // A message steered into a running turn is not in history until the turn is saved.
    expect(left({ turnRunning: true })).toBe('')
    // The turn just ended: history is being read again.
    expect(left({ quietSince: Date.now() - 5_000 })).toBe('')
  })

  it('a waiting bubble past the bound draws its why with Send now; one waiting for the turn has no Send now', () => {
    const old = new Date(Date.now() - 3 * 60_000).toISOString()
    const html = renderToStaticMarkup(createElement(QueuedWaitNote, { m: { queueId: 'qm-1', status: 'received', timestamp: old }, turnRunning: false, sending: false, onSendNow: noop }))
    expect(html).toContain('Not sent yet')
    expect(html).toContain('Send now')
    const afterTurn = renderToStaticMarkup(createElement(QueuedWaitNote, { m: { queueId: 'qm-1', status: 'received', timestamp: old, afterTurn: true }, turnRunning: true, sending: false, onSendNow: noop }))
    expect(afterTurn).toContain('Waiting for the current turn to end')
    expect(afterTurn).not.toContain('Send now')
  })
})
