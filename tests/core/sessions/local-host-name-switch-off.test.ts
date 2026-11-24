/**
 * On the leader with no host running its sessions (the switch off), a row whose host is the name
 * '__local__' is this machine's session exactly as a row of no host: the place helpers
 * (session-row-owner.ts execHostOf, cliHostOf, readHostOf) give the same answers for both, the
 * list of this machine's live sessions holds both, and a liveness check reads the process here
 * without asking a daemon link of that name. Review round 1 of C8-16, N4: before this branch a few
 * sites read '__local__' as a remote host (session-chat's isRemote, the liveness fallback,
 * listLocalLiveSessions); now every site reads it as the host-less row it means.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-local-host-name', { CLOUD_MODE: false }))
const dc = vi.hoisted(() => ({ asked: [] as string[] }))
vi.mock('../../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<object>()),
  isDaemonConnected: (host: string) => { dc.asked.push(host); return false },
  // A link down for ten minutes: a remote row reads dead.
  getDaemonDisconnectedAwakeMs: () => 10 * 60_000,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { cliHostOf, execHostOf, readHostOf } from '../../../src/core/sessions/session-row-owner.js'
import { isSessionProcessAlive } from '../../../src/utils/session-liveness.js'

const ROWS = { none: 'sid-no-host', named: 'sid-local-name', remote: 'sid-devbox' }

beforeAll(async () => {
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  await tracker.createSessionRecord(ROWS.none, 'task-1', 'Marina', '/w', { title: 'No host' })
  await tracker.createSessionRecord(ROWS.named, 'task-2', 'Marina', '/w', { host: '__local__', title: 'Named local' })
  await tracker.createSessionRecord(ROWS.remote, 'task-3', 'Marina', '/w', { host: 'devbox', title: 'On devbox' })
  for (const sid of Object.values(ROWS)) await tracker.updateSessionRecord(sid, { process_status: 'running', pid: process.pid })
})

afterAll(async () => {
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a row named \'__local__\' with the switch off', () => {
  it('the place helpers answer for it as for a row of no host', async () => {
    const named = (await tracker.getSessionByClaudeId(ROWS.named))!
    const none = (await tracker.getSessionByClaudeId(ROWS.none))!
    for (const f of [execHostOf, cliHostOf, readHostOf] as const) expect(f(named), f.name).toEqual(f(none))
    expect(cliHostOf(named)).toBe('__local__')
    expect(execHostOf(named)).toBeUndefined()
  })

  it('is in this machine\'s live sessions, as a row of no host is; a remote row is not', async () => {
    const live = (await tracker.listLocalLiveSessions()).map((s) => s.claudeSessionId).sort()
    expect(live).toEqual([ROWS.named, ROWS.none].sort())
  })

  it('its liveness is its process here, no daemon link asked; a remote row asks its host\'s link', async () => {
    dc.asked.length = 0
    expect(await isSessionProcessAlive((await tracker.getSessionByClaudeId(ROWS.named))!)).toBe(true)
    expect(await isSessionProcessAlive((await tracker.getSessionByClaudeId(ROWS.none))!)).toBe(true)
    expect(dc.asked).toEqual([])
    expect(await isSessionProcessAlive((await tracker.getSessionByClaudeId(ROWS.remote))!)).toBe(false)
    expect(dc.asked).toEqual(['devbox'])
  })
})
