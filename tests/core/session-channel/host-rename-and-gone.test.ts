/**
 * On a host replica that runs its sessions, with the real session store, the real port and the
 * real fact emitter:
 *   R2-H1  a rename the host makes (a resume, a fork) reaches the log as `rename` then a patch of
 *          the new id: never a `born` row, which a leader reads as a new start
 *   R2-M4  the own rows it removed are kept on disk next to its log (gone-rows.ts): after a restart
 *          of the host, and hours later, the leader's copy still never brings one back
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-rename-gone', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { createHostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import { createHostSessionPort, StartBundles } from '../../../src/core/session-channel/host-port.js'
import { GoneRows, GONE_MAX_AGE_MS } from '../../../src/core/session-channel/gone-rows.js'
import { EventBus } from '../../../src/core/event-bus.js'

const KEY = 'devbox'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER']) delete process.env[k]
  _resetServerRoleForTesting()
  sessionDb.applySessionCopy({ rows: [{ claudeSessionId: 'leader-row', taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } as never] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
})

afterAll(async () => {
  sessionDb.setOwnRowsGoneStore(null)
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('R2-H1: a rename on the host', () => {
  it('goes to the log as `rename`, then a patch of the new id, never a born row of it', async () => {
    const dir = path.join(WALNUT_HOME, 'session-channel')
    const log = await FactLog.open({ dir, walnutId: 'w-rename', flushMs: 1, durable: false })
    await tracker.createSessionRecord(A, 'task-done-1', 'p', '/tmp', { host: KEY, judge: 'host', title: 'A' } as never)
    const emitter = createHostEmitter({ log, channel: null, hostKey: KEY, ownRows: async () => [(await tracker.getSessionByClaudeId(A))!], bus: new EventBus() })
    const port = createHostSessionPort({
      hostKey: KEY, bundles: new StartBundles(), api: async () => null,
      beforeRename: (f, t) => emitter.expectRename(f, t),
      renameFailed: (f, t) => emitter.cancelRename(f, t),
      onRename: (f, t) => emitter.noteRename(f, t),
    })
    await emitter.start()
    await log.flush()
    const head = log.head
    await port.records.tracker.renameSessionId(A, B)
    await log.flush()
    const recs = (await log.read(head)).filter((r) => r.name === 'row' || r.name === 'rename')
    expect(recs.map((r) => `${r.name}:${r.sid}`)[0]).toBe(`rename:${B}`)
    for (const r of recs) expect((r.data as { born?: unknown }).born, `${r.name}:${r.sid}`).toBeUndefined()
    expect(emitter.owns(B)).toBe(true)
    expect(emitter.owns(A)).toBe(false)
    // A rename the store refused (no such row) leaves nothing expected behind.
    expect(await port.records.tracker.renameSessionId('missing-row', C)).toBeFalsy()
    await tracker.createSessionRecord(C, '', 'p', '/tmp', { host: KEY, judge: 'host' } as never)
    await log.flush()
    const born = (await log.read(head)).filter((r) => r.name === 'row' && r.sid === C)
    expect((born[0]?.data as { born?: unknown })?.born).toBe(true)
    emitter.stop()
    await log.close()
  })
})

describe('R2-M4: the own rows the host removed, kept on disk', () => {
  it('survive a restart of the host and a leader away for hours: the copy never brings one back', async () => {
    const dir = path.join(WALNUT_HOME, 'session-channel')
    let now = Date.parse('2026-11-22T00:00:00.000Z')
    const first = await GoneRows.open(dir, 'w-gone', () => now)
    sessionDb.setOwnRowsGoneStore(first)
    sessionDb.noteOwnRowGone('renamed-away-1')
    await first.flush()
    // The host restarts: the list is read back from disk.
    sessionDb.setOwnRowsGoneStore(null)
    now += 3 * 60 * 60_000
    const again = await GoneRows.open(dir, 'w-gone', () => now)
    sessionDb.setOwnRowsGoneStore(again)
    const base = { taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 }
    const r = sessionDb.applySessionCopy({ ownHost: KEY, rows: [{ claudeSessionId: 'renamed-away-1', host: KEY, judge: 'host', ...base } as never] })
    expect(r.skippedOwn).toBe(1)
    tracker._resetSessionTrackerForTesting()
    expect(await tracker.getSessionByClaudeId('renamed-away-1')).toBeNull()
    expect(again.list()).toEqual(['renamed-away-1'])
    // Bounded: past its age it is no longer on the list.
    now += GONE_MAX_AGE_MS
    expect(again.has('renamed-away-1')).toBe(false)
    // An own row the host has again under that id leaves the list.
    again.note('back-again')
    again.forget('back-again')
    expect(again.list()).toEqual([])
  })
})
