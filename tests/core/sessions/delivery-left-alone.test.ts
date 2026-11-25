/**
 * A message whose target is done, or that left by a way that wrote no step, never reads as waiting
 * for ever (2026-11-25, the Reflection VP's audit: 12 messages read `parked` 31 to 39 hours after
 * they had left every queue, a title-topic notice was held 13.6 hours for a completed task, and
 * parked rows to completed tasks sat in the queue for weeks):
 *  - every row that leaves the queue unsent is recorded (`removed`, or the step its way out names),
 *    a row that moves is `queued` at its new session, a delivered row records nothing more;
 *  - an agent's row parked for a session left alone (archived, its task complete) is retired after
 *    RETIRE_AFTER_MS, recorded `dropped`; a person's words and a hold's own clock stay;
 *  - Walnut's own notices held for a completed task's session drop after the cold hold's max;
 *  - a trail written before reads `removed` once its row or note is gone (settleGone).
 * Real queue file, real bus, real session and task stores in a test home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-delivery-left-alone') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { deleteMessage, enqueueMessage, getQueue, removeProcessed, resetCache, withdrawQueuedLines } from '../../../src/core/session-message-queue.js'
import { dropTransit, landTransit, takeIntoTransit } from '../../../src/core/session-queue-transit.js'
import { parkMessages } from '../../../src/core/session-queue-park.js'
import { mutateStore } from '../../../src/core/session-queue-store.js'
import { _resetQueueExitsForTesting, noteQueueExit } from '../../../src/core/session-queue-exits.js'
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { addTask, updateTask } from '../../../src/core/task-manager.js'
import { COLD_HOLD_REASON, STOP_PARKED_REASON } from '../../../src/core/relay-fates.js'
import { RETIRE_AFTER_MS, retiresWhenLeftAlone, stopDeliveryRetry, sweepDeliveryRetries } from '../../../src/core/sessions/delivery-retry.js'
import { GONE_GRACE_MS, readDeliveryLines, settleGone, startDeliveryLedger, trailsOf, type DeliveryLine } from '../../../src/core/sessions/delivery-ledger.js'
import { _clearHeldNotices } from '../../../src/core/sessions/held-notices.js'
import { holdQuietNote } from '../../../src/core/sessions/quiet-notes.js'
import { _resetHeldStoreForTesting, held } from '../../../src/core/sessions/held-notices-store.js'
import { FIRST_LAP_MS, startHeldNotices, stopHeldNotices, sweepHeldNotices } from '../../../src/core/sessions/held-notices-sweep.js'
import { COLD_HOLD_MAX_MS } from '../../../src/core/sessions/cold-hold.js'

const SID = 'eeeeeeee-1111-4222-8333-555555555555'
const settle = () => new Promise((r) => setTimeout(r, 80))
let ledger: { stop: () => void } | null = null

const trail = async (id: string) => trailsOf(await readDeliveryLines(1)).find((t) => t.id === id)

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetQueueExitsForTesting()
  _resetSessionTrackerForTesting()
  await _resetHeldStoreForTesting()
  _clearHeldNotices()
  stopDeliveryRetry()
  ledger = startDeliveryLedger()
})

afterEach(async () => {
  ledger?.stop()
  stopDeliveryRetry()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

async function parkedRow(text: string, reason: string, sentBy?: 'person' | 'agent') {
  const row = await enqueueMessage(SID, text, sentBy ? { sentBy } : {})
  await parkMessages([row], reason)
  return (await getQueue(SID)).find((m) => m.id === row.id)!
}

describe('a row that leaves the queue unsent says so in the ledger', () => {
  it('a Discard of a parked row is `removed` with what it was; a delivered row records nothing more', async () => {
    await createSessionRecord(SID, 't-x', 'Acme', '/tmp', { initialProcessStatus: 'idle' })
    const gone = await parkedRow('a peer note', 'Not sent: the working directory no longer exists (/gone)', 'agent')
    expect(await deleteMessage(SID, gone.id)).toBe(true)
    const done = await enqueueMessage(SID, 'delivered words')
    await mutateStore((s) => { for (const m of s.queues[SID] ?? []) if (m.id === done.id) m.status = 'processing' })
    await removeProcessed(SID, [done.id])
    await settle()
    const g = await trail(gone.id)
    expect(g?.state).toBe('removed')
    expect(g?.steps.find((s) => s.step === 'removed')?.why).toContain('parked: Not sent: the working directory no longer exists')
    expect((await trail(done.id))?.steps.map((s) => s.step)).toEqual(['queued'])
  })

  it('a row moved to another session is `queued` there', async () => {
    const row = await enqueueMessage(SID, 'moving words')
    const NEW = 'ffffffff-1111-4222-8333-555555555555'
    await mutateStore((s) => {
      const m = s.queues[SID]!.find((x) => x.id === row.id)!
      s.queues[SID] = s.queues[SID]!.filter((x) => x !== m)
      if (!s.queues[SID]!.length) delete s.queues[SID]
      s.queues[NEW] = [{ ...m, sessionId: NEW }]
    }, true)
    await settle()
    const moved = (await readDeliveryLines(1)).filter((l) => l.id === row.id && l.step === 'queued')
    expect(moved.map((l) => l.sessionId)).toEqual([SID, NEW])
    expect(moved[1].why).toBe(`moved from session ${SID}`)
  })
})

describe('a row on its way between queues (session-queue-transit.ts)', () => {
  const NEW = 'abababab-1111-4222-8333-555555555555'
  it('an engine switch: nothing while in transit, `queued` at the new session once it lands', async () => {
    const row = await enqueueMessage(SID, 'switch words')
    await takeIntoTransit('switch-t1', 'switch', SID, (r) => r.id === row.id)
    await settle()
    expect((await readDeliveryLines(1)).filter((l) => l.id === row.id).map((l) => l.step)).toEqual(['queued'])
    await landTransit('switch-t1', NEW)
    await settle()
    const steps = (await readDeliveryLines(1)).filter((l) => l.id === row.id)
    expect(steps.map((l) => [l.step, l.sessionId])).toEqual([['queued', SID], ['queued', NEW]])
  })

  it('a host hand put back records nothing; one its host took is the host\'s to record', async () => {
    const back = await enqueueMessage(SID, 'handed back')
    const took = await enqueueMessage(SID, 'host took it')
    await takeIntoTransit('host-t1', 'host', SID, (r) => r.id === back.id)
    await landTransit('host-t1', SID)
    await takeIntoTransit('host-t2', 'host', SID, (r) => r.id === took.id)
    await dropTransit('host-t2')
    await settle()
    for (const id of [back.id, took.id]) expect((await readDeliveryLines(1)).filter((l) => l.id === id).map((l) => l.step), id).toEqual(['queued'])
  })
})

describe('a step a way out names is for the row it takes out, in that write only', () => {
  it('a note for a row the write kept is forgotten: its later delivery records nothing more', async () => {
    const row = await enqueueMessage(SID, 'kept by a recheck')
    await mutateStore((s) => { noteQueueExit(row.id, 'dropped', { why: 'a recheck kept it' }); s.queues[SID]![0].status = 'processing' })
    await removeProcessed(SID, [row.id])
    await settle()
    expect((await readDeliveryLines(1)).filter((l) => l.id === row.id).map((l) => l.step)).toEqual(['queued'])
  })

  it('a row whose words rode another line is `written`, a host\'s give-back says nothing', async () => {
    const rode = await enqueueMessage(SID, 'rode a new start')
    await deleteMessage(SID, rode.id, { exit: { step: 'written', via: 'start', why: 'its words rode the first line of a new conversation' } })
    const back = await enqueueMessage(SID, 'given back')
    await withdrawQueuedLines(SID, [back.id])
    await settle()
    expect((await trail(rode.id))?.state).toBe('written')
    expect((await readDeliveryLines(1)).filter((l) => l.id === back.id).map((l) => l.step)).toEqual(['queued'])
  })
})

describe('an agent\'s row parked for a session left alone is retired', () => {
  it('its task complete: after RETIRE_AFTER_MS it goes, recorded `dropped`; a person\'s words and a hold\'s clock stay', async () => {
    const { task } = await addTask({ title: 'Done work', project: 'Acme' })
    // Its folder is gone, as the parks say: no folder check puts them back in line meanwhile.
    await createSessionRecord(SID, task.id, 'Acme', '/gone', { initialProcessStatus: 'stopped' })
    const agent = await parkedRow('a peer note', 'Not sent: the working directory no longer exists (/gone)', 'agent')
    const stopped = await parkedRow('another peer note', STOP_PARKED_REASON, 'agent')
    const person = await parkedRow('his own words', 'Not sent: the working directory no longer exists (/gone)', 'person')
    const cold = await parkedRow('held for a wake', COLD_HOLD_REASON, 'agent')
    const later = Date.parse(agent.parkedAt!) + RETIRE_AFTER_MS
    // Still open: nothing is retired, however old.
    await sweepDeliveryRetries(later + 1000)
    expect((await getQueue(SID)).length).toBe(4)
    await updateTask(task.id, { phase: 'COMPLETE' } as never)
    // Not old enough yet.
    await sweepDeliveryRetries(later - 60_000)
    expect((await getQueue(SID)).length).toBe(4)
    await sweepDeliveryRetries(later + 1000)
    const left = (await getQueue(SID)).map((m) => m.id).sort()
    expect(left).toEqual([person.id, cold.id].sort())
    await settle()
    for (const id of [agent.id, stopped.id]) {
      const t = await trail(id)
      expect(t?.state, id).toBe('dropped')
      expect(t?.steps.find((s) => s.step === 'dropped')?.why).toContain('its task is complete')
    }
  })

  it('an archived session\'s too; the rule reads the row alone', async () => {
    await createSessionRecord(SID, 't-arch', 'Acme', '/tmp', { initialProcessStatus: 'stopped' })
    const agent = await parkedRow('a routine\'s note', 'Not delivered: Claude Code exited before it read this message. Retry it.', 'agent')
    await updateSessionRecord(SID, { archived: true } as never)
    await sweepDeliveryRetries(Date.parse(agent.parkedAt!) + RETIRE_AFTER_MS)
    expect(await getQueue(SID)).toEqual([])
    const now = Date.now()
    const base = { status: 'parked' as const, enqueuedAt: new Date(now - 2 * RETIRE_AFTER_MS).toISOString(), parkedAt: new Date(now - 2 * RETIRE_AFTER_MS).toISOString() }
    expect(retiresWhenLeftAlone({ ...base, sentBy: 'agent' }, now)).toBe(true)
    expect(retiresWhenLeftAlone({ ...base, sentBy: 'person' }, now)).toBe(false)
    expect(retiresWhenLeftAlone({ ...base }, now)).toBe(false)
    expect(retiresWhenLeftAlone({ ...base, sentBy: 'agent', status: 'pending' }, now)).toBe(false)
    // Parked long ago, but its task completed a minute ago: a reopen soon after still finds it.
    expect(retiresWhenLeftAlone({ ...base, sentBy: 'agent' }, now, now - 60_000)).toBe(false)
    expect(retiresWhenLeftAlone({ ...base, sentBy: 'agent' }, now, now - RETIRE_AFTER_MS)).toBe(true)
  })
})

describe('Walnut\'s own notices held for a completed task\'s session', () => {
  it('drop after the cold hold\'s max, recorded; an open task keeps them', async () => {
    const { task } = await addTask({ title: 'Overlay family', project: 'Acme' })
    await createSessionRecord(SID, task.id, 'Acme', '/tmp', { initialProcessStatus: 'stopped' })
    // As title-topic-notice.ts holds it: Walnut's own wake=false notice, which only rides.
    const at = Date.now()
    await holdQuietNote(SID, { key: 'Walnut (title-topic)', label: 'Walnut' }, { at, text: 'Walnut added the topic "Resizable Dialogs" to your title.', mid: 'qm-title-topic-1', by: 'walnut', task: task.id })
    expect(held.get(SID)?.size).toBe(1)
    await sweepHeldNotices(at + COLD_HOLD_MAX_MS + 1000)
    expect(held.get(SID)?.size).toBe(1)
    await updateTask(task.id, { phase: 'COMPLETE' } as never)
    await sweepHeldNotices(at + COLD_HOLD_MAX_MS - 60_000)
    expect(held.get(SID)?.size).toBe(1)
    await sweepHeldNotices(at + COLD_HOLD_MAX_MS + 1000)
    expect(held.get(SID)).toBeUndefined()
    await settle()
    expect((await trail('qm-title-topic-1'))?.state).toBe('dropped')
  })
})

describe('the held notices\' first lap comes soon after boot', () => {
  it('a server restarted every few minutes still sweeps (FIRST_LAP_MS, not a whole SWEEP_MS)', async () => {
    const { task } = await addTask({ title: 'Finished overlay work', project: 'Acme' })
    await createSessionRecord(SID, task.id, 'Acme', '/tmp', { initialProcessStatus: 'stopped' })
    await holdQuietNote(SID, { key: 'Walnut (title-topic)', label: 'Walnut' }, { at: Date.now() - COLD_HOLD_MAX_MS - 60_000, text: 'A topic was added to your title.', mid: 'qm-title-topic-2', by: 'walnut', task: task.id })
    await updateTask(task.id, { phase: 'COMPLETE' } as never)
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      await startHeldNotices()
      await vi.advanceTimersByTimeAsync(FIRST_LAP_MS)
    } finally {
      vi.useRealTimers()
    }
    for (let i = 0; i < 40 && held.get(SID); i++) await settle()
    expect(held.get(SID)).toBeUndefined()
    await stopHeldNotices()
  })
})

describe('a trail written before reads removed once its row or note is gone', () => {
  const at = (min: number) => new Date(Date.parse('2026-11-24T07:41:00Z') + min * 60_000).toISOString()
  const lines: DeliveryLine[] = [
    { at: at(0), step: 'queued', id: 'qm-gone', sessionId: 's-here' },
    { at: at(0), step: 'parked', id: 'qm-gone', sessionId: 's-here', why: 'Working directory no longer exists' },
    { at: at(0), step: 'queued', id: 'qm-still', sessionId: 's-here' },
    { at: at(0), step: 'parked', id: 'qm-still', sessionId: 's-here', why: 'the session is stopped' },
    { at: at(0), step: 'queued', id: 'qm-host', sessionId: 's-host' },
    { at: at(0), step: 'held', id: 'mid-gone', sessionId: 's-here' },
    { at: at(0), step: 'held', id: 'mid-held', sessionId: 's-here' },
    { at: at(30), step: 'queued', id: 'qm-new', sessionId: 's-here' },
  ]
  const where = {
    queueHere: (sid: string) => sid === 's-here',
    inQueue: (id: string) => id === 'qm-still',
    heldNote: (id: string) => id === 'mid-held',
  }
  it('only what is not where it waits, past the grace, on a queue this server holds', () => {
    const now = Date.parse(at(30)) + GONE_GRACE_MS - 1000
    const by = Object.fromEntries(settleGone(trailsOf(lines, now), where, now).map((t) => [t.id, t]))
    expect(by['qm-gone']).toMatchObject({ state: 'removed', gone: expect.stringContaining('no longer in the queue') })
    expect(by['qm-gone'].waitingMin).toBeUndefined()
    expect(by['qm-still'].state).toBe('parked')
    expect(by['qm-host'].state).toBe('queued')
    expect(by['mid-gone']).toMatchObject({ state: 'removed', gone: expect.stringContaining('no longer held') })
    expect(by['mid-held'].state).toBe('held')
    // Younger than the grace: a row just taken out by its delivery is not judged yet.
    expect(by['qm-new'].state).toBe('queued')
    // Held notes not read here: never judged.
    const unread = Object.fromEntries(settleGone(trailsOf(lines, now), { ...where, heldNote: () => null }, now).map((t) => [t.id, t]))
    expect(unread['mid-gone'].state).toBe('held')
  })
})
