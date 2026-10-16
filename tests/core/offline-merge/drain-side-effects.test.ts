/**
 * What a v2 drain does BESIDES the row write, against the real task store, ledger and
 * conflict log of a temp home (WP9 re-review round 1):
 *   - a session's away task_complete ends the task's sessions, as completeTask does
 *     (completeTaskSessions with the actor's sid, so its own session stops at its turn end);
 *   - the record's time stamps only the row it writes: a write the drain's events cause
 *     on another task stamps now;
 *   - a drain that throws after a conflict was durable still sends its letter, and the
 *     next drain (not the next boot) sends a letter an earlier one left unsent, once.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-side-effects'))
/** Notices delivered to sessions, by Claude session id. */
const told = vi.hoisted(() => [] as Array<{ sid: string; text: string }>)
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async (session: { claudeSessionId?: string }, msg: { enqueueText?: string }) => {
    told.push({ sid: String(session?.claudeSessionId ?? ''), text: String(msg?.enqueueText ?? '') })
    return { delivery: 'queued' }
  }),
}))
const completeSpy = vi.hoisted(() => vi.fn(async (_ids: string[], _opts?: { actorSid?: string }) => 0))
/** The one session id the tracker knows (a live session that made away writes). */
const TELL_SID = 'fafafafa-4444-4444-8444-444444444444'
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/session-tracker.js')>()
  return {
    ...orig,
    completeTaskSessions: (ids: string[], opts?: { actorSid?: string }) => completeSpy(ids, opts),
    getSessionByClaudeId: async (sid: string) => sid === 'fafafafa-4444-4444-8444-444444444444'
      ? { claudeSessionId: sid, taskId: 'task-of-the-caller' } as never
      : orig.getSessionByClaudeId(sid),
  }
})
/** addTask with an explicit id throws TaskIdTakenError this many more times (a create race). */
const addFail = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/task-manager.js')>()
  return {
    ...orig,
    addTask: async (input: Parameters<typeof orig.addTask>[0]) => {
      if (addFail.n > 0 && input?.explicitId) { addFail.n--; throw new orig.TaskIdTakenError(input.explicitId, undefined) }
      return orig.addTask(input)
    },
  }
})
const inbox = vi.hoisted(() => ({ letters: [] as Array<{ subject: string; markdown: string }>, failNext: 0 }))
vi.mock('../../../src/core/human-inbox/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/human-inbox/store.js')>()),
  sendLetter: vi.fn(async (l: { subject: string; markdown: string }) => {
    if (inbox.failNext > 0) { inbox.failNext--; throw new Error('inbox unavailable (injected)') }
    inbox.letters.push(l)
    return { id: `letter-${inbox.letters.length}` }
  }),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting, _setReservationWaitForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, updateTask, updateTaskRaw, setPinTierBulk } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { unsentConflictLogs } from '../../../src/core/offline-merge/conflict-log.js'
import { lookupApplied, recordApplied, reserveOp, LOCAL_HOST } from '../../../src/core/offline-merge/ledger.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const SID = 'eeeeeeee-5555-4555-8555-555555555555'
/** A writer that is not a session (a session's away write takes only its op's own fields). */
const NOT_SESSION = { actor: { kind: 'trigger', id: 'trg-side-effects' } }
const OTHER_SID = 'abababab-1212-4121-8121-121212121212'
let seqN = 900
let opN = 0
const op = (): string => `op-se-${(++opN).toString(16).padStart(12, '0')}`

const fieldsRec = (taskId: string, fields: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'task-fields', opId: op(), rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields, ...over,
})

/** A host journal that keeps a record until an ack reaches it; `ackThrows` acks fail first. */
function journal(hostKey: string, records: Array<Record<string, unknown>>, ackThrows = 0) {
  const pending = [...records]
  let throwsLeft = ackThrows
  return {
    pending,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') {
          if (throwsLeft > 0) { throwsLeft--; throw new Error('daemon connection closed (injected)') }
          for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        }
        return { ok: true }
      },
    },
  }
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
  completeSpy.mockClear()
  told.length = 0
  inbox.letters.length = 0
  inbox.failNext = 0
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a completion replayed through v2 ends the task\'s sessions', () => {
  it('a session\'s away task_complete on a task with a live session calls completeTaskSessions with that session as the actor', async () => {
    const id = (await addTask({ title: 'Worker done away', project: 'Acme' } as never)).task.id
    await updateTaskRaw(id, { session_ids: [OTHER_SID, SID], session_id: SID } as never)
    const j = journal('marina', [fieldsRec(id, { phase: { base: 'TODO', value: 'COMPLETE' } }, { at: Date.now() - 3_600_000 })])
    await runOfflineHandover(j.conn as never)
    await settle()
    expect((await getTask(id)).phase).toBe('COMPLETE')
    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy.mock.calls[0][0]).toEqual([OTHER_SID, SID])
    expect(completeSpy.mock.calls[0][1]).toEqual({ actorSid: SID })
    expect(j.pending).toHaveLength(0)
  })

  it('a later away write to a task already COMPLETE ends no session again; a write that keeps it open ends none', async () => {
    const id = (await addTask({ title: 'Closed earlier', project: 'Acme' } as never)).task.id
    await updateTaskRaw(id, { session_ids: [OTHER_SID], session_id: OTHER_SID } as never)
    await runOfflineHandover(journal('marina', [fieldsRec(id, { phase: { base: 'TODO', value: 'COMPLETE' } })]).conn as never)
    await settle()
    expect(completeSpy).toHaveBeenCalledTimes(1)
    completeSpy.mockClear()
    await runOfflineHandover(journal('acme-box', [fieldsRec(id, { title: { base: 'Closed earlier', value: 'Closed, renamed' } })]).conn as never)
    const open = (await addTask({ title: 'Still open', project: 'Acme' } as never)).task.id
    await updateTaskRaw(open, { session_ids: [OTHER_SID], session_id: OTHER_SID } as never)
    await runOfflineHandover(journal('marina', [fieldsRec(open, { phase: { base: 'TODO', value: 'IN_PROGRESS' } })]).conn as never)
    await settle()
    expect((await getTask(id)).title).toBe('Closed, renamed')
    expect((await getTask(open)).phase).toBe('IN_PROGRESS')
    expect(completeSpy).not.toHaveBeenCalled()
  })
})

describe('the record\'s time stamps only the row it writes', () => {
  it('a write a TASK_UPDATED subscriber makes on another task during the drain stamps now; the drained row keeps the record time', async () => {
    const other = (await addTask({ title: 'Parent', project: 'Acme' } as never)).task.id
    const id = (await addTask({ title: 'Child', project: 'Acme' } as never)).task.id
    const at = Date.now() - 5 * 3_600_000
    let fired = false
    let sync = false
    bus.subscribe('drain-side-effects-probe', (ev) => {
      if (fired || ev.name !== EventNames.TASK_UPDATED) return
      if ((ev.data as { task?: { id?: string } }).task?.id !== id) return
      fired = true
      // One write inside emit (sync), one a little later (a debounce, a notice burst).
      void updateTaskRaw(other, { priority: 'immediate' } as never).then(() => { sync = true })
      setTimeout(() => { void updateTaskRaw(other, { title: 'Parent renamed by a hook' } as never) }, 40)
    }, { global: true })
    try {
      await runOfflineHandover(journal('marina', [fieldsRec(id, { title: { base: 'Child', value: 'Child away' } }, { at })]).conn as never)
      await settle(200)
    } finally {
      bus.unsubscribe('drain-side-effects-probe')
    }
    expect(fired && sync).toBe(true)
    const o = await getTask(other)
    expect(o.title).toBe('Parent renamed by a hook')
    const fresh = Date.now() - 60_000
    expect(Date.parse(o.field_at?.title ?? '')).toBeGreaterThan(fresh)
    expect(Date.parse(o.field_at?.priority ?? '')).toBeGreaterThan(fresh)
    const t = await getTask(id)
    expect(t.title).toBe('Child away')
    expect(Math.abs(Date.parse(t.field_at?.title ?? '') - at)).toBeLessThan(5_000)
  })
})

describe('a drain that throws still letters what it made durable', () => {
  it('the ack throws once after a text conflict: the throwing drain sends the letter naming the away text; the redrain sends none again', async () => {
    const id = (await addTask({ title: 'Doc', project: 'Acme', description: 'one\n' } as never)).task.id
    await updateTaskRaw(id, { description: 'mac words\n' } as never)
    const j = journal('marina', [fieldsRec(id, { description: { base: 'one\n', value: 'away words only here\n' } }, { at: Date.now() - 600_000 })], 1)
    const first = await runOfflineHandover(j.conn as never).then(() => 'ok', (e: unknown) => String(e))
    expect(first).toContain('daemon connection closed')
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].subject).toContain('did not merge cleanly')
    expect(j.pending).toHaveLength(1)
    // The reconnect: the same record, acked from the ledger, no second letter.
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(inbox.letters).toHaveLength(1)
    expect(unsentConflictLogs().filter((l) => l.hostKey === 'marina')).toEqual([])
  })

  it('a letter the inbox refused goes out with the NEXT drain of any host (no restart), once, also when two drains start together', async () => {
    const id = (await addTask({ title: 'Doc 2', project: 'Acme', description: 'one\n' } as never)).task.id
    await updateTaskRaw(id, { description: 'mac words 2\n' } as never)
    inbox.failNext = 1
    await runOfflineHandover(journal('marina', [fieldsRec(id, { description: { base: 'one\n', value: 'away words two\n' } }, { at: Date.now() - 600_000 })]).conn as never)
    await settle()
    expect(inbox.letters).toHaveLength(0)
    expect(unsentConflictLogs().filter((l) => l.hostKey === 'marina')).toHaveLength(1)
    await Promise.all([runOfflineHandover(journal('acme-box', []).conn as never), runOfflineHandover(journal('marina', []).conn as never)])
    await settle(150)
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].markdown).toContain(id)
    await runOfflineHandover(journal('acme-box', []).conn as never)
    await settle(150)
    expect(inbox.letters).toHaveLength(1)
    expect(unsentConflictLogs()).toEqual([])
  })
})

describe('ledger rows and a conflict log that cannot be written', () => {
  it('a folded save that was also applied directly keeps its own HTTP row (route and first answer)', async () => {
    const id = (await addTask({ title: 'Folded', project: 'Acme' } as never)).task.id
    const direct = op()
    const quiet = op()
    recordApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: direct, rev: 1 }, { outcome: 'applied', status: 200, body: '{"task":{"id":"x"}}', source: 'http', route: 'PATCH /api/v1/tasks/x' })
    await runOfflineHandover(journal('marina', [fieldsRec(id, { title: { base: 'Folded', value: 'Folded twice' } }, { saveOpIds: [direct, quiet] })]).conn as never)
    expect(lookupApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: direct, rev: 1 })).toMatchObject({ source: 'http', route: 'PATCH /api/v1/tasks/x', status: 200 })
    expect(lookupApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: quiet, rev: 1 })).toMatchObject({ outcome: 'applied', source: 'drain' })
  })

  it('a refusal whose letter entry can never be written backs off, then is acked with the entry in that drain\'s letter (the gateway is not held offline)', async () => {
    // Every entry append fails (the header, a small replace, still lands): a full disk.
    const full = vi.spyOn(fs, 'fdatasyncSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC (injected)'), { code: 'ENOSPC' }) })
    try {
      const j = journal('marina', [fieldsRec('no-such-task-anywhere', { title: { base: 'x', value: 'y' } }, { kind: 'task-fields', op: 'task_update', actor: { kind: 'device', deviceId: 'gone-device', name: 'Old phone' } })])
      for (let i = 0; i < 6 && j.pending.length; i++) {
        await runOfflineHandover(j.conn as never).catch(() => undefined)
        await settle(10)
      }
      expect(j.pending).toHaveLength(0)
      expect(inbox.letters).toHaveLength(1)
      expect(inbox.letters[0].markdown).toContain('Old phone')
    } finally {
      full.mockRestore()
    }
  })
})

describe('a drained phase write derives what applyPhase derives online', () => {
  it('COMPLETE clears the unread dot and the session slots and stores completed_at at the record time, as updateTask does', async () => {
    const online = (await addTask({ title: 'Online done', project: 'Acme' } as never)).task.id
    const away = (await addTask({ title: 'Away done', project: 'Acme' } as never)).task.id
    for (const id of [online, away]) await updateTaskRaw(id, { unread: true, session_id: SID, session_ids: [SID], phase: 'NEED_ACTION', status: 'in_progress' } as never)
    await updateTask(online, { phase: 'COMPLETE' })
    const at = Date.now() - 3_600_000
    await runOfflineHandover(journal('marina', [fieldsRec(away, { phase: { base: 'NEED_ACTION', value: 'COMPLETE' } }, { at })]).conn as never)
    const [o, a] = [await getTask(online), await getTask(away)]
    expect({ unread: o.unread, slot: o.session_id ?? null, done: !!o.completed_at }).toEqual({ unread: false, slot: null, done: true })
    expect({ unread: a.unread, slot: a.session_id ?? null, phase: a.phase }).toEqual({ unread: false, slot: null, phase: 'COMPLETE' })
    expect(Math.abs(Date.parse(a.completed_at ?? '') - at)).toBeLessThan(5_000)
  })

  it('NEED_ACTION lights the unread dot, as updateTask does; a record that sets unread itself keeps its value', async () => {
    const online = (await addTask({ title: 'Online needs me', project: 'Acme' } as never)).task.id
    const away = (await addTask({ title: 'Away needs me', project: 'Acme' } as never)).task.id
    const quiet = (await addTask({ title: 'Away, read already', project: 'Acme' } as never)).task.id
    await updateTask(online, { phase: 'NEED_ACTION' })
    await updateTaskRaw(quiet, { unread: true } as never)
    await runOfflineHandover(journal('marina', [
      fieldsRec(away, { phase: { base: 'TODO', value: 'NEED_ACTION' } }),
      fieldsRec(quiet, { phase: { base: 'TODO', value: 'NEED_ACTION' }, unread: { base: true, value: false } }, NOT_SESSION),
    ]).conn as never)
    expect((await getTask(online)).unread).toBe(true)
    expect((await getTask(away)).unread).toBe(true)
    expect((await getTask(quiet)).unread ?? false).toBe(false)
  })

  it("status:'done' alone completes the task with a completed_at; leaving COMPLETE clears it", async () => {
    const id = (await addTask({ title: 'Done by status', project: 'Acme' } as never)).task.id
    await runOfflineHandover(journal('marina', [fieldsRec(id, { status: { base: 'todo', value: 'done' } }, NOT_SESSION)]).conn as never)
    const done = await getTask(id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.completed_at).toBeTruthy()
    await runOfflineHandover(journal('marina', [fieldsRec(id, { phase: { base: 'COMPLETE', value: 'IN_PROGRESS' } })]).conn as never)
    const open = await getTask(id)
    expect(open.phase).toBe('IN_PROGRESS')
    expect(open.completed_at ?? null).toBeNull()
  })
})

describe('a drained pinned / focus_tier write is the pin write the online PATCH makes', () => {
  const pick = async (id: string) => { const t = await getTask(id); return { pinned: t.pinned ?? false, focus_tier: t.focus_tier ?? null, ordered: typeof t.pin_order === 'number' } }

  it('focus_tier pins the task into that tier at the bottom of the board, and the focus bar hears it', async () => {
    const online = (await addTask({ title: 'Online focus', project: 'Acme' } as never)).task.id
    const away = (await addTask({ title: 'Away focus', project: 'Acme' } as never)).task.id
    await setPinTierBulk([online], 'focus')
    const bars: unknown[] = []
    bus.subscribe('drain-pin-probe', (ev) => { if (ev.name === EventNames.CONFIG_CHANGED) bars.push(ev.data) }, { global: true })
    try {
      await runOfflineHandover(journal('marina', [fieldsRec(away, { focus_tier: { base: '', value: 'focus' } }, NOT_SESSION)]).conn as never)
    } finally { bus.unsubscribe('drain-pin-probe') }
    expect(await pick(away)).toEqual(await pick(online))
    expect(await pick(away)).toEqual({ pinned: true, focus_tier: 'focus', ordered: true })
    expect((await getTask(away)).pin_order).toBeGreaterThan((await getTask(online)).pin_order ?? -1)
    expect(bars).toContainEqual({ key: 'focus_bar' })
  })

  it('pinned:true alone pins as a Satellite with an order; pinned:false unpins and drops the tier', async () => {
    const online = (await addTask({ title: 'Online pin', project: 'Acme' } as never)).task.id
    const away = (await addTask({ title: 'Away pin', project: 'Acme' } as never)).task.id
    await setPinTierBulk([online], 'satellite')
    await runOfflineHandover(journal('marina', [fieldsRec(away, { pinned: { base: false, value: true } }, NOT_SESSION)]).conn as never)
    expect(await pick(away)).toEqual(await pick(online))
    expect(await pick(away)).toEqual({ pinned: true, focus_tier: null, ordered: true })
    const tiered = (await addTask({ title: 'Away unpin', project: 'Acme' } as never)).task.id
    await setPinTierBulk([tiered], 'focus')
    await runOfflineHandover(journal('marina', [fieldsRec(tiered, { pinned: { base: true, value: false } }, NOT_SESSION)]).conn as never)
    expect(await pick(tiered)).toEqual({ pinned: false, focus_tier: null, ordered: false })
  })

  it('a new pin on a completed task is refused whole (409 online) and lettered; nothing of the write lands', async () => {
    const id = (await addTask({ title: 'Closed', project: 'Acme' } as never)).task.id
    await updateTask(id, { phase: 'COMPLETE' })
    const j = journal('marina', [fieldsRec(id, { pinned: { base: false, value: true }, title: { base: 'Closed', value: 'Closed and renamed' } }, NOT_SESSION)])
    await runOfflineHandover(j.conn as never)
    await settle()
    const t = await getTask(id)
    expect({ pinned: t.pinned ?? false, title: t.title }).toEqual({ pinned: false, title: 'Closed' })
    expect(j.pending).toHaveLength(0)
    expect(inbox.letters.at(-1)?.markdown).toContain('Cannot pin a completed task')
  })
})

describe('the session that made a refused away write is told once, also when the drain throws after it', () => {
  it('the ack throws once after a refusal: the throwing drain tells the session; the redrain acks from the ledger and tells no one again', async () => {
    const id = (await addTask({ title: 'Refused away', project: 'Acme' } as never)).task.id
    const j = journal('marina', [fieldsRec(id, { priority: { base: 'none', value: 'not-a-priority' } }, { actor: { kind: 'session', sid: TELL_SID } })], 1)
    const first = await runOfflineHandover(j.conn as never).then(() => 'ok', (e: unknown) => String(e))
    expect(first).toContain('daemon connection closed')
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(told.filter((t) => t.sid === TELL_SID)).toHaveLength(1)
    expect(told[0].text).toContain('priority must be one of')
  })
})

describe('drain order and bounds (WP9 re-review round 2)', () => {
  it('a create whose addTask hit a race lists its gone parent once in the letters, not once per try', async () => {
    addFail.n = 1
    const minted = 'mintrace00000000aaaa01'
    const rec = { v: 2, seq: ++seqN, at: Date.now(), kind: 'task-create', opId: op(), rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_create', taskId: minted, fields: { title: 'Born after a race' }, placement: { parentTaskId: 'gone-parent-race-1' } }
    const j = journal('marina', [rec])
    await runOfflineHandover(j.conn as never)
    await settle(20)
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect((await getTask(minted)).parent_task_id ?? '').toBe('')
    const mentions = inbox.letters.reduce((n, l) => n + (l.markdown.match(/parent link was not applied/g)?.length ?? 0), 0)
    expect(mentions).toBe(1)
  })

  it('an op the ledger holds is acked as applied before the device check: a device unpaired since is not lettered "not applied"', async () => {
    const id = (await addTask({ title: 'Forwarded from a phone', project: 'Acme' } as never)).task.id
    const opId = op()
    recordApplied({ hostKey: 'marina', home: WALNUT_HOME, opId, rev: 1 }, { outcome: 'applied', status: 200, body: `{"task":{"id":"${id}"}}`, source: 'http', route: `PATCH /api/v1/tasks/${id}` })
    const j = journal('marina', [fieldsRec(id, { title: { base: 'Forwarded from a phone', value: 'Renamed on the phone' } }, { opId, actor: { kind: 'device', deviceId: 'phone-unpaired-1', name: 'Old phone' } })])
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(inbox.letters).toHaveLength(0)
    expect(lookupApplied({ hostKey: 'marina', home: WALNUT_HOME, opId, rev: 1 })).toMatchObject({ source: 'http', outcome: 'applied' })
  })

  it('a record whose op a direct write keeps running is not applied beside it: the drain does not wait past its bound, and applies once the write let go', async () => {
    _setReservationWaitForTesting(60)
    try {
      const id = (await addTask({ title: 'Held by a slow write', project: 'Acme' } as never)).task.id
      const opId = op()
      // A write handler that never answers while its client stays connected.
      const held = reserveOp({ hostKey: LOCAL_HOST, home: WALNUT_HOME, opId, rev: 1 })
      expect(held.owner).toBe(true)
      const j = journal('marina', [fieldsRec(id, { title: { base: 'Held by a slow write', value: 'Applied once' } }, { opId })])
      const started = Date.now()
      await runOfflineHandover(j.conn as never)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(j.pending).toHaveLength(1)
      expect((await getTask(id)).title).toBe('Held by a slow write')
      if (held.owner) held.finish(null)
      await runOfflineHandover(j.conn as never)
      expect(j.pending).toHaveLength(0)
      expect((await getTask(id)).title).toBe('Applied once')
    } finally {
      _setReservationWaitForTesting(null)
    }
  })
})
