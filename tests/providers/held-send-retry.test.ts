import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('held-send-retry'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { getQueue, enqueueMessage, markProcessing, removeProcessed } from '../../src/core/session-message-queue.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { SendHeldError, SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'
import { harness, probeSetup, probeTeardown, SID, type Harness } from '../helpers/runner-probe-harness.js'

type RetryInternals = {
  settleUnansweredLine(sid: string, rows: Awaited<ReturnType<typeof getQueue>>, error: Error, stopped: boolean): Promise<void>
  heldSendRetries: Map<string, { delay: number; timer?: ReturnType<typeof setTimeout> }>
  deliverRest(sid: string): void
  sessions: Map<string, Harness['session']>
}
let h: Harness
let internals: RetryInternals

beforeEach(async () => {
  await probeSetup()
  h = harness({ running: false })
  internals = h.runner as unknown as RetryInternals
  vi.useFakeTimers()
})
afterEach(async () => {
  // The harness transport has no signals; detach is stubbed so shutdown cannot
  // contact a daemon. The module's shared connection cleanup is mocked above.
  vi.spyOn(h.session, 'detach').mockImplementation(() => {})
  h.runner.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await probeTeardown()
})

async function hold(error: Error = new SendHeldError()) {
  await enqueueMessage(SID, 'first message')
  const rows = await markProcessing(SID, null)
  await internals.settleUnansweredLine(SID, rows, error, false)
  return rows
}

describe('held native sends retry the oldest existing queue line', () => {
  it.each([new SendHeldError(), new SendOutcomeUnknownError('answer lost')])('keeps one unreferenced timer and the same pending uuid (%s)', async (error) => {
    const rows = await hold(error)
    const deliver = vi.spyOn(internals, 'deliverRest').mockImplementation(() => {})
    await internals.settleUnansweredLine(SID, rows, error, false)
    expect(internals.heldSendRetries.size).toBe(1)
    const timer = internals.heldSendRetries.get(SID)!.timer!
    expect(timer.hasRef()).toBe(false)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(deliver).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(SID)
    expect((await getQueue(SID)).map((row) => ({ id: row.id, status: row.status, uuid: row.lineUuid }))).toEqual([
      { id: rows[0].id, status: 'pending', uuid: rows[0].lineUuid },
    ])
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.resumes).toEqual([])
  })

  it('rearms after another failure with bounded backoff without adding a queue row', async () => {
    const rows = await hold()
    const deliver = vi.spyOn(internals, 'deliverRest').mockImplementation(() => {})
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      await internals.settleUnansweredLine(SID, rows, new SendHeldError(), false)
    }
    expect(deliver).toHaveBeenCalledTimes(5)
    expect(internals.heldSendRetries.get(SID)!.delay).toBe(30_000)
    expect(await getQueue(SID)).toHaveLength(1)
  })

  it.each(['epoch', 'replacement', 'dead', 'archived', 'stop-fence', 'parked', 'removed'])('does not redeliver when %s invalidates the timer', async (change) => {
    const rows = await hold()
    const deliver = vi.spyOn(internals, 'deliverRest').mockImplementation(() => {})
    if (change === 'epoch') Object.assign(h.session, { _stopEpoch: h.session.stopEpoch + 1 })
    if (change === 'replacement') internals.sessions.clear()
    if (change === 'dead') Object.assign(h.session, { _active: false })
    if (change === 'archived') await updateSessionRecord(SID, { archived: true })
    if (change === 'stop-fence') await updateSessionRecord(SID, { stopRequest: { id: 'new-stop', state: 'pending', requestedAt: new Date().toISOString() } } as never)
    if (change === 'parked') await internals.settleUnansweredLine(SID, rows, new SendHeldError(), true)
    if (change === 'removed') {
      await markProcessing(SID, null)
      await removeProcessed(SID, rows.map((row) => row.id))
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).not.toHaveBeenCalled()
    expect(internals.heldSendRetries.size).toBe(0)
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.resumes).toEqual([])
  })

  it.each([new SendHeldError(), new SendOutcomeUnknownError('answer lost')])('a real runner retry sends the original uuid once with dedupe after five seconds (%s)', async (error) => {
    const old = h
    vi.spyOn(old.session, 'detach').mockImplementation(() => {})
    old.runner.destroy()
    let writes = 0
    h = harness({ running: false, lifecycle: false, script: async () => {
      if (writes++ === 0) throw error
      return true
    } })
    internals = h.runner as unknown as RetryInternals
    await enqueueMessage(SID, 'first message')
    await h.internals.processNext(SID)
    expect(h.writes).toHaveLength(1)
    const uuid = h.writes[0].uuid
    expect((await getQueue(SID))[0]).toMatchObject({ status: 'pending', lineUuid: uuid })
    await vi.advanceTimersByTimeAsync(5_000)
    // Let the timer's fire-and-forget queue drain finish its isolated disk writes.
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(h.writes.map((write) => ({ uuid: write.uuid, dedupe: write.dedupe }))).toEqual([
      { uuid, dedupe: false }, { uuid, dedupe: true },
    ])
    expect(await getQueue(SID)).toEqual([])
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.resumes).toEqual([])
    expect(internals.heldSendRetries.size).toBe(0)
  })

  it('a timer retry does not auto-deny a permission the CLI asked after the original send', async () => {
    const old = h
    vi.spyOn(old.session, 'detach').mockImplementation(() => {})
    old.runner.destroy()
    let writes = 0
    h = harness({ running: false, lifecycle: false, script: async () => {
      if (writes++ === 0) throw new SendHeldError()
      return true
    } })
    internals = h.runner as unknown as RetryInternals
    await enqueueMessage(SID, 'first message')
    await h.internals.processNext(SID)
    Object.assign(h.session, { _pendingPermissionRequests: new Map([['later-permission', {
      request_id: 'later-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } },
    }]]) })
    const resolvePermission = vi.spyOn(h.session, 'resolvePermissionRequest')
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(resolvePermission).not.toHaveBeenCalled()
    expect(h.session.hasPendingPermission).toBe(true)
    expect(h.resumes).toEqual([])
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('new pending text does not replace the held head and shutdown cancels the timer', async () => {
    const rows = await hold()
    await enqueueMessage(SID, 'second message')
    const deliver = vi.spyOn(internals, 'deliverRest').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(SID)
    expect((await getQueue(SID)).map((row) => row.message)).toEqual(['first message', 'second message'])
    await internals.settleUnansweredLine(SID, rows, new SendHeldError(), false)
    vi.spyOn(h.session, 'detach').mockImplementation(() => {})
    h.runner.destroy()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deliver).toHaveBeenCalledOnce()
    expect(internals.heldSendRetries.size).toBe(0)
  })
})
