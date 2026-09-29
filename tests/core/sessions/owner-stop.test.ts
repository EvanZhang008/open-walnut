/**
 * The server never signals a CLI pid: orphans end through the daemon that owns
 * them (src/core/sessions/owner-stop.ts).
 *
 * Regression for 2026-09-26/27: an ephemeral test server holding a copy of the
 * production sessions store SIGTERM'd the user's live CLIs from its orphan
 * sweep. Everything here is stubbed. process.kill is spied on for every test
 * and must never be called; the only "daemon" is a fake connection whose
 * `send` is recorded. Pids are fabricated above any real pid limit (2^22 + n),
 * so even a regression that reached the kernel would hit nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-owner-stop'))

import {
  END_DECIDED_REASONS,
  ORPHAN_GRACE_MS,
  ORPHAN_STOP_CAPABILITY,
  orphanCandidateSkip,
  stopAcpThroughOwner,
  stopThroughOwner,
  sweepOrphansThroughOwner,
  type OrphanSweepDeps,
  type OwnerConnection,
} from '../../../src/core/sessions/owner-stop.js'
import { OWNER_HOME_CAPABILITY } from '../../../src/core/sessions/stop-provenance.js'
import type { SessionRecord } from '../../../src/core/types.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { log } from '../../../src/logging/index.js'

/** Above Linux's pid_max ceiling (2^22) and macOS's 99998: no such process can exist. */
const IMPOSSIBLE_PID = 2 ** 22 + 1
const NOW = Date.parse('2026-09-28T12:00:00.000Z')
const HOUR_AGO = new Date(NOW - 60 * 60 * 1000).toISOString()

function row(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'sid-orphan-1',
    taskId: 'task-1',
    project: 'proj',
    process_status: 'stopped',
    mode: 'default',
    startedAt: HOUR_AGO,
    lastActiveAt: HOUR_AGO,
    last_status_change: HOUR_AGO,
    status_reason: 'idle_timeout',
    status_changed_by: 'health-monitor',
    pid: IMPOSSIBLE_PID,
    ...overrides,
  } as SessionRecord
}

interface FakeConn extends OwnerConnection {
  calls: Array<{ command: string; args: Record<string, unknown>; timeoutMs?: number }>
}

function fakeConn(opts: {
  connected?: boolean
  caps?: string[]
  reply?: (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
} = {}): FakeConn {
  const calls: FakeConn['calls'] = []
  return {
    connected: opts.connected ?? true,
    hasCapability: (cap: string) => (opts.caps ?? [ORPHAN_STOP_CAPABILITY]).includes(cap),
    calls,
    async send(command, args, timeoutMs) {
      calls.push({ command, args, timeoutMs })
      return opts.reply ? opts.reply(args) : { ok: true, stopped: true }
    },
  }
}

function deps(conn: FakeConn | null, overrides: Partial<OrphanSweepDeps> = {}) {
  const undo = vi.fn()
  const marks: Array<{ sid: string; reason: string }> = []
  const hosts: string[] = []
  const d: OrphanSweepDeps = {
    connection: async (host) => { hosts.push(host); return conn },
    reread: async (sid) => (sid ? row({ claudeSessionId: sid }) : null),
    markExpectedTeardown: async (sid, reason) => { marks.push({ sid, reason }); return undo },
    now: () => NOW,
    ...overrides,
  }
  return { d, undo, marks, hosts }
}

let killSpy: ReturnType<typeof vi.spyOn>
let infos: Array<{ msg: string; meta?: Record<string, unknown> }>

beforeEach(() => {
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
    throw new Error('process.kill must never be called by the orphan path')
  }) as typeof process.kill)
  infos = []
  vi.spyOn(log.session, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => {
    infos.push({ msg, meta })
  }) as never)
  vi.spyOn(log.session, 'warn').mockImplementation((() => {}) as never)
})

afterEach(() => {
  expect(killSpy, 'the server must never signal a process').not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('orphanCandidateSkip: only a deliberately ended CLI record with a usable pid', () => {
  it.each([...END_DECIDED_REASONS])('a stopped record with reason %s is a candidate', (reason) => {
    expect(orphanCandidateSkip(row({ status_reason: reason as SessionRecord['status_reason'] }), NOW)).toBeNull()
  })

  it('an error record whose reason is a decision is a candidate', () => {
    expect(orphanCandidateSkip(row({ process_status: 'error', status_reason: 'expected_teardown' }), NOW)).toBeNull()
  })

  it.each([
    ['normal_completion'], ['turn_completed'], ['liveness_check_failed'],
    ['process_exited_no_result'], ['daemon_reported_exit'], ['api_error'], ['server_restart'],
  ])('an observation (%s) is not terminal: a live process refutes it', (reason) => {
    expect(orphanCandidateSkip(row({ status_reason: reason as SessionRecord['status_reason'] }), NOW)).toBe('not_terminal')
  })

  it('a record with no reason at all is not terminal', () => {
    expect(orphanCandidateSkip(row({ status_reason: undefined }), NOW)).toBe('not_terminal')
  })

  it.each([['running'], ['idle']])('a %s record is not terminal', (status) => {
    expect(orphanCandidateSkip(row({ process_status: status as SessionRecord['process_status'] }), NOW)).toBe('not_terminal')
  })

  it.each([[undefined], [null], [0], [1], [-1], [-IMPOSSIBLE_PID], [1.5], [Number.NaN]])('pid %s is not usable', (pid) => {
    expect(orphanCandidateSkip(row({ pid: pid as unknown as number }), NOW)).toBe('no_pid')
  })

  it('embedded, sdk and ACP-engine records are not CLI records', () => {
    expect(orphanCandidateSkip(row({ provider: 'embedded' } as Partial<SessionRecord>), NOW)).toBe('not_cli')
    expect(orphanCandidateSkip(row({ provider: 'sdk' } as Partial<SessionRecord>), NOW)).toBe('not_cli')
    expect(orphanCandidateSkip(row({ engine: 'codex' } as Partial<SessionRecord>), NOW)).toBe('not_cli')
  })

  it('a record inside the grace window, or with no timestamp, waits', () => {
    const recent = new Date(NOW - ORPHAN_GRACE_MS + 1000).toISOString()
    expect(orphanCandidateSkip(row({ last_status_change: recent }), NOW)).toBe('grace')
    expect(orphanCandidateSkip(row({ last_status_change: undefined, lastActiveAt: undefined as unknown as string }), NOW)).toBe('grace')
  })

  it('a user stop still being delivered belongs to the stop coordinator', () => {
    const stopRequest = { id: 'x', requestedAt: HOUR_AGO, state: 'pending' as const }
    expect(orphanCandidateSkip(row({ status_reason: 'user_stopped', stopRequest }), NOW)).toBe('stop_pending')
  })
})

describe('sweepOrphansThroughOwner: the owning daemon decides, the server never signals', () => {
  it('a live pid the daemon does NOT own is never terminated, and is logged at info as not_owned', async () => {
    const conn = fakeConn({ reply: () => ({ ok: true, stopped: false, reason: 'not_owned', detail: 'not_in_registry' }) })
    const { d, undo } = deps(conn)

    const outcomes = await sweepOrphansThroughOwner([row()], 'test', d)

    expect(outcomes).toEqual([{
      sessionId: 'sid-orphan-1', host: '__local__', pid: IMPOSSIBLE_PID,
      result: 'left', reason: 'not_owned', detail: 'not_in_registry',
    }])
    // The only thing the server did was ASK the owner.
    expect(conn.calls).toEqual([{
      command: 'stop', args: { sid: 'sid-orphan-1', reason: 'orphan', expectPid: IMPOSSIBLE_PID, home: WALNUT_HOME }, timeoutMs: 15_000,
    }])
    expect(undo).toHaveBeenCalledTimes(1)
    const logged = infos.find((i) => i.msg === 'orphan sweep: left alone')
    expect(logged?.meta).toMatchObject({ sessionId: 'sid-orphan-1', reason: 'not_owned', detail: 'not_in_registry' })
  })

  it('a terminal record the daemon owns IS ended, through the daemon, with the pid as a precondition', async () => {
    const conn = fakeConn({ reply: () => ({ ok: true, stopped: true }) })
    const { d, undo, marks } = deps(conn)

    const outcomes = await sweepOrphansThroughOwner([row({ status_reason: 'user_terminated' })], 'test', d)

    expect(outcomes).toEqual([{ sessionId: 'sid-orphan-1', host: '__local__', pid: IMPOSSIBLE_PID, result: 'ended' }])
    expect(conn.calls).toHaveLength(1)
    expect(conn.calls[0].command).toBe('stop')
    // home names this Walnut, so a shared (remote) daemon ends only what it started for us.
    expect(conn.calls[0].args).toEqual({ sid: 'sid-orphan-1', reason: 'orphan', expectPid: IMPOSSIBLE_PID, home: WALNUT_HOME })
    expect(marks).toEqual([{ sid: 'sid-orphan-1', reason: 'orphan_cleanup' }])
    expect(undo).not.toHaveBeenCalled()
  })

  it('a remote record goes to THAT host\'s daemon', async () => {
    const conn = fakeConn()
    const { d, hosts } = deps(conn, { reread: async (sid) => row({ claudeSessionId: sid, host: 'devbox' }) })

    await sweepOrphansThroughOwner([row({ host: 'devbox' })], 'test', d)

    expect(hosts).toEqual(['devbox'])
    expect(conn.calls).toHaveLength(1)
  })

  it.each([
    ['advertises nothing yet (hello not answered)', []],
    ['predates orphan-stop-v1', ['stop', 'status', 'snapshot-v1']],
  ])('a daemon that %s gets no request at all, so nothing is ended', async (_label, caps) => {
    const conn = fakeConn({ caps })
    const { d } = deps(conn)

    const outcomes = await sweepOrphansThroughOwner([row()], 'test', d)

    expect(conn.calls).toEqual([])
    expect(outcomes[0]).toMatchObject({ result: 'left', reason: 'no_ownership_capability' })
  })

  it('an idle long-running CLI whose record only CLAIMS it stopped is never asked about', async () => {
    // The production risk: a live CLI idling between turns has a stale JSONL, so the
    // old freshness veto did not protect it. Its record is 'stopped' by observation
    // (the false-zombie shape), not by decision, and the owner would say "mine".
    const conn = fakeConn({ reply: () => ({ ok: true, stopped: true }) })
    const { d } = deps(conn)
    const shapes = [
      row({ claudeSessionId: 'observed-1', status_reason: 'liveness_check_failed' }),
      row({ claudeSessionId: 'observed-2', status_reason: undefined }),
      // The incident's own rows: 'stopped' written by the session runner after a
      // transport check lost the process, reason normal_completion.
      row({ claudeSessionId: 'observed-3', status_reason: 'normal_completion', status_changed_by: 'session-runner' }),
    ]

    const outcomes = await sweepOrphansThroughOwner(shapes, 'test', d)

    expect(outcomes).toEqual([])
    expect(conn.calls).toEqual([])
  })

  it('a disconnected or missing owner means nothing happens', async () => {
    for (const conn of [fakeConn({ connected: false }), null]) {
      const { d } = deps(conn)
      const outcomes = await sweepOrphansThroughOwner([row()], 'test', d)
      expect(outcomes[0]).toMatchObject({ result: 'left', reason: 'owner_unreachable' })
      if (conn) expect(conn.calls).toEqual([])
    }
  })

  it('a record that changed since the scan (resumed, new pid, gone) is left alone', async () => {
    for (const current of [
      row({ process_status: 'running' }),
      row({ pid: IMPOSSIBLE_PID + 7 }),
      row({ host: 'elsewhere' }),
      null,
    ]) {
      const conn = fakeConn()
      const { d } = deps(conn, { reread: async () => current })
      const outcomes = await sweepOrphansThroughOwner([row()], 'test', d)
      expect(outcomes[0]).toMatchObject({ result: 'left', reason: 'record_changed' })
      expect(conn.calls).toEqual([])
    }
  })

  it.each([
    ['protected', { ok: true, stopped: false, reason: 'protected', detail: 'bg-task' }],
    ['recent_output', { ok: true, stopped: false, reason: 'recent_output' }],
    ['not_running', { ok: true, stopped: false, reason: 'not_running' }],
  ])('a daemon refusal (%s) leaves the process and undoes the teardown mark', async (reason, reply) => {
    const conn = fakeConn({ reply: () => reply })
    const { d, undo } = deps(conn)
    const outcomes = await sweepOrphansThroughOwner([row()], 'test', d)
    expect(outcomes[0]).toMatchObject({ result: 'left', reason })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('a daemon error or a failed request ends nothing and undoes the mark', async () => {
    const errored = fakeConn({ reply: () => ({ ok: false, error: 'stop: invalid reason' }) })
    const a = deps(errored)
    expect((await sweepOrphansThroughOwner([row()], 'test', a.d))[0]).toMatchObject({ result: 'left', reason: 'daemon_error', detail: 'stop: invalid reason' })
    expect(a.undo).toHaveBeenCalledTimes(1)

    const throwing = fakeConn({ reply: () => { throw new Error('socket closed') } })
    const b = deps(throwing)
    expect((await sweepOrphansThroughOwner([row()], 'test', b.d))[0]).toMatchObject({ result: 'left', reason: 'request_failed', detail: 'socket closed' })
    expect(b.undo).toHaveBeenCalledTimes(1)
  })

  it('asks once per sid even when the scan lists it twice', async () => {
    const conn = fakeConn()
    const { d } = deps(conn)
    await sweepOrphansThroughOwner([row(), row(), row({ claudeSessionId: 'sid-orphan-2' })], 'test', d)
    expect(conn.calls.map((c) => c.args.sid).sort()).toEqual(['sid-orphan-1', 'sid-orphan-2'])
  })

  it('is single-flight: a sweep started while one runs shares it', async () => {
    let release: (v: Record<string, unknown>) => void = () => {}
    const conn = fakeConn({ reply: () => new Promise((r) => { release = r }) })
    const { d } = deps(conn)
    const first = sweepOrphansThroughOwner([row()], 'first', d)
    const second = sweepOrphansThroughOwner([row({ claudeSessionId: 'other' })], 'second', d)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(conn.calls).toHaveLength(1))
    release({ ok: true, stopped: true })
    await first
    expect(conn.calls).toHaveLength(1)
  })
})

describe('stopThroughOwner: a decided stop goes to the owning daemon, never to a local pid', () => {
  it('sends the daemon stop for the sid and reports its confirmation', async () => {
    const conn = fakeConn({ reply: () => ({ ok: true, stopped: true }) })
    const hosts: string[] = []
    const outcome = await stopThroughOwner({ claudeSessionId: 'sid-a', host: undefined }, 'idle', 'idle_timeout', {
      connection: async (h) => { hosts.push(h); return conn },
    })
    expect(outcome).toBe('stopped')
    expect(hosts).toEqual(['__local__'])
    // A daemon older than owner-home-v1 gets today's unlabelled stop from the production server.
    expect(conn.calls).toEqual([{ command: 'stop', args: { sid: 'sid-a', reason: 'idle' }, timeoutMs: 15_000 }])
  })

  it('routes a remote session to its own host', async () => {
    const conn = fakeConn()
    const hosts: string[] = []
    await stopThroughOwner({ claudeSessionId: 'sid-r', host: 'devbox' }, 'maintenance', 'task_completed', {
      connection: async (h) => { hosts.push(h); return conn },
    })
    expect(hosts).toEqual(['devbox'])
    expect(conn.calls[0].args).toEqual({ sid: 'sid-r', reason: 'maintenance' })
  })

  it('names this Walnut and an automatic initiator to a daemon that checks ownership', async () => {
    const conn = fakeConn({ caps: [ORPHAN_STOP_CAPABILITY, OWNER_HOME_CAPABILITY] })
    expect(await stopThroughOwner({ claudeSessionId: 'sid-h' }, 'idle', 'idle_timeout', { connection: async () => conn })).toBe('stopped')
    expect(conn.calls[0].args).toEqual({ sid: 'sid-h', reason: 'idle', home: WALNUT_HOME, initiator: 'automatic' })
  })

  it('passes a human initiator through when a person asked for the stop', async () => {
    const conn = fakeConn({ caps: [OWNER_HOME_CAPABILITY] })
    await stopThroughOwner({ claudeSessionId: 'sid-u' }, 'user', 'user_asked', { connection: async () => conn }, 'human')
    expect(conn.calls[0].args).toEqual({ sid: 'sid-u', reason: 'user', home: WALNUT_HOME, initiator: 'human' })
  })

  it('is unreachable, and sends nothing, when the host daemon is not connected', async () => {
    const conn = fakeConn({ connected: false })
    expect(await stopThroughOwner({ claudeSessionId: 's' }, 'idle', 'x', { connection: async () => conn })).toBe('unreachable')
    expect(await stopThroughOwner({ claudeSessionId: 's' }, 'idle', 'x', { connection: async () => null })).toBe('unreachable')
    expect(await stopThroughOwner({ claudeSessionId: 's' }, 'idle', 'x', { connection: async () => { throw new Error('boom') } })).toBe('unreachable')
    expect(conn.calls).toEqual([])
  })

  it('is refused on a refusal or an error reply, and unknown on a failed request', async () => {
    for (const [reply, expected] of [
      [() => ({ ok: true, stopped: false, reason: 'cron_supervised' }), 'refused'],
      [() => ({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' }), 'refused'],
      [() => ({ ok: false, error: 'stop: process identity is unknown; refusing to signal' }), 'refused'],
      [() => { throw new Error('timeout') }, 'unknown'],
    ] as const) {
      const conn = fakeConn({ reply })
      expect(await stopThroughOwner({ claudeSessionId: 's' }, 'idle', 'x', { connection: async () => conn })).toBe(expected)
    }
  })
})

describe('stopAcpThroughOwner: a detached ACP worker ends through the daemon that hosts it', () => {
  const acpRow = (overrides: Partial<SessionRecord> = {}) =>
    ({ claudeSessionId: 'acp-sid', host: undefined, acpRuntimeId: 'rt-1', ...overrides }) as SessionRecord

  it('sends acpStop for the runtime id to the local daemon', async () => {
    const conn = fakeConn()
    const hosts: string[] = []
    const outcome = await stopAcpThroughOwner(acpRow(), 'user_terminated', { connection: async (h) => { hosts.push(h); return conn } }, { ephemeral: false })
    expect(outcome).toBe('stopped')
    expect(hosts).toEqual(['__local__'])
    expect(conn.calls).toEqual([{ command: 'acpStop', args: { sid: 'rt-1' }, timeoutMs: 15_000 }])
  })

  it('a production server reaches a remote host\'s daemon too', async () => {
    const conn = fakeConn()
    const hosts: string[] = []
    await stopAcpThroughOwner(acpRow({ host: 'devbox' }), 'user_terminated', { connection: async (h) => { hosts.push(h); return conn } }, { ephemeral: false })
    expect(hosts).toEqual(['devbox'])
    expect(conn.calls).toHaveLength(1)
  })

  it('a test server never stops ACP work on a shared remote host, but may on its own local daemon', async () => {
    const remote = fakeConn()
    expect(await stopAcpThroughOwner(acpRow({ host: 'devbox' }), 'user_terminated', { connection: async () => remote }, { ephemeral: true })).toBe('refused')
    expect(remote.calls).toEqual([])

    const local = fakeConn()
    expect(await stopAcpThroughOwner(acpRow(), 'user_terminated', { connection: async () => local }, { ephemeral: true })).toBe('stopped')
    expect(local.calls).toHaveLength(1)
  })

  it('a record with no runtime id sends nothing', async () => {
    const conn = fakeConn()
    expect(await stopAcpThroughOwner(acpRow({ acpRuntimeId: undefined }), 'x', { connection: async () => conn }, { ephemeral: false })).toBe('refused')
    expect(conn.calls).toEqual([])
  })

  it('a disconnected daemon, a refusal and a failed request are reported, never signalled', async () => {
    expect(await stopAcpThroughOwner(acpRow(), 'x', { connection: async () => fakeConn({ connected: false }) }, { ephemeral: false })).toBe('unreachable')
    expect(await stopAcpThroughOwner(acpRow(), 'x', { connection: async () => fakeConn({ reply: () => ({ ok: true, stopped: false }) }) }, { ephemeral: false })).toBe('refused')
    expect(await stopAcpThroughOwner(acpRow(), 'x', { connection: async () => fakeConn({ reply: () => { throw new Error('closed') } }) }, { ephemeral: false })).toBe('unknown')
  })
})
