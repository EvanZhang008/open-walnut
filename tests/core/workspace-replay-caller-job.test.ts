/**
 * A task_start that waits for its workspace is replayed once the workspace is ready
 * (core/workspaces/launch.ts taskStartPending, manager.ts launch). A plugin job's start in bypass
 * (core/plugin-jobs/job-caller.ts) must replay as the job's, or the replay under the anonymous
 * caller `external` is refused by the start-mode ceiling after the workspace was made for it.
 * Only the job a start was asked by rides along, and only with its caller sid.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const started = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: vi.fn(async (p: Record<string, unknown>) => { started.push(p); return { taskId: p.taskIdPrefix, started: true } }),
}))
vi.mock('../../src/core/sessions/quick-start.js', () => ({
  quickStartSession: vi.fn(async (p: Record<string, unknown>) => { started.push(p); return { id: p.existingTaskId } }),
}))

import { managerDeps } from '../../src/core/workspaces/manager.js'
import type { TaskWorkspace, WorkspacePendingStart } from '../../src/core/workspaces/types.js'
import type { Task } from '../../src/core/types.js'

const JOB = { plugin: 'ticket-investigator', job: 'poll', host: 'devbox' }
const task = { id: 't-ws', title: 'Investigate' } as Task
const ws = { provider: 'git-worktree', host: 'devbox', anchor: '/r/repo', cwd: '/w/repo', state: 'ready' } as TaskWorkspace

function pending(extra: Partial<WorkspacePendingStart>): WorkspacePendingStart {
  return { via: 'task-start', message: 'look', mode: 'bypass', at: new Date().toISOString(), source: 'api-v1', ...extra }
}

describe('a workspace replay of a plugin job\'s start', () => {
  beforeEach(() => { started.length = 0 })

  it('replays as the job that asked, in the folder and in the fallback folder', async () => {
    await managerDeps().launch(task, ws, pending({ caller_sid: 'external', caller_job: JOB }))
    await managerDeps().launchInFolder(task, ws, pending({ caller_sid: 'external', caller_job: JOB }), 'no git')
    expect(started.map((p) => [p.callerSid, p.callerJob])).toEqual([['external', JOB], ['external', JOB]])
  })

  it('a stored job with no caller sid, or a malformed one, rides along as no job', async () => {
    await managerDeps().launch(task, ws, pending({ caller_job: JOB }))
    await managerDeps().launch(task, ws, pending({ caller_sid: 'external', caller_job: { plugin: '', job: 'poll', host: 'devbox' } }))
    await managerDeps().launch(task, ws, pending({ caller_sid: 'external' }))
    expect(started.map((p) => 'callerJob' in p)).toEqual([false, false, false])
  })
})

// A start asked under a sid its host could not prove (src/lib/caller-unproven.ts) replays as
// unproven too, so the replay's ceiling is an outside caller's, never the claimed session's.
describe('a workspace replay of an unproven caller\'s start', () => {
  beforeEach(() => { started.length = 0 })

  it('replays unproven on every replay path; a start without the mark replays without it', async () => {
    const marked = pending({ caller_sid: 'sid-bypass', caller_unproven: true })
    await managerDeps().launch(task, ws, marked)
    await managerDeps().launchInFolder(task, ws, marked, 'no git')
    await managerDeps().launch(task, ws, { ...marked, via: 'quick-start' })
    await managerDeps().launch(task, ws, pending({ caller_sid: 'sid-bypass' }))
    expect(started.map((p) => [p.callerSid, p.callerUnproven])).toEqual([
      ['sid-bypass', true], ['sid-bypass', true], ['sid-bypass', true], ['sid-bypass', false],
    ])
  })

  it('the task-start pending start keeps the mark it was asked with, and only then', async () => {
    const { taskStartPending } = await import('../../src/core/workspaces/launch.js')
    expect(taskStartPending(task, { callerSid: 'sid-bypass', callerUnproven: true, source: 'api-v1' }).caller_unproven).toBe(true)
    expect('caller_unproven' in taskStartPending(task, { callerSid: 'sid-bypass', source: 'api-v1' })).toBe(false)
  })
})
