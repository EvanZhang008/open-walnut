/**
 * The session command gate against the store (src/core/sessions/session-command-gate.ts, judge-of.ts):
 *  - a take-back (host-handover.ts takeStartBack: forgetHostJudged, awaits, then the row written back)
 *    never leaves the session marked as the host's: a read in between learns nothing from the row that
 *    still says so (review round 1, S1; the reviewer's repro, with its expectations turned)
 *  - no send reads the store again once its session is known: a repeated command of a legacy session,
 *    of a host-judged one and of an ACP worker (by runtime id) costs no store query (S2)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const m = vi.hoisted(() => ({
  judged: new Map<string, boolean>(),
  runtimes: new Map<string, string>(),
  calls: { judge: 0, row: 0, cursor: 0, seed: 0 },
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-gate-store'))
vi.mock('../../../src/core/session-db.js', async (o) => ({
  ...(await o<typeof import('../../../src/core/session-db.js')>()),
  anyChannelCursor: () => { m.calls.cursor++; return true },
  sessionJudgeInStore: (sid: string) => {
    m.calls.judge++
    return m.judged.has(sid) ? { host: 'devbox', judgedByHost: m.judged.get(sid)! } : null
  },
  sessionTaskAndEngineInStore: (sid: string) => {
    m.calls.row++
    const rt = [...m.runtimes].find(([, s]) => s === sid)?.[0] ?? null
    return m.judged.has(sid) ? { taskId: 't', engine: rt ? 'opencode' : 'claude-code', acpRuntimeId: rt } : null
  },
  hostJudgedRuntimesInStore: () => { m.calls.seed++; return [...m.runtimes].map(([runtimeId, sid]) => ({ sid, host: 'devbox', runtimeId })) },
}))
vi.mock('../../../src/core/session-channel/handover-marks.js', () => ({ handOverMarkStands: () => false }))

import { _resetJudgeOfForTesting, forgetHostJudged, judgingHostOf, noteHostJudged, seedHostJudgedRuntimes } from '../../../src/core/sessions/judge-of.js'
import { HostJudgedCommandError, _resetSessionCommandGateForTesting, assertSessionCommandReachesDaemon } from '../../../src/core/sessions/session-command-gate.js'

const stores = () => m.calls.judge + m.calls.row + m.calls.cursor + m.calls.seed

beforeEach(() => {
  _resetJudgeOfForTesting()
  _resetSessionCommandGateForTesting()
  m.judged.clear()
  m.runtimes.clear()
  m.calls = { judge: 0, row: 0, cursor: 0, seed: 0 }
})

describe('a take-back', () => {
  it('a read between forgetHostJudged and the row written back learns nothing from the row; the session is the leader\'s', () => {
    m.judged.set('seed-1', true)
    noteHostJudged('seed-1', 'devbox')       // handStartToHost
    forgetHostJudged('seed-1')               // takeStartBack, its first line
    expect(judgingHostOf('seed-1')).toBeNull() // a probe while dropHandsOf awaits: the row still says the host's
    expect(() => assertSessionCommandReachesDaemon('devbox', 'start', { sid: 'seed-1' })).not.toThrow()
    m.judged.set('seed-1', false)            // takeSeedBack writes judge: undefined
    expect(judgingHostOf('seed-1')).toBeNull()
    expect(() => assertSessionCommandReachesDaemon('devbox', 'start', { sid: 'seed-1' })).not.toThrow()
  })

  it('a host that did take it after all (its row applied, noteHostJudged) makes it the host\'s again', () => {
    m.judged.set('seed-2', true)
    noteHostJudged('seed-2', 'devbox')
    forgetHostJudged('seed-2')
    expect(judgingHostOf('seed-2')).toBeNull()
    noteHostJudged('seed-2', 'devbox')
    expect(judgingHostOf('seed-2')).toBe('devbox')
    expect(() => assertSessionCommandReachesDaemon('devbox', 'stop', { sid: 'seed-2' })).toThrow(HostJudgedCommandError)
  })
})

describe('the send path reads no store once a session is known', () => {
  it('a legacy session: one read at its first command, none after', () => {
    m.judged.set('legacy-1', false)
    assertSessionCommandReachesDaemon('devbox', 'status', { sid: 'legacy-1' })
    const after = stores()
    for (let i = 0; i < 50; i++) {
      assertSessionCommandReachesDaemon('devbox', 'status', { sid: 'legacy-1' })
      assertSessionCommandReachesDaemon('devbox', 'send', { sid: 'legacy-1' })
    }
    expect(stores()).toBe(after)
  })

  it('an ACP worker\'s commands by runtime id never read the store, legacy or host-judged', () => {
    m.judged.set('acp-sess', true)
    m.runtimes.set('acp-0aa', 'acp-sess')
    noteHostJudged('acp-sess', 'devbox')     // learns its runtime from its row, once
    const after = stores()
    for (let i = 0; i < 50; i++) {
      // A legacy worker (no host-judged session names it): passes, no store read, no scan.
      assertSessionCommandReachesDaemon('devbox', 'acpSend', { sid: 'acp-legacy-' + i })
      assertSessionCommandReachesDaemon('devbox', 'acpState', { sid: 'acp-legacy-' + i })
      expect(() => assertSessionCommandReachesDaemon('devbox', 'acpStop', { sid: 'acp-0aa' })).toThrow(HostJudgedCommandError)
    }
    expect(stores()).toBe(after)
  })

  it('the leader side\'s boot seeds the runtimes once, so a worker is known before its session is', () => {
    m.judged.set('acp-boot', true)
    m.runtimes.set('acp-0bb', 'acp-boot')
    expect(seedHostJudgedRuntimes()).toBe(1)
    expect(m.calls.seed).toBe(1)
    expect(() => assertSessionCommandReachesDaemon('devbox', 'acpStop', { sid: 'acp-0bb' })).toThrow(HostJudgedCommandError)
  })

  it('a take-back forgets the worker too', () => {
    m.judged.set('acp-back', true)
    m.runtimes.set('acp-0cc', 'acp-back')
    noteHostJudged('acp-back', 'devbox')
    forgetHostJudged('acp-back')
    expect(() => assertSessionCommandReachesDaemon('devbox', 'acpStop', { sid: 'acp-0cc' })).not.toThrow()
  })
})
