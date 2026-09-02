/**
 * A recorded WALKTHROUGH of the session Files panel, for a human to watch.
 *
 * The behaviour here is already pinned by `file-explorer-mutations.spec.ts` and
 * `file-draft-persistence.spec.ts`; this file exists to produce the artifact those
 * two don't: one continuous video of the whole feature set in the order a person
 * would meet it (create a folder, create a file in it, edit and save, edit and
 * DON'T save, walk away, come back, turn on live edit and watch it write and merge
 * another writer's change, look back through the file's history, rename,
 * duplicate, delete).
 *
 * Two deliberate choices:
 *   - It builds its OWN browser context instead of using the `page` fixture,
 *     because `recordVideo` is a context option and the video has to land somewhere
 *     durable. Playwright's `outputDir` is wiped at the start of every run and is
 *     shared machine-wide, so a concurrent run by another agent would delete it.
 *   - It still asserts. A "demo recording" that only clicks produces a convincing
 *     video of a broken feature, which is worse than no video at all — every step
 *     below waits on the state it just caused.
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const OUT_DIR = '/tmp/walnut-files-panel'
const VIDEO_DIR = `${OUT_DIR}/video`

/** Long enough for a viewer to register what changed, short enough to stay watchable. */
const BEAT = 700

async function beat(page: Page, ms = BEAT) {
  await page.waitForTimeout(ms)
}

function rowByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name })
}

function nodeByName(explorer: Locator, name: string) {
  return rowByName(explorer, name).locator('xpath=..')
}

async function rightClick(page: Page, target: Locator) {
  await target.click({ button: 'right' })
  const menu = page.getByTestId('file-ctx-menu')
  await expect(menu).toBeVisible()
  await beat(page, 500)
  return menu
}

// A watchable walkthrough is deliberately slower than a test: the BEATs alone are
// ~15s, and the whole tour has run 25-50s depending on machine load. The 30s
// project default ended it mid-flow (and then reported the failure as
// `browserContext.close: Test ended`, which reads like a teardown bug).
test.setTimeout(180_000)

test('recorded walkthrough: create, edit, keep unsaved work, live edit + merge, history, rename, duplicate, delete', async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL
  expect(baseURL, 'baseURL must come from playwright.config.ts, never hardcoded').toBeTruthy()

  await fs.mkdir(VIDEO_DIR, { recursive: true })
  const context = await (browser as Browser).newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()

  const stamp = Date.now()
  const dirName = `tour-${stamp}`
  const fileName = 'notes.txt'
  const renamed = 'release-notes.txt'
  const duplicated = 'release-notes copy.txt'
  let cwd = ''

  try {
    // The collapse pref syncs to the SHARED fixture server, so pin the tree open
    // before first paint or a parallel spec's preference decides what we record.
    await page.addInitScript(() => {
      try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
    expect(res.ok()).toBe(true)
    cwd = ((await res.json())?.session?.cwd ?? '') as string
    expect(cwd).toBeTruthy()

    // ── Open the session's Files panel ───────────────────────────────────────
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
    await beat(page, 1200)

    // ── New Folder… ──────────────────────────────────────────────────────────
    let menu = await rightClick(page, explorer.locator('.sfe-root-header').first())
    await menu.getByRole('menuitem', { name: 'New Folder…' }).click()
    const folderInput = explorer.getByRole('textbox', { name: 'New folder name' })
    await expect(folderInput).toBeVisible()
    await folderInput.pressSequentially(dirName, { delay: 45 })
    await folderInput.press('Enter')
    await expect(rowByName(explorer, dirName)).toBeVisible({ timeout: 10_000 })
    await beat(page)

    // ── New File… inside that folder ─────────────────────────────────────────
    menu = await rightClick(page, rowByName(explorer, dirName))
    await menu.getByRole('menuitem', { name: 'New File…' }).click()
    const fileInput = explorer.getByRole('textbox', { name: 'New file name' })
    await expect(fileInput).toBeVisible()
    await fileInput.pressSequentially(fileName, { delay: 45 })
    await fileInput.press('Enter')
    // Creating a file opens it — no hunting for the row you just made.
    await expect(rowByName(explorer, fileName)).toBeVisible({ timeout: 10_000 })
    const editor = page.locator('.fv-source-editor .cm-content')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await beat(page)

    // ── Type and SAVE ────────────────────────────────────────────────────────
    await editor.click()
    await page.keyboard.type('Files panel: right-click to create, rename, delete.', { delay: 22 })
    await expect(page.locator('.fv-dirty-dot')).toBeVisible()
    await beat(page)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
    await beat(page)

    // ── Type and DON'T save, then walk away ──────────────────────────────────
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type('\nThis line was never saved.', { delay: 22 })
    await expect(page.locator('.fv-dirty-dot')).toBeVisible()
    // The tree marks which file is holding unsaved work.
    await expect(nodeByName(explorer, fileName).locator('.sfe-draft-dot')).toBeVisible({ timeout: 10_000 })
    await beat(page, 1000)

    await panel.getByRole('button', { name: 'Changed' }).click()
    await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
    await beat(page, 1200)

    await panel.getByRole('button', { name: 'Files' }).click()
    await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 15_000 })
    // The unsaved line came back, and the app SAYS it restored it rather than
    // leaving the user to assume their save had worked.
    await expect(editor).toContainText('This line was never saved.', { timeout: 15_000 })
    await expect(page.locator('.fv-draft-note')).toBeVisible()
    await beat(page, 1500)
    await page.screenshot({ path: `${OUT_DIR}/tour-1-draft-restored.png` })

    // Save it so the rest of the tour isn't fighting a dirty buffer.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
    await beat(page)

    // ── Live edit: type, and it is on disk before you reach for Save ─────────
    const filePath = `${cwd}/${dirName}/${fileName}`
    const onDisk = async () => {
      const r = await page.request.get(`/api/file-content?path=${encodeURIComponent(filePath)}`)
      return (await r.json()).content as string
    }
    const liveToggle = page.locator('.fv-live-toggle')
    await liveToggle.click()
    await expect(liveToggle).toHaveClass(/active/)
    await beat(page, 900)
    await editor.locator('.cm-line').last().click()
    await page.keyboard.press('End')
    await page.keyboard.type('\nLive edit writes this line by itself.', { delay: 22 })
    await expect.poll(onDisk, { timeout: 10_000 }).toContain('Live edit writes this line by itself.')
    await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
    await beat(page, 1200)
    await page.screenshot({ path: `${OUT_DIR}/tour-4-live-written.png` })

    // ── Someone else writes the file too — the edits are merged, not fought ──
    // (In real use this is the session's agent; here it is a direct PUT.)
    const before = await onDisk()
    const put = await page.request.put('/api/file-content', {
      data: { path: filePath, content: `An agent added this line at the top.\n${before}` },
    })
    expect(put.ok()).toBe(true)
    await editor.locator('.cm-line').last().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (and you kept typing)', { delay: 22 })
    const receipt = page.locator('.fv-live-receipt')
    await expect(receipt).toBeVisible({ timeout: 10_000 })
    await expect(receipt).toContainText(/^Merged/)
    await expect(editor).toContainText('An agent added this line at the top.')
    await expect(editor).toContainText('(and you kept typing)')
    await expect.poll(onDisk, { timeout: 10_000 }).toContain('(and you kept typing)')
    await beat(page, 1800)
    await page.screenshot({ path: `${OUT_DIR}/tour-5-live-merged.png` })
    // Back to explicit saves for the rest of the tour.
    await liveToggle.click()
    await expect(liveToggle).not.toHaveClass(/active/)

    // ── History: every open and save is a version; look back, restore ────────
    await page.getByRole('button', { name: 'History', exact: true }).click()
    const flyout = page.getByTestId('file-history-flyout')
    await expect(flyout).toBeVisible()
    const rows = flyout.locator('.fh-row')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })
    await beat(page, 1500)
    await rows.last().click()
    await expect(flyout.locator('.fh-diff-table')).toBeVisible({ timeout: 10_000 })
    await beat(page, 2000)
    await page.screenshot({ path: `${OUT_DIR}/tour-6-history-diff.png` })
    await flyout.getByRole('button', { name: 'Restore this version' }).click()
    // Restored as UNSAVED work: the dirty dot is back and nothing was written.
    await expect(page.locator('.fv-dirty-dot')).toBeVisible()
    await beat(page, 1200)
    await page.getByRole('button', { name: 'Discard' }).click()
    const discardModal = page.locator('.app-modal')
    await expect(discardModal).toBeVisible()
    await discardModal.getByRole('button', { name: 'Discard' }).click()
    await expect(page.locator('.fv-dirty-dot')).toHaveCount(0, { timeout: 10_000 })
    await flyout.getByRole('button', { name: 'Close history' }).click()
    await expect(flyout).toHaveCount(0)
    await beat(page)

    // ── Rename… (the stem arrives selected, so the extension survives) ───────
    menu = await rightClick(page, rowByName(explorer, fileName))
    await menu.getByRole('menuitem', { name: 'Rename…' }).click()
    const renameInput = explorer.getByRole('textbox', { name: 'New name' })
    await expect(renameInput).toBeVisible()
    await renameInput.fill(renamed)
    await renameInput.press('Enter')
    await expect(rowByName(explorer, renamed)).toBeVisible({ timeout: 10_000 })
    await beat(page)

    // ── Duplicate (no dialog; Escape keeps the copy) ─────────────────────────
    menu = await rightClick(page, rowByName(explorer, renamed))
    await menu.getByRole('menuitem', { name: 'Duplicate' }).click()
    const dupInput = explorer.getByRole('textbox', { name: 'New name' })
    await expect(dupInput).toBeVisible({ timeout: 10_000 })
    await expect(dupInput).toHaveValue(duplicated)
    await dupInput.press('Escape')
    await expect(rowByName(explorer, duplicated)).toBeVisible()
    await beat(page)
    await page.screenshot({ path: `${OUT_DIR}/tour-2-duplicated.png` })

    // ── Delete, through the app's own confirm (never window.confirm) ─────────
    menu = await rightClick(page, rowByName(explorer, duplicated))
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const modal = page.locator('.app-modal')
    await expect(modal).toBeVisible()
    await expect(modal.locator('.app-modal-title')).toContainText(duplicated)
    await beat(page, 900)
    await page.screenshot({ path: `${OUT_DIR}/tour-3-delete-confirm.png` })
    await modal.locator('.app-modal-btn.primary.danger').click()
    await expect(rowByName(explorer, duplicated)).toHaveCount(0, { timeout: 10_000 })
    await beat(page, 1200)
  } finally {
    // Close the context BEFORE saving: Playwright only finalizes the video file
    // on close, so `saveAs()` on a live context copies a truncated stream.
    const video = page.video()
    await context.close()
    if (video) {
      await video.saveAs(`${OUT_DIR}/files-panel-walkthrough.webm`)
      // eslint-disable-next-line no-console
      console.log(`[tour] video → ${OUT_DIR}/files-panel-walkthrough.webm`)
    }
    if (cwd) await fs.rm(path.join(cwd, dirName), { recursive: true, force: true })
  }
})
