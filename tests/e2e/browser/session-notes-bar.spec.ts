/**
 * E2E: session Notes hybrid UI —
 *  - NO note  → a small "📝 Notes" pill next to the btw pill (no bar).
 *  - HAS note → an always-visible sticky-note BAR docked above the composer
 *               (highlight + dot + first-line preview); the pill disappears.
 *
 * The dedicated /sessions page was removed — both tests exercise the homepage
 * session column (`.main-page-session-column .session-panel`), the only surface.
 *
 *  1. Empty note → pill visible, bar absent; typing auto-saves; reload persists.
 *  2. Saved note → bar visible on load; clearing swaps back to the pill.
 */
import { test, expect, type Page } from '@playwright/test'

// Both tests mutate the SAME seeded session's human_note — parallel runs race
// (one test's cleanup clears the other's setup). Serialize within this file.
test.describe.configure({ mode: 'serial' })

// Seed the home column queue (sessionStorage) so the SessionPanel for the
// seeded 'Normal: fix the bug' session mounts on load.
async function openSeededSessionOnHome(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

test('empty → pill next to btw; saving a note swaps to the always-visible bar', async ({ page }) => {
  // Reset the seeded session's note so the test is idempotent across runs
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })

  const panel = await openSeededSessionOnHome(page)

  // (1) empty note → pill visible next to btw, NO bar
  const pill = panel.locator('.session-notes-pill')
  await expect(pill).toBeVisible({ timeout: 5000 })
  await expect(panel.locator('.session-notes')).toHaveCount(0)
  const btwPill = panel.locator('.side-question-pill', { hasText: 'btw' })
  await expect(btwPill).toBeVisible()
  const pillBox = await pill.boundingBox()
  const btwBox = await btwPill.boundingBox()
  expect(Math.abs(pillBox!.y - btwBox!.y)).toBeLessThan(8) // same row as btw

  // (2) click pill → bar appears in edit mode; type a note (autosave after 1s debounce)
  await pill.click()
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible()
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('remember: deploy after AREX confirms')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })

  // (3) note exists → card carries the has-note state; pill disappears
  await expect(bar).toHaveClass(/session-notes--has-note/)
  await expect(pill).toHaveCount(0)

  // Blur the editor (click the chat area) → collapses to the one-line preview row
  await panel.locator('.session-panel-body').click()
  await expect(bar).toBeVisible()
  await expect(bar.locator('.session-notes-preview')).toHaveText(/remember: deploy after AREX confirms/)

  // Bar is docked at the bottom: below the chat history
  const historyBox = await panel.locator('.session-panel-body').boundingBox()
  const barBox = await bar.boundingBox()
  expect(barBox!.y).toBeGreaterThan(historyBox!.y + historyBox!.height - 2)

  // (4) reload → bar persists with preview, pill still gone
  const panel2 = await openSeededSessionOnHome(page)
  const bar2 = panel2.locator('.session-notes')
  await expect(bar2).toBeVisible({ timeout: 5000 })
  await expect(bar2).toHaveClass(/session-notes--has-note/)
  await expect(bar2.locator('.session-notes-preview')).toHaveText(/remember: deploy after AREX confirms/)
  await expect(panel2.locator('.session-notes-pill')).toHaveCount(0)

  // Clearing the note swaps back: open editor, clear, blur → row unmounts, pill returns
  await bar2.locator('.session-notes-toggle').click()
  await bar2.locator('.session-notes-textarea').fill('')
  await expect(bar2.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })
  await panel2.locator('.session-panel-body').click()
  await expect(panel2.locator('.session-notes')).toHaveCount(0)
  await expect(panel2.locator('.session-notes-pill')).toBeVisible()

  // Cleanup
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('homepage session panel: bar when note exists, pill when empty', async ({ page }) => {
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: 'home panel note' } })

  const panel = await openSeededSessionOnHome(page)

  // Note exists → BAR visible (highlighted, with preview), pill absent
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })
  await expect(bar).toHaveClass(/session-notes--has-note/)
  await expect(bar.locator('.session-notes-preview')).toHaveText('home panel note')
  await expect(panel.locator('.session-notes-pill')).toHaveCount(0)

  // Bottom-docked: bar is below the chat history and above the input
  const historyBox = await panel.locator('.session-panel-body').boundingBox()
  const barBox = await bar.boundingBox()
  const inputBox = await panel.locator('.session-panel-input').boundingBox()
  expect(barBox!.y).toBeGreaterThan(historyBox!.y + historyBox!.height - 2)
  expect(inputBox!.y).toBeGreaterThan(barBox!.y)

  // Clear the note → after save + blur, the row unmounts and the pill returns
  await bar.locator('.session-notes-toggle').click()
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toHaveValue('home panel note')
  await textarea.fill('')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })
  await panel.locator('.session-panel-body').click()
  await expect(panel.locator('.session-notes')).toHaveCount(0)
  const pill = panel.locator('.session-notes-pill')
  await expect(pill).toBeVisible()
  const btwPill = panel.locator('.side-question-pill', { hasText: 'btw' })
  const pillBox = await pill.boundingBox()
  const btwBox = await btwPill.boundingBox()
  expect(Math.abs(pillBox!.y - btwBox!.y)).toBeLessThan(8)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})
