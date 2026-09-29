/**
 * The session runner's orphan sweep (fired on every session start) asks the
 * owning daemon to end an orphaned CLI and never signals the pid itself.
 *
 * It used to process.kill(s.pid, 'SIGTERM') every record that said "stopped"
 * while its pid answered: on 2026-09-26 an ephemeral server over a copied
 * production store did exactly that to the user's live CLIs. The store is a
 * temp sessions.sqlite with a fabricated row (pid above any real pid limit),
 * the daemon is a fake connection, and process.kill is spied on: any real
 * signal is recorded, never delivered, and fails the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

const state = vi.hoisted(() => ({
  conn: null as null | {
    connected: boolean
    hasCapability(cap: string): boolean
    send(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  },
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-runner-orphan-sweep'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()),
  getConnectedDaemonConnection: () => state.conn,
}))

import { SessionRunner } from '../../src/providers/claude-code-session.js'
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ORPHAN_STOP_CAPABILITY } from '../../src/core/sessions/owner-stop.js'
import { WALNUT_HOME } from '../../src/constants.js'

const PID = 2 ** 22 + 61
let signals: Array<[number, unknown]>
let calls: Array<{ command: string; args: Record<string, unknown> }>

function daemon(caps: string[], reply: Record<string, unknown> = { ok: true, stopped: true }) {
  calls = []
  state.conn = {
    connected: true,
    hasCapability: (cap) => caps.includes(cap),
    async send(command, args) { calls.push({ command, args }); return reply },
  }
}

async function seedOrphan(sid: string): Promise<void> {
  await createSessionRecord(sid, 'task-1', 'proj', undefined, { pid: PID })
  await updateSessionRecord(sid, {
    process_status: 'stopped', status_reason: 'user_terminated', status_changed_by: 'user',
    last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  } as never)
}

function sweep(runner: SessionRunner): Promise<void> {
  return (runner as unknown as { killOrphanedSessionProcesses(): Promise<void> }).killOrphanedSessionProcesses()
}

beforeEach(async () => {
  // A fresh store per test: the cases reuse session ids.
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  calls = []
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])   // record, never deliver
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'the runner must never signal a pid it read from a record').toEqual([])
  state.conn = null
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('SessionRunner orphan sweep', () => {
  it('asks the owning daemon with the pid as a precondition, and signals nothing', async () => {
    daemon([ORPHAN_STOP_CAPABILITY])
    await seedOrphan('orphan-a')

    await sweep(new SessionRunner('true'))

    expect(calls).toEqual([{
      command: 'stop',
      args: { sid: 'orphan-a', reason: 'orphan', expectPid: PID, home: WALNUT_HOME },
    }])
  })

  it('a daemon that refuses (not its session) leaves the process alone', async () => {
    daemon([ORPHAN_STOP_CAPABILITY], { ok: true, stopped: false, reason: 'not_owned', detail: 'not_in_registry' })
    await seedOrphan('orphan-b')
    await sweep(new SessionRunner('true'))
    expect(calls).toHaveLength(1)
  })

  it('a daemon without orphan-stop-v1, or no daemon at all, is not asked and nothing is signalled', async () => {
    daemon(['stop', 'status'])
    await seedOrphan('orphan-c')
    await sweep(new SessionRunner('true'))
    expect(calls).toEqual([])

    state.conn = null
    await sweep(new SessionRunner('true'))
  })
})
