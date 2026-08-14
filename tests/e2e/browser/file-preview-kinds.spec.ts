/**
 * Playwright browser tests for the file preview's THREE user-reported gaps
 * (2026-08-09):
 *
 *  1. Clicking a vault note (`.md` under the notes vault) used to NAVIGATE THE
 *     WHOLE APP to /notes — jarring mid-session, with no way back. It must now
 *     open in place like any other file, with an explicit "Open in Notes" button
 *     as the opt-in jump.
 *  2. PDFs (and images) must be viewable, using the BROWSER's own viewer — no
 *     bundled PDF renderer.
 *  3. Right-clicking in the file tree must show WALNUT's menu (Reveal in Finder,
 *     Open in Notes, Copy path…), not the browser's "Back / Reload / View Source".
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = 'test-results/file-preview-kinds'

/**
 * Open the fixture session's panel from the homepage and switch to the Files tab.
 *
 * The kebab's session row is targeted POSITIONALLY (first item), not by label:
 * its text is derived from live status/phase ("Session idle" / "Needs your
 * attention" / "AI is working…"), so a label matcher makes the helper flake as
 * soon as the fixture session's phase moves.
 */
async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  // The list is filtered asynchronously (debounced search → re-render), so the
  // row appears a beat after fill(). The default 5s expect timeout is enough on
  // an idle box but not on a loaded one, where a whole-file run queues behind
  // other agents' vitest/Playwright — that's what made this flake at the tail of
  // a full-file run while passing in isolation.
  await expect(task).toBeVisible({ timeout: 30_000 })
  await task.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await menu.locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/** Click a file row by name in the tree and wait for its preview to mount. */
async function selectFile(explorer: ReturnType<Page['locator']>, name: string) {
  const row = explorer.locator('.session-file-explorer-node', { hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  return row
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('PDF renders in the browser’s own viewer, not a download dead-end', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  await selectFile(explorer, 'contract.pdf')

  // An <iframe> pointed at the raw-bytes endpoint — that URL is what makes the
  // browser use PDF.js. The old code fell through to "Binary file — cannot display".
  const frame = explorer.locator('.fv-doc-preview')
  await expect(frame).toBeVisible({ timeout: 10_000 })
  const src = await frame.getAttribute('src')
  expect(src).toContain('/api/file-content')
  expect(src).toContain('raw=1')
  expect(src).toContain('contract.pdf')
  await expect(explorer.locator('.file-viewer-error')).toHaveCount(0)

  // And the server really labels it application/pdf (the whole reason the
  // browser viewer engages instead of showing mojibake text).
  const res = await page.request.get(src!)
  expect(res.ok()).toBe(true)
  expect(res.headers()['content-type']).toBe('application/pdf')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/pdf-preview.png`, fullPage: false })
})

test('PNG renders as an inline image with Download available', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  await selectFile(explorer, 'diagram.png')

  const img = explorer.locator('.fv-image-preview img')
  await expect(img).toBeVisible({ timeout: 10_000 })
  // Decoded by the browser — a broken/errored <img> has naturalWidth 0.
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(explorer.locator('a.fv-download-btn')).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/image-preview.png`, fullPage: false })
})

test('clicking a vault note previews IN PLACE — no jump to /notes', async ({ page }) => {
  const explorer = await openFilesPanel(page)

  // Root the explorer at the notes vault via the toolbar path field.
  const notesDir = await page.request.get('/api/config')
    .then((r) => r.json())
    .then((b) => b.notesDir as string)
  expect(notesDir).toBeTruthy()

  const urlBefore = page.url()
  await explorer.locator('.sfe-root-path').click()
  await explorer.locator('.sfe-root-path-input').fill(notesDir)
  await explorer.locator('.sfe-root-path-input').press('Enter')

  await selectFile(explorer, 'vault-note.md')

  // The note's CONTENT is on screen inside the session panel... (plain md's
  // Preview tab is the WYSIWYG editor since e46b8f00, not .fv-md-preview)
  await expect(explorer.locator('.fv-wysiwyg-editor')).toContainText('VAULT_NOTE_MARKER', { timeout: 10_000 })
  // ...and the app did NOT navigate away. This is the regression under test.
  expect(page.url()).toBe(urlBefore)
  await expect(page.locator('.notes-page, .notes-layout')).toHaveCount(0)

  // The jump is still ONE click, just opt-in.
  await expect(explorer.locator('button.fv-notes-btn')).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/vault-note-in-place.png`, fullPage: false })
})

test('"Open in Notes" button navigates to the note on /notes', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const notesDir = await page.request.get('/api/config')
    .then((r) => r.json())
    .then((b) => b.notesDir as string)

  await explorer.locator('.sfe-root-path').click()
  await explorer.locator('.sfe-root-path-input').fill(notesDir)
  await explorer.locator('.sfe-root-path-input').press('Enter')
  await selectFile(explorer, 'vault-note.md')

  await explorer.locator('button.fv-notes-btn').click()
  await expect.poll(() => page.url()).toContain('/notes')
  expect(decodeURIComponent(page.url())).toContain('vault-note.md')

  // REGRESSION (2026-08-09, "click Open in Notes, everything is blur"): the Files
  // split view is FULLSCREEN, and its backdrop is a portal onto document.body —
  // outside the subtree App.tsx hides on navigation. MainPage never unmounts, so
  // the blurring sheet survived the route change and covered the Notes page with
  // nothing to dismiss it. The landing page must be clean and interactive.
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(0)
  // Not merely absent from the DOM — the page underneath must actually be usable.
  const notesTree = page.locator('.notes-tree-panel, .notes-layout, .notes-page').first()
  await expect(notesTree).toBeVisible({ timeout: 15_000 })
  // A leftover fixed sheet would intercept the pointer at the page's centre.
  const hitIsInsideNotes = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return !el?.closest('.open-walnut-fullscreen-backdrop')
  })
  expect(hitIsInsideNotes).toBe(true)
  // Body scroll lock is ref-counted; leaving fullscreen must release it too.
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
})

test('any route change out of a fullscreen split view drops the backdrop', async ({ page }) => {
  // The same leak reached WITHOUT the notes button, proving the fix lives in
  // useFullscreen (shared by five consumers) rather than in the Open-in-Notes
  // click path.
  //
  // The navigation is driven through history, not a sidebar click, ON PURPOSE:
  // a fullscreen panel legitimately covers the sidebar, so its links are
  // pointer-intercepted (Playwright times out on them — which is itself
  // evidence fullscreen works). Back/forward is a real SPA route change and
  // exercises exactly the code path under test.
  const explorer = await openFilesPanel(page)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)

  const homeUrl = page.url()
  await page.evaluate(() => { window.history.pushState({}, '', '/calendar'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await expect.poll(() => page.url()).toContain('/calendar')
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(explorer).toBeHidden()

  // Coming back must not resurrect it — the state was reset, not just masked.
  await page.goBack()
  await expect.poll(() => page.url()).toBe(homeUrl)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  // And the body scroll lock was released on the way out.
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
})

test('a non-note .md shows NO "Open in Notes" button', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  // nested-fence.md lives in the project fixture dir, outside the vault.
  // (Plain md's Preview tab is the WYSIWYG editor since e46b8f00.)
  await selectFile(explorer, 'nested-fence.md')
  await expect(explorer.locator('.fv-wysiwyg-editor')).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('button.fv-notes-btn')).toHaveCount(0)
})

test('right-click in the tree opens Walnut’s own menu (not the browser’s)', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const row = explorer.locator('.session-file-explorer-node', { hasText: 'refresh-target.txt' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })

  await row.click({ button: 'right' })
  const menu = page.locator('[data-testid="file-ctx-menu"]')
  await expect(menu).toBeVisible()

  // The actions the user asked for. Reveal/Default-app only exist on a macOS
  // console, so they're asserted conditionally against the server's own capability.
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open in new tab' })).toBeVisible()

  const canReveal = await page.request.get('/api/config')
    .then((r) => r.json())
    .then((b) => b.canRevealLocalFiles === true)
  await expect(menu.getByRole('menuitem', { name: 'Reveal in Finder' }))
    .toHaveCount(canReveal ? 1 : 0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/context-menu.png`, fullPage: false })

  // Escape closes it (and the backdrop must not leave the pane click-blocked).
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.file-ctx-backdrop')).toHaveCount(0)
})

test('right-clicking a vault note offers "Open in Notes" in the menu', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const notesDir = await page.request.get('/api/config')
    .then((r) => r.json())
    .then((b) => b.notesDir as string)

  await explorer.locator('.sfe-root-path').click()
  await explorer.locator('.sfe-root-path-input').fill(notesDir)
  await explorer.locator('.sfe-root-path-input').press('Enter')

  const row = explorer.locator('.session-file-explorer-node', { hasText: 'vault-note.md' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click({ button: 'right' })

  const menu = page.locator('[data-testid="file-ctx-menu"]')
  await expect(menu).toBeVisible()
  // Patched in asynchronously once the vault check resolves.
  await expect(menu.getByRole('menuitem', { name: 'Open in Notes' })).toBeVisible({ timeout: 5_000 })
})
