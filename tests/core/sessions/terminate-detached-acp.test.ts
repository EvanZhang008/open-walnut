/**
 * Terminating a detached ACP session (no live session object, no session
 * manager) asks the daemon that hosts the worker to end it, by runtime id. It
 * never signals the pid in the record.
 *
 * This branch used to SIGTERM the record's process group from this machine:
 * the record's pid, remote hosts' included, in a store an ephemeral server may
 * have copied from production. The runner and the session manager registry are
 * stubbed, the "daemon" is a fake connection, and process.kill is spied on:
 * any real signal is recorded (never delivered) and fails the test. Pids are
 * fabricated above any real pid limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const state = vi.hoisted(() => ({
  ephemeral: false,
  conn: null as null | {
    connected: boolean
    hasCapability(cap: string): boolean
    send(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  },
  hosts: [] as string[],
}))

vi.mock('../../../src/constants.js', () => ({
  ...createMockConstants('walnut-terminate-detached-acp'),
  get IS_EPHEMERAL() { return state.ephemeral },
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: (host: string) => { state.hosts.push(host); return state.conn },
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    isCronArmed: () => false,
    findAcpSession: () => undefined,
    findSessionByClaudeId: () => undefined,
    settleInFlightTurn: () => {},
    markExpectedTeardown: () => undefined,
  },
}))
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => undefined,
}))

import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { terminateSession } from '../../../src/core/sessions/session-lifecycle.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const PID = 2 ** 22 + 51
let signals: Array<[number, unknown]>
let calls: Array<{ command: string; args: Record<string, unknown> }>

function daemon(reply: Record<string, unknown> = { ok: true, stopped: true }) {
  calls = []
  state.conn = {
    connected: true,
    hasCapability: () => true,
    async send(command, args) { calls.push({ command, args }); return reply },
  }
}

beforeEach(async () => {
  // A fresh store per test: the cases reuse session ids.
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  state.ephemeral = false
  state.hosts = []
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])   // record, never deliver
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'terminate must never signal a pid it read from a record').toEqual([])
  state.conn = null
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function seedAcp(sid: string, host?: string): Promise<void> {
  await createSessionRecord(sid, 'task-acp', 'proj', undefined, {
    engine: 'codex', acpRuntimeId: `rt-${sid}`, pid: PID, ...(host ? { host } : {}),
  })
}

describe('terminateSession on a detached ACP session', () => {
  it('sends acpStop for the runtime id to the local daemon and marks the record stopped', async () => {
    daemon()
    await seedAcp('acp-local')

    const result = await terminateSession('acp-local')

    expect(result.status).toBe('terminated')
    expect(state.hosts).toEqual(['__local__'])
    expect(calls).toEqual([{ command: 'acpStop', args: { sid: 'rt-acp-local' } }])
    const rec = await getSessionByClaudeId('acp-local')
    expect(rec).toMatchObject({ process_status: 'stopped', status_reason: 'user_terminated' })
    expect(rec?.pid).toBeUndefined()
  })

  it('a production server asks a remote host\'s daemon', async () => {
    daemon()
    await seedAcp('acp-remote', 'devbox')
    await terminateSession('acp-remote')
    expect(state.hosts).toEqual(['devbox'])
    expect(calls).toEqual([{ command: 'acpStop', args: { sid: 'rt-acp-remote' } }])
  })

  it('an ephemeral server sends nothing to a shared remote host, and still signals nothing', async () => {
    state.ephemeral = true
    daemon()
    await seedAcp('acp-copied', 'devbox')
    const result = await terminateSession('acp-copied')
    expect(result.status).toBe('terminated')
    expect(calls).toEqual([])
  })

  it('a disconnected or refusing daemon still signals nothing', async () => {
    await seedAcp('acp-offline')
    state.conn = { connected: false, hasCapability: () => true, send: async () => { throw new Error('must not send') } }
    await terminateSession('acp-offline')

    daemon({ ok: false, error: 'acpStop: unknown runtime' })
    await seedAcp('acp-refused')
    await terminateSession('acp-refused')
    expect(calls).toHaveLength(1)
  })
})
