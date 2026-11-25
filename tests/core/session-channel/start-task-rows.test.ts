/**
 * The leader's rows of a start's task, carried with the start (src/core/session-channel/start-task-rows.ts):
 * the leader puts them, read for each ask, on every start and resume it hands a host that takes them
 * (switch-catch-up.ts, the one path of both), never a kept-local task's rows a host may not hold; the
 * host takes only rows of the body's task, never the start's own.
 * The whole path against a host whose sessions copy lags: tests/e2e/host-judged-engine-switch-e2e.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { TASK_ROWS_MAX, hostNamesOf, rowsForHost, taskRowsOf, withTaskRows } from '../../../src/core/session-channel/start-task-rows.js'
import { setRevokedHostResolver } from '../../../src/core/session-channel/revoked-hosts.js'
import { startOnHostCatchingUp, type SwitchCatchUpSide } from '../../../src/core/session-channel/switch-catch-up.js'
import { hostPrivacyOf } from '../../../src/core/replication/host-private.js'
import { HOST_SESSIONS_OFF } from '../../../src/core/session-channel/host-api.js'
import type { SessionRecord } from '../../../src/core/types.js'

const row = (sid: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({ claudeSessionId: sid, taskId: 't1', process_status: 'stopped', ...extra }) as SessionRecord
const OLD = row('old-1', { archived: true, archive_reason: 'engine_switched:antigravity' })
const takes = () => true

describe('withTaskRows (leader)', () => {
  it('a start of a task carries its rows and when they were read; the start\'s own id is left out of the ask', async () => {
    let except: string[] = []
    const before = Date.now()
    const out = await withTaskRows({ taskId: 't1', message: 'm', preassignedSessionId: 'new-1' }, 'devbox', { takes, rowsOf: async (_t, _h, ex) => { except = [...ex]; return [OLD] } })
    expect(out).toMatchObject({ taskId: 't1', taskRows: [OLD] })
    expect((out as { taskRowsAt: number }).taskRowsAt).toBeGreaterThanOrEqual(before)
    expect(except).toEqual(['new-1'])
  })

  it('no task, a host that does not take them, none to carry, or a store that throws: the body without rows', async () => {
    const rowsOf = async () => [OLD]
    const none = { message: 'm' }
    expect(await withTaskRows(none, 'devbox', { takes, rowsOf })).toBe(none)
    const plain = { taskId: 't1' }
    expect(await withTaskRows(plain, 'devbox', { takes: () => false, rowsOf })).toBe(plain)
    expect(await withTaskRows(plain, 'devbox', { takes, rowsOf: async () => [] })).toBe(plain)
    expect(await withTaskRows(plain, 'devbox', { takes, rowsOf: async () => { throw new Error('no store') } })).toBe(plain)
    // Rows a body already carries are read again, never sent as they were.
    expect(await withTaskRows({ taskId: 't1', taskRows: [OLD], taskRowsAt: 1 }, 'devbox', { takes: () => false, rowsOf })).toEqual({ taskId: 't1' })
  })

  it('every start and resume a leader hands a host goes with them, read again for the one more ask after an "off"', async () => {
    const sent: unknown[] = []
    const answers = [{ ok: false, error: HOST_SESSIONS_OFF }, { ok: true }]
    const side: SwitchCatchUpSide = {
      startOnHost: async (_h, payload) => { sent.push(payload); return (answers.shift() ?? { ok: true }) as never },
      switchOn: () => true,
      whenLinked: async () => true,
    }
    let reads = 0
    const rowsOf = async () => [row(`read-${++reads}`)]
    await startOnHostCatchingUp(side, 'devbox', { taskId: 't1', message: 'm' }, { taskRows: rowsOf, takesTaskRows: takes, copyConfigNow: async () => true })
    expect(sent.map((p) => (p as { taskRows: SessionRecord[] }).taskRows.map((r) => r.claudeSessionId))).toEqual([['read-1'], ['read-2']])
    await startOnHostCatchingUp(side, 'devbox', { taskId: 't1', message: '', resumeSessionId: 'old-1' }, { taskRows: async (_t, _h, ex) => (ex.has('old-1') ? [] : [OLD]), takesTaskRows: takes })
    expect(sent[2]).not.toHaveProperty('taskRows')
  })

  it('kept fixture: start taskRows: a task kept local leaves no row on a host where none of its sessions runs, and only its rows of that host where one does', () => {
    const hold = { target: 'acme', state: 'chosen', at: '2026-11-21T00:00:00.000Z' }
    const p = hostPrivacyOf([{ id: 'kept', sync_hold: hold }, { id: 't1' }], [{ claudeSessionId: 'k-mac', taskId: 'kept' }, { claudeSessionId: 'k-dev', taskId: 'kept' }])
    const rows = [
      row('k-mac', { taskId: 'kept', title: 'Mac session of a kept task', host: undefined }),
      row('k-dev', { taskId: 'kept', host: 'devbox' }),
      row('k-alias', { taskId: 't1', legacyTaskId: 'kept', host: 'devbox-alias' }),
      row('open-1', { host: undefined }),
    ]
    const devbox = new Set(['devbox', 'devbox-alias'])
    const onDevbox = (h: string | undefined) => devbox.has(h ?? '')
    // None of the kept task's sessions on this host: its rows stay off it.
    expect(rowsForHost(rows, p, new Set(), onDevbox).map((r) => r.claudeSessionId)).toEqual(['open-1'])
    // One of its sessions runs there: its rows of that host go, by any of the host's names; its Mac session never does.
    expect(rowsForHost(rows, p, new Set(['kept']), onDevbox).map((r) => r.claudeSessionId)).toEqual(['k-dev', 'k-alias', 'open-1'])
    // Nothing kept: every row goes.
    expect(rowsForHost(rows, hostPrivacyOf([{ id: 'kept' }, { id: 't1' }], []), new Set(), onDevbox)).toHaveLength(4)
  })
})

describe('hostNamesOf (leader)', () => {
  it('a host is every name the leader\'s links know it by (the alias resolver), never the leader itself', async () => {
    expect(await hostNamesOf('devbox')).toEqual(['devbox'])
    setRevokedHostResolver({ machineOf: () => null, aliasesOf: (k) => (k === 'devbox' ? ['devbox-alias', '__local__', 'devbox'] : []) })
    try {
      expect(await hostNamesOf('devbox')).toEqual(['devbox', 'devbox-alias'])
      expect(await hostNamesOf('other')).toEqual(['other'])
    } finally { setRevokedHostResolver(null) }
    // A resolver that throws names nothing more; the key itself still counts.
    setRevokedHostResolver({ machineOf: () => null, aliasesOf: () => { throw new Error('link gone') } })
    try { expect(await hostNamesOf('devbox')).toEqual(['devbox']) } finally { setRevokedHostResolver(null) }
  })
})

describe('taskRowsOf (host)', () => {
  it('takes the rows of the body\'s task, its unlinked ones too, never the start\'s own or another task\'s', () => {
    const { rows, at } = taskRowsOf({
      taskId: 't1', preassignedSessionId: 'new-1', taskRowsAt: 42,
      taskRows: [OLD, row('new-1'), row('other', { taskId: 't2' }), row('gone', { taskId: '', legacyTaskId: 't1' }), null, 'x', { claudeSessionId: '' }],
    })
    expect(rows.map((r) => r.claudeSessionId)).toEqual(['old-1', 'gone'])
    expect(at).toBe(42)
  })

  it('nothing from a body with no task or no rows; at most TASK_ROWS_MAX; no read time reads as 0', () => {
    expect(taskRowsOf({ taskRows: [OLD] }).rows).toEqual([])
    expect(taskRowsOf({ taskId: 't1' }).rows).toEqual([])
    expect(taskRowsOf({ taskId: 't1', taskRows: 'no' }).rows).toEqual([])
    const many = Array.from({ length: TASK_ROWS_MAX + 5 }, (_, i) => row(`s${i}`))
    const r = taskRowsOf({ taskId: 't1', taskRows: many })
    expect(r.rows).toHaveLength(TASK_ROWS_MAX)
    expect(r.at).toBe(0)
  })
})
