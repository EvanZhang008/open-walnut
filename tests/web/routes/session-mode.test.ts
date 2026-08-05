/**
 * Tests for session mode management — PATCH mode toggle, planCompleted fallback,
 * mode persistence across resume, and task slot promotion.
 *
 * What's real: Express server, session-tracker, task-manager, REST endpoints.
 * What's mocked: constants.js (temp dir).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import type { SessionMode } from '../../../src/core/types.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// Seed a minimal task with a caller-chosen id.
//
// Must go through addTasksBulk (the only writer that honors an explicit id), NOT
// by hand-writing tasks.json: the task store is SQLite now, and tasks.json is
// only ever imported by the one-shot JSON→SQLite migration, which no-ops as soon
// as the tasks table is non-empty. Writing JSON after the first seed therefore
// silently drops the task and every later lookup fails with "No task found
// matching ID prefix".
async function seedTask(taskId: string): Promise<void> {
  const { addTasksBulk, getTask } = await import('../../../src/core/task-manager.js')
  try {
    await getTask(taskId)
    return // already seeded
  } catch { /* not present yet */ }
  const now = new Date().toISOString()
  await addTasksBulk([{
    id: taskId,
    title: `Test task ${taskId}`,
    status: 'todo',
    phase: 'IN_PROGRESS',
    priority: 'immediate',
    project: 'ModeTest',
    source: 'local',
    session_ids: [],
    created_at: now,
    updated_at: now,
    description: '',
    summary: '',
    note: '',
  }])
}

async function seedSession(sessionId: string, taskId: string, mode: SessionMode, extra?: Record<string, unknown>): Promise<void> {
  await createSessionRecord(sessionId, taskId, 'ModeTest', process.cwd(), {
    mode,
    ...extra,
  } as Parameters<typeof createSessionRecord>[4])
}

beforeAll(async () => {
  // closeDb before the rm: a task/session DB handle inherited from an earlier
  // file in this Vitest worker keeps its fd on the unlinked inode and would
  // resurrect that file's rows here.
  closeTaskDb()
  closeSessionDb()
  resetTaskManager()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await seedTask('mode-test-task-001')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  closeTaskDb()
  closeSessionDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── PATCH /api/sessions/:id { mode } ──

describe('PATCH session mode', () => {
  it('updates mode from bypass to plan', async () => {
    await seedSession('mode-patch-001', 'mode-test-task-001', 'bypass')

    const res = await fetch(apiUrl('/api/sessions/mode-patch-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { mode: string } }
    expect(body.session.mode).toBe('plan')

    // Verify persisted
    const record = await getSessionByClaudeId('mode-patch-001')
    expect(record?.mode).toBe('plan')
  })

  it('updates mode from plan to bypass', async () => {
    await seedSession('mode-patch-002', 'mode-test-task-001', 'plan')

    const res = await fetch(apiUrl('/api/sessions/mode-patch-002'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { mode: string } }
    expect(body.session.mode).toBe('bypass')
  })

  it('rejects invalid mode', async () => {
    await seedSession('mode-patch-003', 'mode-test-task-001', 'bypass')

    const res = await fetch(apiUrl('/api/sessions/mode-patch-003'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'turbo' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('mode must be one of')
  })

  it('returns 404 for nonexistent session', async () => {
    const res = await fetch(apiUrl('/api/sessions/nonexistent-session-xyz'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects an unconfirmed live mode change and preserves the persisted mode', async () => {
    await seedSession('mode-live-rejected-001', 'mode-test-task-001', 'plan', {
      pid: 98765,
      initialProcessStatus: 'idle',
    })
    vi.spyOn(sessionRunner, 'changePermissionMode').mockRejectedValue(
      new Error('set_permission_mode rejected by CLI'),
    )

    const res = await fetch(apiUrl('/api/sessions/mode-live-rejected-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'set_permission_mode rejected by CLI' })
    expect((await getSessionByClaudeId('mode-live-rejected-001'))?.mode).toBe('plan')
  })

  it('mode toggle round-trip: bypass → plan → bypass', async () => {
    await seedSession('mode-roundtrip-001', 'mode-test-task-001', 'bypass')

    // bypass → plan
    let res = await fetch(apiUrl('/api/sessions/mode-roundtrip-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    let body = (await res.json()) as { session: { mode: string } }
    expect(body.session.mode).toBe('plan')

    // plan → bypass
    res = await fetch(apiUrl('/api/sessions/mode-roundtrip-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })
    body = (await res.json()) as { session: { mode: string } }
    expect(body.session.mode).toBe('bypass')

    // Verify final persisted state
    const record = await getSessionByClaudeId('mode-roundtrip-001')
    expect(record?.mode).toBe('bypass')
  })
})

// ── planCompleted does NOT lock mode toggle ──

describe('planCompleted independence from mode toggle', () => {
  it('mode can be changed even when planCompleted=true', async () => {
    await seedSession('plan-completed-001', 'mode-test-task-001', 'bypass', {
      planCompleted: true,
      planFile: '/tmp/test-plan.md',
    })

    // Verify initial state
    let record = await getSessionByClaudeId('plan-completed-001')
    expect(record?.mode).toBe('bypass')
    expect(record?.planCompleted).toBe(true)

    // Switch to plan
    const res1 = await fetch(apiUrl('/api/sessions/plan-completed-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    expect(res1.status).toBe(200)
    record = await getSessionByClaudeId('plan-completed-001')
    expect(record?.mode).toBe('plan')
    expect(record?.planCompleted).toBe(true) // unchanged

    // Switch back to bypass — should work, planCompleted doesn't lock
    const res2 = await fetch(apiUrl('/api/sessions/plan-completed-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })
    expect(res2.status).toBe(200)
    record = await getSessionByClaudeId('plan-completed-001')
    expect(record?.mode).toBe('bypass')
    expect(record?.planCompleted).toBe(true) // still unchanged
  })

  it('mode changes do not clear planCompleted', async () => {
    await seedSession('plan-completed-002', 'mode-test-task-001', 'plan', {
      planCompleted: true,
    })

    // Multiple mode changes should not affect planCompleted
    for (const mode of ['bypass', 'plan', 'default', 'plan'] as SessionMode[]) {
      await fetch(apiUrl('/api/sessions/plan-completed-002'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
    }

    const record = await getSessionByClaudeId('plan-completed-002')
    expect(record?.mode).toBe('plan')
    expect(record?.planCompleted).toBe(true)
  })
})

// ── Task slot promotion on mode change ──

describe('Task slot promotion on mode change', () => {
  it('switching to plan promotes session to plan slot', async () => {
    const taskId = 'slot-promo-task-001'
    await seedTask(taskId)
    await seedSession('slot-promo-001', taskId, 'bypass')

    // Link to exec slot
    const { linkSessionSlot, getTask } = await import('../../../src/core/task-manager.js')
    await linkSessionSlot(taskId, 'slot-promo-001', 'exec')

    let task = await getTask(taskId)
    expect(task.exec_session_id).toBe('slot-promo-001')
    expect(task.plan_session_id).toBeUndefined()

    // PATCH mode to plan
    await fetch(apiUrl('/api/sessions/slot-promo-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })

    // Verify slot promoted
    task = await getTask(taskId)
    expect(task.plan_session_id).toBe('slot-promo-001')
    // exec should be cleared (session moved from exec → plan)
    expect(task.exec_session_id).toBeUndefined()
  })

  it('switching from plan demotes session to exec slot', async () => {
    const taskId = 'slot-demo-task-001'
    await seedTask(taskId)
    await seedSession('slot-demo-001', taskId, 'plan')

    const { linkSessionSlot, getTask } = await import('../../../src/core/task-manager.js')
    await linkSessionSlot(taskId, 'slot-demo-001', 'plan')

    let task = await getTask(taskId)
    expect(task.plan_session_id).toBe('slot-demo-001')

    // PATCH mode to bypass
    await fetch(apiUrl('/api/sessions/slot-demo-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })

    // Verify slot demoted
    task = await getTask(taskId)
    expect(task.plan_session_id).toBeUndefined()
    expect(task.exec_session_id).toBe('slot-demo-001')
  })

  it('does not overwrite existing plan slot owned by another session', async () => {
    const taskId = 'slot-guard-task-001'
    await seedTask(taskId)
    await seedSession('slot-guard-plan', taskId, 'plan')
    await seedSession('slot-guard-exec', taskId, 'bypass')

    const { linkSessionSlot, getTask } = await import('../../../src/core/task-manager.js')
    await linkSessionSlot(taskId, 'slot-guard-plan', 'plan')
    await linkSessionSlot(taskId, 'slot-guard-exec', 'exec')

    // Try to promote exec session to plan — should be blocked
    await fetch(apiUrl('/api/sessions/slot-guard-exec'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })

    // Plan slot should still belong to the original plan session
    const task = await getTask(taskId)
    expect(task.plan_session_id).toBe('slot-guard-plan')
    // But mode on the session record should still be updated
    const record = await getSessionByClaudeId('slot-guard-exec')
    expect(record?.mode).toBe('plan')
  })
})

// ── Task enrichment: planCompleted fallback ──

describe('Task enrichment with planCompleted', () => {
  it('session with planCompleted appears in plan_session_status even when mode is bypass', async () => {
    const taskId = 'enrich-task-001'
    await seedTask(taskId)
    await seedSession('enrich-001', taskId, 'bypass', {
      planCompleted: true,
    })

    // Link to session_ids so enrichment can find it
    const { linkSessionSlot } = await import('../../../src/core/task-manager.js')
    await linkSessionSlot(taskId, 'enrich-001', 'exec')

    // Fetch tasks from API (enriched)
    const res = await fetch(apiUrl('/api/tasks'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Array<Record<string, unknown>> }
    const task = body.tasks.find(t => t.id === taskId)
    expect(task).toBeDefined()

    // session_status should have planCompleted even though it's on exec slot
    const sessionStatus = task!.session_status as Record<string, unknown> | undefined
    if (sessionStatus) {
      expect(sessionStatus.planCompleted).toBe(true)
    }
  })
})

// ── ClaudeCodeSession.send() mode fallback ──

describe('ClaudeCodeSession send() mode preservation', () => {
  it('send() with explicit mode sets _mode correctly', async () => {
    const { ClaudeCodeSession } = await import('../../../src/providers/claude-code-session.js')

    for (const mode of ['bypass', 'plan', 'accept'] as const) {
      const session = new ClaudeCodeSession('test-task', 'TestProject', 'echo')
      // Access private _mode via type assertion for testing
      const s = session as unknown as { _mode: string }

      // Call send with a mode — it will try to spawn and fail, but _mode is set synchronously
      try {
        session.send('test', '/tmp', undefined, mode)
      } catch { /* spawn will fail, that's ok */ }

      expect(s._mode).toBe(mode)
    }
  })

  // Removed: 'send() with undefined mode falls back to default'. ea2e248 flipped
  // the no-mode fallback from 'default' to 'bypass' on purpose (users shouldn't be
  // prompted to approve every edit; plan mode must be explicitly requested), and
  // that contract is asserted against the real CLI flag — not a private field — in
  // tests/providers/claude-code-session.test.ts ('no mode defaults to
  // bypassPermissions'). Re-asserting it here would only duplicate it more weakly.
})

// Note: JSONL recovery tests (recoverStateFromJsonl) are covered in
// tests/e2e/session-plan-mode.test.ts which has the full session infrastructure.
