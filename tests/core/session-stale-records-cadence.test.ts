/**
 * "fixing stale records": one warning per record per episode, and a record the
 * snapshot projection owns is asked of its host instead of waiting.
 *
 * 2026-11-12: one dead remote CLI was "fixed" every 5 seconds for 10 minutes (157
 * warnings in an hour). Its record was snapshot-covered in enforce mode, so the gate
 * dropped every repair write whole and the record stayed 'running' until the
 * health monitor's pull ran again. Each caller of the repair (the capacity check on
 * every send, both alive-by-host reads) re-found it and warned again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
const recheckSession = vi.fn(async (sessionId: string) => ({ sessionId, checked: false }))
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({ recheckSession }))

import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  getAllAliveSessionsByHost,
  getActiveSessionsByHost,
  _resetSessionTrackerForTesting,
  _resetStaleRepairForTests,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import {
  setSnapshotModeForTests,
  markSnapshotCovered,
  _resetSnapshotGateForTests,
} from '../../src/core/session-snapshot-gate.js'
import { log } from '../../src/logging/index.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

/** A pid that named a real process and no longer does. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  return Number(String(r.stdout))
}

async function deadRunning(sid: string): Promise<void> {
  await createSessionRecord(sid, '', 'proj', '/Users/test/stale-cadence', { pid: deadPid() })
  await updateSessionRecord(sid, { process_status: 'running' })
}

/** The repair decides synchronously; only the host ask (a dynamic import) and the
 *  write land later, and those are awaited through vi.waitFor on their effect. */
const asked = (n: number) => vi.waitFor(() => expect(recheckSession).toHaveBeenCalledTimes(n))
let now = Date.now()

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetStaleRepairForTests()
  _resetSnapshotGateForTests()
  recheckSession.mockClear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(async () => {
  vi.restoreAllMocks()
  setSnapshotModeForTests(null)
  _resetSnapshotGateForTests()
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

const staleWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter(([msg]) => msg === 'fixing stale records')

describe('fixing stale records', () => {
  it('a record the projection owns is repaired at most every 30s, warns every 10 min and is asked of its host every 5 min', async () => {
    const sid = 'stale-covered'
    await deadRunning(sid)
    setSnapshotModeForTests('enforce')
    markSnapshotCovered(sid)
    const warn = vi.spyOn(log.session, 'warn')

    // The callers come round every few seconds: three in the same moment, then 5s later.
    expect(Object.values(await getAllAliveSessionsByHost()).flat()).toEqual([])
    await getActiveSessionsByHost()
    await getAllAliveSessionsByHost()
    now += 5_000
    await getActiveSessionsByHost()
    await asked(1)
    expect(staleWarnings(warn)).toHaveLength(1)
    expect(recheckSession).toHaveBeenCalledTimes(1)
    expect(recheckSession).toHaveBeenCalledWith(sid)
    // The gate dropped the legacy write: only the host's snapshot can move it.
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')

    // Still stale 31s later: repaired again quietly, the host not asked again yet.
    now += 31_000
    await getAllAliveSessionsByHost()
    await asked(1)
    expect(recheckSession).toHaveBeenCalledTimes(1)
    expect(staleWarnings(warn)).toHaveLength(1)

    // Five minutes on: the host is asked again, still without a new warning.
    now += 5 * 60_000
    await getAllAliveSessionsByHost()
    await asked(2)
    expect(recheckSession).toHaveBeenCalledTimes(2)
    expect(staleWarnings(warn)).toHaveLength(1)

    // Stale for over 10 minutes: one more warning, so a stuck record is never silent.
    now += 5 * 60_000
    await getAllAliveSessionsByHost()
    await asked(3)
    expect(staleWarnings(warn)).toHaveLength(2)
  })

  it('a record the projection does not own is written stopped at once, with one warning and no host ask', async () => {
    const sid = 'stale-legacy'
    await deadRunning(sid)
    setSnapshotModeForTests('enforce') // enforce, but this sid has no snapshot yet
    const warn = vi.spyOn(log.session, 'warn')

    await getAllAliveSessionsByHost()
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped'))
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('liveness_check_failed')
    expect(staleWarnings(warn)).toHaveLength(1)
    expect(recheckSession).not.toHaveBeenCalled()
    // Fixed, so the next caller does not find it again.
    await getAllAliveSessionsByHost()
    await new Promise((r) => setImmediate(r))
    expect(staleWarnings(warn)).toHaveLength(1)
  })
})
