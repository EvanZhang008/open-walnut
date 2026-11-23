/**
 * A host's retrier gave up on a session it runs (src/core/sessions/held-error.ts): the leader raises
 * the held error card and moves the give-up's phase edge (src/core/session-channel/leader-retry-over.ts).
 * Only for a session a host judges; a retry-over naming one of the leader's own sessions is ignored
 * (its own retriers raise their own).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-leader-retry-over'))
const phases: unknown[] = []
vi.mock('../../../src/core/phase.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/phase.js')>()),
  applySessionPhase: async (...args: unknown[]) => { phases.push(args); return { changed: true } },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../../src/core/session-tracker.js'
import { applyHanded } from '../../helpers/handed-rows.js'
import { _resetJudgeOfForTesting } from '../../../src/core/sessions/judge-of.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { setRetryOverCard, startLeaderRetryOver } from '../../../src/core/session-channel/leader-retry-over.js'
import { RETRY_OVER_SUBSCRIBER } from '../../../src/core/sessions/held-error.js'

const HOST_SID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const cards: Array<{ sid: string; taskId?: string; words: string }> = []
let stop: () => void = () => {}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  cards.length = 0
  phases.length = 0
  await applyHanded({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid: HOST_SID, born: true, patch: { claudeSessionId: HOST_SID, taskId: 'task-1', project: 'p', host: 'devbox', judge: 'host', process_status: 'idle', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  await createSessionRecord('legacy-r1', 'task-2', 'p')
  _resetJudgeOfForTesting()
  setRetryOverCard(async (rec, words) => { cards.push({ sid: rec.claudeSessionId, taskId: rec.taskId, words }) })
  stop = startLeaderRetryOver({ lateQuietMs: 20 })
})

afterEach(() => { stop(); setRetryOverCard(null); closeDb(); _resetSessionTrackerForTesting(); _resetJudgeOfForTesting() })

const settle = () => new Promise((r) => setTimeout(r, 100))

describe('the leader raises what a host\'s retrier held', () => {
  it('the card and the phase edge of a host-judged session, as the host sent them (late too)', async () => {
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: HOST_SID, card: { words: 'The model refused twice; no other model to switch to.' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel' })
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: HOST_SID, taskId: 'task-1', phase: { trigger: 'session:error', why: 'safeguard-switch:gave-up' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel', late: true })
    await settle()
    expect(cards).toEqual([{ sid: HOST_SID, taskId: 'task-1', words: 'The model refused twice; no other model to switch to.' }])
    expect(phases).toEqual([['task-1', 'session:error', 'safeguard-switch:gave-up', { sessionId: HOST_SID, retryOver: true }]])
  })

  it('a late give-up a later turn of the same backlog outran raises no card and no phase', async () => {
    const t0 = Date.now() - 10 * 60_000
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: HOST_SID, taskId: 'task-1', card: { words: 'gave up' }, phase: { trigger: 'session:error', why: 'safeguard-switch:gave-up' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel', late: true, timestamp: t0 })
    // The next send ran a good turn: its result comes later in the same backlog.
    bus.emit(EventNames.SESSION_RESULT, { sessionId: HOST_SID, result: 'fine' }, ['main-ai'], { source: 'host-channel', late: true, timestamp: t0 + 60_000 })
    await settle()
    expect(cards).toEqual([])
    expect(phases).toEqual([])
  })

  it('a fresh give-up is acted on, unless a turn of that session ended after it', async () => {
    const t0 = Date.now()
    bus.emit(EventNames.SESSION_RESULT, { sessionId: HOST_SID, result: 'later turn' }, ['main-ai'], { source: 'host-channel', timestamp: t0 })
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: HOST_SID, card: { words: 'old' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel', timestamp: t0 - 1_000 })
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: HOST_SID, card: { words: 'new' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel', timestamp: t0 + 1_000 })
    await settle()
    expect(cards.map((c) => c.words)).toEqual(['new'])
  })

  it('ignores one naming the leader\'s own session', async () => {
    bus.emit(EventNames.SESSION_RETRY_OVER, { sessionId: 'legacy-r1', taskId: 'task-2', card: { words: 'x' }, phase: { trigger: 'session:error', why: 'y' } }, [RETRY_OVER_SUBSCRIBER], { source: 'host-channel' })
    await settle()
    expect(cards).toEqual([])
    expect(phases).toEqual([])
  })
})
