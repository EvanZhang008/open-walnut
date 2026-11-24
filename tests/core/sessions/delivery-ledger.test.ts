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
  DELIVERY_LEDGER_DIR, START_LINE_PREFIX, onDeliveryEvent, pruneDeliveryLedger, readDeliveryLines, recordDelivery, setDeliveryTaskResolver, trailsOf, withStartLine,
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

  it('a message still waiting says for how many minutes, held, parked or queued; one that went on does not', () => {
    const by = Object.fromEntries(trailsOf([
      { at: t(0), step: 'held', id: 'mid-w', sessionId: 's1' },
      { at: t(10), step: 'queued', id: 'qm-c' }, { at: t(15), step: 'parked', id: 'qm-c', why: 'held for the session\'s next wake' },
      { at: t(20), step: 'queued', id: 'qm-d' }, { at: t(21), step: 'written', id: 'qm-d' },
    ], Date.parse(t(45))).map((x) => [x.id, x]))
    expect(by['mid-w']).toMatchObject({ state: 'held', waitingMin: 45 })
    expect(by['qm-c']).toMatchObject({ state: 'parked', waitingMin: 30 })
    expect(by['qm-d'].waitingMin).toBeUndefined()
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
    // A row held for a cold session's next wake or a turn's end is parked, with why.
    const queue = await fs.readFile('src/core/session-message-queue.ts', 'utf-8')
    expect(queue).toMatch(/if \(holdsCold \|\| holdsRow\) \{[\s\S]{0,400}step: 'parked', id: msg\.id, sessionId, why/)
  })
})

/**
 * 2026-11-24 audit: a person's words that a raw enqueue or a task's start carried had no row, rows
 * of a session whose task the route could not find had no task, and a Threads reply its task read
 * there stayed `queued` for 20 hours.
 */
describe('every way into a session has its row, with its task', () => {
  it('a row the queue stores is queued there, a raw enqueue too, with who sent it and its task', async () => {
    const { enqueueMessage, resetCache } = await import('../../../src/core/session-message-queue.js')
    resetCache()
    // As the send held behind a permission prompt and a letter's answer queue it: no bus event.
    const raw = await enqueueMessage('s-perm', 'his words', { sentBy: 'person' })
    const sent = await enqueueMessage('s-ui', 'more words', { source: 'ui', taskId: 'task-ui' })
    await settle()
    const by = Object.fromEntries(trailsOf(await readDeliveryLines(1)).map((x) => [x.id, x]))
    expect(by[raw.id]).toMatchObject({ state: 'queued', sessionId: 's-perm' })
    expect(by[raw.id].steps[0].source).toBe('person')
    expect(by[sent.id]).toMatchObject({ state: 'queued', sessionId: 's-ui', taskId: 'task-ui' })
    // The queue's own event says so, and is not recorded twice; a host's forwarded one still is.
    await onDeliveryEvent(ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 's-ui', messageId: sent.id, source: 'ui', ledgered: true }))
    await onDeliveryEvent({ name: EventNames.SESSION_MESSAGE_QUEUED, data: { sessionId: 's-host', messageId: 'qm-host-1', ledgered: true }, source: 'host-channel', timestamp: Date.now() } as never)
    const lines = await readDeliveryLines(1)
    expect(lines.filter((l) => l.id === sent.id && l.step === 'queued')).toHaveLength(1)
    expect(lines.filter((l) => l.id === 'qm-host-1' && l.step === 'queued')).toHaveLength(1)
  })

  it('a step that names no task gets its session\'s, so ?task= finds it after its session is gone', async () => {
    setDeliveryTaskResolver(async (sid) => (sid === 's-pi' ? 'mtaskpi-0001' : undefined))
    try {
      await onDeliveryEvent(ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 's-pi', messageId: 'qm-pi', source: 'ui' }))
      await onDeliveryEvent(ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: 's-pi', count: 1, messageIds: ['qm-pi'] }))
      await recordDelivery({ step: 'queued', id: 'qm-other', sessionId: 's-other' })
    } finally { setDeliveryTaskResolver(null) }
    const lines = await readDeliveryLines(1)
    expect(lines.filter((l) => l.id === 'qm-pi').map((l) => l.taskId)).toEqual(['mtaskpi-0001', 'mtaskpi-0001'])
    expect(lines.find((l) => l.id === 'qm-other')?.taskId).toBeUndefined()
  })

  it('a task\'s first line, carried by its start: written once the start has its id, read when the CLI starts it', async () => {
    const commits: string[] = []
    const base = { data: {}, commit: async (sid: string) => { commits.push(sid) } }
    // With the uuid the start gave, and without one (the first line read with no queue row).
    await withStartLine(base, { message: 'a first question', taskId: 'mtaskfirst-1', attributionSource: 'ui', firstLineUuid: 'u-first' }, 'web-ui', false).commit('s-new')
    await withStartLine(base, { message: 'another first question', taskId: 'mtasktwo-1', attributionSource: 'mobile' }, undefined, false).commit('s-two')
    // An ACP start's first line is a queue row (recorded where the queue stores it); an init-only start has none.
    await withStartLine(base, { message: 'hi', taskId: 't-acp' }, 'ui', true).commit('s-acp')
    await withStartLine(base, { message: '  ', taskId: 't-init' }, 'ui', false).commit('s-init')
    expect(commits).toEqual(['s-new', 's-two', 's-acp', 's-init'])
    await settle()
    await onDeliveryEvent(ev(EventNames.SESSION_USER_LINE, { sessionId: 's-new', uuid: 'u-first', taskId: 'mtaskfirst-1' }))
    await onDeliveryEvent(ev(EventNames.SESSION_USER_LINE, { sessionId: 's-two', uuid: 'u-cli', taskId: 'mtasktwo-1' }))
    // A later line with no row of the same session is not that first line again.
    await onDeliveryEvent(ev(EventNames.SESSION_USER_LINE, { sessionId: 's-two', uuid: 'u-later' }))
    const trails = trailsOf(await readDeliveryLines(1))
    const starts = trails.filter((x) => x.id.startsWith(START_LINE_PREFIX))
    expect(starts.map((x) => ({ session: x.sessionId, task: x.taskId, state: x.state, from: x.from, reads: x.steps.filter((s) => s.step === 'read').length })).sort((a, b) => a.session!.localeCompare(b.session!))).toEqual([
      { session: 's-new', task: 'mtaskfirst-1', state: 'read', from: 'person', reads: 1 },
      { session: 's-two', task: 'mtasktwo-1', state: 'read', from: 'person', reads: 1 },
    ])
    expect(starts.find((x) => x.sessionId === 's-new')!.steps[0].source).toBe('ui')
  })

  it('a read long after a start with no uuid is not its first line read (2026-11-24 review)', () => {
    const trails = trailsOf([
      { at: t(0), step: 'written', id: `${START_LINE_PREFIX}s-late-1`, sessionId: 's-late' },
      // A line typed in the terminal an hour later, with no queue row.
      { at: t(60), step: 'read', sessionId: 's-late' },
    ], Date.parse(t(61)))
    expect(trails.find((x) => x.id === `${START_LINE_PREFIX}s-late-1`)!.state).toBe('written')
  })

  it('a session whose task is not known yet is looked up again soon, not left with no task for 10 minutes', async () => {
    let known = false
    setDeliveryTaskResolver(async () => (known ? 'mtasknew-0001' : undefined))
    // The clock moves by hand (only Date): the miss is kept 5 seconds.
    const real = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(real)
    try {
      await recordDelivery({ step: 'queued', id: 'qm-new-1', sessionId: 's-new-task' })
      known = true
      now.mockReturnValue(real + 5_100)
      await recordDelivery({ step: 'written', id: 'qm-new-1', sessionId: 's-new-task' })
    } finally { now.mockRestore(); setDeliveryTaskResolver(null) }
    const lines = (await readDeliveryLines(1)).filter((l) => l.id === 'qm-new-1')
    expect(lines.map((l) => l.taskId)).toEqual([undefined, 'mtasknew-0001'])
  })

  it('a Threads reply its task read there reads `read`, not queued for ever', () => {
    const by = Object.fromEntries(trailsOf([
      { at: t(0), step: 'queued', id: 'qm-reply-0001', sessionId: 's1', source: 'ui' },
      { at: t(0), step: 'parked', id: 'qm-reply-0001', sessionId: 's1', why: 'held for the end of the running turn' },
      { at: t(1), step: 'cancelled', id: 'qm-reply-0001', sessionId: 's1' },
      { at: t(1), step: 'read', ids: ['qm-reply-0001'], via: 'threads', sessionId: 's1', taskId: 'mtaskowner' },
    ], Date.parse(t(1200))).map((x) => [x.id, x]))
    expect(by['qm-reply-0001']).toMatchObject({ state: 'read', taskId: 'mtaskowner' })
    expect(by['qm-reply-0001'].waitingMin).toBeUndefined()
  })
})
