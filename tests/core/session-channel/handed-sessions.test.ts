/**
 * A host brings this leader only sessions that are its own (src/core/session-channel/handed-sessions.ts,
 * session-tracker applyHostChannelBatch): every way a host's data reaches a row here, each allowed
 * case and each refused one. Refused means nothing applied: no row made or changed, both rows of a
 * rename kept, the record named in `refused`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-handed-sessions'))

import { _resetSessionTrackerForTesting, applyHostChannelBatch, createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { HAND_MS, dropHand, handStart, handsNow, _resetLinesPruneForTesting, linesNotOthers, noteLinesHanded, settleAnswer } from '../../../src/core/session-channel/handed-sessions.js'
import { _resetRefusedSessionsForTesting } from '../../../src/core/session-channel/refused-sessions.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'devbox-a'
const OTHER = 'devbox-b'
const whole = (sid: string, host = HOST, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host, judge: 'host',
  startedAt: '2026-11-23T00:00:00.000Z', lastActiveAt: '2026-11-23T00:00:00.000Z', messageCount: 0, title: 'From host', ...extra,
})
let seq = 0
const born = (sid: string, host = HOST, extra: Partial<SessionRecord> = {}, hand?: string) =>
  applyHostChannelBatch({ hostId: host, rows: [{ sid, born: true, patch: whole(sid, host, extra), seq: ++seq, ...(hand ? { hand } : {}) }], renames: [], cursor: { logId: `L-${host}`, seq } })
const patch = (sid: string, p: Record<string, unknown>, host = HOST) =>
  applyHostChannelBatch({ hostId: host, rows: [{ sid, patch: p, seq: ++seq }], renames: [], cursor: { logId: `L-${host}`, seq } })
const rename = (from: string, to: string, host = HOST) =>
  applyHostChannelBatch({ hostId: host, rows: [], renames: [{ from, to, seq: ++seq }], cursor: { logId: `L-${host}`, seq } })

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetRefusedSessionsForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  seq = 0
})
afterEach(() => {
  closeDb()
  _resetSessionTrackerForTesting()
})

describe('a born row of a session the leader has no row of', () => {
  it('refused when nobody handed it to the host: no row is made', async () => {
    const r = await born('never-handed')
    expect(r.written).toEqual([])
    expect(r.refused).toEqual(['never-handed'])
    expect(await getSessionByClaudeId('never-handed')).toBeNull()
  })

  it('applied when the leader handed the host that id (a seeded start); the hand is used up', async () => {
    await handStart(HOST, 'seeded-1')
    const r = await born('seeded-1')
    expect(r.written).toEqual(['seeded-1'])
    expect(await getSessionByClaudeId('seeded-1')).toMatchObject({ host: HOST, judge: 'host' })
    expect(handsNow()).toEqual([])
  })

  it('refused for an id the leader handed another host; that host\'s own born row applies after', async () => {
    await handStart(OTHER, 'meant-for-b')
    expect((await born('meant-for-b', HOST)).refused).toEqual(['meant-for-b'])
    expect(await getSessionByClaudeId('meant-for-b')).toBeNull()
    expect((await born('meant-for-b', OTHER)).written).toEqual(['meant-for-b'])
    expect(await getSessionByClaudeId('meant-for-b')).toMatchObject({ host: OTHER })
  })

  it('an open hand (a start whose id the host names) lets in only the born row that echoes it, once', async () => {
    const hand = await handStart(HOST, null)
    expect((await born('acp-1', HOST, {}, hand)).written).toEqual(['acp-1'])
    expect((await born('acp-2', HOST, {}, hand)).refused).toEqual(['acp-2'])
    expect(await getSessionByClaudeId('acp-2')).toBeNull()
  })

  it('with an open hand standing, a born or resync row of another unknown id (no echo) is refused (S2)', async () => {
    const hand = await handStart(HOST, null)
    expect((await born('stray-born')).refused).toEqual(['stray-born'])
    const resync = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'stray-resync', born: true, patch: whole('stray-resync'), seq: ++seq }], renames: [], cursor: { logId: `L-${HOST}`, seq } })
    expect(resync.refused).toEqual(['stray-resync'])
    // An echo of a hand that is not an id hand of this host neither: a made-up one, another host's.
    expect((await born('made-up', HOST, {}, 'f'.repeat(18))).refused).toEqual(['made-up'])
    const otherHand = await handStart(OTHER, null)
    expect((await born('took-b', HOST, {}, otherHand)).refused).toEqual(['took-b'])
    // The start's own row still takes its hand.
    expect((await born('acp-real', HOST, {}, hand)).written).toEqual(['acp-real'])
  })

  it('a host\'s open hand never lets in an id another host was handed', async () => {
    const hand = await handStart(HOST, null)
    await handStart(OTHER, 'meant-for-b')
    expect((await born('meant-for-b', HOST, {}, hand)).refused).toEqual(['meant-for-b'])
    // The open hand is still there for the host's own new id.
    expect((await born('acp-own', HOST, {}, hand)).written).toEqual(['acp-own'])
  })

  it('a whole row again (resync) and a rows frame are held to the same rule', async () => {
    const resync = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'resync-new', born: true, patch: whole('resync-new'), seq: ++seq }], renames: [], cursor: { logId: `L-${HOST}`, seq } })
    expect(resync.refused).toEqual(['resync-new'])
    const frame = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'frame-new', born: true, patch: whole('frame-new') }], renames: [], cursor: { logId: `L-${HOST}`, seq }, snapshot: { at: seq + 1 } })
    expect(frame.refused).toEqual(['frame-new'])
    expect(await getSessionByClaudeId('frame-new')).toBeNull()
  })

  it('a hand past HAND_MS lets nothing in; a dropped hand neither', async () => {
    await handStart(HOST, 'old', { now: Date.now() - HAND_MS - 1 })
    expect((await born('old')).refused).toEqual(['old'])
    const id = await handStart(HOST, 'dropped')
    await dropHand(id)
    expect((await born('dropped')).refused).toEqual(['dropped'])
  })

  it('a hand outlives a restart of the leader: a born row that comes after it applies', async () => {
    await handStart(HOST, 'across-restart')
    closeDb()
    _resetSessionTrackerForTesting()
    expect((await born('across-restart')).written).toEqual(['across-restart'])
  })
})

describe('the task a session is for (S1)', () => {
  it('a born row naming another task than its hand\'s is refused; the one naming the hand\'s task applies', async () => {
    await handStart(HOST, 'for-t1', { taskId: 't1' })
    expect((await born('for-t1', HOST, { taskId: 't2' })).refused).toEqual(['for-t1'])
    expect(await getSessionByClaudeId('for-t1')).toBeNull()
    expect((await born('for-t1', HOST, { taskId: 't1' })).written).toEqual(['for-t1'])
    const open = await handStart(HOST, null, { taskId: 't1' })
    expect((await born('acp-t2', HOST, { taskId: 't2' }, open)).refused).toEqual(['acp-t2'])
  })

  it('a held row keeps its task: a patch or a whole row naming another task changes everything else', async () => {
    await handStart(HOST, 'kept', { taskId: 't1' })
    await born('kept', HOST, { taskId: 't1' })
    const r = await patch('kept', { taskId: 't-other', messageCount: 4 })
    expect(r.written).toEqual(['kept'])
    expect(r.taskKept).toEqual(['kept'])
    expect(await getSessionByClaudeId('kept')).toMatchObject({ taskId: 't1', messageCount: 4 })
    // A whole row (resync) that leaves the task out, or names another, keeps it too.
    await born('kept', HOST, { taskId: 't-third', messageCount: 5 })
    expect(await getSessionByClaudeId('kept')).toMatchObject({ taskId: 't1', messageCount: 5 })
  })
})

describe('a session handed with no task (R2-N1)', () => {
  it('a hand with no task admits only a born row with no task, and the row never gains one later', async () => {
    await handStart(HOST, 'no-task', { taskId: '' })
    expect((await born('no-task', HOST, { taskId: 't-any' })).refused).toEqual(['no-task'])
    expect((await born('no-task', HOST, { taskId: '' })).written).toEqual(['no-task'])
    const r = await patch('no-task', { taskId: 't-later', messageCount: 2 })
    expect(r.taskKept).toEqual(['no-task'])
    expect(await getSessionByClaudeId('no-task')).toMatchObject({ messageCount: 2 })
    expect((await getSessionByClaudeId('no-task'))?.taskId ?? '').toBe('')
  })
})

describe('the session each queue row is for (fact-keys.ts scoped keys)', () => {
  it('a fact of a session keeps its own rows and rows the leader never made; never another session\'s, across a reopen of the store', async () => {
    _resetLinesPruneForTesting()
    const t0 = Date.now()
    await noteLinesHanded('s-a', ['qm-1', 'qm-2'], t0)
    await noteLinesHanded('s-b', ['qm-3'], t0)
    expect(linesNotOthers('s-a', ['qm-1', 'qm-3', 'qm-mobile-none'], t0)).toEqual(['qm-1', 'qm-mobile-none'])
    closeDb()
    expect(linesNotOthers('s-b', ['qm-1', 'qm-3'], t0)).toEqual(['qm-3'])
    // Moved to another session (a transfer, a redelivery): the newest owner names it.
    await noteLinesHanded('s-b', ['qm-2'], t0 + 1)
    expect(linesNotOthers('s-a', ['qm-2'], t0 + 1)).toEqual([])
    // Past the horizon nothing is known of it any more.
    expect(linesNotOthers('s-b', ['qm-1'], t0 + 31 * 86_400_000)).toEqual(['qm-1'])
  })
})

describe('a patch of a session the leader has no row of (N5)', () => {
  it('is asked for whole only when it was handed this host; a refused one is not asked about again', async () => {
    expect((await patch('never-handed-p', { messageCount: 1 })).resync).toEqual([])
    await handStart(HOST, 'handed-p')
    expect((await patch('handed-p', { messageCount: 1 })).resync).toEqual(['handed-p'])
  })
})

describe('a row the leader holds already', () => {
  it('the host\'s own row (judge host, its host) takes the host\'s patches', async () => {
    await handStart(HOST, 'mine')
    await born('mine')
    const r = await applyHostChannelBatch({ hostId: HOST, rows: [{ sid: 'mine', patch: { messageCount: 3 }, seq: ++seq }], renames: [], cursor: { logId: `L-${HOST}`, seq } })
    expect(r.written).toEqual(['mine'])
    expect((await getSessionByClaudeId('mine'))?.messageCount).toBe(3)
  })

  it('a legacy session and another host\'s session are never taken: their rows stay as they were', async () => {
    await createSessionRecord('legacy-1', '', 'p', undefined, { title: 'Leader own' })
    await handStart(OTHER, 'b-own')
    await born('b-own', OTHER)
    for (const sid of ['legacy-1', 'b-own']) {
      const r = await born(sid, HOST)
      expect(r.written).toEqual([])
      expect(r.skipped).toEqual([sid])
    }
    expect(await getSessionByClaudeId('legacy-1')).toMatchObject({ title: 'Leader own' })
    expect((await getSessionByClaudeId('legacy-1'))?.judge).toBeUndefined()
    expect(await getSessionByClaudeId('b-own')).toMatchObject({ host: OTHER })
  })
})

describe('a rename (a CLI that answered under a new id, an ACP id change)', () => {
  it('of the host\'s own row into a new id nobody was handed: applied', async () => {
    await handStart(HOST, 'r-from')
    await born('r-from')
    const r = await rename('r-from', 'r-to')
    expect(r.written).toEqual(['r-to'])
    expect(await getSessionByClaudeId('r-from')).toBeNull()
    expect(await getSessionByClaudeId('r-to')).toMatchObject({ host: HOST })
  })

  it('into a legacy row, into another host\'s row, into an id handed to another host: refused, both rows kept', async () => {
    await handStart(HOST, 'r-own')
    await born('r-own')
    await createSessionRecord('legacy-2', '', 'p', undefined, { title: 'Leader own' })
    await handStart(OTHER, 'b-row')
    await born('b-row', OTHER)
    await handStart(OTHER, 'b-handed')
    for (const to of ['legacy-2', 'b-row', 'b-handed']) {
      const r = await rename('r-own', to)
      expect(r.written, to).toEqual([])
      expect(r.refused, to).toEqual([to])
      expect(await getSessionByClaudeId('r-own'), to).toMatchObject({ host: HOST })
    }
    expect(await getSessionByClaudeId('legacy-2')).toMatchObject({ title: 'Leader own' })
    expect(await getSessionByClaudeId('b-row')).toMatchObject({ host: OTHER })
    expect(await getSessionByClaudeId('b-handed')).toBeNull()
  })

  it('of a row that is not the host\'s: skipped, as before', async () => {
    await createSessionRecord('legacy-3', '', 'p')
    const r = await rename('legacy-3', 'stolen')
    expect(r.written).toEqual([])
    expect(r.skipped).toEqual(['legacy-3'])
    expect(await getSessionByClaudeId('legacy-3')).not.toBeNull()
    expect(await getSessionByClaudeId('stolen')).toBeNull()
  })
})

describe('the answer of a start the leader handed (settleAnswer)', () => {
  it('a new id: the open hand now names it, so its born row applies (echo or not) and no other id does', async () => {
    const hand = await handStart(HOST, null)
    expect(await settleAnswer(HOST, 'answered-1', hand)).toEqual({ ok: true, row: false })
    expect(handsNow()).toEqual([{ host: HOST, sid: 'answered-1' }])
    expect((await born('other-new', HOST, {}, hand)).refused).toEqual(['other-new'])
    expect((await born('answered-1')).written).toEqual(['answered-1'])
  })

  it('the host\'s own row (its born row beat the answer): ok, and the leader has its row', async () => {
    const hand = await handStart(HOST, null)
    await born('fast-1', HOST, {}, hand)
    expect(await settleAnswer(HOST, 'fast-1', hand)).toEqual({ ok: true, row: true })
  })

  it('a seeded start answered with another id leaves one hand, naming the answer\'s id (N7)', async () => {
    const hand = await handStart(HOST, 'seeded-x', { taskId: 't1' })
    expect(await settleAnswer(HOST, 'answered-y', hand, { taskId: 't1' })).toEqual({ ok: true, row: false })
    expect(handsNow()).toEqual([{ host: HOST, sid: 'answered-y' }])
    expect((await born('seeded-x', HOST, { taskId: 't1' })).refused).toEqual(['seeded-x'])
  })

  it('a legacy session, another host\'s session, an id handed to another host: false', async () => {
    await createSessionRecord('legacy-4', '', 'p')
    await handStart(OTHER, 'b-row2')
    await born('b-row2', OTHER)
    await handStart(OTHER, 'b-handed2')
    for (const sid of ['legacy-4', 'b-row2', 'b-handed2']) {
      const hand = await handStart(HOST, null)
      expect((await settleAnswer(HOST, sid, hand)).ok, sid).toBe(false)
    }
  })
})
