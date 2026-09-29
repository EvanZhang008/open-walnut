/**
 * Every server-originated daemon `stop` names the asking Walnut (owner-home-v1,
 * src/core/sessions/stop-provenance.ts), and an ephemeral server sends no stop
 * at all to a daemon that cannot check who started a session.
 *
 * Why: an ephemeral test server runs over a copy of the production data, so it
 * holds the user's session ids, and with remote hosts on it reaches the same
 * shared daemon as production. Without a Walnut name in the request, the daemon
 * cannot tell the test server's stop from production's.
 *
 * Everything is stubbed: the "daemons" are fake connections whose `send` is
 * recorded, and process.kill is spied on and must never be called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const state = vi.hoisted(() => ({ ephemeral: false }))

vi.mock('../../../src/constants.js', () => ({
  ...createMockConstants('walnut-stop-provenance'),
  // Read at call time, so each test picks the kind of server it plays.
  get IS_EPHEMERAL() { return state.ephemeral },
}))

import {
  describeStopRefusal,
  OWNER_HOME_CAPABILITY,
  STOP_NOT_SENT_NO_OWNERSHIP_CHECK,
  stopProvenance,
} from '../../../src/core/sessions/stop-provenance.js'
import { stopThroughOwner, type OwnerConnection } from '../../../src/core/sessions/owner-stop.js'
import { SessionStopCoordinator, type SessionStopDeps } from '../../../src/core/sessions/session-stop.js'
import { RemoteSessionManager } from '../../../src/providers/remote-session-manager.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import type { SessionRecord } from '../../../src/core/types.js'
import { log } from '../../../src/logging/index.js'

interface FakeConn extends OwnerConnection {
  calls: Array<{ command: string; args: Record<string, unknown> }>
}

function fakeConn(caps: string[], reply: Record<string, unknown> = { ok: true, stopped: true }): FakeConn {
  const calls: FakeConn['calls'] = []
  return {
    connected: true,
    hasCapability: (cap: string) => caps.includes(cap),
    calls,
    async send(command, args) {
      calls.push({ command, args })
      return reply
    },
  }
}

const OLD_DAEMON = ['stop', 'status', 'orphan-stop-v1']
const CHECKING_DAEMON = [...OLD_DAEMON, OWNER_HOME_CAPABILITY]

/** A RemoteSessionManager holding `conn` for `sid`, without dialling anything. */
function managerOn(conn: FakeConn, sid = 'sid-mgr'): RemoteSessionManager {
  const mgr = new RemoteSessionManager(sid, 'devbox', null)
  const internals = mgr as unknown as { conn: FakeConn; _sid: string; _hasPipe: boolean }
  internals.conn = conn
  internals._sid = sid
  internals._hasPipe = true
  return mgr
}

function coordinatorOn(conn: FakeConn) {
  const saved: Array<NonNullable<SessionRecord['stopRequest']>> = []
  let record = { claudeSessionId: 'sid-user', host: 'devbox' } as SessionRecord
  const deps: SessionStopDeps = {
    get: async () => record,
    save: async (_sid, updates) => { record = { ...record, ...updates } as SessionRecord; return record },
    confirm: async (_sid, request) => { saved.push(request); record = { ...record, stopRequest: request }; return record },
    pending: async () => [],
    park: async () => {},
    connection: async () => conn,
    changed: () => {},
  }
  return { coordinator: new SessionStopCoordinator(deps), saved }
}

let killSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
    throw new Error('process.kill must never be called by a stop path')
  }) as typeof process.kill)
  vi.spyOn(log.session, 'info').mockImplementation((() => {}) as never)
  vi.spyOn(log.session, 'warn').mockImplementation((() => {}) as never)
})

afterEach(() => {
  state.ephemeral = false
  expect(killSpy, 'the server must never signal a process').not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('stopProvenance: which ownership fields a stop carries', () => {
  it('names this Walnut and the initiator to a daemon that checks ownership', () => {
    expect(stopProvenance(fakeConn(CHECKING_DAEMON), 'automatic')).toEqual({ home: WALNUT_HOME, initiator: 'automatic' })
    expect(stopProvenance(fakeConn(CHECKING_DAEMON), 'human', { home: '/elsewhere' })).toEqual({ home: '/elsewhere', initiator: 'human' })
  })

  it('a production server keeps sending today\'s unlabelled stop to an older daemon', () => {
    expect(stopProvenance(fakeConn(OLD_DAEMON), 'automatic')).toEqual({})
    expect(stopProvenance(null, 'human')).toEqual({})
  })

  it('an ephemeral server marks every stop strict', () => {
    expect(stopProvenance(fakeConn(CHECKING_DAEMON), 'human', { ephemeral: true }))
      .toEqual({ home: WALNUT_HOME, initiator: 'human', strict: true })
    state.ephemeral = true
    expect(stopProvenance(fakeConn(CHECKING_DAEMON), 'automatic')).toEqual({ home: WALNUT_HOME, initiator: 'automatic', strict: true })
  })

  it('an ephemeral server sends nothing to a daemon that cannot check ownership', () => {
    state.ephemeral = true
    expect(stopProvenance(fakeConn(OLD_DAEMON), 'human')).toBeNull()
    expect(stopProvenance(fakeConn([]), 'automatic')).toBeNull()
    expect(stopProvenance(null, 'human')).toBeNull()
    expect(stopProvenance({}, 'human')).toBeNull()
  })
})

describe('describeStopRefusal', () => {
  it('turns a daemon reply into one sentence', () => {
    expect(describeStopRefusal({ ok: false, error: 'stop: invalid reason' })).toBe('stop: invalid reason')
    expect(describeStopRefusal({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' }))
      .toBe('Not stopped: the host\'s daemon records this session as started by another Walnut')
    expect(describeStopRefusal({ ok: true, stopped: false, reason: 'not_owned', detail: 'not_journaled' }))
      .toBe('Not stopped: the host\'s daemon has no record that this Walnut started this session (not_journaled)')
    expect(describeStopRefusal({ ok: true, stopped: false, reason: 'cron_supervised' })).toBe('Daemon did not stop the session (cron_supervised)')
    expect(describeStopRefusal({ ok: true, stopped: false, reason: 'protected', detail: 'bg-task' })).toBe('Daemon did not stop the session (protected: bg-task)')
    expect(describeStopRefusal({ ok: true })).toBe('Daemon did not confirm the stop')
  })
})

describe('an ephemeral server and a daemon without owner-home-v1: no path sends a stop', () => {
  beforeEach(() => { state.ephemeral = true })

  it('a decided stop (idle timeout, eviction, task completion) is refused without a request', async () => {
    const conn = fakeConn(OLD_DAEMON)
    for (const reason of ['idle', 'maintenance', 'user'] as const) {
      expect(await stopThroughOwner({ claudeSessionId: 'sid-copied', host: 'devbox' }, reason, 'test', { connection: async () => conn })).toBe('refused')
    }
    expect(conn.calls).toEqual([])
  })

  it('a person\'s stop stays pending with a reason instead of being sent', async () => {
    const conn = fakeConn(OLD_DAEMON)
    const { coordinator, saved } = coordinatorOn(conn)
    const request = await coordinator.request('sid-user')
    expect(conn.calls).toEqual([])
    expect(request.state).toBe('pending')
    expect(saved.at(-1)).toMatchObject({ state: 'pending', error: STOP_NOT_SENT_NO_OWNERSHIP_CHECK })
  })

  it('a live manager\'s stop, kill and idle stop send nothing', async () => {
    const conn = fakeConn(OLD_DAEMON)
    const mgr = managerOn(conn)
    await expect(mgr.stop('user')).rejects.toThrow(STOP_NOT_SENT_NO_OWNERSHIP_CHECK)
    mgr.kill('maintenance')
    expect(mgr.hasPipe).toBe(true)
    expect(await mgr.stopForIdle()).toBe(false)
    expect(conn.calls).toEqual([])
  })

  it('with owner-home-v1 every path sends a strict, named stop', async () => {
    const conn = fakeConn(CHECKING_DAEMON)
    await stopThroughOwner({ claudeSessionId: 'sid-a' }, 'idle', 'test', { connection: async () => conn })
    await coordinatorOn(conn).coordinator.request('sid-user')
    const mgr = managerOn(conn, 'sid-m')
    await mgr.stop('user')
    mgr.kill('idle')
    await mgr.stopForIdle()
    await vi.waitFor(() => expect(conn.calls).toHaveLength(5))
    expect(conn.calls.map((c) => c.command)).toEqual(['stop', 'stop', 'stop', 'stop', 'stop'])
    for (const call of conn.calls) expect(call.args).toMatchObject({ home: WALNUT_HOME, strict: true })
    expect(conn.calls.map((c) => c.args.initiator)).toEqual(['automatic', 'human', 'human', 'automatic', 'automatic'])
  })
})

describe('a production server', () => {
  it('names itself to a checking daemon on every path, and reports a refusal in words', async () => {
    const refusing = fakeConn(CHECKING_DAEMON, { ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' })
    expect(await stopThroughOwner({ claudeSessionId: 'sid-a' }, 'maintenance', 'task_completed', { connection: async () => refusing })).toBe('refused')
    const { coordinator, saved } = coordinatorOn(refusing)
    await coordinator.request('sid-user')
    expect(saved.at(-1)?.error).toBe('Not stopped: the host\'s daemon records this session as started by another Walnut')
    await expect(managerOn(refusing).stop('user')).rejects.toThrow('started by another Walnut')
    for (const call of refusing.calls) {
      expect(call.args.home).toBe(WALNUT_HOME)
      expect(call.args).not.toHaveProperty('strict')
    }
  })

  it('sends today\'s unlabelled stop to an older daemon', async () => {
    const conn = fakeConn(OLD_DAEMON)
    await stopThroughOwner({ claudeSessionId: 'sid-a' }, 'idle', 'test', { connection: async () => conn })
    await coordinatorOn(conn).coordinator.request('sid-user')
    await managerOn(conn, 'sid-m').stop('maintenance')
    expect(conn.calls.map((c) => c.args)).toEqual([
      { sid: 'sid-a', reason: 'idle' },
      { sid: 'sid-user', reason: 'user', stopRequestId: expect.any(String) },
      { sid: 'sid-m', reason: 'maintenance' },
    ])
  })
})
