/**
 * The pure rules of test-run objects (src/core/test-run.ts, src/core/test-run-sweep.ts): the
 * label a header may carry, which servers mark at all, what a test viewer is served, which
 * projects a list shows, and what the sweep picks. The live behaviour is pinned through a real
 * server in tests/e2e/test-run-objects.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  TEST_RUN_OWNER, isTestRunProject, isTestRunTask, listedProjects, parseTestRunLabel,
  testRunMarkingEnabled, testRunProjectMetadata, unmarkForTestViewer, withTestRun, resetTestRunForTesting,
} from '../../src/core/test-run.js'
import { pickExpiredTestProjects, pickExpiredTestTasks, testRunIdleMs } from '../../src/core/test-run-sweep.js'
import type { ProjectRecord, Task } from '../../src/core/types.js'

const HOUR = 3_600_000

function task(over: Partial<Task>): Task {
  return { id: 'x', title: 't', status: 'todo', phase: 'TODO', priority: 'none', project: '', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z', ...over } as Task
}

describe('parseTestRunLabel', () => {
  it('keeps a printable label up to 60 characters and refuses empty or off values', () => {
    expect(parseTestRunLabel('org-chart')).toBe('org-chart')
    expect(parseTestRunLabel(['first', 'second'])).toBe('first')
    expect(parseTestRunLabel('  aéb\n ')).toBe('ab')
    expect(parseTestRunLabel('x'.repeat(80))).toHaveLength(60)
    for (const off of [undefined, null, '', '   ', '0', 'false', 'FALSE', 42]) expect(parseTestRunLabel(off)).toBeUndefined()
  })
})

describe('testRunMarkingEnabled', () => {
  it('is off on the test runner, and the flag wins either way', async () => {
    resetTestRunForTesting()
    expect(await testRunMarkingEnabled({ VITEST: 'true' })).toBe(false)
    expect(await testRunMarkingEnabled({ WALNUT_TEST_RUN_MARK: '1', VITEST: 'true' })).toBe(true)
    expect(await testRunMarkingEnabled({ WALNUT_TEST_RUN_MARK: '0' })).toBe(false)
    resetTestRunForTesting()
  })
})

describe('what a test viewer and a list see', () => {
  it('a test viewer gets a test task without its marker; other kept tasks stay as they are', () => {
    const t = task({ plugin_only: TEST_RUN_OWNER })
    expect(isTestRunTask(t)).toBe(true)
    expect(unmarkForTestViewer(t).plugin_only).toBeUndefined()
    const plugin = task({ plugin_only: 'keeper' })
    expect(unmarkForTestViewer(plugin)).toBe(plugin)
    expect(isTestRunTask(plugin)).toBe(false)
  })

  it('a list leaves out a test project unless real work lives in it or the reader is the test run', () => {
    const projects: Record<string, ProjectRecord> = {
      Real: { source: 'local' },
      Probe: { source: 'local', metadata: testRunProjectMetadata('probe') },
      Used: { source: 'local', metadata: testRunProjectMetadata('probe') },
    }
    expect(isTestRunProject(projects.Probe)).toBe(true)
    expect(isTestRunProject(projects.Real)).toBe(false)
    expect(Object.keys(listedProjects(projects, (n) => n === 'Used'))).toEqual(['Real', 'Used'])
    expect(Object.keys(withTestRun('probe', () => listedProjects(projects)))).toEqual(['Real', 'Probe', 'Used'])
  })
})

describe('the sweep picks', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z')

  it('test tasks idle past the window, counting session activity, never Main or real work', () => {
    const old = '2026-10-27T05:00:00.000Z'
    const tasks = [
      task({ id: 'idle', plugin_only: TEST_RUN_OWNER, created_at: old, updated_at: old }),
      task({ id: 'busy-session', plugin_only: TEST_RUN_OWNER, created_at: old, updated_at: old, last_session_update: '2026-10-27T11:00:00.000Z' }),
      task({ id: 'fresh', plugin_only: TEST_RUN_OWNER, created_at: '2026-10-27T10:00:00.000Z', updated_at: '2026-10-27T10:00:00.000Z' }),
      task({ id: 'real', created_at: old, updated_at: old }),
      task({ id: 'plugin', plugin_only: 'keeper', created_at: old, updated_at: old }),
      task({ id: 'main', plugin_only: TEST_RUN_OWNER, org_role: 'main', created_at: old, updated_at: old }),
    ]
    expect(pickExpiredTestTasks(tasks, now, 6 * HOUR).map((t) => t.id)).toEqual(['idle'])
  })

  it('keeps a test task real work still hangs on: a real task under it, a real project it leads', () => {
    const old = '2026-10-27T05:00:00.000Z'
    const tasks = [
      task({ id: 'parent', plugin_only: TEST_RUN_OWNER, created_at: old, updated_at: old }),
      task({ id: 'adopted', parent_task_id: 'parent' }),
      task({ id: 'vp', plugin_only: TEST_RUN_OWNER, org_role: 'lead', org_leads: ['Garden'], created_at: old, updated_at: old }),
      task({ id: 'garden-work', project: 'Garden' }),
      task({ id: 'test-child-only', plugin_only: TEST_RUN_OWNER, created_at: old, updated_at: old }),
      task({ id: 'test-kid', plugin_only: TEST_RUN_OWNER, parent_task_id: 'test-child-only', created_at: old, updated_at: old }),
    ]
    expect(pickExpiredTestTasks(tasks, now, 6 * HOUR).map((t) => t.id)).toEqual(['test-child-only', 'test-kid'])
  })

  it('test projects that are empty and marked long enough ago', () => {
    const at = (iso: string) => ({ source: 'local' as const, metadata: { test_run: { label: 'p', at: iso } } })
    const projects: Record<string, ProjectRecord> = {
      Empty: at('2026-10-27T01:00:00.000Z'),
      Busy: at('2026-10-27T01:00:00.000Z'),
      Young: at('2026-10-27T11:00:00.000Z'),
      Real: { source: 'local' },
    }
    expect(pickExpiredTestProjects(projects, [{ project: 'busy' }], now, 6 * HOUR)).toEqual(['Empty'])
  })

  it('the window is WALNUT_TEST_RUN_TTL_HOURS, default 6', () => {
    expect(testRunIdleMs({})).toBe(6 * HOUR)
    expect(testRunIdleMs({ WALNUT_TEST_RUN_TTL_HOURS: '2' })).toBe(2 * HOUR)
    expect(testRunIdleMs({ WALNUT_TEST_RUN_TTL_HOURS: 'nope' })).toBe(6 * HOUR)
  })
})

describe('the test-run scope', () => {
  it('ends with its request: work left armed inside it is not the test run\'s', async () => {
    const { ambientTestRun } = await import('../../src/core/test-run.js')
    let open = true
    let seenLater: string | undefined = 'unset'
    await withTestRun('probe', async () => {
      expect(ambientTestRun()).toBe('probe')
      await new Promise<void>((resolve) => {
        setTimeout(() => { seenLater = ambientTestRun(); resolve() }, 20)
        open = false // the answer went out before the timer fired
      })
    }, () => open)
    expect(seenLater).toBeUndefined()
    expect(ambientTestRun()).toBeUndefined()
  })
})
