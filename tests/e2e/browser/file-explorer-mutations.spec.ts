/**
 * Playwright browser tests for FILE MUTATIONS in the session Files panel:
 * New File… / New Folder… / Rename… / Duplicate / Delete, driven exactly as a
 * user drives them — right-click a tree row, pick the item, type in the inline
 * row that appears.
 *
 * What these pin (each one is a way the feature can look broken while the HTTP
 * call succeeds):
 *   - The inline row is a REAL row of the tree at the right indent, and Enter
 *     turns it into a listed entry; a new file also opens in the preview pane,
 *     because creating a file you then have to hunt for is not "New File".
 *   - Rename preselects the STEM, so typing replaces the name and keeps `.txt`.
 *   - Duplicate needs no dialog and lands in rename mode (VS Code) — Escape
 *     KEEPS the duplicate, it does not undo it.
 *   - Delete goes through the app's own confirm dialog with a danger button,
 *     never window.confirm.
 *   - A name the filesystem can't take is rejected INLINE, keeping the row so
 *     the name can be fixed in place.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
// Outside `test-results/` on purpose: Playwright wipes that dir at the start of
// every run, and it is shared machine-wide, so a concurrent run by another agent
// deletes shots a human still wants to open.
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/mutations'

/** Resolve the fixture session's cwd from the API (it lives under an isolated tmp base). */
async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

/** Open the fixture session's panel from the homepage and switch to the Files tab. */
async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // The kebab's session row is targeted POSITIONALLY (first item), not by label: its
  // text is derived from live state, so a label matcher flakes as soon as the
  // fixture session's state drifts.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/** Right-click a locator and wait for Walnut's own menu (never the browser's). */
async function rightClick(page: Page, target: Locator) {
  await target.click({ button: 'right' })
  const menu = page.getByTestId('file-ctx-menu')
  await expect(menu).toBeVisible()
  return menu
}

function rowByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name })
}

/** The whole tree row (the `.session-file-explorer-node` wrapping that name). */
function nodeByName(explorer: Locator, name: string) {
  return rowByName(explorer, name).locator('xpath=..')
}

test.beforeEach(async ({ page }) => {
  // Pin the Files tree EXPANDED before first render: the collapse pref key syncs
  // to the SHARED fixture server (ui-prefs), so a parallel run of
  // file-explorer-tree-collapse.spec.ts would otherwise boot with no tree.
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('create → rename → duplicate → delete, all inline in the tree', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const cwd = await fixtureCwd(page)
  const stamp = Date.now()
  const created = `hello-${stamp}.txt`
  const renamed = `renamed-${stamp}.txt`
  const duplicated = `renamed-${stamp} copy.txt`

  try {
    // ── 1. New File… from the cwd root header ────────────────────────────────
    const rootHeader = explorer.locator('.sfe-root-header').first()
    let menu = await rightClick(page, rootHeader)
    await menu.getByRole('menuitem', { name: 'New File…' }).click()

    const newFileInput = explorer.getByRole('textbox', { name: 'New file name' })
    await expect(newFileInput).toBeVisible()
    await newFileInput.fill(created)
    await newFileInput.press('Enter')

    await expect(rowByName(explorer, created)).toBeVisible({ timeout: 10_000 })
    // Creating a file OPENS it: the preview pane holds its (empty) editor and the
    // new row is the selected one.
    await expect(explorer.locator('.fv-source-editor')).toBeVisible({ timeout: 10_000 })
    await expect(nodeByName(explorer, created)).toHaveClass(/selected/)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/1-created-file.png` })

    // ── 2. Rename… — the input arrives pre-filled with the STEM selected ─────
    menu = await rightClick(page, rowByName(explorer, created))
    await menu.getByRole('menuitem', { name: 'Rename…' }).click()

    const renameInput = explorer.getByRole('textbox', { name: 'New name' })
    await expect(renameInput).toBeVisible()
    const selection = await renameInput.evaluate((el) => {
      const input = el as HTMLInputElement
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd }
    })
    expect(selection.value).toBe(created)
    expect(selection.start).toBe(0)
    expect(selection.end).toBe(created.lastIndexOf('.')) // ".txt" stays put

    await renameInput.fill(renamed)
    await renameInput.press('Enter')

    await expect(rowByName(explorer, renamed)).toBeVisible({ timeout: 10_000 })
    await expect(rowByName(explorer, created)).toHaveCount(0)
    // The open file FOLLOWS the rename (selection moved to the new path) instead
    // of going dead on a path that no longer exists.
    await expect(nodeByName(explorer, renamed)).toHaveClass(/selected/)
    await expect(explorer.locator('.fv-source-editor')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/2-renamed-file.png` })

    // ── 3. Duplicate — no dialog, lands in rename mode, Escape KEEPS it ──────
    menu = await rightClick(page, rowByName(explorer, renamed))
    await menu.getByRole('menuitem', { name: 'Duplicate' }).click()

    const dupInput = explorer.getByRole('textbox', { name: 'New name' })
    await expect(dupInput).toBeVisible({ timeout: 10_000 })
    await expect(dupInput).toHaveValue(duplicated)
    await dupInput.press('Escape')
    await expect(rowByName(explorer, duplicated)).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/3-duplicated-file.png` })

    // ── 4. Delete — the app's confirm dialog, danger button, then gone ───────
    menu = await rightClick(page, rowByName(explorer, duplicated))
    // exact: role-name matching is substring by default, and a dir target would
    // also offer "Delete folder".
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click()

    const modal = page.locator('.app-modal')
    await expect(modal).toBeVisible()
    await expect(modal.locator('.app-modal-title')).toContainText(duplicated)
    const dangerBtn = modal.locator('.app-modal-btn.primary.danger')
    await expect(dangerBtn).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/4-delete-confirm.png` })
    await dangerBtn.click()

    await expect(rowByName(explorer, duplicated)).toHaveCount(0, { timeout: 10_000 })
  } finally {
    for (const name of [created, renamed, duplicated]) {
      await fs.rm(path.join(cwd, name), { force: true })
    }
  }
})

test('New Folder… adds a folder row to the tree', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const cwd = await fixtureCwd(page)
  const dirName = `dir-${Date.now()}`

  try {
    const menu = await rightClick(page, explorer.locator('.sfe-root-header').first())
    await menu.getByRole('menuitem', { name: 'New Folder…' }).click()

    const input = explorer.getByRole('textbox', { name: 'New folder name' })
    await expect(input).toBeVisible()
    await input.fill(dirName)
    await input.press('Enter')

    await expect(rowByName(explorer, dirName)).toBeVisible({ timeout: 10_000 })
    // A folder, not a file: the row carries the folder glyph.
    await expect(nodeByName(explorer, dirName).locator('.sfe-icon')).toHaveText('📁')
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5-created-folder.png` })
  } finally {
    await fs.rm(path.join(cwd, dirName), { recursive: true, force: true })
  }
})

test('an invalid name is rejected inline and keeps the row', async ({ page }) => {
  const explorer = await openFilesPanel(page)

  const menu = await rightClick(page, explorer.locator('.sfe-root-header').first())
  await menu.getByRole('menuitem', { name: 'New File…' }).click()

  const input = explorer.getByRole('textbox', { name: 'New file name' })
  await expect(input).toBeVisible()
  await input.fill('a/b')
  await input.press('Enter')

  // Rejected BEFORE any request, with the row still up so the name can be fixed.
  const error = explorer.locator('.sfe-edit-error')
  await expect(error).toBeVisible()
  await expect(error).toHaveText("Name can't contain slashes")
  await expect(input).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/6-invalid-name.png` })

  // Escape gets out of it cleanly.
  await input.press('Escape')
  await expect(explorer.locator('.sfe-edit-input')).toHaveCount(0)
})
