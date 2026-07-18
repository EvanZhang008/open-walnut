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

// Serial: the Walnut Agent chat test mutates SERVER state (note-agent
// conversations) that would make the CC test's "switcher disappears when the
// last session closes" assertion racy if the tests overlapped.
test.describe.configure({ mode: 'serial' })

const API = 'http://localhost:3457'
const NOTE = 'CCTest/Session Note.md'

async function seedNote() {
  await fetch(`${API}/api/notes-v2/content/${NOTE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Session Note\n\nbody\n' }),
  })
}

// Server-side fresh state: delete leftover note-agent SIDE conversations from
// a prior (possibly aborted) run — they'd keep the switcher visible and break
// the "switcher disappears" assertions. The main conversation 409s; skip it.
async function clearNoteAgentSideChats() {
  const res = await fetch(`${API}/api/agents/note-agent/conversations`)
  if (!res.ok) return
  const { conversations } = (await res.json()) as { conversations: Array<{ id: string; isMain?: boolean }> }
  for (const c of conversations) {
    if (c.isMain) continue
    await fetch(`${API}/api/agents/note-agent/conversations/${c.id}`, { method: 'DELETE' })
  }
}

async function gotoNotes(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
}

test('right-click note → Start Claude Code session → full SessionPanel, dropdown switcher, survives reload', async ({ page }) => {
  await seedNote()
  await clearNoteAgentSideChats()
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

  // PERCEIVED-INSTANT: the full chat shell (pane + switcher + ENABLED input)
  // is interactive well under 500ms — no blank spinner phase. The switcher's
  // TITLE is the session's origin note name.
  const switcher = page.locator('.notes-chat-switcher')
  await expect(switcher).toBeVisible({ timeout: 2000 })
  await expect(page.locator('.notes-session-chat .chat-input-textarea')).toBeVisible({ timeout: 2000 })
  const shellReadyMs = Date.now() - clickedAt
  expect(shellReadyMs).toBeLessThan(500)
  await expect(switcher.locator('.notes-chat-switcher-title')).toHaveText('Session Note')
  // Origin-folder context + explicit Claude Code badge, right in the trigger.
  await expect(switcher.locator('.notes-chat-switcher-folder')).toHaveText('CCTest')
  await expect(switcher.locator('.notes-chat-switcher-badge')).toHaveText(/Claude Code/i)

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

  // ── DRAG-RESIZE: the divider tracks the mouse; width persists. ──
  const pane = page.locator('.notes-chat-pane')
  const widthBefore = (await pane.boundingBox())!.width
  const divider = page.locator('.notes-chat-divider')
  const db = (await divider.boundingBox())!
  await page.mouse.move(db.x, db.y + db.height / 2)
  await page.mouse.down()
  await page.mouse.move(db.x - 120, db.y + db.height / 2, { steps: 5 }) // drag LEFT → wider
  await page.mouse.up()
  const widthAfter = (await pane.boundingBox())!.width
  expect(widthAfter).toBeGreaterThan(widthBefore + 80)
  const persistedWidth = await page.evaluate(() => localStorage.getItem('open-walnut-notes-chat-width'))
  expect(Number(persistedWidth)).toBeGreaterThan(widthBefore + 80)

  // ── SECOND SESSION → its own dropdown entry; the first stays reachable. ──
  await file.click({ button: 'right' })
  await page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }).click()
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible({ timeout: 30_000 })
  const trigger = switcher.locator('.notes-chat-switcher-trigger')
  await trigger.click()
  const menu = page.locator('.notes-chat-switcher-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.notes-chat-switcher-item', { hasText: 'Note Agent' })).toBeVisible()
  // TWO labeled groups — the kind of chat is stated, never implied.
  await expect(menu.locator('.notes-chat-switcher-group')).toHaveText([/Walnut Agent/i, /Claude Code/i])
  await expect(menu.locator('.notes-chat-switcher-session')).toHaveCount(2)
  // Each session row shows its origin folder as a sublabel.
  await expect(menu.locator('.notes-chat-switcher-item-folder').first()).toHaveText('CCTest')
  // Switch back to the FIRST session — its panel renders again, menu closes.
  await menu.locator('.notes-chat-switcher-session').first().click()
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible()

  // ── SURVIVES RELOAD: both sessions + the active one are persisted. ──
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.notes-chat-pane .session-panel')).toBeVisible({ timeout: 15_000 })
  await trigger.click()
  await expect(page.locator('.notes-chat-switcher-menu .notes-chat-switcher-session')).toHaveCount(2)
  await expect(page.locator('.notes-chat-switcher-menu .notes-chat-switcher-session').first()).toHaveClass(/active/)

  // Dropdown switches back to the built-in agent without losing the sessions.
  await page.locator('.notes-chat-switcher-menu .notes-chat-switcher-item', { hasText: 'Note Agent' }).click()
  await expect(page.locator('.notes-chat-pane .session-panel')).toHaveCount(0)
  await expect(page.locator('.notes-chat-switcher-title')).toHaveText('Note Agent')

  // EXPLICIT close (menu row ×) both sessions → switcher disappears (agent
  // only) and persisted state is cleared (a reload must NOT resurrect them).
  await trigger.click()
  await page.locator('.notes-chat-switcher-menu .notes-chat-switcher-close').first().click()
  await expect(page.locator('.notes-chat-switcher-menu .notes-chat-switcher-session')).toHaveCount(1)
  await page.locator('.notes-chat-switcher-menu .notes-chat-switcher-close').click()
  await expect(page.locator('.notes-chat-switcher')).toHaveCount(0)
  const persisted = await page.evaluate(() => localStorage.getItem('open-walnut-notes-cc-session'))
  expect(persisted).toBeNull()
})

test('right-click note → New Note Agent chat → named deletable Walnut Agent conversation', async ({ page }) => {
  await seedNote()
  await clearNoteAgentSideChats()
  await gotoNotes(page)
  await page.evaluate(() => {
    localStorage.removeItem('open-walnut-notes-cc-session')
    localStorage.removeItem('open-walnut-notes-chat-mode')
  })
  await page.reload()
  await page.waitForLoadState('networkidle')

  // Right-click the note → the NEW agent-chat entry sits above the CC one.
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  const file = page.locator('.notes-tree-file:not(.notes-bookmark-row)', { hasText: 'Session Note' })
  if (!(await file.isVisible().catch(() => false))) await folderEl.click()
  await file.click({ button: 'right' })
  const menuItem = page.locator('.notes-context-menu button', { hasText: 'New Note Agent chat' })
  await expect(menuItem).toBeVisible()
  await menuItem.click()

  // A fresh SERVER-SIDE conversation named after the note becomes the active
  // pane: switcher trigger shows its title + the Walnut Agent badge, and the
  // pane is the agent chat (with its input), NOT a session panel.
  const switcher = page.locator('.notes-chat-switcher')
  await expect(switcher).toBeVisible({ timeout: 5000 })
  await expect(switcher.locator('.notes-chat-switcher-title')).toHaveText('Session Note')
  await expect(switcher.locator('.notes-chat-switcher-badge')).toHaveText(/Walnut Agent/i)
  await expect(page.locator('.notes-chat-pane .notes-chat')).toBeVisible()
  await expect(page.locator('.notes-chat-pane .session-panel')).toHaveCount(0)

  // The menu lists it under the Walnut Agent group as a deletable row,
  // alongside the always-present (never deletable) main "Note Agent" row.
  const trigger = switcher.locator('.notes-chat-switcher-trigger')
  await trigger.click()
  const menu = page.locator('.notes-chat-switcher-menu')
  await expect(menu.locator('.notes-chat-switcher-item', { hasText: 'Note Agent' }).first()).toBeVisible()
  const agentRow = menu.locator('.notes-chat-switcher-agent-chat', { hasText: 'Session Note' })
  await expect(agentRow).toHaveCount(1)
  await expect(agentRow).toHaveClass(/active/)
  await expect(agentRow.locator('.notes-chat-switcher-close')).toBeVisible()

  // SURVIVES RELOAD (conversation is server-persisted; mode in localStorage).
  await page.keyboard.press('Escape')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.notes-chat-switcher-title')).toHaveText('Session Note', { timeout: 10_000 })

  // DELETE via the row × → falls back to the main Note Agent chat and the row
  // is gone (server-side delete, verified after a reload too).
  await page.locator('.notes-chat-switcher-trigger').click()
  await page.locator('.notes-chat-switcher-menu .notes-chat-switcher-agent-chat .notes-chat-switcher-close').click()
  await expect(page.locator('.notes-chat-switcher-menu .notes-chat-switcher-agent-chat')).toHaveCount(0)
  await expect(page.locator('.notes-chat-switcher-title')).toHaveText('Note Agent')
  await page.reload()
  await page.waitForLoadState('networkidle')
  // No side chats and no CC sessions left → the switcher hides entirely.
  await expect(page.locator('.notes-chat-switcher')).toHaveCount(0)
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
  // on an already-expanded folder COLLAPSES it, and the async prefs merge can
  // flip expansion UNDER the test right after load. Retry-expand until the
  // attachment is actually visible instead of trusting one instant check.
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'CCTest' })
  const attachFolder = page.locator('.notes-tree-folder', { hasText: '_attachment' })
  const attachment = page.locator('.notes-tree-file.notes-tree-attachment, .notes-tree-file', { hasText: '.png' }).first()
  for (let i = 0; i < 5 && !(await attachment.isVisible().catch(() => false)); i++) {
    if (!(await attachFolder.isVisible().catch(() => false))) await folderEl.click().catch(() => {})
    if (await attachFolder.isVisible().catch(() => false)) await attachFolder.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await expect(attachment).toBeVisible()
  await attachment.click({ button: 'right' })

  await expect(page.locator('.notes-context-menu')).toBeVisible()
  await expect(
    page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }),
  ).toHaveCount(0)
})
