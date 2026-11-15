/**
 * Saved inbox items and receipts that zod 4.3 read must still read under the zod
 * Walnut runs now. zod 4.5 refuses minute-only times and counts string length in
 * code points; normalizeItems() hides an item that fails its schema ("Invalid saved
 * email item"), so a stricter rule would quietly take a saved email's actions away.
 * The real store is checked by persisted-items-real-data.live.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { normalizeItems } from '../../../src/core/human-inbox/item-schema.js'

const source = { kind: 'mail', account: 'imap:acct1', message: 'INBOX:1:42' }
const receipt = (over: Record<string, unknown> = {}) => ({
  actionId: 'it1-read', requestId: 'rq1', planId: 'plan1', planVersion: 1, revision: 1,
  updatedAt: '2026-10-22T12:30Z', status: 'success', intent: 'mark_read', source, input: {},
  stage: 'finished', recovery: [], startedAt: '2026-10-22T12:29+02:00',
  attempts: [{ requestId: 'rq1', status: 'success', updatedAt: '2026-10-22T12:30-00:00' }], ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  id: 'it1', subject: 'Invoice', summary: 'A bill from the gym', source,
  display: { sender: { name: 'Gym', address: 'billing@example.com' }, sentAt: '2026-10-22T12:30Z' },
  readObservation: { read: false, observedAt: '2024-02-29T23:59+05:30' },
  actions: [{ id: 'it1-read', kind: 'op', intent: 'mark_read' }], ...over,
})

describe('saved inbox items under the current zod', () => {
  it('a minute-only time in an item and its receipts still reads, with :00 seconds', () => {
    const [read] = normalizeItems([{ ...item(), receipts: [receipt()] }])!
    expect(read.unavailableReason).toBeUndefined()
    expect(read.actions).toHaveLength(1)
    expect(read.display?.sentAt).toBe('2026-10-22T12:30:00Z')
    expect(read.readObservation?.observedAt).toBe('2024-02-29T23:59:00+05:30')
    expect(read.receipts?.[0].updatedAt).toBe('2026-10-22T12:30:00Z')
    expect(read.receipts?.[0].startedAt).toBe('2026-10-22T12:29:00+02:00')
    expect(read.receipts?.[0].attempts?.[0].updatedAt).toBe('2026-10-22T12:30:00-00:00')
  })

  it('a time with seconds reads unchanged', () => {
    const [read] = normalizeItems([item({ display: { sentAt: '2026-10-23T00:52:26Z' }, readObservation: { read: true, observedAt: '2026-10-23T00:55:09.802Z' } })])!
    expect(read.display?.sentAt).toBe('2026-10-23T00:52:26Z')
    expect(read.readObservation?.observedAt).toBe('2026-10-23T00:55:09.802Z')
  })

  it('lengths count UTF-16 units, as when they were saved', () => {
    const emoji = '\u{1F4E7}' // 1 code point, 2 UTF-16 units
    const atMax = emoji.repeat(500) // 1000 units: the subject's limit
    const [kept] = normalizeItems([item({ subject: atMax })])!
    expect(kept.unavailableReason).toBeUndefined()
    expect(kept.subject).toBe(atMax)
    // One unit over is refused, as zod 4.3 refused it, though it is only 501 code points.
    const [over] = normalizeItems([item({ subject: `${atMax}x` })])!
    expect(over.unavailableReason).toBe('Invalid saved email item')
  })

  it('a malformed time still marks the item, as before', () => {
    const [bad] = normalizeItems([item({ display: { sentAt: '2026-10-22 12:30' } })])!
    expect(bad.unavailableReason).toBe('Invalid saved email item')
    const [badReceipt] = normalizeItems([{ ...item(), receipts: [receipt({ updatedAt: 'yesterday' })] }])!
    expect(badReceipt.unavailableReason).toBe('Invalid saved execution receipt')
  })
})
