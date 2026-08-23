/**
 * DEMO RECORDING (not a regression test — skipped unless PW_DEMO=1).
 *
 * Records a video walkthrough of the Changed-tab code intelligence:
 *   1. Open the Changed tab of a session.
 *   2. ⌘F in-diff search: type a symbol, see match count, Enter cycles, a
 *      gutter-only number gets "No results".
 *   3. Double-click a word — every exact match in the diff lights up.
 *   4. Cmd+click a symbol — reference panel opens; a row in another file opens
 *      as an in-tab ghost context view (keyword flashed), and "Open in Files"
 *      crosses to the Files tab at the same line.
 *   5. Right-click a selection — OUR context menu (Copy / Ask / Find
 *      references / Find in file), on the diff AND on the Files viewer.
 *
 * Run: PW_DEMO=1 npx playwright test tests/e2e/browser/changed-code-intel-demo.spec.ts
 * Video lands in test-results/<test-dir>/video.webm.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-changed-session'
const TASK_ID = 'pw-task-changed'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// Shares pw-changed-session with changed-code-intel.spec.ts (whose serial mode
// only covers ITS file) — run this spec alone, never PW_DEMO=1 on the full suite.
test.skip(process.env.PW_DEMO !== '1', 'demo recording only — run with PW_DEMO=1')

test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } }, viewport: { width: 1440, height: 900 } })

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

/** Type like a person so the video is watchable. */
async function typeSlow(page: Page, sel: string, text: string) {
  await page.locator(sel).pressSequentially(text, { delay: 90 })
}

test('demo: Changed-tab search, highlight, references, right-click menu', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800)

  // ── Open the session's Changed tab ────────────────────────────────────
  await page.locator('.todo-search-input').pressSequentially(SESSION_ID, { delay: 40 })
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.waitForTimeout(500)
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await page.waitForTimeout(600)
  await panel.getByRole('button', { name: 'Changed' }).click()
  const diff = panel.locator('.session-diff-view')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  await expect(diff.locator('.session-diff-filepane[data-file-path$="sync-controller.go"]'))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1200)

  // ── 1. ⌘F search inside the diff ──────────────────────────────────────
  await diff.locator('.session-diff-main').click()
  await page.keyboard.press(`${MOD}+f`)
  const bar = diff.locator('.fv-search-bar')
  await expect(bar).toBeVisible()
  await typeSlow(page, '.fv-search-bar .fv-search-input', 'HasSyncedForItems')
  await expect(bar.locator('.fv-search-count')).toHaveText('1/2')
  await page.waitForTimeout(1200)
  await bar.locator('.fv-search-input').press('Enter')
  await page.waitForTimeout(900)
  await bar.locator('.fv-search-input').press('Enter')
  await page.waitForTimeout(900)
  // Gutter line numbers are excluded from search.
  await bar.locator('.fv-search-input').fill('')
  await typeSlow(page, '.fv-search-bar .fv-search-input', '12')
  await expect(bar.locator('.fv-search-count')).toHaveText('No results')
  await page.waitForTimeout(1400)
  await bar.locator('.fv-search-input').press('Escape')
  await page.waitForTimeout(800)

  // ── 2. Select a word → every exact match highlights ───────────────────
  const pt = await centerOfText(page, DIFF_MAIN, 'HasSyncedForItems')
  await page.mouse.dblclick(pt.x, pt.y)
  await page.waitForTimeout(1800)

  // ── 3. Cmd+click → references → in-tab ghost context → Open in Files ──
  await page.keyboard.down(MOD)
  await page.mouse.click(pt.x, pt.y)
  await page.keyboard.up(MOD)
  const refPanel = diff.locator('.ref-panel')
  await expect(refPanel).toBeVisible()
  await expect(refPanel.locator('.ref-panel-row')).toHaveCount(3, { timeout: 10_000 })
  await page.waitForTimeout(1800)
  await refPanel.locator('.ref-panel-row', { hasText: 'c.factory.HasSyncedForItems(nil)' }).click()
  const ghost = diff.locator('.session-diff-ghost')
  await expect(ghost).toBeVisible({ timeout: 10_000 })
  await expect(ghost.locator('.cm-jump-flash')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2200)
  await ghost.getByRole('button', { name: 'Open in Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.cm-jump-flash')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2000)

  // ── 4. Right-click menu on the Files viewer ───────────────────────────
  const editorSel = `.session-panel[data-session-id="${SESSION_ID}"] .fv-source-editor .cm-content`
  await expect(page.locator(editorSel)).toBeVisible({ timeout: 10_000 })
  const pt2 = await centerOfText(page, editorSel, 'HasSyncedForItems')
  await page.mouse.dblclick(pt2.x, pt2.y)
  await page.waitForTimeout(700)
  await page.mouse.click(pt2.x, pt2.y, { button: 'right' })
  const menu = page.locator('[data-testid="code-ctx-menu"]')
  await expect(menu).toBeVisible()
  await page.waitForTimeout(2000)
  await menu.getByRole('menuitem', { name: /Find references/ }).click()
  await expect(explorer.locator('.ref-panel')).toBeVisible()
  await expect(explorer.locator('.ref-panel-row')).toHaveCount(3, { timeout: 10_000 })
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')

  // ── 5. Right-click menu back on the Changed tab ───────────────────────
  await panel.getByRole('button', { name: 'Changed' }).click()
  await expect(diff.locator('.session-diff-filepane[data-file-path$="sync-controller.go"]'))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800)
  const pt3 = await centerOfText(page, DIFF_MAIN, 'syncedFn')
  await page.mouse.dblclick(pt3.x, pt3.y)
  await page.waitForTimeout(600)
  await page.mouse.click(pt3.x, pt3.y, { button: 'right' })
  await expect(menu).toBeVisible()
  await page.waitForTimeout(2000)
  await menu.getByRole('menuitem', { name: /Find in file/ }).click()
  await expect(bar).toBeVisible()
  await expect(bar.locator('.fv-search-input')).toHaveValue('syncedFn')
  await page.waitForTimeout(2200)
})
