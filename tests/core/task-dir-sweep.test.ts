/**
 * The server half of task directory cleanup (src/core/task-dir-sweep.ts):
 * which directories it asks a host to remove, and that it asks only hosts
 * that can answer. The host half (the unmerged-work check) is
 * tests/providers/task-dir-core.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { pickRemovable, sweepTaskDirsOnce, type TaskStateForSweep } from '../../src/core/task-dir-sweep.js'
import { WALNUT_HOME } from '../../src/constants.js'
import type { TaskDirEntry } from '../../src/providers/task-dir-core.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-26T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const dir = (taskId: string, usedDaysAgo: number, home?: string): TaskDirEntry =>
  ({ taskId, path: `/r/${taskId}`, home, createdAt: iso(usedDaysAgo + 1), lastUsedAt: iso(usedDaysAgo), mtimeMs: NOW - usedDaysAgo * DAY })
const task = (id: string, phase: string, doneDaysAgo?: number): TaskStateForSweep =>
  ({ id, phase, ...(doneDaysAgo != null ? { completed_at: iso(doneDaysAgo) } : {}) })

describe('pickRemovable', () => {
  const opts = { now: NOW, keepDays: 7, home: '/data/home' }

  it.each([
    ['an open task, however old', [dir('a', 90)], [task('a', 'IN_PROGRESS')], []],
    ['a waiting task', [dir('a', 90)], [task('a', 'WAITING')], []],
    ['a task completed 3 days ago', [dir('a', 10)], [task('a', 'COMPLETE', 3)], []],
    ['a task completed 8 days ago, dir used yesterday (reopened and closed again)', [dir('a', 1)], [task('a', 'COMPLETE', 8)], []],
    ['a task completed 8 days ago, dir untouched since', [dir('a', 9)], [task('a', 'COMPLETE', 8)], ['a']],
    ['a completed task with no completion time', [dir('a', 30)], [task('a', 'COMPLETE')], []],
    ['a deleted task of this Walnut, idle 31 days', [dir('a', 31, '/data/home')], [], ['a']],
    ['a deleted task of this Walnut, idle 10 days', [dir('a', 10, '/data/home')], [], []],
    ['an unknown task of another Walnut sharing the host', [dir('a', 200, '/other/home')], [], []],
    ['an unknown task with no owner recorded', [dir('a', 200)], [], []],
  ])('%s', (_label, dirs, tasks, expected) => {
    expect(pickRemovable(dirs, new Map(tasks.map((t) => [t.id, t])), opts)).toEqual(expected)
  })

  it('falls back to phase_changed_at when completed_at is missing', () => {
    const t = { id: 'a', phase: 'COMPLETE', phase_changed_at: iso(9) }
    expect(pickRemovable([dir('a', 9)], new Map([['a', t]]), opts)).toEqual(['a'])
  })
})

describe('sweepTaskDirsOnce', () => {
  function fakeConn(host: string, caps: string[], dirs: TaskDirEntry[]) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    return {
      calls,
      conn: {
        host,
        hasCapability: (c: string) => caps.includes(c),
        send: async (cmd: string, p?: Record<string, unknown>) => {
          calls.push([cmd, p])
          if (cmd === 'taskdir.list') return { ok: true, dirs }
          if (cmd === 'taskdir.remove') return { ok: true, removed: (p!.taskIds as Array<{ taskId: string }>).slice(0, 1).map((i) => i.taskId), kept: [{ taskId: 'x', reasons: ['r'] }], missing: [] }
          return { ok: false }
        },
      },
    }
  }

  it('asks each capable host to remove only what is done with, and skips hosts without task-dir-v1', async () => {
    const local = fakeConn('__local__', ['task-dir-v1'], [dir('done', 30), dir('open', 30), dir('gone', 40, WALNUT_HOME)])
    const old = fakeConn('old-host', [], [dir('done', 30)])
    const res = await sweepTaskDirsOnce({
      conns: [local.conn, old.conn],
      loadTasks: async () => [task('done', 'COMPLETE', 20), task('open', 'TODO')],
      now: NOW,
    })
    expect(local.calls.map((c) => c[0])).toEqual(['taskdir.list', 'taskdir.remove'])
    expect(local.calls[1][1]).toEqual({ taskIds: [
      { taskId: 'done', usedBefore: Date.parse(iso(30)) },
      { taskId: 'gone', usedBefore: Date.parse(iso(40)) },
    ] })
    expect(old.calls).toEqual([])
    expect(res).toEqual([{ host: '__local__', removed: ['done'], kept: [{ taskId: 'x', reasons: ['r'] }], missing: [] }])
  })

  it('sends no removal when nothing qualifies, and survives a host that errors', async () => {
    const quiet = fakeConn('a', ['task-dir-v1'], [dir('open', 30)])
    const broken = {
      host: 'b', hasCapability: () => true,
      send: async () => { throw new Error('link down') },
    }
    const res = await sweepTaskDirsOnce({ conns: [broken, quiet.conn], loadTasks: async () => [task('open', 'IN_PROGRESS')], now: NOW })
    expect(res).toEqual([])
    expect(quiet.calls.map((c) => c[0])).toEqual(['taskdir.list'])
  })
})
