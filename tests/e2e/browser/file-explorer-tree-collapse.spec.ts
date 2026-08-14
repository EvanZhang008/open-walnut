/**
 * Playwright browser tests for the Files panel tree collapse toggle.
 *
 * The Files tab's left tree pane can be hidden (like the Changed tab's tree
 * toggle and the split chat column) so the file preview gets the full width.
 * The choice persists across panel close/reopen via localStorage.
 *
 * ISOLATION: the pref key (`open-walnut-file-explorer-tree-collapsed`) is
 * mirrored to the SHARED fixture server by ui-prefs-sync, so a collapse here
 * would leak into sibling explorer specs booting in parallel (they'd find no
 * tree at all). Every test pins its own starting value via addInitScript — a
 * locally-written value with no sync timestamp wins the boot merge (same
 * pattern + reasoning as presetStickyTier in draft-helpers.ts) — and an
 * afterEach resets the server copy even when an assertion failed mid-test.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = 'test-results/file-explorer-tree-collapse'
const LS_KEY = 'open-walnut-file-explorer-tree-collapsed'

/** Pin the collapse pref BEFORE first render so the shared server's copy
 *  (possibly dirtied by a parallel or earlier run) can't leak in. */
async function presetTreeCollapsed(page: Page, collapsed: boolean): Promise<void> {
  await page.addInitScript(([k, v]) => {
    try { localStorage.setItem(k as string, v as string) } catch { /* storage off */ }
  }, [LS_KEY, collapsed ? '1' : '0'])
}

/** Open the fixture session's panel from the homepage and switch to the Files tab. */
async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // Positional (first item): the session row's label is derived from live state.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return { panel, explorer }
}

test.afterEach(async ({ page }) => {
  // Reset the pref in the LIVE page so ui-prefs-sync PUTs '0' back to the shared
  // server — an initScript alone wouldn't (it only patches future documents).
  await page.evaluate((k) => { try { localStorage.setItem(k, '0') } catch { /* off */ } }, LS_KEY)
  // Give the debounced sync flush a beat (800ms debounce + network).
  await page.waitForTimeout(1200)
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('tree toggle hides the tree, preview takes full width, toggle restores', async ({ page }) => {
  await presetTreeCollapsed(page, false)
  await page.reload()
  await page.waitForLoadState('networkidle')
  const { explorer } = await openFilesPanel(page)

  const tree = explorer.locator('.session-file-explorer-tree')
  const preview = explorer.locator('.session-file-explorer-preview')
  await expect(tree).toBeVisible()

  // Open a file so the preview pane has real content on both sides of the
  // toggle. incident-report.md: no other spec mutates it (refresh-target.txt
  // is rewritten mid-test by file-explorer-refresh.spec.ts).
  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(preview).toContainText('Controller restart loop', { timeout: 10_000 })
  const wideBefore = (await preview.boundingBox())!.width

  // Collapse: tree + divider disappear, preview keeps the open file and widens.
  await explorer.getByRole('button', { name: 'Hide file tree' }).click()
  await expect(tree).toHaveCount(0)
  await expect(explorer.locator('.sfe-divider')).toHaveCount(0)
  await expect(preview).toContainText('Controller restart loop')
  const wideAfter = (await preview.boundingBox())!.width
  expect(wideAfter).toBeGreaterThan(wideBefore + 100)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-collapsed.png` })

  // Restore: the toggle flips its glyph/label and brings the tree back.
  const showBtn = explorer.getByRole('button', { name: 'Show file tree' })
  await expect(showBtn).toHaveText('☰')
  await showBtn.click()
  await expect(tree).toBeVisible()
  await expect(explorer.getByRole('button', { name: 'Hide file tree' })).toHaveText('⟨')
  await expect(explorer.locator('.sfe-name', { hasText: 'incident-report.md' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-restored.png` })
})

test('collapsed state persists across closing and reopening the Files view', async ({ page }) => {
  await presetTreeCollapsed(page, false)
  await page.reload()
  await page.waitForLoadState('networkidle')
  const { panel, explorer } = await openFilesPanel(page)

  await explorer.getByRole('button', { name: 'Hide file tree' }).click()
  await expect(explorer.locator('.session-file-explorer-tree')).toHaveCount(0)

  // Close the Files view and reopen it — the tree stays hidden.
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(explorer).not.toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer2 = panel.locator('.session-file-explorer')
  await expect(explorer2).toBeVisible({ timeout: 10_000 })
  await expect(explorer2.locator('.session-file-explorer-tree')).toHaveCount(0)

  // Restore so the shared pref isn't left collapsed for sibling specs.
  await explorer2.getByRole('button', { name: 'Show file tree' }).click()
  await expect(explorer2.locator('.session-file-explorer-tree')).toBeVisible()
})

test('expanded folders survive a collapse/restore round-trip', async ({ page }) => {
  await presetTreeCollapsed(page, false)
  await page.reload()
  await page.waitForLoadState('networkidle')
  const { explorer } = await openFilesPanel(page)

  // Expand deep/nested (fixture ships it for the linked-from-chat spec).
  await explorer.locator('.sfe-name', { hasText: /^deep$/ }).click()
  const nested = explorer.locator('.sfe-name', { hasText: /^nested$/ })
  await expect(nested).toBeVisible({ timeout: 10_000 })
  await nested.click()
  const deepFile = explorer.locator('.sfe-name', { hasText: 'linked-from-chat.md' })
  await expect(deepFile).toBeVisible({ timeout: 10_000 })

  await explorer.getByRole('button', { name: 'Hide file tree' }).click()
  await expect(explorer.locator('.session-file-explorer-tree')).toHaveCount(0)
  await explorer.getByRole('button', { name: 'Show file tree' }).click()

  // The unmount must not have dropped the expand state (it's component state
  // + localStorage, both of which outlive the tree subtree).
  await expect(deepFile).toBeVisible({ timeout: 10_000 })
})
