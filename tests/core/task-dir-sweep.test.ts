/**
 * The server half of task directory cleanup (src/core/task-dir-sweep.ts):
 * which directories it asks a host to remove, and that it asks only hosts
 * that can answer. The host half (the unmerged-work check) is
 * tests/providers/task-dir-core.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { pickBuildPrunable, pickPrunable, pickRemovable, sweepTaskDirsOnce, type TaskStateForSweep } from '../../src/core/task-dir-sweep.js'
import { PHASE_ORDER } from '../../src/core/phase.js'
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

describe('pickPrunable', () => {
  const opts = { now: NOW, pruneDays: 1, removed: new Set<string>() }
  const pruned = (d: TaskDirEntry, daysAgo: number): TaskDirEntry => ({ ...d, prunedAt: iso(daysAgo) })

  it.each([
    ['an open task', [dir('a', 5)], [task('a', 'IN_PROGRESS')], []],
    ['a task completed 2 days ago, dir unused since', [dir('a', 2)], [task('a', 'COMPLETE', 2)], ['a']],
    ['a task completed 2 hours ago', [dir('a', 2)], [task('a', 'COMPLETE', 0.1)], []],
    ['a task completed 3 days ago, dir used 2 hours ago', [dir('a', 0.1)], [task('a', 'COMPLETE', 3)], []],
    ['already pruned since its last use', [pruned(dir('a', 3), 1)], [task('a', 'COMPLETE', 3)], []],
    ['pruned before a later use', [pruned(dir('a', 2), 4)], [task('a', 'COMPLETE', 3)], ['a']],
    ['a deleted task', [dir('a', 40, WALNUT_HOME)], [], []],
  ])('%s', (_label, dirs, tasks, expected) => {
    expect(pickPrunable(dirs, new Map(tasks.map((t) => [t.id, t])), opts)).toEqual(expected)
  })

  it('skips a directory removed whole this round, prunes one the removal kept, and is off at 0 days', () => {
    const tasks = new Map([['a', task('a', 'COMPLETE', 9)]])
    expect(pickPrunable([dir('a', 9)], tasks, { ...opts, removed: new Set(['a']) })).toEqual([])
    expect(pickPrunable([dir('a', 9)], tasks, opts)).toEqual(['a'])
    expect(pickPrunable([dir('a', 9)], tasks, { ...opts, pruneDays: 0 })).toEqual([])
  })
})

describe('pickBuildPrunable', () => {
  const opts = { now: NOW, idleDays: 2, home: '/data/home', skip: new Set<string>() }

  it.each([
    ['an open task idle 3 days', [dir('a', 3)], [task('a', 'IN_PROGRESS')], ['a']],
    ['a running task (the host judges each build folder by its own age)', [dir('a', 0.01)], [task('a', 'IN_PROGRESS')], ['a']],
    ['already build-pruned since its last use', [{ ...dir('a', 5), buildsPrunedAt: iso(1) }], [task('a', 'WAITING')], []],
    ['build-pruned before a later use', [{ ...dir('a', 3), buildsPrunedAt: iso(4) }], [task('a', 'NEED_ACTION')], ['a']],
    ['a fully pruned finished task is still build-pruned once', [{ ...dir('a', 5), prunedAt: iso(4) }], [task('a', 'COMPLETE', 6)], ['a']],
    ['a deleted task of this Walnut', [dir('a', 5, '/data/home')], [], ['a']],
    ['an unknown task of another Walnut', [dir('a', 5, '/other/home')], [], []],
    ['an unknown task with no owner recorded', [dir('a', 5)], [], []],
  ])('%s', (_label, dirs, tasks, expected) => {
    expect(pickBuildPrunable(dirs, new Map(tasks.map((t) => [t.id, t])), opts)).toEqual(expected)
  })

  it('skips what this round removes or prunes whole, and is off at 0 days', () => {
    const tasks = new Map([['a', task('a', 'TODO')]])
    expect(pickBuildPrunable([dir('a', 9)], tasks, { ...opts, skip: new Set(['a']) })).toEqual([])
    expect(pickBuildPrunable([dir('a', 9)], tasks, { ...opts, idleDays: 0 })).toEqual([])
  })

  // The class guard: 2026-11-08, directories of open tasks held 70 of 74 GB because only
  // COMPLETE was ever pruned. Every phase there is, and any phase added later, must have
  // its idle directory's build output reclaimed by one of the pickers.
  it.each(PHASE_ORDER)('an idle directory of a %s task loses its build output', (phase) => {
    const tasks = new Map([['a', task('a', phase, phase === 'COMPLETE' ? 10 : undefined)]])
    const dirs = [dir('a', 10)]
    const full = pickPrunable(dirs, tasks, { now: NOW, pruneDays: 1, removed: new Set() })
    const builds = pickBuildPrunable(dirs, tasks, { ...opts, skip: new Set(full) })
    expect([...full, ...builds]).toEqual(['a'])
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
          if (cmd === 'taskdir.pruneBuilds') return { ok: true, pruned: (p!.taskIds as Array<{ taskId: string }>).map((i) => ({ taskId: i.taskId, repos: [], builds: ['node_modules'] })), kept: [], missing: [] }
          if (cmd === 'taskdir.prune') return { ok: true, pruned: (p!.taskIds as Array<{ taskId: string }>).map((i) => ({ taskId: i.taskId, repos: ['clone'], builds: [] })), kept: [], missing: [] }
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

  it('asks a host with task-dir-prune-v1 to prune a task done a day, and an older host nothing more', async () => {
    const both = fakeConn('__local__', ['task-dir-v1', 'task-dir-prune-v1'], [dir('old', 30), dir('recent', 2), dir('fresh', 0.1)])
    const older = fakeConn('old-host', ['task-dir-v1'], [dir('recent', 2)])
    const loadTasks = async () => [task('old', 'COMPLETE', 20), task('recent', 'COMPLETE', 2), task('fresh', 'COMPLETE', 0.1)]
    const res = await sweepTaskDirsOnce({ conns: [both.conn, older.conn], loadTasks, now: NOW })
    expect(both.calls.map((c) => c[0])).toEqual(['taskdir.list', 'taskdir.remove', 'taskdir.prune'])
    expect(both.calls[2][1]).toEqual({ taskIds: [{ taskId: 'recent', usedBefore: Date.parse(iso(2)) }] })
    expect(older.calls.map((c) => c[0])).toEqual(['taskdir.list'])
    expect(res).toEqual([{ host: '__local__', removed: ['old'], kept: [{ taskId: 'x', reasons: ['r'] }], missing: [], pruned: [{ taskId: 'recent', repos: ['clone'], builds: [] }] }])
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

  it('asks a host with task-dir-prune-builds-v1 for an idle open task\'s build output, an older host never', async () => {
    const both = fakeConn('__local__', ['task-dir-v1', 'task-dir-prune-v1', 'task-dir-prune-builds-v1'], [dir('lead', 3), { ...dir('busy', 0.5), buildsPrunedAt: iso(0.1) }])
    const older = fakeConn('cloud', ['task-dir-v1', 'task-dir-prune-v1'], [dir('lead', 3)])
    const loadTasks = async () => [task('lead', 'IN_PROGRESS'), task('busy', 'IN_PROGRESS')]
    const res = await sweepTaskDirsOnce({ conns: [both.conn, older.conn], loadTasks, now: NOW, lowDisk: false })
    expect(both.calls.map((c) => c[0])).toEqual(['taskdir.list', 'taskdir.pruneBuilds'])
    expect(both.calls[1][1]).toEqual({ taskIds: [{ taskId: 'lead', usedBefore: Date.parse(iso(3)) }], idleBefore: NOW - 2 * DAY })
    expect(older.calls.map((c) => c[0])).toEqual(['taskdir.list'])
    expect(res).toEqual([{ host: '__local__', buildsPruned: [{ taskId: 'lead', repos: [], builds: ['node_modules'] }] }])
  })

  it('a low disk shortens the wait to 6 hours on this machine only', async () => {
    const local = fakeConn('__local__', ['task-dir-v1', 'task-dir-prune-builds-v1'], [dir('a', 0.5)])
    const remote = fakeConn('cloud', ['task-dir-v1', 'task-dir-prune-builds-v1'], [dir('a', 0.5)])
    await sweepTaskDirsOnce({ conns: [local.conn, remote.conn], loadTasks: async () => [task('a', 'WAITING')], now: NOW, lowDisk: true })
    expect(local.calls[1]).toEqual(['taskdir.pruneBuilds', { taskIds: [{ taskId: 'a', usedBefore: Date.parse(iso(0.5)) }], idleBefore: NOW - 0.25 * DAY }])
    expect(remote.calls[1]).toEqual(['taskdir.pruneBuilds', { taskIds: [{ taskId: 'a', usedBefore: Date.parse(iso(0.5)) }], idleBefore: NOW - 2 * DAY }])
  })
})
