/**
 * The words a setup or teardown run reads with (web/src/components/workspaces/
 * script-run-text.ts) and the role tags of a script (ProjectScriptsDialog).
 */
import { describe, expect, it } from 'vitest'
import { durationText, scriptRunStatus, scriptSourceText } from '../../web/src/components/workspaces/script-run-text'
import { workspacePill, workspaceStateLabel } from '../../web/src/components/workspaces/workspace-text'
import type { TaskWorkspace, WorkspaceScriptRun } from '../../src/core/workspaces/types'

const base: WorkspaceScriptRun = { name: 'Install', command: 'bun install', source: 'walnut.json', state: 'running', started_at: '2026-11-04T10:00:00.000Z' }

describe('script run words', () => {
  it('says how a run went, with how long it took', () => {
    expect(scriptRunStatus(base)).toBe('Running…')
    expect(scriptRunStatus({ ...base, state: 'done', ended_at: '2026-11-04T10:00:42.400Z' })).toBe('Done in 42s')
    expect(scriptRunStatus({ ...base, state: 'done', ended_at: '2026-11-04T10:02:05.000Z' })).toBe('Done in 2m 5s')
    expect(scriptRunStatus({ ...base, state: 'done' })).toBe('Done')
    expect(scriptRunStatus({ ...base, state: 'failed', error: 'exited with code 1' })).toBe('Failed: exited with code 1')
    expect(scriptRunStatus({ ...base, state: 'skipped', error: 'the daemon needs an update' })).toBe('Did not run: the daemon needs an update')
    expect(scriptRunStatus({ ...base, state: 'skipped', untrusted: true, error: 'not allowed' })).toBe('Needs your OK')
  })
  it('durations and sources', () => {
    expect(durationText(0)).toBe('0s')
    expect(durationText(120)).toBe('2m')
    expect(scriptSourceText('project')).toBe("project's scripts")
    expect(scriptSourceText('walnut.json')).toBe('walnut.json')
  })
})

describe('workspace words while a script runs', () => {
  const ws: TaskWorkspace = { provider: 'git-worktree', host: '__local__', anchor: '/r/web', root: '/w/web/x', cwd: '/w/web/x', repos: [], state: 'ready' }

  it('a running cleanup shows on the pill and the label, over a done setup', () => {
    const cleaning: TaskWorkspace = { ...ws, setup: { ...base, state: 'done' }, teardown: { ...base, name: 'Down', state: 'running' } }
    expect(workspacePill(cleaning)).toMatchObject({ text: 'Running cleanup', tone: 'busy' })
    expect(workspaceStateLabel(cleaning)).toBe('Running cleanup…')
    expect(workspacePill({ ...cleaning, state: 'kept', kept_reason: 'x' })).toMatchObject({ text: 'Running cleanup', tone: 'busy' })
    // Once it ended, the workspace's own state shows again.
    expect(workspacePill({ ...cleaning, teardown: { ...base, name: 'Down', state: 'done' } })).toMatchObject({ text: 'Worktree', tone: 'ok' })
    // A failed cleanup stays on the row, even once the workspace is gone.
    expect(workspacePill({ ...cleaning, state: 'kept', teardown: { ...base, name: 'Down', state: 'failed' } })).toMatchObject({ text: 'Cleanup failed', tone: 'warn' })
    expect(workspacePill({ ...cleaning, state: 'removed', teardown: { ...base, name: 'Down', state: 'failed' } })).toMatchObject({ text: 'Cleanup failed', tone: 'warn' })
    expect(workspacePill({ ...cleaning, state: 'removed' })).toBeNull()
    // Reopened and in use again: its own state, not the old cleanup's.
    expect(workspacePill({ ...cleaning, setup: { ...base, state: 'failed' }, teardown: { ...base, name: 'Down', state: 'failed' } })).toMatchObject({ text: 'Setup failed', tone: 'error' })
  })

  it('a running setup reads busy, a failed one an error', () => {
    expect(workspacePill({ ...ws, setup: base })).toMatchObject({ text: 'Running setup', tone: 'busy' })
    expect(workspacePill({ ...ws, setup: { ...base, state: 'failed' } })).toMatchObject({ text: 'Setup failed', tone: 'error' })
    expect(workspacePill({ ...ws, setup: { ...base, state: 'skipped', untrusted: true } })).toMatchObject({ text: 'Setup needs your OK', tone: 'warn' })
    const held = workspacePill({ ...ws, setup: { ...base, state: 'failed' }, pending_start: { via: 'quick-start', message: 'go', at: 'now' } })!
    expect(held.title).toMatch(/The session waits/)
    expect(workspaceStateLabel({ ...ws, setup: { ...base, state: 'failed' } })).toBe('Setup failed')
  })
})
