/**
 * Playwright browser test: SessionPill real-time mode change.
 *
 * The pill lives on the /tasks table's Session column (Home task rows have shown a
 * status dot instead since 4fc00f92, and `tests/web/todo-panel-layout.test.ts`
 * keeps it off Home). Its label reads "Session · {Mode} · {Phase} / {Process}".
 *
 * Tests two bug scenarios:
 *
 * 1. Single-slot bug (pw-task-001 / pw-mode-test-session):
 *    Task has session_id set. Mode change event updates session_status.mode
 *    → pill should update from "Session · Bypass" → "Session · Plan".
 *
 * 2. Exec-slot bug (pw-task-exec-bug / pw-exec-bug-session):
 *    Task has exec_session_id but NO session_id (simulates broken server state
 *    where task:updated was emitted without session_id). Mode change event
 *    updates exec_session_status.mode only — pill must still show "Plan".
 *    Bug: mode prop reads session_status?.mode ?? plan_session_status?.mode,
 *    missing exec_session_status?.mode. AND the 2-slot legacy path ignores
 *    the mode prop entirely, always showing "exec".
 */
import { test, expect } from '@playwright/test'

// Session ID used in test-server seed data (the bypass session linked to pw-task-001)
const BYPASS_SESSION_ID = 'pw-mode-test-session'
const TASK_ID = 'pw-task-001'

// Exec-slot bug test constants
const EXEC_SESSION_ID = 'pw-exec-bug-session'
const EXEC_TASK_ID = 'pw-task-exec-bug'

/**
 * Inject a fake WS event by dispatching a MessageEvent on the captured WebSocket.
 */
async function injectEvent(page: import('@playwright/test').Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?')
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() })
      ws.dispatchEvent(new MessageEvent('message', { data: frame }))
    },
    { name, data },
  )
}

/**
 * Emits `session:status-changed` the way the server does now: a versioned
 * snapshot (top-level fields plus `status`, SessionStatusChangedEvent). The
 * status store drops unversioned input once it holds a versioned snapshot
 * (`applyLegacy` in session-status-store.ts), and the page hydrates one for every
 * visible session, so a bare `{ sessionId, mode }` frame would never land.
 * Starts from the server's current snapshot and bumps the revision per change.
 */
async function statusChanger(page: import('@playwright/test').Page, sessionId: string) {
  const res = await page.request.get(`/api/sessions/status?ids=${encodeURIComponent(sessionId)}`)
  expect(res.ok()).toBe(true)
  const { statuses } = await res.json() as { statuses: Record<string, Record<string, unknown>> }
  const base = statuses[sessionId]
  expect(base, `server status snapshot for ${sessionId}`).toBeTruthy()
  let revision = base.statusRevision as number
  return async (patch: { process_status: string; mode: string; activity: string }) => {
    revision += 1
    const status = { ...base, ...patch, statusRevision: revision, statusUpdatedAt: new Date().toISOString() }
    await injectEvent(page, 'session:status-changed', { ...status, status })
  }
}

/** Load Home and wait for the captured WebSocket to connect. */
async function openHomeWithSocket(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 5000 })
}

/**
 * A task's row on the /tasks table, reached the way a user reaches it: the
 * sidebar link, the column chooser to show the Session column (off by default),
 * then the table's search box to find the task among the fixture's rows.
 */
async function tasksTableRow(page: import('@playwright/test').Page, taskId: string, title: string) {
  await page.getByTestId('sidebar-core-app-tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  const table = page.getByTestId('tasks-table')
  await expect(table).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('tasks-columns-btn').click()
  const menu = page.getByTestId('tasks-columns-menu')
  await expect(menu).toBeVisible()
  await menu.locator('[data-column="session"] input').check()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await page.locator('input.tp-search').fill(title)
  const row = table.locator(`.tp-row[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('[data-col="session"]')).toHaveCount(1)
  return row
}

// ── Setup: Patch WebSocket before each test ──

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          ;(window as any).__capturedWs = this
        }
      }
    } as any
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try {
          (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]
        } catch { /* read-only */ }
      }
    }
  })
})

// ── Tests ──

test.describe('SessionPill real-time mode change', () => {
  test('bypass → plan: SessionPill text changes from "Bypass" to "Plan" on mode change event', async ({ page }) => {
    await openHomeWithSocket(page)

    // Find the SessionPill for pw-task-001 — it should show "Bypass" (bypass mode)
    const taskItem = await tasksTableRow(page, TASK_ID, 'Playwright test task')
    const pill = taskItem.locator('.task-session-pill')
    await expect(pill).toBeVisible({ timeout: 3000 })

    // Verify initial state: the mode segment is Bypass, not Plan
    await expect(pill).toContainText('Session · Bypass ·')
    await expect(pill).not.toContainText('Plan')

    // Now inject a session:status-changed event with mode: 'plan'
    // This simulates what happens when EnterPlanMode fires mid-session
    const changeStatus = await statusChanger(page, BYPASS_SESSION_ID)
    await changeStatus({ process_status: 'running', mode: 'plan', activity: 'planning' })

    // THE CRITICAL ASSERTION: SessionPill should now show "Plan" instead of "Bypass"
    await expect(pill).toContainText('Session · Plan ·')
    await expect(pill).not.toContainText('Bypass')
  })

  test('plan → bypass: SessionPill text changes from "Plan" to "Bypass" on mode change event', async ({ page }) => {
    await openHomeWithSocket(page)

    const taskItem = await tasksTableRow(page, TASK_ID, 'Playwright test task')
    const pill = taskItem.locator('.task-session-pill')
    await expect(pill).toBeVisible({ timeout: 3000 })

    // First: inject a mode change to 'plan'
    const changeStatus = await statusChanger(page, BYPASS_SESSION_ID)
    await changeStatus({ process_status: 'running', mode: 'plan', activity: 'planning' })

    // Verify it shows "Plan"
    await expect(pill).toContainText('Session · Plan ·')

    // Now inject mode change BACK to bypass
    await changeStatus({ process_status: 'running', mode: 'bypass', activity: 'implementing' })

    // Should show "Bypass" again (not "Plan")
    await expect(pill).toContainText('Session · Bypass ·')
    await expect(pill).not.toContainText('Plan')
  })
})

// ── Exec-slot bug: task has exec_session_id but NO session_id ──
//
// Reproduces the real production scenario:
//   1. Session starts → server calls linkSessionSlot (sets exec_session_id)
//      then linkSession (sets session_id), but emits task:updated with the
//      linkSessionSlot task — which has exec_session_id but NO session_id.
//   2. Browser processes task:updated: task.session_id stays undefined.
//   3. Session enters plan mode → session:status-changed fires with mode:'plan'.
//   4. matchesSingle = false (session_id !== new sessionId)
//      matchesExec = true → exec_session_status.mode = 'plan'
//   5. BUG: mode prop = session_status?.mode ?? plan_session_status?.mode
//      → misses exec_session_status?.mode, so mode stays undefined.
//   6. SessionPill 2-slot path: slotLabel = 'exec' (ignores mode prop).
//      Pill never shows "plan".
//
// Fix (both needed; today both live in TaskSessionPill, SessionPill.tsx):
//   A. The mode prop falls back to exec_session_status?.mode
//   B. A task with only exec_session_id resolves to that session (single-slot
//      path), so the label is the session's mode, never a bare "exec"

test.describe('SessionPill exec-slot mode change (missing session_id)', () => {
  test('exec-slot: SessionPill should show "Plan" when mode changes to plan via exec slot', async ({ page }) => {
    await openHomeWithSocket(page)

    // Find the task. Its seed carries no session fields, but the server links the
    // seeded pw-exec-bug-session record to it, so the row may already show a pill.
    const taskItem = await tasksTableRow(page, EXEC_TASK_ID, 'Exec slot bug task')
    const pill = taskItem.locator('.task-session-pill')

    // STEP 1: Inject task:updated simulating the BUGGY server emit from linkSessionSlot.
    // The task has exec_session_id set but NO session_id (linkSession return was ignored).
    await injectEvent(page, 'task:updated', {
      task: {
        id: EXEC_TASK_ID,
        title: 'Exec slot bug task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        project: 'Walnut',
        source: 'ms-todo',
        // exec_session_id set — but NO session_id (this is the bug)
        exec_session_id: EXEC_SESSION_ID,
        exec_session_status: { process_status: 'running', mode: 'bypass' },
        session_ids: [EXEC_SESSION_ID],
        active_session_ids: [EXEC_SESSION_ID],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    // STEP 2: The pill appears for the exec-slot session, in its mode (bypass)
    await expect(pill).toBeVisible({ timeout: 3000 })
    await expect(pill).toContainText('Session · Bypass ·')
    await expect(pill).not.toContainText('Plan')

    // STEP 3: Inject session:status-changed with mode: 'plan'
    // This simulates EnterPlanMode firing mid-session.
    const changeStatus = await statusChanger(page, EXEC_SESSION_ID)
    await changeStatus({ process_status: 'running', mode: 'plan', activity: 'planning' })

    // FIXED: pill should show "Session · Plan · …"
    // Check the mode segment "Plan ·" (not just "Plan", which "Planning" also matches)
    await expect(pill).toContainText('Session · Plan ·')
    await expect(pill).not.toContainText('Bypass')

    // Screenshot to document the passing state
    await page.screenshot({ path: 'test-results/exec-slot-pill-pass.png' })
  })
})
