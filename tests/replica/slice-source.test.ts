/**
 * A host's Walnut service that keeps no copy reads its sessions' rows from the slice the leader
 * pushed (src/replica/slice-source.ts): installed beneath the stores (src/core/unstored-rows.ts),
 * so the task store, the Board store, the session registry and the request readers show them as
 * stored, a stored row of the same id wins, a new slice replaces the old rows, and nothing is
 * left once the source stops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-slice-source'))

import { addTask, getTask, listTasks, queryTasks, _resetForTesting } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { getBoard, getBoardView } from '../../src/core/boards/board-store.js'
import { awaySessionsOfTask, getSessionByClaudeId, isAwaySession, listSessions } from '../../src/core/session-tracker.js'
import { getSessionRequest } from '../../src/core/session-requests.js'
import { createSliceSource, rowsOfSlice, type SliceAnswer } from '../../src/replica/slice-source.js'
import { hasUnstoredRows } from '../../src/core/unstored-rows.js'

const HOST = 'smallbox'

function slice(over: Partial<SliceAnswer> = {}): SliceAnswer {
  return {
    host: HOST, asOf: 1_000,
    tasks: [
      { id: 'task-lead-0001', title: 'Lead of the team', phase: 'IN_PROGRESS', project: 'Acme' },
      { id: 'task-work-0002', title: 'Worker here', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: 'task-lead-0001' },
    ],
    sessions: [{ sid: 'sid-work-1', taskId: 'task-work-0002', title: 'worker session' }],
    requests: [{ id: 'rq-abcdef01', fromSessionId: 'sid-work-1', toTaskId: 'task-lead-0001', preview: 'done?', status: 'pending', createdAt: '2026-11-25T00:00:00.000Z', deadlineAt: 2_000_000_000_000 }],
    boards: [{ taskId: 'task-lead-0001', html: '<p>plan</p>', version: 3, threads: {}, marks: {} }],
    boardOf: { 'task-work-0002': 'task-lead-0001' },
    ...over,
  }
}

/** A follower link that answers follower.slice with `current` and follower.sessions with live states. */
function link(state: { current: SliceAnswer; live?: Record<string, string> }) {
  const asked: string[] = []
  return {
    asked,
    request: async (cmd: string) => {
      asked.push(cmd)
      if (cmd === 'follower.slice') return { ok: true, ...state.current }
      if (cmd === 'follower.sessions') return { ok: true, sessions: Object.entries(state.live ?? {}).map(([sid, s]) => ({ sid, state: s })) }
      return { ok: false, error: 'unknown' }
    },
  }
}

describe('the slice beneath the stores (copyless service)', () => {
  beforeEach(async () => {
    closeDb()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    _resetForTesting()
  })
  afterEach(() => { closeDb() })

  it('turns the runtime\'s slice into stored rows: tasks, sessions with their live state, requests, Boards', () => {
    const rows = rowsOfSlice(slice(), new Map([['sid-work-1', 'working']]), HOST)
    expect(rows.tasks.map((t) => [t.id, t.status, t.phase])).toEqual([['task-lead-0001', 'in_progress', 'IN_PROGRESS'], ['task-work-0002', 'in_progress', 'IN_PROGRESS']])
    expect(rows.sessions[0]).toMatchObject({ claudeSessionId: 'sid-work-1', taskId: 'task-work-0002', host: HOST, process_status: 'running', project: 'Acme' })
    expect(rows.requests[0]).toMatchObject({ id: 'rq-abcdef01', status: 'pending', toTaskId: 'task-lead-0001' })
    expect(rows.boards.get('task-lead-0001')).toMatchObject({ task_id: 'task-lead-0001', version: 3, html: '<p>plan</p>' })
  })

  it('every store reads the slice\'s rows as its own; a stored row of the same id wins; a new slice replaces them; stop removes them', async () => {
    const { task: stored } = await addTask({ title: 'Stored here', project: 'Acme' })
    const state = { current: slice({ tasks: [...(slice().tasks as object[]), { id: stored.id, title: 'Slice copy of the stored one', phase: 'TODO' }] }), live: { 'sid-work-1': 'idle' } }
    const l = link(state)
    const source = createSliceSource({ request: l.request, hostKey: HOST, everyMs: 0 })
    await source.refresh(0)
    expect(hasUnstoredRows()).toBe(true)

    // tasks: one by id and by prefix, the lists, a query
    expect((await getTask('task-work-0002')).title).toBe('Worker here')
    expect((await getTask('task-lead')).id).toBe('task-lead-0001')
    expect((await getTask(stored.id)).title).toBe('Stored here')
    expect((await listTasks()).map((t) => t.id).sort()).toEqual([stored.id, 'task-lead-0001', 'task-work-0002'].sort())
    expect((await queryTasks({})).map((t) => t.id)).toContain('task-work-0002')
    // a Board, a session, a request
    expect((await getBoard('task-lead-0001'))?.version).toBe(3)
    expect((await getBoardView('task-lead-0001'))?.html).toBe('<p>plan</p>')
    expect(await getSessionByClaudeId('sid-work-1')).toMatchObject({ taskId: 'task-work-0002', host: HOST, process_status: 'idle' })
    expect((await listSessions()).map((s) => s.claudeSessionId)).toContain('sid-work-1')
    // never an away start: the reader fold must not link it to its task as one this host started alone
    expect(awaySessionsOfTask('task-work-0002')).toEqual([])
    expect(isAwaySession('sid-work-1')).toBe(false)
    expect(await getSessionRequest('rq-abcdef01')).toMatchObject({ fromSessionId: 'sid-work-1' })

    // the leader pushes a new slice: a renamed task, the worker gone
    state.current = slice({ asOf: 2_000, tasks: [{ id: 'task-lead-0001', title: 'Lead, renamed', phase: 'IN_PROGRESS', project: 'Acme' }], sessions: [] })
    await source.refresh(0)
    expect((await getTask('task-lead-0001')).title).toBe('Lead, renamed')
    await expect(getTask('task-work-0002')).rejects.toThrow()
    expect(await getSessionByClaudeId('sid-work-1')).toBeNull()

    source.stop()
    expect(hasUnstoredRows()).toBe(false)
    await expect(getTask('task-lead-0001')).rejects.toThrow()
    expect(await getBoard('task-lead-0001')).toBeNull()
  })

  it('a write on a task the slice does not hold needs the leader (no_copy), never "not found"', async () => {
    const source = createSliceSource({ request: link({ current: slice() }).request, hostKey: HOST, everyMs: 0 })
    try {
      const a = source.missing('task-elsewhere')
      expect(a).toMatchObject({ answered: false, status: 503, body: { error: { code: 'needs_leader', why: 'no_copy' } } })
    } finally { source.stop() }
  })

  it('reads the runtime once per refresh window, shared by concurrent readers', async () => {
    const l = link({ current: slice() })
    const source = createSliceSource({ request: l.request, hostKey: HOST, everyMs: 0 })
    try {
      await Promise.all([source.refresh(0), source.refresh(0), source.refresh(0)])
      await source.refresh(60_000)
      expect(l.asked.filter((c) => c === 'follower.slice').length).toBeLessThanOrEqual(2)
    } finally { source.stop() }
  })
})
