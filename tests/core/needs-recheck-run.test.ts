/**
 * One pass of the re-check clock (src/core/sessions/needs-recheck.ts): a session's "needs you"
 * unconfirmed for NEEDS_RECHECK_MS gets ONE trigger note in its own session, recorded on the task
 * first; a fresh ask and a task with no session are left alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionRecord, Task } from '../../src/core/types.js'

const tasks = new Map<string, Task>()
const writes: { id: string; patch: Record<string, unknown> }[] = []
const sends: { sid: string; text: string; source?: string }[] = []

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: async () => [...tasks.values()],
  updateTaskRaw: async (id: string, patch: Record<string, unknown>) => {
    writes.push({ id, patch })
    tasks.set(id, { ...tasks.get(id)!, ...patch } as Task)
    return { changed: true }
  },
}))
vi.mock('../../src/core/task-wait-until.js', () => ({
  WAIT_UNTIL_SEND_SOURCE: 'wait-until',
}))
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => (id === 'nosess' ? [] : [{ claudeSessionId: `s-${id}`, taskId: id, process_status: 'stopped' } as SessionRecord]),
}))
vi.mock('../../src/core/routines/session-target.js', () => ({
  pickDeliverySession: (rows: SessionRecord[]) => rows[0] ?? null,
}))
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async (sid: string, text: string, o: { source?: string }) => { sends.push({ sid, text, source: o.source }) },
}))

import { runNeedsRecheck, NEEDS_RECHECK_MS } from '../../src/core/sessions/needs-recheck.js'

const NOW = Date.parse('2026-10-28T18:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const needs = (id: string, checkedAt: string): Task => ({
  id, title: `T ${id}`, phase: 'NEED_ACTION', status: 'in_progress',
  user_status: { state: 'needs', source: 'session', ask: 'Sign in on the Mac', checkedAt },
}) as Task

beforeEach(() => {
  tasks.clear(); writes.length = 0; sends.length = 0
  for (const t of [needs('old', ago(NEEDS_RECHECK_MS + 60_000)), needs('fresh', ago(60_000)), needs('nosess', ago(10 * NEEDS_RECHECK_MS))]) tasks.set(t.id, t)
})

describe('a re-check pass', () => {
  it('wakes only the stale ask with a session, recorded before the send', async () => {
    expect(await runNeedsRecheck(NOW)).toEqual(['old'])
    expect(writes).toEqual([{ id: 'old', patch: { needs_recheck: { at: new Date(NOW).toISOString(), count: 1, ask: 'Sign in on the Mac' } } }])
    expect(sends).toHaveLength(1)
    expect(sends[0].sid).toBe('s-old')
    expect(sends[0].source).toBe('wait-until')
    expect(sends[0].text).toContain('kind="trigger"')
    expect(sends[0].text).toContain('"Sign in on the Mac"')
  })

  it('the next pass inside the period asks nothing again; the next period counts up', async () => {
    await runNeedsRecheck(NOW)
    expect(await runNeedsRecheck(NOW + 60_000)).toEqual([])
    // By then the fresh ask is due too, for its first re-check.
    expect(await runNeedsRecheck(NOW + NEEDS_RECHECK_MS + 60_000)).toEqual(['old', 'fresh'])
    expect(tasks.get('fresh')!.needs_recheck!.count).toBe(1)
    expect(tasks.get('old')!.needs_recheck!.count).toBe(2)
  })

  it('a task that no longer asks the user has its count cleared, and the next ask starts at one', async () => {
    await runNeedsRecheck(NOW)
    // Its re-check turn runs as Working: the count stays.
    tasks.set('old', { ...tasks.get('old')!, user_status: { state: 'working' } } as Task)
    await runNeedsRecheck(NOW + 60_000)
    expect(tasks.get('old')!.needs_recheck!.count).toBe(1)
    tasks.set('old', { ...tasks.get('old')!, user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review' } } as Task)
    await runNeedsRecheck(NOW + 2 * 60_000)
    expect(tasks.get('old')!.needs_recheck).toBeNull()
  })
})
