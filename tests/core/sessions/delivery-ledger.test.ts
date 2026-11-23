/**
 * The delivery ledger (src/core/sessions/delivery-ledger.ts; 2026-11-23 audit: "delivered" meant
 * only that the server took a message, and one lost message took a read of 650 MB of logs): each
 * step of a message is one line, the bus events of the queue and the CLI are recorded by one
 * subscriber, a held note (kept on disk by held-notices-store.ts) is where the queue row that carried
 * it is or dropped with why, and old days are pruned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-delivery-ledger'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { EventNames } from '../../../src/core/event-bus.js'
import { DROP_WHY, _clearHeldNotices, dropParts, pendingHeldNotices } from '../../../src/core/sessions/held-notices.js'
import { _resetHeldStoreForTesting } from '../../../src/core/sessions/held-notices-store.js'
import { holdQuietNote } from '../../../src/core/sessions/quiet-notes.js'
import {
  DELIVERY_LEDGER_DIR, onDeliveryEvent, pruneDeliveryLedger, readDeliveryLines, recordDelivery, trailsOf,
  type DeliveryLine,
} from '../../../src/core/sessions/delivery-ledger.js'

const ev = (name: string, data: unknown) => ({ name, data, timestamp: Date.now() }) as never
const t = (min: number) => new Date(Date.parse('2026-11-23T10:00:00Z') + min * 60_000).toISOString()

const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  await _resetHeldStoreForTesting()
  _clearHeldNotices()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the steps of a message', () => {
  it('sent, queued, written and read: read once the CLI started a line carrying it', () => {
    const lines: DeliveryLine[] = [
      { at: t(0), step: 'sent', id: 'qm-1', sessionId: 's1', taskId: 'task-1', from: 'sess-vp', title: 'Fix the card' },
      { at: t(0), step: 'queued', id: 'qm-1', sessionId: 's1' },
      { at: t(1), step: 'written', id: 'qm-1', sessionId: 's1' },
      { at: t(1), step: 'read', sessionId: 's1', lineUuid: 'u-1', ids: ['qm-1'] },
      { at: t(2), step: 'sent', id: 'qm-2', sessionId: 's1' },
      { at: t(2), step: 'queued', id: 'qm-2', sessionId: 's1' },
      { at: t(3), step: 'parked', id: 'qm-2', sessionId: 's1', why: 'the session is stopped' },
      { at: t(4), step: 'queued', id: 'qm-3', sessionId: 's1' },
      { at: t(5), step: 'failed', id: 'qm-3', sessionId: 's1', why: 'resume failed' },
    ]
    const by = Object.fromEntries(trailsOf(lines).map((x) => [x.id, x]))
    expect(by['qm-1']).toMatchObject({ state: 'read', from: 'sess-vp', title: 'Fix the card', taskId: 'task-1' })
    expect(by['qm-2'].state).toBe('parked')
    expect(by['qm-3'].state).toBe('failed')
  })

  it('a held note is where the row that carried it is, dropped with why, and still held across a restart', () => {
    const lines: DeliveryLine[] = [
      { at: t(0), step: 'held', id: 'mid-rode', sessionId: 's1', from: 'sess-vp' },
      { at: t(1), step: 'held', id: 'mid-waits', sessionId: 's1' },
      { at: t(2), step: 'held', id: 'mid-old', sessionId: 's1' },
      { at: t(3), step: 'server_start' },
      { at: t(4), step: 'queued', id: 'qm-9', sessionId: 's1' },
      { at: t(4), step: 'carried', id: 'qm-9', sessionId: 's1', ids: ['mid-rode'] },
      { at: t(5), step: 'written', id: 'qm-9', sessionId: 's1' },
      { at: t(6), step: 'dropped', id: 'mid-old', sessionId: 's1', why: 'it waited 3 days' },
      { at: t(7), step: 'carried', sessionId: 's1', ids: ['mid-nocarrier'] },
    ]
    const by = Object.fromEntries(trailsOf(lines).map((x) => [x.id, x]))
    expect(by['mid-rode']).toMatchObject({ state: 'written', carriedBy: 'qm-9', from: 'sess-vp' })
    expect(by['mid-waits'].state).toBe('held')
    expect(by['mid-old'].state).toBe('dropped')
    expect(by['mid-nocarrier'].state).toBe('carried')
  })
})

describe('the ledger file', () => {
  it('records the bus events of the queue and the CLI', async () => {
    await onDeliveryEvent(ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 's1', messageId: 'qm-1', source: 'peer' }))
    await onDeliveryEvent(ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: 's1', count: 1, messageIds: ['qm-1'] }))
    await onDeliveryEvent(ev(EventNames.SESSION_USER_LINE, { sessionId: 's1', uuid: 'u-1', rowIds: ['qm-1'] }))
    await onDeliveryEvent(ev(EventNames.SESSION_BATCH_FAILED, { sessionId: 's1', messageIds: ['qm-5'], error: 'stopped', parked: true }))
    const lines = await readDeliveryLines(1)
    expect(lines.map((l) => l.step)).toEqual(['queued', 'written', 'read', 'parked'])
    const by = Object.fromEntries(trailsOf(lines).map((x) => [x.id, x]))
    expect(by['qm-1'].state).toBe('read')
    expect(by['qm-5']).toMatchObject({ state: 'parked' })
  })

  it('the hold names the row a note rode and a note it let go (held-notices.ts markTold, dropParts)', async () => {
    await holdQuietNote('s2', { key: 'sess-vp', label: 'VP' }, { at: Date.now(), text: 'a note', mid: 'mid-a', from: 'sess-vp' })
    await holdQuietNote('s2', { key: 'sess-vp', label: 'VP' }, { at: Date.now(), text: 'another', mid: 'mid-b', from: 'sess-vp' })
    const taken = await pendingHeldNotices('s2')
    taken!.markTold('qm-c')
    dropParts('s3', [{ at: Date.now(), text: 'x', mid: 'mid-z' }], DROP_WHY.age)
    await settle()
    const lines = await readDeliveryLines(1)
    expect(lines.find((l) => l.step === 'carried')).toMatchObject({ id: 'qm-c', sessionId: 's2', ids: ['mid-a', 'mid-b'] })
    expect(lines.find((l) => l.step === 'dropped')).toMatchObject({ id: 'mid-z', sessionId: 's3', why: DROP_WHY.age })
  })

  it('a take that was put back records nothing carried', async () => {
    await holdQuietNote('s4', { key: 'k', label: 'K' }, { at: Date.now(), text: 'n', mid: 'mid-p' })
    const taken = await pendingHeldNotices('s4')
    taken!.release()
    await settle()
    expect((await readDeliveryLines(1)).filter((l) => l.step === 'carried')).toEqual([])
  })

  it('a row written and then failed or parked reads as failed or parked, not written', () => {
    const by = Object.fromEntries(trailsOf([
      { at: t(0), step: 'queued', id: 'qm-1' }, { at: t(1), step: 'written', id: 'qm-1' }, { at: t(2), step: 'parked', id: 'qm-1', why: 'stopped' },
    ]).map((x) => [x.id, x]))
    expect(by['qm-1'].state).toBe('parked')
  })

  it('holds no message text, and a torn line is skipped', async () => {
    await recordDelivery({ step: 'sent', id: 'qm-1', title: `a  title\nwith ${'x'.repeat(200)}` })
    const file = path.join(DELIVERY_LEDGER_DIR(), (await fs.readdir(DELIVERY_LEDGER_DIR()))[0])
    await fs.appendFile(file, '{"at":"2026-11-23T1')
    const lines = await readDeliveryLines(1)
    expect(lines).toHaveLength(1)
    expect(lines[0].title).toMatch(/^a title with x+$/)
    expect(lines[0].title!.length).toBeLessThanOrEqual(120)
    expect(Object.keys(lines[0]).sort()).toEqual(['at', 'id', 'step', 'title'])
  })

  it('keeps 14 days', async () => {
    await fs.mkdir(DELIVERY_LEDGER_DIR(), { recursive: true })
    await fs.writeFile(path.join(DELIVERY_LEDGER_DIR(), '2026-11-01.ndjson'), '')
    await fs.writeFile(path.join(DELIVERY_LEDGER_DIR(), '2026-11-20.ndjson'), '')
    await pruneDeliveryLedger(Date.parse('2026-11-23T10:00:00Z'))
    expect((await fs.readdir(DELIVERY_LEDGER_DIR())).sort()).toEqual(['2026-11-20.ndjson'])
  })
})

describe('the send path', () => {
  it('records sent and held (by the note\'s message id) where a task_send ends, carried and dropped where the hold settles a note', async () => {
    const core = await fs.readFile('src/core/sessions/session-send-core.ts', 'utf-8')
    const hold = await fs.readFile('src/core/sessions/held-notices.ts', 'utf-8')
    expect(core).toMatch(/step: 'held', id: noteId, sessionId: targetSid/)
    expect(core).toMatch(/step: 'sent', id: messageId \?\? rowId/)
    expect(hold).toContain("l.recordDelivery({ step: 'carried', ...(row ? { id: row } : {}), sessionId, ids: mids })")
    expect(hold).toContain("l.recordDelivery({ step: 'dropped', id: m.mid, sessionId: sid, why })")
  })
})
