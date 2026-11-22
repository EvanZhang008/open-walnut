/**
 * The leader's apply of a host's channel records (session-tracker applyHostChannelBatch): rows,
 * renames and the channel's position in one transaction; a leader field the leader holds is
 * kept; only the host's own rows are written; the status and content events of a normal write
 * follow the commit. And the row hook (session-channel/row-hook.ts): every committed write path
 * of the store announces the row it wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apply-host-batch'))

import {
  _resetSessionTrackerForTesting, applyHostChannelBatch, batchUpdateSessionRecords, createSessionRecord, getSessionByClaudeId,
  importSessionRecord, loadChannelCursor, renameSessionId, updateSessionRecord,
} from '../../../src/core/session-tracker.js'
import { closeDb, getDb } from '../../../src/core/session-db.js'
import { setOwnRowListener } from '../../../src/core/session-channel/row-hook.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'devbox'
const born = (sid: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', messageCount: 0, title: 'From host',
  statusRevision: 1, statusUpdatedAt: '2026-11-22T00:00:00.000Z', ...extra,
})

const events: BusEvent[] = []
beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  events.length = 0
  bus.subscribe('apply-host-batch-test', (e) => { events.push(e) }, { global: true, interest: ['session:'] })
})
afterEach(() => {
  bus.unsubscribe('apply-host-batch-test')
  setOwnRowListener(null)
  closeDb()
  _resetSessionTrackerForTesting()
})

describe('applyHostChannelBatch', () => {
  it('writes a born row and keeps the position, in one transaction', async () => {
    const r = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    expect(r.written).toEqual(['s1'])
    const row = await getSessionByClaudeId('s1')
    expect(row).toMatchObject({ host: HOST, judge: 'host', process_status: 'running', title: 'From host' })
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 1 })
    const status = events.filter((e) => e.name === EventNames.SESSION_STATUS_CHANGED)
    expect(status).toHaveLength(1)
    expect(status[0].source).toBe('host-channel')
  })

  it('a patch moves the host fields and never the leader fields the leader holds', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    // A person renames it and leaves a note on the leader.
    await updateSessionRecord('s1', { title: 'Mine', human_note: 'keep' })
    events.length = 0
    await applyHostChannelBatch({
      hostId: HOST,
      rows: [{ sid: 's1', patch: { process_status: 'idle', title: 'Host title', human_note: null, activity: null, statusRevision: 2 }, seq: 2 }],
      renames: [], cursor: { logId: 'L1', seq: 2 },
    })
    const row = (await getSessionByClaudeId('s1'))!
    expect(row.process_status).toBe('idle')
    expect(row.title).toBe('Mine')
    expect(row.human_note).toBe('keep')
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 2 })
    expect(events.some((e) => e.name === EventNames.SESSION_STATUS_CHANGED && (e.data as { sessionId: string }).sessionId === 's1')).toBe(true)
  })

  it('a whole row (a rows frame) clears a host field it leaves out, and keeps the leader fields', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1', { errorMessage: 'old' }), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    await updateSessionRecord('s1', { title: 'Mine' })
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1') }], renames: [], cursor: { logId: 'L1', seq: 5 } })
    const row = (await getSessionByClaudeId('s1'))!
    expect(row.errorMessage).toBeUndefined()
    expect(row.title).toBe('Mine')
  })

  it('writes only the host\'s own rows: another host\'s, a legacy row and a patch of an unknown row are skipped', async () => {
    await createSessionRecord('legacy', '', 'p')
    await applyHostChannelBatch({ hostId: 'other', rows: [{ sid: 'o1', born: true, patch: born('o1', { host: 'other' }) }], renames: [], cursor: { logId: 'X', seq: 1 } })
    const r = await applyHostChannelBatch({
      hostId: HOST,
      rows: [
        { sid: 'legacy', patch: { process_status: 'error' } },
        { sid: 'o1', patch: { process_status: 'error' } },
        { sid: 'ghost', patch: { process_status: 'error' } },
        { sid: 'wrong', born: true, patch: born('wrong', { host: 'other' }) },
      ],
      renames: [], cursor: { logId: 'L1', seq: 4 },
    })
    expect(r.written).toEqual([])
    expect(r.skipped.sort()).toEqual(['ghost', 'legacy', 'o1', 'wrong'])
    expect((await getSessionByClaudeId('legacy'))!.process_status).not.toBe('error')
    expect((await getSessionByClaudeId('o1'))!.process_status).toBe('running')
    expect(await getSessionByClaudeId('ghost')).toBeNull()
    // The position still moves: the records were read.
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 4 })
  })

  it('applies renames and row changes in log order', async () => {
    await applyHostChannelBatch({
      hostId: HOST,
      rows: [
        { sid: 'a', born: true, patch: born('a'), seq: 1 },
        { sid: 'b', patch: { process_status: 'idle' }, seq: 3 },
      ],
      renames: [{ from: 'a', to: 'b', seq: 2 }],
      cursor: { logId: 'L1', seq: 3 },
    })
    expect(await getSessionByClaudeId('a')).toBeNull()
    expect((await getSessionByClaudeId('b'))!.process_status).toBe('idle')
  })

  it('is atomic: a failure in the transaction leaves neither the rows nor the position', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    getDb()!.exec('DROP TABLE session_channel_cursor')
    await expect(applyHostChannelBatch({
      hostId: HOST, rows: [{ sid: 's1', patch: { process_status: 'idle' }, seq: 2 }], renames: [], cursor: { logId: 'L1', seq: 2 },
    })).rejects.toThrow()
    expect((await getSessionByClaudeId('s1'))!.process_status).toBe('running')
  })
})

describe('the row hook', () => {
  it('hears every committed write path, with the row as stored', async () => {
    const heard: Array<{ sid: string; status?: string }> = []
    setOwnRowListener((row) => heard.push({ sid: row.claudeSessionId, status: row.process_status }))
    await createSessionRecord('c1', '', 'p')
    await updateSessionRecord('c1', { process_status: 'idle' })
    await batchUpdateSessionRecords(['c1'], { process_status: 'running' })
    await renameSessionId('c1', 'c2')
    await importSessionRecord({ claudeSessionId: 'i1', taskId: '', cwd: '/tmp', project: 'p' })
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', born: true, patch: born('h1') }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    const sids = heard.map((h) => h.sid)
    expect(sids).toEqual(expect.arrayContaining(['c1', 'c2', 'i1', 'h1']))
    // Create, update and batch each announced c1 as it was stored after that write.
    const c1 = heard.filter((h) => h.sid === 'c1').map((h) => h.status)
    expect(c1).toHaveLength(3)
    expect(c1.slice(1)).toEqual(['idle', 'running'])
  })

  it('reads nothing back while nothing listens', async () => {
    let n = 0
    setOwnRowListener(null)
    await createSessionRecord('q1', '', 'p')
    setOwnRowListener(() => { n++ })
    await updateSessionRecord('q1', { process_status: 'idle' })
    expect(n).toBe(1)
  })
})
