/**
 * The toasts a completed task's workspace cleanup gives (web/src/components/
 * workspaces/cleanup-notices.ts) and the kept reason's sentence (workspace-text.ts).
 */
import { describe, expect, it } from 'vitest'
import { __resetSetupWatch, cleanupNotice, completionNotice, setupNotice, watchSetupRun } from '../../web/src/components/workspaces/cleanup-notices'
import { keptText } from '../../web/src/components/workspaces/workspace-text'
import type { TaskWorkspace, WorkspaceScriptRun } from '../../src/core/workspaces/types'

const ready: TaskWorkspace = { provider: 'git-worktree', host: '__local__', anchor: '/r/web', root: '/w/web-x', cwd: '/w/web-x', repos: [], state: 'ready' }
const down: WorkspaceScriptRun = { name: 'Stop services', command: 'make down', source: 'project', state: 'running', started_at: '2026-11-04T10:00:00.000Z' }
const ran = { ...down, state: 'done' as const, ended_at: '2026-11-04T10:00:05.000Z' }

describe('cleanup notices', () => {
  it('a cleanup script starting, then the workspace removed', () => {
    const running = { ...ready, teardown: down }
    expect(cleanupNotice('t', 'Fix login', ready, running)).toMatchObject({ severity: 'info', title: 'Running cleanup Stop services', body: expect.stringContaining('“Fix login” completed') })
    // The same run seen again (a progress write) says nothing more.
    expect(cleanupNotice('t', 'Fix login', running, { ...running, updated_at: 'x' })).toBeNull()
    const removing = { ...ready, state: 'removing' as const, teardown: ran, removal: { trigger: 'complete' as const, from: 'ready' as const } }
    expect(cleanupNotice('t', 'Fix login', running, removing)).toBeNull()
    expect(cleanupNotice('t', 'Fix login', removing, { ...removing, state: 'removed' })).toMatchObject({
      severity: 'success', title: 'Workspace removed', body: 'Cleanup Stop services: Done in 5s. The workspace of “Fix login” was removed.',
    })
  })

  it('a failed cleanup script, and a workspace kept with its reason', () => {
    const failed = { ...ready, teardown: { ...ran, state: 'failed' as const, error: 'exited with code 2' } }
    const kept = { ...failed, state: 'kept' as const, kept_reason: 'web: 1 uncommitted change', setup: { ...ran, name: 'Install' } }
    expect(cleanupNotice('t', 'Fix login', { ...ready, teardown: down }, kept)).toMatchObject({
      severity: 'warning', title: 'Cleanup Stop services failed; workspace kept',
      body: 'Cleanup Stop services failed: exited with code 2. The workspace of “Fix login” was kept: web has 1 uncommitted change. Files a setup script makes count too, unless .gitignore lists them. Its output is in the session\'s Scripts menu.',
    })
    // Removed anyway: the code and its last line, and that nothing was lost.
    const gone = { ...ready, state: 'removed' as const, teardown: { ...ran, state: 'failed' as const, exit_code: 3, error: 'exited with code 3', output: 'stopping\nservice web not found\n' } }
    expect(cleanupNotice('t', 'Fix login', { ...ready, teardown: down }, gone)).toMatchObject({
      severity: 'warning', title: 'Cleanup Stop services failed; workspace removed',
      body: 'Cleanup Stop services failed (exit 3): “service web not found”. The workspace of “Fix login” was removed anyway, since nothing in it would be lost. Its output is in the session\'s Scripts menu.',
    })
  })

  it('no toast for a row first seen, a person\'s own removal, or nothing new', () => {
    expect(cleanupNotice('t', 'x', undefined, { ...ready, state: 'removed' })).toBeNull()
    const manual = { ...ready, state: 'removing' as const, removal: { trigger: 'manual' as const, from: 'ready' as const } }
    expect(cleanupNotice('t', 'x', manual, { ...manual, state: 'removed' })).toBeNull()
    expect(cleanupNotice('t', 'x', ready, { ...ready })).toBeNull()
  })

  it('a kept reason reads as a sentence', () => {
    expect(keptText({ ...ready, state: 'kept', kept_reason: 'web: 2 uncommitted changes; web: has stashed changes' })).toBe('web has 2 uncommitted changes; web has stashed changes.')
    expect(keptText({ ...ready, state: 'kept' })).toBe('it still holds work.')
  })

  it('a completion says at once that the workspace is checked next', () => {
    expect(completionNotice('t', 'Fix login', 'IN_PROGRESS', 'COMPLETE', ready)).toMatchObject({ severity: 'info', title: 'Cleaning up the workspace', key: 'cleanup-running:t:check' })
    expect(completionNotice('t', 'Fix login', 'COMPLETE', 'COMPLETE', ready)).toBeNull()
    expect(completionNotice('t', 'Fix login', undefined, 'COMPLETE', ready)).toBeNull()
    expect(completionNotice('t', 'Fix login', 'IN_PROGRESS', 'COMPLETE', { ...ready, state: 'kept' })).toBeNull()
    expect(completionNotice('t', 'Fix login', 'IN_PROGRESS', 'COMPLETE', undefined)).toBeNull()
  })

  it("a setup this page ran again tells its end, once; another task's says nothing", () => {
    __resetSetupWatch()
    const install: WorkspaceScriptRun = { name: 'Install', command: 'bun i', source: 'walnut.json', state: 'done', started_at: '2026-11-04T09:00:00.000Z', ended_at: '2026-11-04T09:00:06.000Z' }
    const again = { ...install, state: 'running' as const, started_at: '2026-11-04T10:00:00.000Z', ended_at: undefined }
    const done = { ...again, state: 'done' as const, ended_at: '2026-11-04T10:00:04.000Z' }
    expect(setupNotice('t', 'Fix login', { ...ready, setup: again }, { ...ready, setup: done })).toBeNull()
    watchSetupRun('t')
    expect(setupNotice('t', 'Fix login', { ...ready, setup: install }, { ...ready, setup: again })).toBeNull()
    expect(setupNotice('t', 'Fix login', { ...ready, setup: again }, { ...ready, setup: done })).toMatchObject({ severity: 'success', title: 'Setup Install done', body: expect.stringContaining('“Fix login”') })
    expect(setupNotice('t', 'Fix login', { ...ready, setup: again }, { ...ready, setup: done })).toBeNull()
    // A whole run between two rows, and a failure.
    watchSetupRun('t')
    const failed = { ...done, state: 'failed' as const, started_at: '2026-11-04T11:00:00.000Z', error: 'exited with code 2' }
    expect(setupNotice('t', 'Fix login', { ...ready, setup: done }, { ...ready, setup: failed })).toMatchObject({ severity: 'warning', title: 'Setup Install failed', body: expect.stringContaining('exited with code 2') })
  })

  it('a setup the session does not wait for says when it starts and when it ends', () => {
    __resetSetupWatch()
    const bg: WorkspaceScriptRun = { name: 'Warm cache', command: 'make cache', source: 'project', state: 'running', wait: false, started_at: '2026-11-04T12:00:00.000Z' }
    expect(setupNotice('t2', 'Fix login', ready, { ...ready, setup: bg })).toMatchObject({ severity: 'info', title: 'Setup Warm cache runs in the background', key: expect.stringMatching(/^setup-started:/) })
    expect(setupNotice('t2', 'Fix login', { ...ready, setup: bg }, { ...ready, setup: { ...bg, progress: 'x' } as WorkspaceScriptRun })).toBeNull()
    const done = { ...bg, state: 'done' as const, ended_at: '2026-11-04T12:00:09.000Z' }
    expect(setupNotice('t2', 'Fix login', { ...ready, setup: bg }, { ...ready, setup: done })).toMatchObject({ severity: 'success', title: 'Setup Warm cache done', key: expect.stringMatching(/^setup-ended:/) })
    // A waiting setup (the column shows it) says nothing here.
    expect(setupNotice('t4', 'Fix login', ready, { ...ready, setup: { ...bg, wait: true } })).toBeNull()
  })
})
