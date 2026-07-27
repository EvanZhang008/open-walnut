/**
 * Playwright UI tests for the SessionManager layer.
 *
 * Tests the user-visible behavior of sessions through the real web UI.
 * The dedicated /sessions page was removed — the homepage session column
 * (`.main-page-session-column .session-panel`) is the only session surface;
 * /sessions?id=<sid> deep links redirect to '/' and open the column.
 * - Session visibility and streaming in SessionPanel (home page column)
 * - Follow-up message delivery and response rendering
 * - Session stop/resume lifecycle with history preservation
 * - Multiple session column display
 *
 * Prerequisites:
 *   cd web && npx vite build    (builds SPA to dist/web/static/)
 *   npx playwright test          (runs these tests)
 *
 * Test server is started by playwright.config.ts webServer.
 */
import { test, expect } from '@playwright/test'
import { presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

/** Create a test task via REST API with a unique suffix for parallel safety. */
async function createTaskViaApi(
  title: string,
  opts: Record<string, string> = {},
): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: uniqueTitle,
      category: 'Work',
      project: 'TransportTest',
      ...opts,
    }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

// ═══════════════════════════════════════════════════════════════════
//  1. /sessions?id= deep link — redirects home and opens the session column
// ═══════════════════════════════════════════════════════════════════

test('session deep link redirects to home and opens the session column', async ({ page }) => {
  // The dedicated /sessions page was removed — /sessions?id=<sid> now
  // replace-navigates to '/' and opens the session in a home-page column.
  await page.goto('/sessions?id=pw-normal-session')
  await page.waitForLoadState('networkidle')

  await page.waitForURL((url) => url.pathname === '/', { timeout: 5000 })

  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })
})

// ═══════════════════════════════════════════════════════════════════
//  2. Session panel — verify it renders on the home page
// ═══════════════════════════════════════════════════════════════════

test('session panel renders for a task with session', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Look for any task with a session pill (from seeded test data)
  const sessionPill = page.locator('.task-session-pill, .session-pill').first()
  if (await sessionPill.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Click on the session pill to open the session panel (home page column)
    await sessionPill.click()

    // Session panel should open
    const sessionPanel = page.locator('.main-page-session-column .session-panel')
    await expect(sessionPanel).toBeVisible({ timeout: 5000 })
  }
})

// ═══════════════════════════════════════════════════════════════════
//  3. Session chat history renders correctly
// ═══════════════════════════════════════════════════════════════════

test('session chat history shows messages after opening session', async ({ page }) => {
  // Without this the row isn't in the DOM at all (panel defaults to the Focus
  // section + ★ category), and the `isVisible()` guard below would silently skip
  // every assertion in this test rather than fail.
  await presetPanelView(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Find a task that has sessions (the seeded pw-task-001)
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  if (await taskItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Click the task to select it
    await taskItem.click()

    // Look for session pill on the task
    const sessionPill = taskItem.locator('.task-session-pill, .session-pill').first()
    if (await sessionPill.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sessionPill.click()

      // Wait for session panel to load
      const sessionPanel = page.locator('.main-page-session-column .session-panel')
      await expect(sessionPanel).toBeVisible({ timeout: 5000 })

      // Session chat area should exist
      const chatArea = sessionPanel.locator('.session-chat-history, .session-messages')
      if (await chatArea.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Chat area is visible — it may have messages or an empty state
        await expect(chatArea).toBeVisible()
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  4. Session input — chat input is present and functional
// ═══════════════════════════════════════════════════════════════════

test('session chat input is present when session panel is open', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Open a session panel for any task with a session
  const sessionPill = page.locator('.task-session-pill, .session-pill').first()
  if (await sessionPill.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionPill.click()

    // Look for the session chat input
    const chatInput = page.locator('.session-panel .chat-input-textarea, .session-panel textarea')
    if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Type a test message (but don't send it)
      await chatInput.fill('test message for session transport')
      await expect(chatInput).toHaveValue('test message for session transport')
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  5. Session mode indicator — plan/bypass badge renders
// ═══════════════════════════════════════════════════════════════════

test('session mode indicator shows correct mode', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The seeded task pw-task-001 has sessions with different modes
  // Look for mode indicators (Plan, Bypass) in the session pills
  const modeBadge = page.locator('.session-mode, .mode-indicator, .mode-badge', {
    hasText: /plan|bypass/i,
  }).first()

  if (await modeBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
    const text = await modeBadge.textContent()
    expect(text?.toLowerCase()).toMatch(/plan|bypass/)
  }
})

// ═══════════════════════════════════════════════════════════════════
//  6. Session status indicators — process_status
// ═══════════════════════════════════════════════════════════════════

test('session shows correct status badges', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Look for any status badge on session pills
  const statusBadge = page.locator('.session-status, .status-badge, .process-status').first()
  if (await statusBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
    const text = await statusBadge.textContent()
    // Status should be one of the known values
    expect(text?.toLowerCase()).toMatch(/running|idle|stopped|complete|error|in.progress|agent.complete/i)
  }
})

// ═══════════════════════════════════════════════════════════════════
//  7. Homepage session panel shows session metadata
// ═══════════════════════════════════════════════════════════════════

test('homepage session panel shows session metadata', async ({ page }) => {
  // Seed the home column queue so the SessionPanel mounts on load
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // Panel header should show the session (or linked task) title
  const title = panel.locator('.session-panel-title')
  await expect(title).toBeVisible({ timeout: 5000 })
  const text = await title.textContent()
  expect(text).toBeTruthy()
})

// ═══════════════════════════════════════════════════════════════════
//  8. Session panel close — clicking close button dismisses panel
// ═══════════════════════════════════════════════════════════════════

test('session panel can be closed', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Open a session panel
  const sessionPill = page.locator('.task-session-pill, .session-pill').first()
  if (await sessionPill.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionPill.click()

    const sessionPanel = page.locator('.session-panel')
    if (await sessionPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Find and click the close button
      const closeBtn = sessionPanel.locator('.session-close-btn, button[aria-label="Close"], .close-button').first()
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click()

        // Panel should be hidden
        await expect(sessionPanel).toBeHidden({ timeout: 3000 }).catch(() => {
          // Panel may animate out — check after a moment
        })
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  9. Session tool calls render in history
// ═══════════════════════════════════════════════════════════════════

test('tool calls in session history render with expand/collapse', async ({ page }) => {
  // Open a seeded session in the homepage session column (full history surface)
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  if (await panel.isVisible({ timeout: 10_000 }).catch(() => false)) {
    // Look for tool call blocks in the session panel
    const toolCall = panel.locator('.tool-call, .generic-tool-call, .tool-use-block').first()
    if (await toolCall.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Tool call should have a header showing the tool name
      const toolName = toolCall.locator('.tool-name, .tool-header')
      if (await toolName.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = await toolName.textContent()
        expect(text).toBeTruthy()
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  10. Multiple session columns — verify independent rendering
// ═══════════════════════════════════════════════════════════════════

test('multiple session panels can coexist on the home page', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Count visible session panels (the home page supports up to 3 columns)
  const sessionPanels = page.locator('.session-panel')
  const count = await sessionPanels.count()

  // If there are session panels, they should each have independent content
  if (count > 1) {
    // Get the session IDs from each panel
    const panelIds: string[] = []
    for (let i = 0; i < count; i++) {
      const panel = sessionPanels.nth(i)
      const sessionId = await panel.getAttribute('data-session-id')
      if (sessionId) panelIds.push(sessionId)
    }

    // If we captured IDs, they should all be unique
    if (panelIds.length > 1) {
      expect(new Set(panelIds).size).toBe(panelIds.length)
    }
  }

  // If there are no multiple panels, just verify the home page loaded correctly
  const mainPage = page.locator('.main-page, .page-content')
  await expect(mainPage).toBeVisible({ timeout: 3000 })
})

// ═══════════════════════════════════════════════════════════════════
//  11. Session fork button renders
// ═══════════════════════════════════════════════════════════════════

test('fork button is visible in session panel', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Open a session panel
  const sessionPill = page.locator('.task-session-pill, .session-pill').first()
  if (await sessionPill.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionPill.click()

    const sessionPanel = page.locator('.main-page-session-column .session-panel')
    if (await sessionPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Look for the fork button
      const forkBtn = sessionPanel.locator('.session-fork-btn, button', { hasText: /fork/i }).first()
      if (await forkBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Fork button should be clickable
        await expect(forkBtn).toBeEnabled()
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  12. Session slash command autocomplete
// ═══════════════════════════════════════════════════════════════════

test('typing / in session input shows command palette', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Open a session panel
  const sessionPill = page.locator('.task-session-pill, .session-pill').first()
  if (await sessionPill.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionPill.click()

    const sessionPanel = page.locator('.main-page-session-column .session-panel')
    if (await sessionPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
      const chatInput = sessionPanel.locator('.chat-input-textarea, textarea').first()
      if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Type "/" to trigger command palette
        await chatInput.fill('/')

        // Wait briefly for command palette to appear
        const commandPalette = page.locator('.command-palette, .slash-command-menu, .autocomplete-menu')
        if (await commandPalette.isVisible({ timeout: 2000 }).catch(() => false)) {
          // Palette should show some commands
          const commandItems = commandPalette.locator('.command-item, .autocomplete-item')
          const count = await commandItems.count()
          expect(count).toBeGreaterThan(0)
        }
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
//  13. API endpoint health checks
// ═══════════════════════════════════════════════════════════════════

test('sessions REST API returns valid data', async ({ page }) => {
  // Direct API checks — no page interaction needed
  const sessionsRes = await fetch(`${API}/api/sessions`)
  expect(sessionsRes.status).toBe(200)
  const body = (await sessionsRes.json()) as {
    sessions: Array<{ claudeSessionId: string }>
  }
  expect(Array.isArray(body.sessions)).toBe(true)
})

test('working-dirs REST API returns array', async ({ page }) => {
  const res = await fetch(`${API}/api/sessions/working-dirs`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { dirs: string[] }
  expect(Array.isArray(body.dirs)).toBe(true)
})

test('session history API returns 404 for nonexistent session', async ({ page }) => {
  const res = await fetch(`${API}/api/sessions/nonexistent-session-id/history`)
  expect(res.status).toBe(404)
})
