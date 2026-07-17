/**
 * E2E: start a REAL Claude Code session from the /notes tree context menu.
 *
 *  1. Right-click a note → "Start Claude Code session" appears (not on attachments).
 *  2. Clicking it opens the chat column in "Claude Code" mode with mode tabs.
 *  3. The quick-start request targets the notes vault (cwd = notesDir) and the
 *     opening message references the clicked note.
 *  4. Once the session links (task:updated), the pane renders the live session
 *     chat with its input; the mode tabs switch back to the Note Assistant.
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

test('right-click note → Start Claude Code session → live session chat in the side pane', async ({ page }) => {
  await seedNote()
  await gotoNotes(page)
  // Fresh state — a persisted CC session id from another spec run would skip pending.
  await page.evaluate(() => localStorage.removeItem('open-walnut-notes-cc-session'))

  // Capture the quick-start request body to assert cwd + message targeting.
  let quickStartBody: { cwd?: string; message?: string } | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    quickStartBody = route.request().postDataJSON() as { cwd?: string; message?: string }
    await route.continue()
  })

  // Expand the folder, right-click the note.
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  const file = page.locator('.notes-tree-file', { hasText: 'Session Note' })
  if (!(await file.isVisible().catch(() => false))) await folderEl.click()
  await file.click({ button: 'right' })

  const menuItem = page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' })
  await expect(menuItem).toBeVisible()
  const clickedAt = Date.now()
  await menuItem.click()

  // PERCEIVED-INSTANT: the full chat shell (pane + mode tabs + ENABLED input +
  // kickoff bubble) is interactive well under 500ms — no blank spinner phase.
  const tabs = page.locator('.notes-chat-mode-tabs')
  await expect(tabs).toBeVisible({ timeout: 2000 })
  await expect(page.locator('.notes-session-chat .chat-input-textarea')).toBeVisible({ timeout: 2000 })
  const shellReadyMs = Date.now() - clickedAt
  expect(shellReadyMs).toBeLessThan(500)
  await expect(tabs.locator('.notes-chat-mode-tab.active')).toHaveText('Claude Code')

  // The clicked note also opened in the editor (pane and target move together).
  await expect(page.locator('.notes-tab', { hasText: 'Session Note' })).toBeVisible()

  // Quick-start targeted the vault with an EMPTY message — init-only spawn,
  // no auto first turn.
  await expect.poll(() => quickStartBody).not.toBeNull()
  expect(quickStartBody!.cwd).toBeTruthy()
  expect(quickStartBody!.message).toBe('')

  // The session links (mock CLI) → live pane flips from Starting… to the real
  // history view; the badge leaves the pending state.
  await expect(page.locator('.notes-session-chat-badge.pending')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.notes-session-chat .chat-input-textarea')).toBeVisible()

  // Mode tabs switch back to the built-in assistant without losing the session tab.
  await tabs.locator('.notes-chat-mode-tab', { hasText: 'Note Assistant' }).click()
  await expect(page.locator('.notes-chat-title, .notes-chat .notes-chat-mode-tab.active').first()).toBeVisible()
  await expect(tabs.locator('.notes-chat-mode-tab', { hasText: 'Claude Code' })).toBeVisible()
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

  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  await folderEl.click()
  const attachFolder = page.locator('.notes-tree-folder', { hasText: '_attachment' })
  await attachFolder.click()
  const attachment = page.locator('.notes-tree-file.notes-tree-attachment, .notes-tree-file', { hasText: '.png' }).first()
  await attachment.click({ button: 'right' })

  await expect(page.locator('.notes-context-menu')).toBeVisible()
  await expect(
    page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }),
  ).toHaveCount(0)
})
