/**
 * E2E: start a REAL Claude Code session from the /notes tree context menu.
 *
 *  1. Right-click a note → "Start Claude Code session" appears (not on attachments).
 *  2. Clicking it opens the chat column in "Claude Code" mode with mode tabs.
 *  3. The quick-start request targets the notes vault (cwd = notesDir) with an
 *     EMPTY message (init-only spawn — no auto first turn).
 *  4. Once the session links (task:updated), the pending shell hands off to the
 *     REAL <SessionPanel> — the same rich UI as the home-page session columns.
 *  5. The session SURVIVES a page reload (persisted until explicitly closed).
 *
 * Uses the REAL pipeline: quick-start REST → SESSION_START → MockDaemon spawns
 * the mock Claude CLI → real WS stream + JSONL history (same infra as
 * single-timeline-real-pipeline.spec.ts).
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'
const NOTE = 'CCTest/Session Note.md'

async function seedNote() {
  await fetch(`${API}/api/notes-v2/content/${NOTE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Session Note\n\nbody\n' }),
  })
}

async function gotoNotes(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
}

test('right-click note → Start Claude Code session → full SessionPanel, per-session tabs, survives reload', async ({ page }) => {
  await seedNote()
  await gotoNotes(page)
  // Fresh state — persisted CC tabs from another spec run were already read
  // into React state at mount, so clear the keys AND reload.
  await page.evaluate(() => {
    localStorage.removeItem('open-walnut-notes-cc-session')
    localStorage.removeItem('open-walnut-notes-chat-mode')
  })
  await page.reload()
  await page.waitForLoadState('networkidle')

  // Capture the quick-start request body to assert cwd + message targeting.
  let quickStartBody: { cwd?: string; message?: string } | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    quickStartBody = route.request().postDataJSON() as { cwd?: string; message?: string }
    await route.continue()
  })

  // Expand the folder, right-click the note. Exclude Recent/Bookmark rows —
  // they share .notes-tree-file and a prior run's recents (synced via server
  // ui-prefs) would otherwise shadow the real tree node.
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  const file = page.locator('.notes-tree-file:not(.notes-bookmark-row)', { hasText: 'Session Note' })
  if (!(await file.isVisible().catch(() => false))) await folderEl.click()
  await file.click({ button: 'right' })

  const menuItem = page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' })
  await expect(menuItem).toBeVisible()
  const clickedAt = Date.now()
  await menuItem.click()

  // PERCEIVED-INSTANT: the full chat shell (pane + tabs + ENABLED input) is
  // interactive well under 500ms — no blank spinner phase. The session tab is
  // named after the note it was started from.
  const tabs = page.locator('.notes-chat-mode-tabs')
  await expect(tabs).toBeVisible({ timeout: 2000 })
  await expect(page.locator('.notes-session-chat .chat-input-textarea')).toBeVisible({ timeout: 2000 })
  const shellReadyMs = Date.now() - clickedAt
  expect(shellReadyMs).toBeLessThan(500)
  const ccTab = tabs.locator('.notes-chat-cc-tab', { hasText: 'Session Note' })
  await expect(ccTab).toHaveClass(/active/)

  // The clicked note also opened in the editor (pane and target move together).
  await expect(page.locator('.notes-tab', { hasText: 'Session Note' })).toBeVisible()

  // Quick-start targeted the vault with an EMPTY message — init-only spawn,
  // no auto first turn.
  await expect.poll(() => quickStartBody).not.toBeNull()
  expect(quickStartBody!.cwd).toBeTruthy()
  expect(quickStartBody!.message).toBe('')

  // The session links (mock CLI) → the pending shell hands off to the REAL
  // SessionPanel: same rich UI as home-page session columns (header chips,
  // close button, its own input).
  const panel = page.locator('.notes-chat-pane .session-panel')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.notes-session-chat')).toHaveCount(0)
  await expect(panel.locator('.chat-input-textarea')).toBeVisible()
  await expect(panel.locator('.session-panel-close')).toBeVisible()

  // ── SECOND SESSION → its own tab; the first stays reachable. ──
  await file.click({ button: 'right' })
  await page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }).click()
  await expect(tabs.locator('.notes-chat-cc-tab')).toHaveCount(2)
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible({ timeout: 30_000 })
  // Switch back to the FIRST session's tab — its panel renders again.
  await tabs.locator('.notes-chat-cc-tab').first().click()
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible()

  // ── SURVIVES RELOAD: both tabs + the active one are persisted. ──
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab')).toHaveCount(2)
  await expect(page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab').first()).toHaveClass(/active/)

  // Tabs switch back to the built-in agent without losing the session tabs.
  await page.locator('.notes-chat-mode-tabs .notes-chat-mode-tab', { hasText: 'Note Agent' }).click()
  await expect(page.locator('.notes-chat-pane .session-panel')).toHaveCount(0)
  await expect(page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab')).toHaveCount(2)

  // EXPLICIT close (tab ×) both sessions → pane returns to the agent and the
  // persisted state is cleared (a reload must NOT resurrect them).
  await page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab-close').first().click()
  await expect(page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab')).toHaveCount(1)
  await page.locator('.notes-chat-mode-tabs .notes-chat-cc-tab-close').click()
  await expect(page.locator('.notes-chat-mode-tabs')).toHaveCount(0)
  const persisted = await page.evaluate(() => localStorage.getItem('open-walnut-notes-cc-session'))
  expect(persisted).toBeNull()
})

test('attachments do not offer Start Claude Code session', async ({ page }) => {
  // Upload an attachment next to the seeded note (vault _attachment convention).
  await seedNote()
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await fetch(`${API}/api/notes-v2/attachment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notePath: NOTE, data: png1x1, mediaType: 'image/png' }),
  })
  await gotoNotes(page)

  // Folder expansion state persists (server-synced ui-prefs) — a blind click
  // on an already-expanded folder COLLAPSES it. Only click when the child
  // isn't visible yet.
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  const attachFolder = page.locator('.notes-tree-folder', { hasText: '_attachment' })
  if (!(await attachFolder.isVisible().catch(() => false))) await folderEl.click()
  const attachment = page.locator('.notes-tree-file.notes-tree-attachment, .notes-tree-file', { hasText: '.png' }).first()
  if (!(await attachment.isVisible().catch(() => false))) await attachFolder.click()
  await attachment.click({ button: 'right' })

  await expect(page.locator('.notes-context-menu')).toBeVisible()
  await expect(
    page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }),
  ).toHaveCount(0)
})
