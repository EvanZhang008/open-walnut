/**
 * Playwright browser test for the per-file HISTORY panel in the session Files panel.
 *
 * The user asked for a simple history of the file they have open, working with or
 * without git. Walnut records a version when the editor opens a file ("Opened")
 * and on every save ("You" / "Live" / "Merged"), and the panel lets them look at
 * any version as a diff against the current buffer and restore it as UNSAVED work.
 *
 * What this pins:
 *   - the file's pre-edit bytes are a version to go back to (identical bytes are
 *     one row, however many opens and saves found them),
 *   - a save shows up in the open panel without closing/reopening it,
 *   - Restore puts the old text in the editor as an unsaved edit (Save armed,
 *     nothing written yet), and Save then really writes it.
 *
 * The git half has its own route tests; the fixture dir here is not a repo, so
 * the panel shows the snapshot timeline alone — which is the "must work without
 * git" requirement.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/history'

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

function editor(page: Page): Locator {
  return page.locator('.fv-source-editor .cm-content')
}

async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const cwd = await fixtureCwd(page)
  const abs = `${cwd}/${name}`
  const res = await page.request.post('/api/files/create', { data: { path: abs } })
  expect(res.status(), await res.text()).toBe(200)
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: body } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

async function onDisk(page: Page, abs: string): Promise<string> {
  const res = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`)
  expect(res.ok()).toBe(true)
  return (await res.json()).content as string
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('the open file has a history: opened, saved, and restorable as unsaved work', async ({ page }) => {
  const name = `hist-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'version one\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('version one')

  // Open the panel. There is already exactly ONE version: the seeding save above
  // went through the editor's own route, and the open that followed found the
  // same bytes — identical content is one version, never two rows.
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const flyout = page.getByTestId('file-history-flyout')
  await expect(flyout).toBeVisible()
  const rows = flyout.locator('.fh-row')
  await expect(rows).toHaveCount(1, { timeout: 10_000 })
  await expect(rows.first().locator('.fh-pill')).toHaveText(/Opened|You/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-opened-version.png` })

  // Edit and save: the panel picks the new version up while staying open.
  await editor(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' plus two')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(rows).toHaveCount(2, { timeout: 10_000 })
  // Newest first: the save is on top, the original beneath it.
  await expect(rows.nth(0).locator('.fh-pill')).toHaveText('You')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-saved-version-added.png` })

  // Look at the original version: a diff against what is in the editor now.
  await rows.nth(1).click()
  const diff = flyout.locator('.fh-diff')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  await expect(diff.locator('.fh-diff-label')).toContainText('now')
  await expect(diff.locator('.fh-diff-table')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-diff-against-now.png` })

  // Restore: the old text lands in the editor as UNSAVED work — nothing written.
  await diff.getByRole('button', { name: 'Restore this version' }).click()
  await expect(editor(page)).toContainText('version one')
  await expect(editor(page)).not.toContainText('plus two')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  expect(await onDisk(page, abs)).toBe('version one plus two\n')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-restored-unsaved.png` })

  // Save makes it real, and that is a third version on the timeline.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('version one\n')
  await expect(rows).toHaveCount(3, { timeout: 10_000 })

  // The panel's own close works, and the toolbar button reflects it.
  await flyout.getByRole('button', { name: 'Close history' }).click()
  await expect(flyout).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'false')
})
