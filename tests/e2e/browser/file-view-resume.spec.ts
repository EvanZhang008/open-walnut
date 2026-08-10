/**
 * Playwright browser tests for the Files panel: markdown strikethrough correctness
 * and "resume where I left off".
 *
 * Two regressions from the 2026-07-28 report, both verified through real UI clicks:
 *
 * 1. RENDERING — marked's default `del` tokenizer opens on a SINGLE `~`, so two
 *    unrelated approximations in one paragraph ("watching ~550K objects … cache
 *    (~20 min rebuild)") paired up and struck out everything between them,
 *    including the bold runs. Fixed by requiring `~~` on the shared marked
 *    singleton (the note renderer already did this locally).
 *
 * 2. RESUME — the preview pane kept no memory: reopening the Files panel showed
 *    the empty "Select a file to preview" pane, so the user had to hunt for and
 *    re-click the file every time, and it always reopened scrolled to the top.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = 'test-results/file-view-resume'

/** Open the fixture session's panel from the homepage (real clicks, no page.goto). */
async function openSessionPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // The kebab's session row is targeted POSITIONALLY (first item), not by label: its
  // text is derived from live state ("Session idle" / "AI is working…" / "Session
  // error" / "Unread — open to mark read"), so a label matcher flakes as soon as the
  // fixture session's state drifts.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** Toggle the Files tab on and wait for the explorer. */
async function openFiles(panel: ReturnType<Page['locator']>) {
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/** Toggle the Files tab back off (same button — it's a toggle). */
async function closeFiles(panel: ReturnType<Page['locator']>) {
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
}

/** The element that actually scrolls a markdown preview. */
function mdPreview(explorer: ReturnType<Page['locator']>) {
  return explorer.locator('.fv-md-preview')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('lone ~ approximations do not strike out the paragraph', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  const preview = mdPreview(explorer)
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview).toContainText('~550K objects')

  // THE regression: the whole span between `~550K` and `~20 min` used to render
  // inside a <del>. The only strike in this file is the real `~~…~~` one.
  const struck = await preview.locator('del').allInnerTexts()
  expect(struck).toEqual(['retracted claim'])

  // The approximations survive as literal text, and the bold run that sat inside
  // the bogus strike range is still bold (and NOT struck).
  await expect(preview).toContainText('~694 times')
  await expect(preview).toContainText('~20 min cold')
  const strong = preview.locator('strong', { hasText: 'silently losing its lease' })
  await expect(strong).toHaveCount(1)
  const strikeOnBold = await strong.evaluate((el) => {
    // line-through applied by an ancestor <del> shows up on the computed style.
    return getComputedStyle(el).textDecorationLine.includes('line-through') || !!el.closest('del')
  })
  expect(strikeOnBold).toBe(false)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-no-bogus-strike.png` })
})

test('reopening the Files panel restores the file AND the reading position', async ({ page }) => {
  const panel = await openSessionPanel(page)
  let explorer = await openFiles(panel)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  let preview = mdPreview(explorer)
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview).toContainText('timeline entry 1')

  // Scroll down as a reader would, and let the debounced save settle.
  await preview.evaluate((el) => { el.scrollTop = 900 })
  await expect.poll(() => preview.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
  await page.waitForTimeout(500)
  const before = await preview.evaluate((el) => el.scrollTop)

  await closeFiles(panel)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-panel-closed.png` })

  explorer = await openFiles(panel)
  // THE regression #1: this used to be "Select a file to preview" — the file had
  // to be found in the tree and clicked again on every single open.
  preview = mdPreview(explorer)
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.sfe-preview-empty')).toHaveCount(0)
  // The tree row is shown as selected too, not just the pane content.
  await expect(
    explorer.locator('.session-file-explorer-node.selected .sfe-name', { hasText: 'incident-report.md' }),
  ).toHaveCount(1)

  // THE regression #2: it reopened at the top of a long document every time.
  await expect.poll(
    () => preview.evaluate((el) => el.scrollTop),
    { timeout: 10_000, message: 'preview should resume near the saved offset' },
  ).toBeGreaterThan(before - 150)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/step3-resumed.png` })
})

test('scroll memory is per file — switching files does not carry the offset over', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)

  // Scroll file A down.
  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  const preview = mdPreview(explorer)
  await expect(preview).toContainText('timeline entry 1', { timeout: 10_000 })
  await preview.evaluate((el) => { el.scrollTop = 800 })
  await page.waitForTimeout(500)

  // Open file B — it must start at the TOP, not inherit A's offset.
  await explorer.locator('.sfe-name', { hasText: 'second-doc.md' }).click()
  await expect(mdPreview(explorer)).toContainText('Second doc', { timeout: 10_000 })
  await expect.poll(() => mdPreview(explorer).evaluate((el) => el.scrollTop)).toBeLessThan(50)

  // Back to A — its own position is still remembered.
  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(mdPreview(explorer)).toContainText('timeline entry 1', { timeout: 10_000 })
  await expect.poll(
    () => mdPreview(explorer).evaluate((el) => el.scrollTop),
    { timeout: 10_000 },
  ).toBeGreaterThan(400)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/step4-per-file-offsets.png` })
})

test('scrolling back to the top is remembered as the top', async ({ page }) => {
  const panel = await openSessionPanel(page)
  let explorer = await openFiles(panel)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  let preview = mdPreview(explorer)
  await expect(preview).toContainText('timeline entry 1', { timeout: 10_000 })
  await preview.evaluate((el) => { el.scrollTop = 900 })
  await page.waitForTimeout(400)
  // Then read back up to the top and leave.
  await preview.evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(500)

  await closeFiles(panel)
  explorer = await openFiles(panel)
  preview = mdPreview(explorer)
  await expect(preview).toBeVisible({ timeout: 10_000 })
  // Must NOT snap back down to the stale 900 — that felt like the panel fighting you.
  await page.waitForTimeout(400)
  expect(await preview.evaluate((el) => el.scrollTop)).toBeLessThan(50)
})
