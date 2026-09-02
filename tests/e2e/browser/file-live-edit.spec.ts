/**
 * Playwright browser tests for LIVE EDIT in the session Files panel.
 *
 * Live mode writes the buffer to disk shortly after the user stops typing, and
 * answers the one thing that makes auto-save dangerous in a directory an agent
 * is also editing: a 409 from the optimistic lock. Instead of a banner, it
 * re-reads disk and three-way-merges; only an overlapping edit stops it.
 *
 * What these pin, each a way the feature could ship and still lose work:
 *   - the auto-write really reaches disk and clears the dirty state,
 *   - a non-overlapping write from someone else is FOLDED IN, both edits land,
 *     and the user is told (a silent merge is indistinguishable from "nothing
 *     happened", which is how a user learns to distrust the mode),
 *   - an overlapping write PAUSES live mode for that file with the user's text
 *     still in the editor and the other writer's bytes still on disk — neither
 *     side is thrown away by a guess,
 *   - switching files lands the outgoing file's last burst under ITS path.
 *
 * The merge rule itself has 28 unit tests (tests/web/three-way-merge.test.ts);
 * these are the wiring tests through the real components.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
/** Not under test-results/: that dir is wiped by every concurrent run. */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/live-edit'

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

function liveToggle(page: Page): Locator {
  return page.locator('.fv-live-toggle')
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
  const res = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`, {
    headers: { 'cache-control': 'no-store' },
  })
  expect(res.ok()).toBe(true)
  return (await res.json()).content as string
}

/** Someone else (an agent, another tab) rewrites the file. No expectedHash: the
 *  other writer does not hold our lock, which is exactly what makes our next
 *  write 409. */
async function externalWrite(page: Page, abs: string, content: string): Promise<void> {
  const put = await page.request.put('/api/file-content', { data: { path: abs, content } })
  expect(put.ok(), await put.text()).toBe(true)
}

/** Place the caret at the START of a given 1-based line (click, then Home). */
async function caretToLineStart(page: Page, line: number): Promise<void> {
  await editor(page).locator('.cm-line').nth(line - 1).click()
  await page.keyboard.press('Home')
}

async function openFileLive(page: Page, explorer: Locator, name: string, expectText: string): Promise<void> {
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText(expectText)
  const toggle = liveToggle(page)
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveClass(/active/)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      // Every test starts with live mode OFF and turns it on itself: the pref is
      // global, and a previous test leaving it on would hide a broken toggle.
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('live mode writes the buffer to disk after typing stops, and remembers being on', async ({ page }) => {
  const name = `live-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'first line\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'first line')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-live-on.png` })

  const typed = `typed-live-${Date.now()}`
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)

  // No Save click. The bytes must reach disk on their own, and the dirty state
  // must clear — a dirty dot that stays lit after an auto-write would teach the
  // user to press Save anyway, which defeats the mode.
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain(typed)
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-auto-written.png` })

  // The preference is global and survives the page: stored, not just in state.
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-live-edit'))).toBe('1')
})

test('a non-overlapping change from disk is merged into the live buffer and written back', async ({ page }) => {
  const name = `live-merge-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'middle')

  // Another writer changes the LAST line while we hold the lock on the old bytes.
  await externalWrite(page, abs, 'top\nmiddle\nbottom-by-agent\n')

  // We edit the FIRST line. The auto-write 409s, live mode re-reads disk, and the
  // two edits touch different lines → both survive.
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')

  const receipt = page.locator('.fv-live-receipt')
  await expect(receipt).toBeVisible({ timeout: 10_000 })
  await expect(receipt).toContainText(/^Merged/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-merged-receipt.png` })

  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('ours-top\nmiddle\nbottom-by-agent\n')
  // The editor shows the merged text too — the other writer's line arrived in
  // place, without a remount (the buffer still has our edit).
  await expect(editor(page)).toContainText('ours-top')
  await expect(editor(page)).toContainText('bottom-by-agent')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(liveToggle(page)).toHaveClass(/active/)
})

test('an overlapping change pauses live mode for the file and keeps both versions', async ({ page }) => {
  const name = `live-conflict-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'line one\nline two\nline three\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'line two')

  // Both sides rewrite line 1 — no merge can decide this.
  await externalWrite(page, abs, 'THEIRS one\nline two\nline three\n')
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')

  // Live mode pauses for THIS file (the pill is no longer active) and says why.
  const toggle = liveToggle(page)
  await expect(toggle).toHaveClass(/fv-live-suspended/, { timeout: 10_000 })
  await expect(toggle).not.toHaveClass(/active/)
  const notice = page.locator('.fv-save-error')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Live edit is paused for this file')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-conflict-paused.png` })

  // Neither side was thrown away: our text is still in the editor (dirty), and
  // the other writer's bytes are still what is on disk.
  await expect(editor(page)).toContainText('ours-line one')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  expect(await onDisk(page, abs)).toBe('THEIRS one\nline two\nline three\n')

  // Clicking the pill on a paused file resumes it (it does not flip the global
  // preference off, which is what a naive toggle would do here).
  await toggle.click()
  await expect(toggle).toHaveClass(/active/)
  await expect(toggle).not.toHaveClass(/fv-live-suspended/)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-live-edit'))).toBe('1')
})

test('switching files lands the outgoing file\'s last burst under its own path', async ({ page }) => {
  const stamp = Date.now()
  const nameA = `live-a-${stamp}.txt`
  const nameB = `live-b-${stamp}.txt`
  const absA = await makeScratchFile(page, nameA, 'file A\n')
  const absB = await makeScratchFile(page, nameB, 'file B\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, nameA, 'file A')

  // Line 1 explicitly: a click on the editor body lands on the empty line the
  // trailing newline leaves, and End there would type a new line, not an edit.
  await editor(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' plus-a-edit')
  // Switch BEFORE the 600ms debounce would have fired.
  await nodeByName(explorer, nameB).click()
  await expect(editor(page)).toContainText('file B')

  // A's bytes land on A's path; B is untouched — a stale closure here would
  // write A's text under B's path, the one failure this record-per-write design
  // exists to make impossible.
  await expect.poll(() => onDisk(page, absA), { timeout: 10_000 }).toBe('file A plus-a-edit\n')
  expect(await onDisk(page, absB)).toBe('file B\n')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/5-switch-landed.png` })
})
