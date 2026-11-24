/**
 * judgeOf (src/core/sessions/judge-of.ts): a session is its host's only when its row says
 * judge 'host' and names a host other than this server; a start is a host's only while the leader
 * side's probe says that host runs its sessions; a gated handler skips a host's session's events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-judge-of'))

import { _resetSessionTrackerForTesting, createSessionRecord } from '../../../src/core/session-tracker.js'
import { applyHanded } from '../../helpers/handed-rows.js'
import { closeDb } from '../../../src/core/session-db.js'
import {
  _resetJudgeOfForTesting, judgeOf, judgeOfRecord, judgeOfStart, judgingHostOf, judgedHereOnly, judgedHereRecords, noteHostJudged, setHostJudgeProbe,
} from '../../../src/core/sessions/judge-of.js'
import { WALNUT_HOME } from '../../../src/constants.js'

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); _resetJudgeOfForTesting() })

describe('judgeOf', () => {
  it('is here for every row while no host channel ever applied here', async () => {
    await createSessionRecord('l1', '', 'p')
    expect(judgeOf('l1')).toBe('here')
    expect(judgeOf('missing')).toBe('here')
  })

  it('is host for a row the channel wrote, here for the leader\'s own rows beside it', async () => {
    await createSessionRecord('l1', '', 'p')
    await applyHanded({
      hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
      rows: [{ sid: 'h1', born: true, patch: { claudeSessionId: 'h1', taskId: '', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
    })
    // A fresh process (no memo) reads it from the store.
    _resetJudgeOfForTesting()
    expect(judgeOf('h1')).toBe('host')
    expect(judgingHostOf('h1')).toBe('devbox')
    expect(judgeOf('l1')).toBe('here')
  })

  it('knows a session its host just started before the row arrives', () => {
    expect(judgeOf('new-sid')).toBe('here')
    noteHostJudged('new-sid', 'devbox')
    expect(judgeOf('new-sid')).toBe('host')
  })

  it('judges a record in hand by the same rule', () => {
    expect(judgeOfRecord({ judge: 'host', host: 'devbox' })).toBe('host')
    expect(judgeOfRecord({ host: 'devbox' })).toBe('here')
    expect(judgeOfRecord({ judge: 'host', host: '' })).toBe('here')
    expect(judgedHereRecords([{ judge: 'host' as const, host: 'a' }, { host: 'b' }])).toEqual([{ host: 'b' }])
  })
})

describe('judgeOfStart', () => {
  it('is here with no probe, for a local start, and when the probe says no', () => {
    expect(judgeOfStart('devbox')).toBe('here')
    setHostJudgeProbe((h) => h === 'devbox')
    expect(judgeOfStart('devbox')).toBe('host')
    expect(judgeOfStart('other')).toBe('here')
    expect(judgeOfStart(undefined)).toBe('here')
    expect(judgeOfStart('__local__')).toBe('here')
    setHostJudgeProbe(() => { throw new Error('boom') })
    expect(judgeOfStart('devbox')).toBe('here')
  })
})

describe('judgedHereOnly', () => {
  it('skips the events of a host\'s session and passes every other one through', () => {
    noteHostJudged('h1', 'devbox')
    const seen: string[] = []
    const handler = judgedHereOnly((e: { name: string; data: unknown }) => { seen.push(e.name) })
    handler({ name: 'session:result', data: { sessionId: 'h1' } })
    handler({ name: 'session:result', data: { sessionId: 'l1' } })
    handler({ name: 'session:deleted', data: { sessionIds: ['h1'] } })
    expect(seen).toEqual(['session:result', 'session:deleted'])
  })
})
