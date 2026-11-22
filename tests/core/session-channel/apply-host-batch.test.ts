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
  _resetSessionTrackerForTesting, applyHostChannelBatch, batchUpdateSessionRecords, createSessionRecord, deleteSessionRecords, getSessionByClaudeId,
  importSessionRecord, loadChannelCursor, renameSessionId, updateSessionRecord,
} from '../../../src/core/session-tracker.js'
import { closeDb, getDb } from '../../../src/core/session-db.js'
import { setOwnRowListener } from '../../../src/core/session-channel/row-hook.js'
import { leaderDropHosts, leaderDropsOf } from '../../../src/core/session-channel/leader-drops.js'
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

describe('applyHostChannelBatch across links and repairs', () => {
  it('a record an earlier link applied is never applied twice: the position is read in the same transaction', async () => {
    // The first link's batch (1..3) commits after the second link already resumed from 0.
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', born: true, patch: born('s1'), seq: 1 }, { sid: 's1', patch: { messageCount: 1 }, seq: 3 }], renames: [], cursor: { logId: 'L1', seq: 3 } })
    await updateSessionRecord('s1', { title: 'Mine' })
    const again = await applyHostChannelBatch({
      hostId: HOST,
      rows: [{ sid: 's1', born: true, patch: born('s1'), seq: 1 }, { sid: 's1', patch: { messageCount: 1 }, seq: 3 }, { sid: 's1', patch: { messageCount: 2 }, seq: 4 }],
      renames: [], cursor: { logId: 'L1', seq: 4 },
    })
    expect(again.after).toBe(3)
    expect(again.written).toEqual(['s1'])
    expect(await getSessionByClaudeId('s1')).toMatchObject({ messageCount: 2, title: 'Mine' })
    // A late batch of the old link never moves the position back.
    const old = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 's1', patch: { messageCount: 1 }, seq: 3 }], renames: [], cursor: { logId: 'L1', seq: 3 } })
    expect(old).toMatchObject({ after: 4, written: [] })
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 4 })
    expect((await getSessionByClaudeId('s1'))!.messageCount).toBe(2)
  })

  it('names the rows worth the host\'s whole row: a patch with no base row, a rename whose old row is missing', async () => {
    const r = await applyHostChannelBatch({
      hostId: HOST, rows: [{ sid: 'no-base', patch: { messageCount: 3 }, seq: 1 }],
      renames: [{ from: 'never-here', to: 'renamed', seq: 2 }], cursor: { logId: 'L1', seq: 2 },
    })
    expect(r.resync.sort()).toEqual(['no-base', 'renamed'])
    expect(r.written).toEqual([])
  })

  it('a rows snapshot is the host\'s every row: one of its rows it no longer names goes, a start in flight and the leader\'s own rows stay', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'kept', born: true, patch: born('kept'), seq: 1 }, { sid: 'renamed-away', born: true, patch: born('renamed-away'), seq: 2 }, { sid: 'seed', born: true, patch: born('seed'), seq: 3 }], renames: [], cursor: { logId: 'L1', seq: 3 } })
    await createSessionRecord('legacy-on-host', '', 'p', '/w', { host: HOST, title: 'Legacy' })
    await createSessionRecord('elsewhere', '', 'p', '/w', { host: 'another-box', title: 'Other' })
    events.length = 0
    const r = await applyHostChannelBatch({
      hostId: HOST, rows: [{ sid: 'kept', born: true, patch: born('kept') }], renames: [], cursor: { logId: 'L2', seq: 0 },
      snapshot: { keep: new Set(['seed']) },
    })
    expect(r.removed).toEqual(['renamed-away'])
    expect(await getSessionByClaudeId('renamed-away')).toBeNull()
    for (const sid of ['kept', 'seed', 'legacy-on-host', 'elsewhere']) expect(await getSessionByClaudeId(sid), sid).not.toBeNull()
    const deleted = events.filter((e) => e.name === EventNames.SESSION_DELETED)
    expect(deleted.map((e) => (e.data as { sessionIds: string[] }).sessionIds)).toEqual([['renamed-away']])
  })
})

describe('a delete the leader makes of a host\'s session (leader-drops.ts)', () => {
  it('marks a host\'s row it deletes, and no other row', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', born: true, patch: born('h1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    await createSessionRecord('legacy-1', '', 'p', '/tmp', { host: HOST } as never)
    expect(await deleteSessionRecords(new Set(['h1', 'legacy-1']), 'test')).toBe(2)
    expect(leaderDropsOf(HOST)).toEqual(['h1'])
    expect([...leaderDropHosts(['h1', 'legacy-1'])]).toEqual([[HOST, ['h1']]])
  })

  it('while marked, the host\'s rows of it do not come back and its other records are answered gone; its drop clears the mark', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', born: true, patch: born('h1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    await deleteSessionRecords(new Set(['h1']), 'test')
    // Records the host wrote before it heard of the delete.
    const r = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', patch: { process_status: 'idle' }, seq: 2 }], renames: [{ from: 'h0', to: 'h1', seq: 3 }], cursor: { logId: 'L1', seq: 3 }, check: ['h1', 'other'] })
    expect(r.gone).toEqual(['h1'])
    expect(r.written).toEqual([])
    expect(await getSessionByClaudeId('h1')).toBeNull()
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 3 })
    // A born row of it (a rows frame) does not come back either.
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h1', born: true, patch: born('h1') }], renames: [], cursor: { logId: 'L1', seq: 4 } })
    expect(await getSessionByClaudeId('h1')).toBeNull()
    // Its drop record: the mark goes, in the same transaction as the position.
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 5 }, drops: ['h1'] })
    expect(leaderDropsOf(HOST)).toEqual([])
    expect(loadChannelCursor(HOST)).toEqual({ logId: 'L1', seq: 5 })
  })

  it('a host\'s own drop with no mark changes nothing here: a host never deletes a row the leader has', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h2', born: true, patch: born('h2'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    await applyHostChannelBatch({ hostId: HOST, rows: [], renames: [], cursor: { logId: 'L1', seq: 2 }, drops: ['h2'] })
    expect(await getSessionByClaudeId('h2')).toMatchObject({ judge: 'host', host: HOST })
  })

  it('another host\'s drop does not clear this host\'s mark', async () => {
    await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'h3', born: true, patch: born('h3'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    await deleteSessionRecords(new Set(['h3']), 'test')
    await applyHostChannelBatch({ hostId: 'otherbox', rows: [], renames: [], cursor: { logId: 'L9', seq: 1 }, drops: ['h3'] })
    expect(leaderDropsOf(HOST)).toEqual(['h3'])
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
