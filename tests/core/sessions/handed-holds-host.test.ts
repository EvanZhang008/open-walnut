/**
 * The host's half of a hold its leader handed over (src/core/sessions/handed-holds.ts
 * queueLinesOnHost, the host routes' `enqueue`): each held line is queued here under its hold, and
 * this host's own queue-after-turn sends it when this host's turn ends, the leader there or not; a
 * cold hold is put back in line in front of a line that goes now; a reason that is not one that
 * crosses is never taken as a hold.
 *
 * Real: a host replica's role and own-row writer, its queue file, the real queue-after-turn on the
 * real bus; only the runner's "is a turn running" answer is scripted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-handed-holds-host', { CLOUD_MODE: false }))

import { SESSION_QUEUE_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { queueLinesOnHost } from '../../../src/core/sessions/handed-holds.js'
import { startQueueAfterTurn, stopQueueAfterTurn } from '../../../src/core/sessions/queue-after-turn.js'
import { AFTER_TURN_REASON, COLD_HOLD_REASON, STOP_PARKED_REASON } from '../../../src/core/relay-fates.js'
import { buildPeerWrapper } from '../../../src/core/peers/peer-wrapper.js'
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'
import { renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { frameForSource } from '../../../src/core/sessions/send-frame.js'

const KEY = 'devbox'
const OWN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const running = new Set<string>()
const sends: Array<{ sessionId: string; source: string }> = []

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  // The store as the leader's copy made it, then this host replica's own row in it.
  sessionDb.applySessionCopy({ rows: [] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
  await tracker.createSessionRecord(OWN, '', 'Marina', '/tmp', { host: KEY, judge: 'host' } as never)
  vi.spyOn(sessionRunner, 'isTurnRunning').mockImplementation((sid: string) => running.has(sid))
  bus.subscribe('test-host-holds-sends', (e) => {
    if (e.name === EventNames.SESSION_SEND) sends.push({ sessionId: (e.data as { sessionId: string }).sessionId, source: e.source })
  }, { global: true, interest: [EventNames.SESSION_SEND] })
  await startQueueAfterTurn()
})

afterAll(async () => {
  stopQueueAfterTurn()
  bus.unsubscribe('test-host-holds-sends')
  vi.restoreAllMocks()
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await fsp.rm(SESSION_QUEUE_FILE, { force: true }).catch(() => {})
  resetCache()
  sends.length = 0
  running.clear()
})

const until = async (fn: () => Promise<boolean> | boolean, ms = 8_000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) }
}

describe('a host keeps and releases the holds its leader handed it', () => {
  it('a leader\'s queue row (its envelopes, then notes and hints) is queued here as it is, never wrapped again', async () => {
    // 2026-11-24: rows whose hints sat after their envelopes read as typed words here, so this host
    // wrapped each whole as "Walnut (peer)" and the sender's envelope became escaped words.
    running.add(OWN)
    const reply = buildPeerWrapper('Done: the fix is on main.', { title: 'Review C8', shortId: '11111111', sessionId: '11111111-2222-4333-8444-555555555555', taskId: 't-review', host: 'local' })
    const notice = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' }, body: 'A task you follow completed.' })
    const row = `${notice}\n\n${reply}\n\n${renderHintBlock('team-guidance', 'Team guidance from Walnut VP: lessons.')}`
    for (const [id, sentBy] of [['qm-row-agent', 'agent'], ['qm-row-unmarked', undefined]] as const) {
      await queueLinesOnHost(OWN, [{ id, message: row, ...(sentBy ? { sentBy } : {}), held: { reason: AFTER_TURN_REASON } }], 'peer')
      const queued = (await getQueue(OWN)).find((m) => m.id === id)!
      expect(queued.message).toBe(row)
      expect(queued.message).not.toContain('&lt;walnut-message')
    }
    // The same row framed as a fresh send would have been wrapped whole: the case this guards.
    expect(frameForSource(row, 'peer')).toContain('&lt;walnut-message')
    // Loose words in a handed row are framed on their own; its envelopes stay as they are.
    await queueLinesOnHost(OWN, [{ id: 'qm-row-loose', message: `${reply}\nand one loose line`, sentBy: 'agent', held: { reason: AFTER_TURN_REASON } }], 'peer')
    const loose = (await getQueue(OWN)).find((m) => m.id === 'qm-row-loose')!.message
    expect(loose.startsWith(reply)).toBe(true)
    expect(loose).toContain('and one loose line')
    expect(loose).not.toContain('&lt;walnut-message')
    // Plain words an agent sent still read as an agent's, never a person's.
    await queueLinesOnHost(OWN, [{ id: 'qm-row-plain', message: 'deploy it', sentBy: 'agent', held: { reason: AFTER_TURN_REASON } }], 'peer')
    expect((await getQueue(OWN)).find((m) => m.id === 'qm-row-plain')!.message).toMatch(/^<walnut-message kind="peer-note" from="Walnut \(peer\)"/)
    running.delete(OWN)
  })

  it('a line held for the turn\'s end waits here and goes out when this host\'s turn ends', async () => {
    running.add(OWN)
    await tracker.updateSessionRecord(OWN, { process_status: 'running' })
    await queueLinesOnHost(OWN, [{ id: 'qm-after-1', message: 'next, please', sentBy: 'person', held: { reason: AFTER_TURN_REASON } }], 'queue-hold')
    expect((await getQueue(OWN)).map((m) => [m.id, m.status, m.parkedReason])).toEqual([['qm-after-1', 'parked', AFTER_TURN_REASON]])
    await new Promise((r) => setTimeout(r, 600))
    expect(sends).toEqual([])
    // The turn ends here: the host's own result event, as its runner says it.
    running.delete(OWN)
    await tracker.updateSessionRecord(OWN, { process_status: 'idle' })
    bus.emit(EventNames.SESSION_RESULT, { sessionId: OWN, result: 'done', isError: false }, ['main-ai'], { source: 'session-runner' })
    await until(() => sends.some((s) => s.sessionId === OWN))
    expect((await getQueue(OWN)).find((m) => m.id === 'qm-after-1')?.status).not.toBe('parked')
  })

  it('a cold hold is queued held, and a line that goes now puts it back in line in front of itself', async () => {
    await queueLinesOnHost(OWN, [{ id: 'qm-cold-1', message: 'fyi', sentBy: 'agent', held: { reason: COLD_HOLD_REASON, coldSend: { source: 'api-agent' } } }], 'queue-hold')
    const held = (await getQueue(OWN)).find((m) => m.id === 'qm-cold-1')!
    expect([held.status, held.parkedReason, held.coldSend]).toEqual(['parked', COLD_HOLD_REASON, { source: 'api-agent' }])
    await queueLinesOnHost(OWN, [{ id: 'qm-now-1', message: 'now', sentBy: 'person' }], 'mobile')
    const q = await getQueue(OWN)
    expect(q.map((m) => [m.id, m.status])).toEqual([['qm-cold-1', 'pending'], ['qm-now-1', 'pending']])
  })

  it('a reason that is not one that crosses is queued as a line that goes now, never parked', async () => {
    await queueLinesOnHost(OWN, [{ id: 'qm-odd-1', message: 'x', sentBy: 'person', held: { reason: STOP_PARKED_REASON } }], 'mobile')
    expect((await getQueue(OWN)).map((m) => [m.id, m.status])).toEqual([['qm-odd-1', 'pending']])
  })
})
