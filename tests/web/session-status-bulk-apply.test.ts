/**
 * Bulk applies to the session status store (a task list seed, a hydration
 * batch) notify listeners ONCE and log ONE summary line.
 *
 * A page load applied ~9,600 transitions one at a time, each with an info line
 * and a listener pass: over a second of main thread once DevTools or the log
 * forwarder serialized the lines (2026-09-29). Inside a bulk apply the
 * per-transition line is debug-level; a single live event keeps its info line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))

import { SessionStatusStore, type SessionStatusSnapshot } from '../../web/src/stores/session-status-store'

const sid = (i: number) => `sess-${String(i).padStart(4, '0')}`

function snapshot(sessionId: string, revision: number, processStatus: SessionStatusSnapshot['process_status'] = 'running'): SessionStatusSnapshot {
  return {
    sessionId, taskId: null, process_status: processStatus, activity: null, mode: 'default',
    planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude',
    pendingPermissionTool: null, statusRevision: revision, statusUpdatedAt: '2026-09-29T00:00:00.000Z',
  }
}

const infoLines = (message: string) => logMock.info.mock.calls.filter((c) => c[1] === message)
const debugLines = (message: string) => logMock.debug.mock.calls.filter((c) => c[1] === message)

let store: SessionStatusStore
let listener: ReturnType<typeof vi.fn>

beforeEach(() => {
  // A fresh store with one subscriber and an empty log.
  vi.clearAllMocks()
  store = new SessionStatusStore()
  listener = vi.fn()
  store.subscribe(listener)
})

describe('bulk applies notify once and log one summary', () => {
  it('a task list seed of 500 tasks: one notification, per-transition lines at debug, one summary', () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `task-${i}`, session_id: sid(i), session_status: { process_status: i % 2 ? 'idle' : 'stopped' },
    }))
    // A listener that reads during the notification sees the whole list applied.
    let seenAtNotify = 0
    listener.mockImplementation(() => { seenAtNotify = tasks.filter((t) => store.getStatus(t.session_id)).length })

    store.seedTaskList(tasks, 'rest:task-list')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(seenAtNotify).toBe(500)
    expect(infoLines('transition accepted')).toHaveLength(0)
    expect(debugLines('transition accepted')).toHaveLength(500)
    expect(infoLines('task list seeded')).toEqual([
      ['session-status', 'task list seeded', { source: 'rest:task-list', tasks: 500, accepted: 500 }],
    ])
    expect(store.getStatus(sid(1))?.process_status).toBe('idle')
  })

  it('a re-seed that changes nothing neither notifies nor logs a summary', () => {
    const tasks = [{ id: 't', session_id: sid(1), session_status: { process_status: 'idle' } }]
    store.seedTaskList(tasks, 'rest:task-list')
    vi.clearAllMocks()

    store.seedTaskList(tasks, 'rest:task-list')
    expect(listener).not.toHaveBeenCalled()
    expect(infoLines('task list seeded')).toHaveLength(0)
  })

  it('a hydration batch returns how many it accepted and notifies once', () => {
    store.applyVersioned(snapshot(sid(2), 9), 'ws')
    vi.clearAllMocks()

    const accepted = store.applyVersionedBatch([
      snapshot(sid(1), 3),
      snapshot(sid(2), 4), // older than the live snapshot: rejected
      snapshot(sid(3), 5, 'idle'),
    ], 'rest:session-list')

    expect(accepted).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getStatus(sid(2))?.statusRevision).toBe(9)
    expect(store.getStatus(sid(3))?.process_status).toBe('idle')
    expect(infoLines('transition accepted')).toHaveLength(0)
    expect(debugLines('transition accepted')).toHaveLength(2)
  })

  it('an empty or all-duplicate batch does not notify', () => {
    expect(store.applyVersionedBatch([], 'rest:session-list')).toBe(0)
    store.applyVersioned(snapshot(sid(1), 3), 'ws')
    listener.mockClear()
    expect(store.applyVersionedBatch([snapshot(sid(1), 3)], 'rest:session-list')).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('a single live event still notifies at once and logs its transition at info', () => {
    expect(store.ingestStatusEvent({ status: snapshot(sid(7), 2) })).toBe('accepted')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(infoLines('transition accepted')).toEqual([
      ['session-status', 'transition accepted', expect.objectContaining({ sessionId: sid(7), source: 'ws', revision: 2 })],
    ])
    expect(debugLines('transition accepted')).toHaveLength(0)
  })
})
