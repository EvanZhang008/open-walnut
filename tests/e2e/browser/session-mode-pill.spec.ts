/**
 * Playwright browser test: SessionPill real-time mode change.
 *
 * Tests two bug scenarios:
 *
 * 1. Single-slot bug (pw-task-001 / pw-mode-test-session):
 *    Task has session_id set. Mode change event updates session_status.mode
 *    → pill should update from "session" → "plan".
 *
 * 2. Exec-slot bug (pw-task-exec-bug / pw-exec-bug-session):
 *    Task has exec_session_id but NO session_id (simulates broken server state
 *    where task:updated was emitted without session_id). Mode change event
 *    updates exec_session_status.mode only — pill must still show "plan".
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

// ── Setup: Patch WebSocket before each test ──

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (!(window as any).__capturedWs) {
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
  test('bypass → plan: SessionPill text changes from "session" to "plan" on mode change event', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Wait for WS to connect
    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    // Click "All" category tab to show all tasks (default is starred tab)
    const allTab = page.locator('.todo-panel-tab', { hasText: 'All' })
    await expect(allTab).toBeVisible({ timeout: 5000 })
    await allTab.click()
    await page.waitForTimeout(300)

    // Find the SessionPill for pw-task-001 — it should show "session" (bypass mode)
    const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
    await expect(taskItem).toBeVisible({ timeout: 5000 })

    const pill = taskItem.locator('.task-session-pill')
    await expect(pill).toBeVisible({ timeout: 3000 })

    // Verify initial state: pill should contain "session" (not "plan") since mode is bypass
    const initialText = await pill.textContent()
    expect(initialText).toContain('session')
    expect(initialText).not.toContain('plan')

    // Now inject a session:status-changed event with mode: 'plan'
    // This simulates what happens when EnterPlanMode fires mid-session
    await injectEvent(page, 'session:status-changed', {
      sessionId: BYPASS_SESSION_ID,
      taskId: TASK_ID,
      work_status: 'in_progress',
      process_status: 'running',
      mode: 'plan',
      activity: 'planning',
    })

    // Wait a moment for React to re-render
    await page.waitForTimeout(500)

    // THE CRITICAL ASSERTION: SessionPill should now show "plan" instead of "session"
    const updatedText = await pill.textContent()
    expect(updatedText).toContain('plan')
    expect(updatedText).not.toContain('session')
  })

  test('plan → bypass: SessionPill text changes from "plan" to "session" on mode change event', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    // Click "All" category tab to show all tasks (default is starred tab)
    const allTab = page.locator('.todo-panel-tab', { hasText: 'All' })
    await expect(allTab).toBeVisible({ timeout: 5000 })
    await allTab.click()
    await page.waitForTimeout(300)

    const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
    await expect(taskItem).toBeVisible({ timeout: 5000 })

    const pill = taskItem.locator('.task-session-pill')
    await expect(pill).toBeVisible({ timeout: 3000 })

    // First: inject a mode change to 'plan'
    await injectEvent(page, 'session:status-changed', {
      sessionId: BYPASS_SESSION_ID,
      taskId: TASK_ID,
      work_status: 'in_progress',
      process_status: 'running',
      mode: 'plan',
      activity: 'planning',
    })
    await page.waitForTimeout(300)

    // Verify it shows "plan"
    await expect(pill).toContainText('plan')

    // Now inject mode change BACK to bypass
    await injectEvent(page, 'session:status-changed', {
      sessionId: BYPASS_SESSION_ID,
      taskId: TASK_ID,
      work_status: 'in_progress',
      process_status: 'running',
      mode: 'bypass',
      activity: 'implementing',
    })
    await page.waitForTimeout(500)

    // Should show "session" again (not "plan")
    const finalText = await pill.textContent()
    expect(finalText).toContain('session')
    expect(finalText).not.toContain('plan')
  })
})

// ── Exec-slot bug: task has exec_session_id but NO session_id ──
//
// Root cause: when a new session starts, the server emits task:updated with the
// task returned by linkSessionSlot (has exec_session_id but NO session_id).
// linkSession is called but its return value is ignored.
// Result in browser: task.session_id stays undefined → legacy 2-slot path used.
//
// Bug #1 (frontend): mode prop = session_status?.mode ?? plan_session_status?.mode
//   → misses exec_session_status?.mode
// Bug #2 (frontend): 2-slot path's slotLabel = 'exec' regardless of mode prop
//
// Both bugs must be fixed for this test to pass.

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
// Fix (both needed):
//   A. TodoPanel: add ?? task.exec_session_status?.mode to mode prop
//   B. SessionPill: in exec-only 2-slot path, use mode prop for slotLabel

test.describe('SessionPill exec-slot mode change (missing session_id)', () => {
  test('exec-slot: SessionPill should show "plan" when mode changes to plan via exec slot', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    // Click "All" category tab
    const allTab = page.locator('.todo-panel-tab', { hasText: 'All' })
    await expect(allTab).toBeVisible({ timeout: 5000 })
    await allTab.click()
    await page.waitForTimeout(300)

    // Find the task — initially it has NO sessions
    const taskItem = page.locator('.todo-panel-item', { hasText: 'Exec slot bug task' })
    await expect(taskItem).toBeVisible({ timeout: 5000 })

    // STEP 1: Inject task:updated simulating the BUGGY server emit from linkSessionSlot.
    // The task has exec_session_id set but NO session_id (linkSession return was ignored).
    await injectEvent(page, 'task:updated', {
      task: {
        id: EXEC_TASK_ID,
        title: 'Exec slot bug task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        // exec_session_id set — but NO session_id (this is the bug)
        exec_session_id: EXEC_SESSION_ID,
        exec_session_status: { work_status: 'in_progress', process_status: 'running', mode: 'bypass' },
        session_ids: [EXEC_SESSION_ID],
        active_session_ids: [EXEC_SESSION_ID],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    await page.waitForTimeout(300)

    // STEP 2: Verify pill now shows "exec" — 2-slot legacy path (no session_id)
    const pill = taskItem.locator('.task-session-pill')
    await expect(pill).toBeVisible({ timeout: 3000 })
    const initialText = await pill.textContent()
    expect(initialText).toContain('exec')
    expect(initialText).not.toContain('plan')

    // STEP 3: Inject session:status-changed with mode: 'plan'
    // This simulates EnterPlanMode firing mid-session.
    await injectEvent(page, 'session:status-changed', {
      sessionId: EXEC_SESSION_ID,
      taskId: EXEC_TASK_ID,
      work_status: 'in_progress',
      process_status: 'running',
      mode: 'plan',
      activity: 'planning',
    })

    await page.waitForTimeout(500)

    // FIXED: pill should show "plan · planning / live"
    // Fix A (TodoPanel): mode prop now reads exec_session_status?.mode as fallback
    // Fix B (SessionPill): exec-only 2-slot path uses mode prop for slotLabel
    const updatedText = await pill.textContent()
    // Specifically check the label prefix "plan ·" (not just "plan" which could match "planning")
    expect(updatedText).toContain('plan ·')
    expect(updatedText).not.toContain('exec ·')

    // Screenshot to document the passing state
    await page.screenshot({ path: 'test-results/exec-slot-pill-pass.png' })
  })
})
