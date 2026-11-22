/**
 * A host replica's sessions.sqlite is the leader's copy, read only; a host that runs its sessions
 * writes its own rows (host = its key, judge 'host') through session-db's own-row writer, which
 * refuses every write of any other row (copy-guard's rule stays for those).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-own-row-writer', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'

const KEY = 'devbox'
const own = (sid: string) => ({ host: KEY, judge: 'host' as const, title: sid })

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  // The leader's copy arrives first: one leader row and nothing of this host's.
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER']) delete process.env[k]
  _resetServerRoleForTesting()
  sessionDb.applySessionCopy({ rows: [{ claudeSessionId: 'leader-row', taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } as never] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
})

afterAll(async () => {
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the own-row writer of a host replica', () => {
  it('without it, a host replica writes nothing (the copy guard)', async () => {
    await expect(tracker.createSessionRecord('h-0', '', 'p', '/tmp', own('h-0') as never)).rejects.toThrow(/readonly|read only|query_only/i)
  })

  it('with it, the host creates, updates, renames and deletes its own rows', async () => {
    sessionDb.allowOwnRowWrites(KEY)
    await tracker.createSessionRecord('h-1', '', 'p', '/tmp', own('h-1') as never)
    await tracker.updateSessionRecord('h-1', { process_status: 'idle' })
    expect((await tracker.getSessionByClaudeId('h-1'))).toMatchObject({ host: KEY, judge: 'host', process_status: 'idle' })
    await tracker.renameSessionId('h-1', 'h-2')
    expect(await tracker.getSessionByClaudeId('h-2')).not.toBeNull()
    expect(await tracker.deleteSessionRecords(['h-2'], 'test')).toBe(1)
  })

  it('and still refuses any other row: the leader\'s, a row of another host, an own row made someone else\'s', async () => {
    sessionDb.allowOwnRowWrites(KEY)
    await expect(tracker.updateSessionRecord('leader-row', { human_note: 'x' })).rejects.toThrow(sessionDb.NOT_OWN_ROW)
    await expect(tracker.createSessionRecord('other', '', 'p', '/tmp', { host: 'elsewhere', judge: 'host' } as never)).rejects.toThrow(sessionDb.NOT_OWN_ROW)
    // A row it makes on itself is its own from birth.
    expect(await tracker.createSessionRecord('born-own', '', 'p', '/tmp', { host: KEY })).toMatchObject({ judge: 'host' })
    await tracker.createSessionRecord('h-3', '', 'p', '/tmp', own('h-3') as never)
    await expect(tracker.updateSessionRecord('h-3', { host: 'elsewhere' })).rejects.toThrow(sessionDb.NOT_OWN_ROW)
    expect(await tracker.deleteSessionRecords(['leader-row'], 'test').catch((e: Error) => e.message)).toMatch(sessionDb.NOT_OWN_ROW)
    expect(await tracker.getSessionByClaudeId('leader-row')).not.toBeNull()
  })

  it('the leader\'s copy never brings back an own row this host removed (a rename the leader has not applied yet); a seed it hands comes down', async () => {
    sessionDb.allowOwnRowWrites(KEY)
    await tracker.createSessionRecord('mine-now', '', 'p', '/tmp', own('mine-now') as never)
    sessionDb.noteOwnRowGone('renamed-away')
    const base = { taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 }
    const r = sessionDb.applySessionCopy({
      ownHost: KEY,
      rows: [
        { claudeSessionId: 'renamed-away', host: KEY, judge: 'host', ...base } as never,
        { claudeSessionId: 'mine-now', host: KEY, judge: 'host', human_note: 'from the leader', ...base } as never,
        { claudeSessionId: 'leader-two', ...base } as never,
        // A row the leader made for a start and marked this host's: this host's from here on.
        { claudeSessionId: 'seeded', host: KEY, judge: 'host', ...base } as never,
      ],
    })
    expect(r.skippedOwn).toBe(1)
    tracker._resetSessionTrackerForTesting()
    expect(await tracker.getSessionByClaudeId('renamed-away')).toBeNull()
    expect(await tracker.getSessionByClaudeId('mine-now')).toMatchObject({ judge: 'host', human_note: 'from the leader' })
    expect(await tracker.getSessionByClaudeId('leader-two')).not.toBeNull()
    expect(await tracker.getSessionByClaudeId('seeded')).toMatchObject({ judge: 'host', host: KEY })
  })
})
