/**
 * An ephemeral server booted over a data dir that already holds session rows
 * with pids (a hand-copied sessions store, the 2026-09-26 incident shape) comes
 * up with every one of those pids cleared, and signals nothing on the way.
 *
 * Real startServer in ephemeral mode, isolated temp home, local daemon mocked
 * out. The seeded pids sit above any real pid limit, and process.kill is
 * replaced for the whole boot: signal 0 to one of our pids answers ESRCH, any
 * other signal is recorded and never delivered, and the test fails if one is
 * aimed at a seeded pid.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ephemeral-pids', { IS_EPHEMERAL: true }))
vi.mock('../../src/providers/local-daemon.js', () => ({
  localDaemon: { ensureRunning: async () => {}, stopIfIsolated: async () => {}, port: 0 },
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { closeDb as closeTaskDb } from '../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../src/core/session-db.js'

const BASE = 2 ** 22
const SEEDED = [BASE + 101, BASE + 102, BASE + 103]
const signals: Array<{ pid: number; sig: unknown }> = []
const realKill = process.kill.bind(process)

beforeAll(async () => {
  vi.stubEnv('WALNUT_DISABLE_SEARCH', '1')
  vi.stubEnv('WALNUT_DISABLE_BACKGROUND_AI', '1')
  vi.stubEnv('WALNUT_EXTERNAL_SESSION_IMPORT', '0')
  await fsp.mkdir(WALNUT_HOME, { recursive: true })

  // The copied production rows: a live-looking running session, and two the
  // old sweeps would have signalled (stopped + decided, stopped + observed).
  await createSessionRecord('inherited-running', 'task-a', 'proj', undefined, { pid: SEEDED[0] })
  await updateSessionRecord('inherited-running', { process_status: 'running' })
  await createSessionRecord('inherited-idle-timeout', 'task-b', 'proj', undefined, { pid: SEEDED[1] })
  await updateSessionRecord('inherited-idle-timeout', {
    process_status: 'stopped', status_reason: 'idle_timeout', status_changed_by: 'health-monitor',
    last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })
  await createSessionRecord('inherited-normal', 'task-c', 'proj', undefined, { pid: SEEDED[2] })
  await updateSessionRecord('inherited-normal', {
    process_status: 'stopped', status_reason: 'normal_completion', status_changed_by: 'session-runner',
    last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })

  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    // A missing signal means SIGTERM, so only an explicit 0 is a probe.
    if (sig === 0) {
      if (SEEDED.includes(Math.abs(pid)) || !Number.isSafeInteger(pid) || pid <= 1) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      return realKill(pid, 0) // an existence probe of a real positive pid delivers nothing
    }
    signals.push({ pid, sig })
    return true
  }) as typeof process.kill)

  await startServer({ port: 0, dev: true })
})

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  closeTaskDb()
  closeSessionDb()
  // A late fire-and-forget write from the stopped server can land while rm walks
  // the tree (ENOTEMPTY once in a batch run): retry instead of failing teardown.
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.unstubAllEnvs()
})

it('clears every inherited pid at boot and never signals one', async () => {
  for (const sid of ['inherited-running', 'inherited-idle-timeout', 'inherited-normal']) {
    const record = await getSessionByClaudeId(sid)
    expect(record, sid).not.toBeNull()
    expect(record?.pid, sid).toBeUndefined()
  }
  expect(signals.filter((s) => SEEDED.includes(Math.abs(s.pid)))).toEqual([])
})
