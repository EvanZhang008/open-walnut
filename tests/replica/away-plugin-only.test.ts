/**
 * A task a plugin job makes on its host while the Mac is away, when its plugin keeps its tasks
 * to its own view (manifest `taskVisibility: "plugin"`, Task.plugin_only): the follower loads no
 * plugin manifest, so it takes the Mac's word (the host server spec's `pluginsKeepTasks`,
 * plugin-task-visibility.ts) and stamps the row through the function the Mac's create uses
 * (task-row-fold.ts createdRow, keptByMaker). Such a row is never pinned, in no tier, absent
 * from the board's lists (replica/away-reads.ts overlayList, overlayTiers) and there for the
 * plugin's own reads (a list naming its ids, the task itself).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { createdRow, foldTaskRecord, keptByMaker } from '../../src/core/offline-merge/task-row-fold.js'
import { pluginOnlyForCaller, resetPluginTaskVisibilityForTesting, setPluginsKeepingTasksFromLeader } from '../../src/core/plugins/plugin-task-visibility.js'
import { overlayList, overlayTiers } from '../../src/replica/away-reads.js'
import type { Overlay } from '../../src/replica/overlay.js'

const T0 = Date.parse('2026-11-18T12:00:00Z')
const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }
const OTHER_JOB = { kind: 'plugin-job', plugin: 'marina-feed', job: 'poll' }

afterEach(() => resetPluginTaskVisibilityForTesting())

/** An overlay holding two creates of this host: the kept plugin's and another plugin's. */
function overlayOf(): Overlay {
  const recs: Record<string, { actor: unknown; fields: Record<string, unknown>; placement: Record<string, unknown> }> = {
    'mtask-kept-1': { actor: JOB, fields: { title: 'Import the venue rows' }, placement: { project: 'Acme' } },
    'mtask-open-1': { actor: OTHER_JOB, fields: { title: 'Feed the pier list' }, placement: { project: 'Acme' } },
  }
  const withValues = (row: Record<string, unknown>, values: Record<string, unknown>) => ({ ...row, ...values })
  return {
    createdTaskIds: () => Object.keys(recs),
    task: (id: string, row: Record<string, unknown> | null) => (recs[id] ? foldTaskRecord(row, id, { kind: 'task-create', ...recs[id]! }, T0, withValues) : row),
    entries: () => Object.entries(recs).map(([taskId, r], i) => ({ opId: `op-${i}`, seq: i + 1, rev: 1, kind: 'task-create', at: T0, state: 'pending', record: { kind: 'task-create', taskId, ...r } })),
  } as unknown as Overlay
}

const req = (path: string, query: Record<string, string> = {}) => ({ path, query }) as unknown as Request

describe('a plugin-only plugin\'s task made away from the Mac', () => {
  it('the follower takes the Mac\'s word on which plugins keep their tasks, and only well-formed ids', () => {
    expect(pluginOnlyForCaller(undefined, 'acme-sync')).toBeUndefined()
    setPluginsKeepingTasksFromLeader(['acme-sync', 'bad id', 42])
    expect(pluginOnlyForCaller(undefined, 'acme-sync')).toBe('acme-sync')
    expect(pluginOnlyForCaller(undefined, 'bad id')).toBeUndefined()
    setPluginsKeepingTasksFromLeader(undefined)
    expect(pluginOnlyForCaller(undefined, 'acme-sync')).toBeUndefined()
  })

  it('is stamped as the Mac stamps it: kept to the plugin, never pinned, in no tier; any other maker as before', () => {
    expect(createdRow('mtask-kept-1', { title: 'Import' }, { project: 'Acme', tier: 'focus' }, T0, JOB)).not.toHaveProperty('plugin_only')
    setPluginsKeepingTasksFromLeader(['acme-sync'])
    expect(keptByMaker(JOB)).toBe('acme-sync')
    expect(keptByMaker({ kind: 'session', sid: 's' })).toBeUndefined()
    const kept = createdRow('mtask-kept-1', { title: 'Import' }, { project: 'Acme', tier: 'focus' }, T0, JOB)
    expect(kept).toMatchObject({ plugin_only: 'acme-sync', pinned: false })
    expect(kept).not.toHaveProperty('focus_tier')
    // Another plugin's job, a device, a session: as before.
    expect(createdRow('mtask-open-1', { title: 'Feed' }, { project: 'Acme' }, T0, OTHER_JOB)).toMatchObject({ pinned: true })
    expect(createdRow('mtask-open-1', { title: 'Feed' }, { project: 'Acme' }, T0, OTHER_JOB)).not.toHaveProperty('plugin_only')
  })

  it('is absent from the board\'s lists and the Focus bar, and there for the plugin\'s own reads', () => {
    setPluginsKeepingTasksFromLeader(['acme-sync'])
    const overlay = overlayOf()
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id)
    // The console's board and an agent's task_list, and the phone's list.
    expect(ids(overlayList(req('/tasks'), [], overlay))).toEqual(['mtask-open-1'])
    expect(ids(overlayList(req('/tasks/enriched'), [], overlay))).toEqual(['mtask-open-1'])
    expect(ids(overlayList(req('/v1/tasks'), [], overlay))).toEqual(['mtask-open-1'])
    expect(ids(overlayList(req('/v1/tasks', { ids: 'mtask-kept-1' }), [], overlay))).toEqual([])
    // The plugin's own view reads the ones it knows by id, and the task itself.
    expect(ids(overlayList(req('/tasks', { ids: 'mtask-kept-1' }), [], overlay))).toEqual(['mtask-kept-1'])
    expect(overlay.task('mtask-kept-1', null)).toMatchObject({ id: 'mtask-kept-1', plugin_only: 'acme-sync' })
    // Never pinned: not on the Focus bar.
    const bar = overlayTiers({ pinned_tasks: [], focus_tasks: [], satellite_tasks: [], backlog_tasks: [], wait_tasks: [], custom_tier_tasks: {} }, overlay)
    expect(bar.pinned_tasks).toEqual(['mtask-open-1'])
  })
})
