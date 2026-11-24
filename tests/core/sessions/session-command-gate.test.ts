/**
 * The session command gate (src/core/sessions/session-command-gate.ts): for a session its host runs
 * and judges, the leader sends that host's daemon no command about its process. Probes answer from
 * the channel's mirror (providers/host-judged-view.ts), controls go to the host's service as
 * `lifecycle` calls, and DaemonConnection.send refuses whatever a caller still aims at the daemon.
 * A legacy session, and every non-session command, go to the daemon as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const m = vi.hoisted(() => ({
  handOver: new Set<string>(),
  runtimes: new Map<string, string>(),
  hostCalls: [] as Array<{ sid: string; member: string; args: unknown[] }>,
  hostAnswer: undefined as unknown,
  rows: new Map<string, Record<string, unknown>>(),
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-command-gate'))
vi.mock('../../../src/core/session-channel/handover-marks.js', () => ({ handOverMarkStands: (sid: string) => m.handOver.has(sid) }))
vi.mock('../../../src/core/session-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-db.js')>()),
  hostJudgedOfAcpRuntimeInStore: (rt: string) => (m.runtimes.has(rt) ? { sid: m.runtimes.get(rt)!, host: 'devbox' } : null),
  sessionTaskAndEngineInStore: () => null,
  anyChannelCursor: () => false,
  sessionJudgeInStore: () => null,
}))
vi.mock('../../../src/core/sessions/host-judged-controls.js', () => ({
  onJudgingHost: async (sid: string, member: string, args: unknown[] = []) => { m.hostCalls.push({ sid, member, args }); return m.hostAnswer },
  terminateOnHost: async (sid: string, opts: unknown) => { m.hostCalls.push({ sid, member: 'terminateSession', args: [opts] }); return m.hostAnswer },
}))
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-tracker.js')>()),
  getSessionByClaudeIdSync: (sid: string) => m.rows.get(sid) ?? null,
}))

import {
  HostJudgedCommandError, SESSION_PROCESS_COMMANDS, assertSessionCommandReachesDaemon, sessionCommandRefusals, sessionCommandTarget,
  _resetSessionCommandGateForTesting,
} from '../../../src/core/sessions/session-command-gate.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { noteLiveState, markHostLiveUnknown, _resetRemoteJudgedSessionsForTesting } from '../../../src/providers/remote-judged-session.js'
import { DaemonConnection, probeAcpWorker, probeDaemonSession, probeDaemonSessionArgs } from '../../../src/providers/daemon-connection.js'
import { isSessionProcessAlive } from '../../../src/utils/session-liveness.js'
import { stopAcpThroughOwner, stopThroughOwner, sweepOrphansThroughOwner } from '../../../src/core/sessions/owner-stop.js'
import { hostWorkOf } from '../../../src/core/sessions/host-work.js'
import { ownerView } from '../../../src/core/sessions/replaced-session.js'
import { resendAlreadyRan } from '../../../src/core/sessions/resend-already-ran.js'
import { cancelPendingStartOf } from '../../../src/core/sessions/cancel-pending-start.js'
import type { SessionRecord } from '../../../src/core/types.js'

const JUDGED = 'judged-1'
const LEGACY = 'legacy-1'
const row = (sid: string, over: Partial<SessionRecord> = {}) => ({
  claudeSessionId: sid, taskId: 't', project: 'p', host: 'devbox', process_status: 'idle', pid: 4242, mode: 'default',
  startedAt: 'x', lastActiveAt: new Date(0).toISOString(), last_status_change: new Date(0).toISOString(), messageCount: 1, ...over,
}) as unknown as SessionRecord

/** A daemon link that counts every command it is asked to send. */
function countingLink() {
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  return {
    sent,
    conn: {
      connected: true,
      hasCapability: () => true,
      async send(cmd: string, params: Record<string, unknown>) { sent.push({ cmd, params }); return { ok: true, stopped: true } },
    },
  }
}

beforeEach(() => {
  _resetJudgeOfForTesting()
  _resetSessionCommandGateForTesting()
  _resetRemoteJudgedSessionsForTesting()
  m.handOver.clear()
  m.runtimes.clear()
  m.hostCalls = []
  m.hostAnswer = undefined
  m.rows.clear()
  noteHostJudged(JUDGED, 'devbox')
})
afterEach(() => _resetJudgeOfForTesting())

describe('the gate', () => {
  it('names where a command goes: the host for a host-judged session, the daemon for a legacy one', () => {
    expect(sessionCommandTarget(JUDGED)).toEqual({ to: 'host', host: 'devbox' })
    expect(sessionCommandTarget(LEGACY)).toEqual({ to: 'daemon' })
    expect(sessionCommandTarget(undefined)).toEqual({ to: 'daemon' })
  })

  it('refuses every session-process command of a host-judged session, naming its host-service route', () => {
    for (const cmd of SESSION_PROCESS_COMMANDS) {
      const params = cmd === 'rename' ? { oldSid: JUDGED, newSid: 'x' } : { sid: JUDGED }
      let err: unknown
      try { assertSessionCommandReachesDaemon('devbox', cmd, params) } catch (e) { err = e }
      expect(err, cmd).toBeInstanceOf(HostJudgedCommandError)
      expect((err as HostJudgedCommandError).route, cmd).toMatch(/host-api|channel|host's own/)
    }
    expect(Object.keys(sessionCommandRefusals()).sort()).toEqual([...SESSION_PROCESS_COMMANDS].sort())
  })

  it('lets a legacy session and every non-session command through', () => {
    for (const cmd of SESSION_PROCESS_COMMANDS) expect(() => assertSessionCommandReachesDaemon('devbox', cmd, { sid: LEGACY })).not.toThrow()
    for (const cmd of ['fs.read', 'git.status', 'exec.run', 'ping', 'list']) expect(() => assertSessionCommandReachesDaemon('devbox', cmd, { sid: JUDGED })).not.toThrow()
  })

  it('knows an ACP worker by its runtime id', () => {
    m.runtimes.set('acp-0123', JUDGED)
    expect(() => assertSessionCommandReachesDaemon('devbox', 'acpStop', { sid: 'acp-0123' })).toThrow(HostJudgedCommandError)
    expect(() => assertSessionCommandReachesDaemon('devbox', 'acpStop', { sid: 'acp-other' })).not.toThrow()
  })

  it('while a hand-over is unanswered, only the read of whether a CLI runs reaches the runtime', () => {
    m.handOver.add(JUDGED)
    expect(() => assertSessionCommandReachesDaemon('devbox', 'status', { sid: JUDGED })).not.toThrow()
    expect(() => assertSessionCommandReachesDaemon('devbox', 'stop', { sid: JUDGED })).toThrow(HostJudgedCommandError)
    expect(() => assertSessionCommandReachesDaemon('devbox', 'getState', { sid: JUDGED })).toThrow(HostJudgedCommandError)
  })

  it('DaemonConnection.send refuses before anything else (no link needed to see it)', async () => {
    const conn = new DaemonConnection('devbox', null as never)
    await expect(conn.send('status', { sid: JUDGED })).rejects.toBeInstanceOf(HostJudgedCommandError)
    // A legacy session's command gets as far as the link (none here).
    await expect(conn.send('status', { sid: LEGACY })).rejects.toThrow(/not connected/)
  })
})

describe('probes answer a host-judged session from the channel', () => {
  it('liveness: the host\'s live state while fresh, its row once the link is unknown', async () => {
    noteLiveState(JUDGED, { processStatus: 'running', turnRunning: true }, 'devbox')
    expect(await isSessionProcessAlive(row(JUDGED, { process_status: 'running' }))).toBe(true)
    noteLiveState(JUDGED, { processStatus: 'stopped' }, 'devbox')
    expect(await isSessionProcessAlive(row(JUDGED, { process_status: 'idle' }))).toBe(false)
    markHostLiveUnknown('devbox')
    expect(await isSessionProcessAlive(row(JUDGED, { process_status: 'idle' }))).toBe(true)
  })

  it('the daemon probe helpers send nothing for it', async () => {
    noteLiveState(JUDGED, { processStatus: 'idle', acp: { workerLive: true } }, 'devbox')
    expect(await probeDaemonSession('devbox', JUDGED)).toEqual({ alive: true })
    expect(await probeDaemonSessionArgs('devbox', JUDGED)).toBeNull()
    m.runtimes.set('acp-77', JUDGED)
    expect(await probeAcpWorker('devbox', 'acp-77')).toBe(true)
    // No connection was looked up: a legacy session's probe finds no link here and answers null.
    expect(await probeDaemonSession('devbox', LEGACY)).toBeNull()
  })

  it('its work and its hold read from the live state', async () => {
    noteLiveState(JUDGED, { processStatus: 'idle', outliving: ['background'] }, 'devbox')
    expect(await hostWorkOf({ claudeSessionId: JUDGED, host: 'devbox' })).toEqual({ alive: true, working: true, inTurn: false, outliving: ['background'] })
    expect(await ownerView({ claudeSessionId: JUDGED, host: 'devbox', engine: 'claude-code' } as never)).toEqual({ alive: true, hold: 'background' })
    noteLiveState(JUDGED, { processStatus: 'running', inTurn: true, pendingPermission: true }, 'devbox')
    expect(await hostWorkOf({ claudeSessionId: JUDGED, host: 'devbox' })).toMatchObject({ alive: true, working: false, inTurn: true })
    markHostLiveUnknown('devbox')
    expect(await hostWorkOf({ claudeSessionId: JUDGED, host: 'devbox' })).toBeNull()
  })
})

describe('controls go to the host\'s service', () => {
  it('a stop this server decided on is its host\'s terminate; its daemon is never asked', async () => {
    const link = countingLink()
    m.hostAnswer = { status: 'terminated', sessionId: JUDGED }
    expect(await stopThroughOwner(row(JUDGED), 'maintenance', 'task_completed', { connection: async () => link.conn as never })).toBe('stopped')
    expect(m.hostCalls).toEqual([{ sid: JUDGED, member: 'terminateSession', args: [{ force: true, by: 'task_completed' }] }])
    expect(await stopAcpThroughOwner({ ...row(JUDGED), acpRuntimeId: 'acp-9' }, 'task_completed', { connection: async () => link.conn as never })).toBe('stopped')
    expect(link.sent).toEqual([])
  })

  it('an idle reap and an orphan sweep are its host\'s own: nothing is asked anywhere', async () => {
    const link = countingLink()
    expect(await stopThroughOwner(row(JUDGED), 'idle', 'capacity_eviction', { connection: async () => link.conn as never })).toBe('refused')
    const ended = row(JUDGED, { process_status: 'stopped', status_reason: 'user_terminated', last_status_change: new Date(Date.now() - 10 * 60_000).toISOString() })
    const swept = await sweepOrphansThroughOwner([ended], 'test', {
      connection: async () => link.conn as never, reread: async () => ended, markExpectedTeardown: async () => undefined, now: () => Date.now(),
    })
    expect(swept).toEqual([expect.objectContaining({ sessionId: JUDGED, result: 'left', reason: 'host_judged' })])
    expect(link.sent).toEqual([])
    expect(m.hostCalls).toEqual([])
  })

  it('a legacy session is still stopped through its daemon', async () => {
    const link = countingLink()
    expect(await stopThroughOwner(row(LEGACY), 'maintenance', 'task_completed', { connection: async () => link.conn as never })).toBe('stopped')
    expect(link.sent.map((s) => s.cmd)).toEqual(['stop'])
  })

  it('a resend\'s line fate and an unconfirmed start\'s cancel are asked of the host', async () => {
    m.hostAnswer = true
    expect(await resendAlreadyRan({ sessionId: JUDGED, host: 'devbox', lineUuid: 'u1', messageIds: ['qm-1'] })).toBe(true)
    m.hostAnswer = { ok: true, cancelled: true, alive: false }
    expect(await cancelPendingStartOf({ sid: JUDGED, sessionId: JUDGED, host: 'devbox' })).toEqual({ ok: true, cancelled: true, alive: false })
    expect(m.hostCalls).toEqual([
      { sid: JUDGED, member: 'lineAlreadyRan', args: ['u1', ['qm-1']] },
      { sid: JUDGED, member: 'cancelPendingStart', args: [JUDGED] },
    ])
  })
})
