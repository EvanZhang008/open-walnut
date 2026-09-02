/**
 * Playwright browser tests for UNSAVED-EDIT SURVIVAL in the session Files panel.
 *
 * The reported bug: "I had unsaved edits, left the Files panel, came back, and
 * they were gone. Even unsaved, Walnut should keep a temporary copy." The buffer
 * lived only in `FileContentView`'s React state, so unmounting the pane dropped
 * it silently — the worst kind of data loss, because nothing ever told the user.
 *
 * What these pin (each is a way the feature can be "implemented" and still lose
 * work, or lie about not losing it):
 *   - Typing then LEAVING the panel entirely and coming back restores the text.
 *     Tab-switching away is the cheap version of this test; unmounting the whole
 *     explorer is the one that actually failed.
 *   - The restore is announced. A silently restored draft is indistinguishable
 *     from "my save worked", which would make the user stop pressing Save.
 *   - The tree marks which files hold unsaved work, because a draft you cannot
 *     find is only marginally better than a draft that was dropped.
 *   - Save clears the draft: a stale draft resurrecting over saved bytes would
 *     turn this safety net into a corruption source.
 *
 * The last three tests are the WIRING tests, added after a review found that the
 * rules had unit tests but nothing proved the components called them. They also
 * cover the disk-changed-underneath banner, which this file originally skipped as
 * "a server-fixture concern": it only needs a PUT between two reads, which the
 * browser can do directly.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
/**
 * Deliberately NOT under `test-results/`: Playwright wipes its output dir at the
 * start of every run, and that dir is shared with every other spec on this
 * machine — a concurrent run by another agent deleted these shots between the
 * run that produced them and the read that reviewed them. Evidence a human is
 * meant to open outlives one test run, so it goes to /tmp.
 */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel'

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
async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // Positional, not by label: the session row's text is derived from live state.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

/** Leave the Files panel the way a user does: switch the panel to another tab. */
async function leaveFilesPanel(page: Page): Promise<void> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await panel.getByRole('button', { name: 'Changed' }).click()
  // The explorer must actually unmount — that unmount is what used to drop the
  // buffer, so a test that leaves it mounted proves nothing.
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
}

/**
 * Come back to Files on the ALREADY-OPEN panel. Deliberately not a second
 * `openFilesPanel()`: opening the panel puts it in fullscreen over the homepage,
 * so the todo row it would click through to is covered and unclickable.
 */
async function returnToFilesPanel(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

/** The CodeMirror editing surface in the preview pane. */
function editor(page: Page): Locator {
  return page.locator('.fv-source-editor .cm-content')
}

/** Create a file through the API so the test owns a scratch target of its own. */
async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const cwd = await fixtureCwd(page)
  const abs = `${cwd}/${name}`
  const res = await page.request.post('/api/files/create', { data: { path: abs } })
  expect(res.status(), await res.text()).toBe(200)
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: body } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

test.beforeEach(async ({ page }) => {
  // Pin the tree EXPANDED before first render: the collapse pref syncs through
  // ui-prefs to the SHARED fixture server, so a parallel spec could otherwise
  // boot this page with no tree at all.
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('unsaved edits survive leaving the Files panel, and say so on return', async ({ page }) => {
  const name = `draft-${Date.now()}.txt`
  await makeScratchFile(page, name, 'original contents\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original contents')

  // Type an edit and do NOT save.
  const typed = `edited-but-never-saved-${Date.now()}`
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)
  // The dirty dot is the app's own signal that it registered the edit.
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-typed-unsaved.png` })

  // The draft is written on a 400ms debounce — leaving sooner must still flush it,
  // so wait past the debounce here and let the "leave immediately" case be covered
  // by the unmount flush in the unit tests rather than a racy sleep.
  await page.waitForTimeout(900)

  await leaveFilesPanel(page)
  const explorer2 = await returnToFilesPanel(page)

  // The file reopens on its own (remembered selection) and carries the edit.
  await expect(editor(page)).toContainText(typed, { timeout: 15_000 })
  // …and it is ANNOUNCED, not silently restored.
  await expect(page.locator('.fv-draft-note')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-restored-after-leaving.png` })

  // The tree marks the file as holding unsaved work.
  await expect(nodeByName(explorer2, name).locator('.sfe-draft-dot')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-tree-draft-dot.png` })
})

test('saving clears the draft and the tree marker', async ({ page }) => {
  const name = `draft-save-${Date.now()}.txt`
  await makeScratchFile(page, name, 'before\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('before')

  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-then-saved')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await page.waitForTimeout(900)
  await expect(nodeByName(explorer, name).locator('.sfe-draft-dot')).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // Dirty state and the tree marker both clear — the draft record is gone, so a
  // later reopen cannot resurrect pre-save text over the saved bytes.
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(nodeByName(explorer, name).locator('.sfe-draft-dot')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-saved-marker-cleared.png` })

  // And the reopened file shows the saved text with NO restore note.
  await leaveFilesPanel(page)
  await returnToFilesPanel(page)
  await expect(editor(page)).toContainText('-then-saved', { timeout: 15_000 })
  await expect(page.locator('.fv-draft-note')).toHaveCount(0)
})

/**
 * The WIRING tests. The rules behind these live in pure modules with their own unit
 * tests, but nothing in the node tier can prove the components CALL them:
 * `FileContentView.tsx` and `SessionFileExplorer.tsx` cannot be imported there at
 * all (a transitive `notePurify.addHook` blows up outside a browser). So each
 * scenario below is a real click path through the real components.
 *
 * Each one is a way to lose the user's typing that shipped at least once:
 *   - renaming a drafted file orphaned the draft at the old path, and the reopened
 *     file showed pre-edit disk bytes with no hint anything had been dropped,
 *   - deleting a drafted file RESURRECTED the draft, so creating that filename
 *     again offered to restore the deleted file's body,
 *   - restoring a draft over bytes that changed on disk disarmed the save lock, so
 *     the next Save silently replaced newer content (an agent's edit, typically).
 */
test('a rename carries the unsaved draft to the new name', async ({ page }) => {
  const name = `draft-ren-${Date.now()}.txt`
  const renamed = `draft-ren-done-${Date.now()}.txt`
  await makeScratchFile(page, name, 'before rename\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('before rename')

  const typed = `carried-${Date.now()}`
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await page.waitForTimeout(900)

  // Rename through the real menu, exactly as a user would.
  await nodeByName(explorer, name).click({ button: 'right' })
  await page.getByTestId('file-ctx-menu').getByRole('menuitem', { name: 'Rename…' }).click()
  const renameInput = explorer.getByRole('textbox', { name: 'New name' })
  await expect(renameInput).toBeVisible()
  await renameInput.fill(renamed)
  await renameInput.press('Enter')
  await expect(nodeByName(explorer, renamed)).toBeVisible({ timeout: 10_000 })

  // The typing followed the file, and the tree marks the NEW name as drafted.
  await expect(editor(page)).toContainText(typed, { timeout: 15_000 })
  await expect(nodeByName(explorer, renamed).locator('.sfe-draft-dot')).toBeVisible()
  await expect(nodeByName(explorer, name)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/5-draft-followed-rename.png` })
})

test('deleting a drafted file does not leave a draft behind for that name', async ({ page }) => {
  const name = `draft-del-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'original\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original')
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('never-saved-and-then-deleted')
  await expect(nodeByName(explorer, name).locator('.sfe-draft-dot')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900)

  await nodeByName(explorer, name).click({ button: 'right' })
  await page.getByTestId('file-ctx-menu').getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.app-modal-btn.primary.danger').click()
  await expect(nodeByName(explorer, name)).toHaveCount(0, { timeout: 10_000 })

  // Recreate the SAME name with fresh content. The deleted file's body must not
  // come back, and no restore note may appear.
  const res = await page.request.post('/api/files/create', { data: { path: abs } })
  expect(res.status(), await res.text()).toBe(200)
  await page.request.put('/api/file-content', { data: { path: abs, content: 'brand new\n' } })
  await explorer.getByRole('button', { name: 'Refresh' }).click()
  await nodeByName(explorer, name).click()

  await expect(editor(page)).toContainText('brand new', { timeout: 15_000 })
  await expect(editor(page)).not.toContainText('never-saved-and-then-deleted')
  await expect(page.locator('.fv-draft-note')).toHaveCount(0)
  await expect(page.locator('.fv-draft-banner')).toHaveCount(0)
  await expect(nodeByName(explorer, name).locator('.sfe-draft-dot')).toHaveCount(0)
})

test('restoring a draft over changed bytes warns on save instead of overwriting', async ({ page }) => {
  const name = `draft-conflict-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'v1 from disk\n')

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('v1 from disk')

  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('my-unsaved-line')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await page.waitForTimeout(900)

  // Something else rewrites the file — in real use this is the session's agent.
  const put = await page.request.put('/api/file-content', {
    data: { path: abs, content: 'v2 written by someone else\n' },
  })
  expect(put.ok(), await put.text()).toBe(true)

  // Re-reading now finds a draft whose base bytes are stale → the choice banner.
  await explorer.getByRole('button', { name: 'Refresh' }).click()
  const banner = page.locator('.fv-draft-banner')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/6-stale-draft-banner.png` })

  await banner.getByRole('button', { name: /Restore my changes/i }).click()
  await expect(editor(page)).toContainText('my-unsaved-line')

  // THE POINT: saving must not silently replace v2. The lock stays armed at the
  // draft's own base, so the first Save conflicts and asks.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const conflict = page.locator('.fv-save-error')
  await expect(conflict).toBeVisible({ timeout: 15_000 })
  await expect(conflict).toContainText('changed on disk since you opened it')
  // The buffer survives the refusal — a conflict that also ate the typing would
  // be a worse bug than the silent overwrite it replaced.
  await expect(editor(page)).toContainText('my-unsaved-line')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/7-save-conflict-warned.png` })

  // And the file on disk is still what the other writer put there.
  const onDisk = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`)
  expect((await onDisk.json()).content).toContain('v2 written by someone else')
})
