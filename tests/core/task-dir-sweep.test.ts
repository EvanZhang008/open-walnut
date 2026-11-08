/**
 * The server half of task directory cleanup (src/core/task-dir-sweep.ts):
 * which directories it asks a host to remove, and that it asks only hosts
 * that can answer. The host half (the unmerged-work check) is
 * tests/providers/task-dir-core.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { localDiskLow, pickBuildPrunable, pickPrunable, pickRemovable, sweepTaskDirsOnce, type TaskStateForSweep } from '../../src/core/task-dir-sweep.js'
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
    // This machine's directories in use too (`live`); another host's disk is not the one measured.
    expect(local.calls[1]).toEqual(['taskdir.pruneBuilds', { taskIds: [{ taskId: 'a', usedBefore: Date.parse(iso(0.5)) }], idleBefore: NOW - 0.25 * DAY, live: true }])
    expect(remote.calls[1]).toEqual(['taskdir.pruneBuilds', { taskIds: [{ taskId: 'a', usedBefore: Date.parse(iso(0.5)) }], idleBefore: NOW - 2 * DAY }])
  })

  // 2026-11-08: the second refill (30 to 8 GiB) was running tasks' own run folders, not build output.
  // On a low disk the local host measures open tasks' directories and tells each one over the limit.
  it('a low disk tells an open task over the size limit, once a day or again after 2 GB more, never a done one', async () => {
    const GiB = 1024 ** 3
    let sizes = [
      { taskId: 'big', bytes: 9 * GiB, partial: false, top: [{ name: 'runs', bytes: 8 * GiB }, { name: 'notes.md', bytes: 4096 }] },
      { taskId: 'small', bytes: 1 * GiB, partial: false, top: [] },
      { taskId: 'done', bytes: 20 * GiB, partial: false, top: [] },
      { taskId: 'nosession', bytes: 20 * GiB, partial: false, top: [] },
    ]
    const mk = (host: string, caps: string[]) => {
      const f = fakeConn(host, caps, [dir('big', 0.1), dir('small', 0.1), dir('done', 0.1), dir('nosession', 0.1)])
      const send = f.conn.send
      f.conn.send = async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'taskdir.sizes') { f.calls.push([cmd, p]); return { ok: true, sizes: sizes.filter((s) => (p!.taskIds as string[]).includes(s.taskId)) } }
        return send(cmd, p)
      }
      return f
    }
    const loadTasks = async () => [
      { ...task('big', 'IN_PROGRESS'), session_id: 's-big' }, { ...task('small', 'WAITING'), session_id: 's-small' },
      { ...task('done', 'COMPLETE', 3), session_id: 's-done' }, task('nosession', 'TODO'),
    ]
    const told: Array<{ id: string; text: string; messageId: string }> = []
    const tellTask = async (t: { id: string }, text: string, messageId: string) => { told.push({ id: t.id, text, messageId }) }
    const noticeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-size-notice-')), 'told.json')
    const caps = ['task-dir-v1', 'task-dir-sizes-v1']
    const local = mk('__local__', caps)
    const remote = mk('cloud', caps)
    const res = await sweepTaskDirsOnce({ conns: [local.conn, remote.conn], loadTasks, now: NOW, lowDisk: true, tellTask, noticeFile, orgOn: true })
    // Only open tasks with a session are measured; only this machine's disk is low.
    expect(local.calls.find((c) => c[0] === 'taskdir.sizes')?.[1]).toEqual({ taskIds: ['big', 'small'] })
    expect(remote.calls.some((c) => c[0] === 'taskdir.sizes')).toBe(false)
    expect(told.map((t) => t.id)).toEqual(['big'])
    expect(told[0].text).toContain('takes 9.0 GB')
    expect(told[0].text).toContain('- runs: 8.0 GB')
    expect(told[0].text).not.toContain('notes.md')
    expect(told[0].text).toContain('Walnut deletes none of it for you')
    expect(res.find((r) => r.host === '__local__')?.toldSize).toEqual(['big'])
    // Not again the same day, also after a restart (the record is on disk) ...
    await sweepTaskDirsOnce({ conns: [mk('__local__', caps).conn], loadTasks, now: NOW + 3_600_000, lowDisk: true, tellTask, noticeFile })
    expect(told).toHaveLength(1)
    // ... unless it grew by 2 GB, or a day went by.
    sizes = sizes.map((s) => (s.taskId === 'big' ? { ...s, bytes: 11.5 * GiB } : s))
    await sweepTaskDirsOnce({ conns: [mk('__local__', caps).conn], loadTasks, now: NOW + 7_200_000, lowDisk: true, tellTask, noticeFile })
    expect(told).toHaveLength(2)
    // A new notice is new news: its own message id, never a retry the queue would skip.
    expect(told[1].messageId).not.toBe(told[0].messageId)
    await sweepTaskDirsOnce({ conns: [mk('__local__', caps).conn], loadTasks, now: NOW + 7_200_000 + DAY, lowDisk: true, tellTask, noticeFile })
    expect(told).toHaveLength(3)
    // A disk that is not low, or a host without the capability, measures nothing.
    const calm = mk('__local__', caps)
    await sweepTaskDirsOnce({ conns: [calm.conn], loadTasks, now: NOW + 3 * DAY, lowDisk: false, tellTask, noticeFile })
    const older = mk('__local__', ['task-dir-v1'])
    await sweepTaskDirsOnce({ conns: [older.conn], loadTasks, now: NOW + 3 * DAY, lowDisk: true, tellTask, noticeFile })
    expect([...calm.calls, ...older.calls].some((c) => c[0] === 'taskdir.sizes')).toBe(false)
    expect(told).toHaveLength(3)
  })

  // Review round 5: no Walnut message reaches Main or a VP while the org is off; and a directory the host
  // did not reach (its deadline) is asked for first next round, so one huge tree cannot starve the rest.
  it('skips an org node while the org is off, and asks first for the directories measured longest ago', async () => {
    const GiB = 1024 ** 3
    const asked: string[][] = []
    const conn = {
      host: '__local__', hasCapability: (c: string) => ['task-dir-v1', 'task-dir-sizes-v1'].includes(c),
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'taskdir.list') return { ok: true, dirs: [dir('vp', 0.1), dir('a', 0.1), dir('b', 0.1)] }
        if (cmd !== 'taskdir.sizes') return { ok: false }
        const ids = p!.taskIds as string[]
        asked.push(ids)
        // The host reaches only the first one before its deadline.
        return { ok: true, sizes: [{ taskId: ids[0], bytes: 9 * GiB, partial: false, top: [] }] }
      },
    }
    const loadTasks = async () => [
      { ...task('vp', 'IN_PROGRESS'), session_id: 's-vp', org_role: 'lead' },
      { ...task('a', 'IN_PROGRESS'), session_id: 's-a' }, { ...task('b', 'IN_PROGRESS'), session_id: 's-b' },
    ]
    const told: string[] = []
    const tellTask = async (t: { id: string }) => { told.push(t.id) }
    const noticeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-size-notice-')), 'told.json')
    const round = (n: number, orgOn: boolean) => sweepTaskDirsOnce({ conns: [conn], loadTasks, now: NOW + n * 3_600_000, lowDisk: true, tellTask, noticeFile, orgOn })
    await round(0, false)
    await round(1, false)
    expect(asked).toEqual([['a', 'b'], ['b', 'a']])
    expect(told).toEqual(['a', 'b'])
    await round(2, true)
    expect(asked[2][0]).toBe('vp')
    expect(told).toEqual(['a', 'b', 'vp'])
  })

  // 2026-11-08: the Mac refilled from 30 to 12 GiB within hours while the watermark (10 GiB) still read ok.
  it('the disk counts as low under the placement floor (20 GiB), before the watermark', async () => {
    const GiB = 1024 ** 3
    expect(await localDiskLow(async () => ({ bavail: 12 * GiB / 4096, bsize: 4096 }))).toBe(true)
    expect(await localDiskLow(async () => ({ bavail: 30 * GiB / 4096, bsize: 4096 }))).toBe(false)
    expect(await localDiskLow(async () => { throw new Error('statfs failed') })).toBe(false)
  })
})
