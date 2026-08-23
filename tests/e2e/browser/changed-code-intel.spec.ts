/**
 * Changed tab: the same code intelligence the Files viewer has — ⌘F in-diff
 * search (gutter numbers excluded), select→highlight-matches, cmd+click→
 * reference panel whose rows open IN-TAB (a ghost context view for files
 * outside the change set, with an "Open in Files" escape to the Files tab) —
 * plus the custom right-click menu on both surfaces.
 *
 * Fixture: pw-changed-session (test-server.ts) whose JSONL Writes
 * sync-controller.go, so the Changed tab shows it as an added file; the
 * on-disk twin plus sync-caller.go is what reference lookup greps.
 *
 * NOTE the ⌘F/count assertions ('1/2', '1/1') rely on the added file rendering
 * whole-file UNIFIED (new files force that layout) — a split render would list
 * lines twice and double every count here.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-changed-session'
const TASK_ID = 'pw-task-changed'

// One fixture session, shared server-side view memory (ui-prefs) — parallel
// workers would fight over the selected file. Serial is correctness here.
test.describe.configure({ mode: 'serial' })

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openChangedPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Changed' }).click()
  const diff = panel.locator('.session-diff-view')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  // The one changed file auto-selects; wait for its table to render.
  await expect(diff.locator('.session-diff-filepane[data-file-path$="sync-controller.go"]'))
    .toBeVisible({ timeout: 15_000 })
  return { panel, diff }
}

/** Viewport center of the FIRST occurrence of `needle` inside `containerSel`. */
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

const DIFF_MAIN = `.session-panel[data-session-id="${SESSION_ID}"] .session-diff-main`

/** Ranges registered under a CSS Custom Highlight name (the DOM-surface paint
 *  is not inspectable as elements — the registry is the observable). */
async function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    const h = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get(n)
    return h ? h.size : 0
  }, name)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('⌘F searches the diff: counts content matches, skips gutter line numbers', async ({ page }) => {
  const { diff } = await openChangedPanel(page)
  await diff.locator('.session-diff-main').click()

  await page.keyboard.press(`${MOD}+f`)
  const bar = diff.locator('.fv-search-bar')
  await expect(bar).toBeVisible()

  await bar.locator('.fv-search-input').fill('HasSyncedForItems')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/2')
  expect(await highlightSize(page, 'walnut-search')).toBe(2)

  await bar.locator('.fv-search-input').press('Enter')
  await expect(bar.locator('.fv-search-count')).toHaveText('2/2')
  await bar.locator('.fv-search-input').press('Enter')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/2')

  // "12" exists ONLY as a gutter line number — content must not match it.
  await bar.locator('.fv-search-input').fill('12')
  await expect(bar.locator('.fv-search-count')).toHaveText('No results')

  await bar.locator('.fv-search-input').press('Escape')
  await expect(bar).not.toBeVisible()
  expect(await highlightSize(page, 'walnut-search')).toBe(0)
})

test('selecting a word highlights every exact match in the diff', async ({ page }) => {
  await openChangedPanel(page)
  const pt = await centerOfText(page, DIFF_MAIN, 'HasSyncedForItems')
  await page.mouse.dblclick(pt.x, pt.y)
  await expect
    .poll(() => highlightSize(page, 'walnut-selmatch'), { timeout: 5_000 })
    .toBe(2)
  // Collapsing the selection clears the paint.
  await page.mouse.click(pt.x, pt.y)
  await expect
    .poll(() => highlightSize(page, 'walnut-selmatch'), { timeout: 5_000 })
    .toBe(0)
})

test('cmd+click opens references; a row opens in-tab context; Open in Files crosses tabs', async ({ page }) => {
  const { panel, diff } = await openChangedPanel(page)

  const pt = await centerOfText(page, DIFF_MAIN, 'HasSyncedForItems')
  await page.keyboard.down(MOD)
  await page.mouse.click(pt.x, pt.y)
  await page.keyboard.up(MOD)

  const refPanel = diff.locator('.ref-panel')
  await expect(refPanel).toBeVisible()
  await expect(refPanel.locator('.ref-panel-header')).toContainText('HasSyncedForItems')
  // 1 def + 2 refs across the two on-disk fixture files.
  await expect(refPanel.locator('.ref-panel-row')).toHaveCount(3, { timeout: 10_000 })
  await expect(refPanel.locator('.ref-panel-file-current').first()).toContainText('sync-controller.go')

  // A row in the OTHER file (outside the change set) → stays in the Changed
  // tab as a read-only ghost context view, keyword flashed at the line.
  await refPanel.locator('.ref-panel-row', { hasText: 'c.factory.HasSyncedForItems(nil)' }).click()
  const ghost = diff.locator('.session-diff-ghost')
  await expect(ghost).toBeVisible({ timeout: 10_000 })
  await expect(ghost.locator('.session-diff-ghost-path')).toContainText('sync-caller.go')
  const ghostFlash = ghost.locator('.cm-jump-flash')
  await expect(ghostFlash).toBeVisible({ timeout: 10_000 })
  await expect(ghostFlash).toHaveText('HasSyncedForItems')

  // The escape hatch: "Open in Files" leaves for the Files tab, same landing.
  await ghost.getByRole('button', { name: 'Open in Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const flash = explorer.locator('.cm-jump-flash')
  await expect(flash).toBeVisible({ timeout: 10_000 })
  await expect(flash).toHaveText('HasSyncedForItems')
})

test('right-click menu works on the diff and on the Files viewer', async ({ page }) => {
  const { panel, diff } = await openChangedPanel(page)

  // Diff surface: dblclick selects the word, right-click raises OUR menu.
  const pt = await centerOfText(page, DIFF_MAIN, 'syncedFn')
  await page.mouse.dblclick(pt.x, pt.y)
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  const menu = page.locator('[data-testid="code-ctx-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Ask about this/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Find references/ })).toBeVisible()

  // "Find in file" opens the search bar prefilled with the word.
  await menu.getByRole('menuitem', { name: /Find in file/ }).click()
  const bar = diff.locator('.fv-search-bar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.fv-search-input')).toHaveValue('syncedFn')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/1')
  await bar.locator('.fv-search-input').press('Escape')

  // Files viewer surface: same menu; "Find references" opens the ref panel.
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const row = explorer.locator('.session-file-explorer-node', { hasText: 'sync-caller.go' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  const editorSel = `.session-panel[data-session-id="${SESSION_ID}"] .fv-source-editor .cm-content`
  await expect(page.locator(editorSel)).toBeVisible({ timeout: 10_000 })
  const pt2 = await centerOfText(page, editorSel, 'HasSyncedForItems')
  await page.mouse.click(pt2.x, pt2.y, { button: 'right' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Find references/ }).click()
  await expect(explorer.locator('.ref-panel')).toBeVisible()
  await expect(explorer.locator('.ref-panel-row')).toHaveCount(3, { timeout: 10_000 })
})
