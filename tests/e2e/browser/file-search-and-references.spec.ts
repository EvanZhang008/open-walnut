/**
 * Files viewer: in-file search (⌘F), select→highlight-matches, and
 * cmd+click→reference panel.
 *
 * Fixture: sync-controller.go + sync-caller.go under the editor-fixture root
 * (test-server.ts) — one definition of HasSyncedForItems, two call sites.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

// All four tests drive the SAME fixture session, and the explorer's
// selected-file memory syncs to the shared fixture server (ui-prefs) — parallel
// workers yank each other's open file. Serial is correctness here, not speed.
test.describe.configure({ mode: 'serial' })

async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return { panel, explorer }
}

async function openFixtureFile(page: Page, explorer: ReturnType<Page['locator']>, name: string) {
  const row = explorer.locator('.session-file-explorer-node', { hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  // CodeMirror editor is the default view for a readable code file.
  const editor = explorer.locator('.fv-source-editor .cm-content')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  return editor
}

/**
 * Viewport center of the FIRST occurrence of `needle` as a text-node range.
 * Clicking a `.cm-line` locator lands on the LINE's center, not the word —
 * word-precise gestures (dblclick select, cmd+click lookup) need coordinates.
 */
async function centerOfText(page: Page, containerSel: string, needle: string) {
  const pt = await page.evaluate(([sel, text]) => {
    const root = document.querySelector(sel!)
    if (!root) return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const idx = (n as Text).data.indexOf(text!)
      if (idx === -1) continue
      const r = document.createRange()
      r.setStart(n, idx)
      r.setEnd(n, idx + text!.length)
      const rect = r.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return null
  }, [containerSel, needle] as const)
  expect(pt, `text "${needle}" not found in ${containerSel}`).not.toBeNull()
  return pt!
}

const EDITOR_SEL = `.session-panel[data-session-id="${SESSION_ID}"] .fv-source-editor .cm-content`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('⌘F searches the code file: count, highlights, Enter steps through matches', async ({ page }) => {
  const { explorer } = await openFilesPanel(page)
  const editor = await openFixtureFile(page, explorer, 'sync-controller.go')
  await editor.click() // focus inside the viewer so the shortcut targets it

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const bar = explorer.locator('.fv-search-bar')
  await expect(bar).toBeVisible()

  await bar.locator('.fv-search-input').fill('SEARCH_MARKER')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/1')
  await expect(explorer.locator('.cm-searchMatch')).toHaveCount(1)

  // A term with several hits: Enter advances, wrapping at the end.
  await bar.locator('.fv-search-input').fill('HasSyncedForItems')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/2')
  await expect(explorer.locator('.cm-searchMatch')).toHaveCount(2)
  await bar.locator('.fv-search-input').press('Enter')
  await expect(bar.locator('.fv-search-count')).toHaveText('2/2')
  await bar.locator('.fv-search-input').press('Enter')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/2')

  // Esc closes the bar and clears the paint.
  await bar.locator('.fv-search-input').press('Escape')
  await expect(bar).not.toBeVisible()
  await expect(explorer.locator('.cm-searchMatch')).toHaveCount(0)
})

test('search works in the markdown preview too (DOM surface)', async ({ page }) => {
  const { explorer } = await openFilesPanel(page)
  const row = explorer.locator('.session-file-explorer-node', { hasText: 'incident-report.md' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(explorer.locator('.fv-html-toolbar')).toBeVisible({ timeout: 10_000 })
  // Wait for the WYSIWYG editor to actually hold the doc — TipTap fills after
  // mount, and a search fired against the empty surface would report 0.
  await expect(explorer.locator('.fv-wysiwyg-editor')).toContainText('timeline entry 1', { timeout: 10_000 })

  // The Find button is the mouse path to the same bar (⌘F targeting is covered above).
  await explorer.locator('.fv-find-btn').click()
  const bar = explorer.locator('.fv-search-bar')
  await expect(bar).toBeVisible()
  await bar.locator('.fv-search-input').fill('timeline entry')
  // DOM surfaces paint via CSS.highlights (not inspectable as elements) — the
  // count is the observable contract. 160 fixture bullets carry this phrase.
  await expect(bar.locator('.fv-search-count')).toHaveText('1/160')
})

test('selecting an identifier highlights its other exact matches (CodeMirror)', async ({ page }) => {
  const { explorer } = await openFilesPanel(page)
  await openFixtureFile(page, explorer, 'sync-controller.go')

  // Double-click ON THE WORD selects it (a .cm-line locator would land on the
  // line's center, selecting whatever word happens to sit there).
  const pt = await centerOfText(page, EDITOR_SEL, 'HasSyncedForItems')
  await page.mouse.dblclick(pt.x, pt.y)
  // highlightSelectionMatches marks the OTHER occurrence with .cm-selectionMatch.
  await expect(explorer.locator('.cm-selectionMatch')).toHaveCount(1)
})

test('cmd+click an identifier opens the reference panel; a row jumps to that file', async ({ page }) => {
  const { explorer } = await openFilesPanel(page)
  await openFixtureFile(page, explorer, 'sync-controller.go')

  const pt = await centerOfText(page, EDITOR_SEL, 'HasSyncedForItems')
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.mouse.click(pt.x, pt.y)
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')

  const panelEl = explorer.locator('.ref-panel')
  await expect(panelEl).toBeVisible()
  await expect(panelEl.locator('.ref-panel-header')).toContainText('HasSyncedForItems')
  // 1 def + 2 refs across the two fixture files.
  await expect(panelEl.locator('.ref-panel-row')).toHaveCount(3, { timeout: 10_000 })
  await expect(panelEl.locator('.ref-panel-section').first()).toHaveText('Definitions')
  await expect(panelEl.locator('.ref-panel-def')).toHaveCount(1)

  // The group for the file the lookup came from is tinted and tagged (once per
  // section it appears in — Definitions and References both hold this file).
  await expect(panelEl.locator('.ref-panel-file-current').first()).toContainText('sync-controller.go')
  await expect(panelEl.locator('.ref-panel-current-tag').first()).toHaveText('this file')

  // Click the sync-caller.go reference row → the preview opens that file and
  // the landed-on keyword flashes so the eye finds it.
  const callerRow = panelEl.locator('.ref-panel-row', { hasText: 'c.factory.HasSyncedForItems(nil)' })
  await callerRow.click()
  await expect(explorer.locator('.session-file-explorer-node.selected', { hasText: 'sync-caller.go' }))
    .toBeVisible({ timeout: 10_000 })
  const flash = explorer.locator('.cm-jump-flash')
  await expect(flash).toBeVisible({ timeout: 10_000 })
  await expect(flash).toHaveText('HasSyncedForItems')

  // Editor-style Back: returns to the file the jump left, not just "previous".
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+[' : 'Control+[')
  await expect(explorer.locator('.session-file-explorer-node.selected', { hasText: 'sync-controller.go' }))
    .toBeVisible({ timeout: 10_000 })

  // Esc closes the panel.
  await page.keyboard.press('Escape')
  await expect(panelEl).not.toBeVisible()
})
