/**
 * Playwright browser tests for the Files panel's navigation memory — the
 * 2026-08-09 report: "if I open a file by clicking a link in a session, when I
 * click Files it should remember the last open file and go there automatically,
 * and we can have a left and right so it remembers, like a browser".
 *
 * ROOT CAUSE the first test pins: the "last file I was reading" memory was keyed
 * by the explorer's TREE ROOT, and the two ways into the Files panel resolve to
 * different roots for the SAME session — a chat file-path click roots at the
 * clicked file's parent dir, the Files chip roots at the host HOME. So the
 * click wrote one key and the chip read another: the chip always reopened on the
 * empty pane (then "Select a file to preview", now "No file open"). Both now
 * key by a stable session SCOPE, and the tree expands to reveal the restored
 * file.
 *
 * The rest cover the browser-style ‹ › history: Back returns to the previous
 * file, Forward returns to the one you left, ⌘[ / ⌘] do the same from the
 * keyboard, and the buttons are disabled at each end of the stack.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { goToSessionFolder } from './todo-panel-helpers'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/file-view-history'

// The ‹ › buttons sit in the document bar only while it has room; a narrow
// pane, or a name the bar would cut, folds them into ⋯ (data-fold 2 and on). A
// wide window keeps them in the bar, which is what these tests click.
test.use({ viewport: { width: 1920, height: 900 } })

/**
 * Open the fixture session's panel from the homepage (real clicks, no page.goto).
 *
 * The task menu has no open-session row any more; the row itself is the
 * one-click way in (the same click a user makes).
 */
async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  // Generous timeouts throughout: search is debounced and this machine runs several
  // agent sessions, so the default 5s expect budget is a coin flip under load.
  await expect(task).toBeVisible({ timeout: 20_000 })
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

async function openFiles(panel: Locator): Promise<Locator> {
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  await goToSessionFolder(explorer)
  return explorer
}

/**
 * Toggle the Files panel off. When the panel was opened by a chat file-path click,
 * the chip's FIRST click re-roots the explorer to the host HOME and only the
 * second closes it (SessionPanel.toggleView) — so retry once rather than assume
 * one click always closes.
 */
async function closeFiles(panel: Locator) {
  const chip = panel.getByRole('button', { name: 'Files', exact: true })
  await chip.click()
  const explorer = panel.locator('.session-file-explorer')
  if (await explorer.count() > 0) await chip.click()
  await expect(explorer).toHaveCount(0, { timeout: 10_000 })
}

/** Click a file path in the chat — the entry point that used to lose the memory. */
async function clickChatFileLink(panel: Locator): Promise<Locator> {
  const link = panel.locator('a.file-link', { hasText: 'linked-from-chat.md' }).first()
  await expect(link).toBeVisible({ timeout: 15_000 })
  await link.click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

function back(explorer: Locator): Locator {
  return explorer.getByRole('button', { name: 'Back to the previously viewed file' })
}

function forward(explorer: Locator): Locator {
  return explorer.getByRole('button', { name: 'Forward to the next viewed file' })
}

/** The selected tree row's filename, or null when nothing is selected. */
async function selectedName(explorer: Locator): Promise<string | null> {
  const sel = explorer.locator('.session-file-explorer-node.selected .sfe-name')
  if (await sel.count() === 0) return null
  return (await sel.first().innerText()).trim()
}

test.beforeEach(async ({ page, baseURL }) => {
  // Pin the Files tree EXPANDED before first render (the collapse pref key
  // syncs via ui-prefs on the shared fixture server; see tree-collapse spec).
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  // These tests SHARE a browser profile, and the feature under test persists to
  // localStorage — so without this every test but the first would inherit the
  // previous one's stack ("nothing visited yet" would be false, and re-clicking a
  // file already on top of the stack is a deliberate no-op). Clear the two Files
  // panel memory namespaces before each test; everything else (prefs, layout) stays.
  await page.addInitScript(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('open-walnut-file-explorer-history')
        || k.startsWith('open-walnut-file-explorer-selected')) localStorage.removeItem(k)
    }
  })
  // The history key (unlike the selected-file key) is mirrored to the fixture
  // server's ui-prefs, and the boot merge adopts the server copy for any key this
  // browser lacks. So clearing localStorage alone let the stack another spec left
  // for this same session (file-selection-dismiss opens design-options.md in it)
  // come back at boot. Answer the boot GET without that one namespace; every other
  // pref stays as served, and this test's own writes (PUTs) go through untouched.
  await page.route('**/api/ui-prefs', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = await response.json() as { prefs?: Record<string, unknown> }
    const prefs = Object.fromEntries(Object.entries(body.prefs ?? {})
      .filter(([key]) => !key.startsWith('open-walnut-file-explorer-history')))
    await route.fulfill({ response, json: { ...body, prefs } })
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  // `networkidle` on a loaded machine (concurrent agents) waits out unrelated
  // polling and blows the 30s budget; the specs assert on real elements anyway.
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
})

// NOTE: previews assert on `.fv-md-preview, .fv-wysiwyg-editor` — plain
// editable markdown renders in the WYSIWYG editor since e46b8f00; the read-only
// .fv-md-preview remains only for MDX/truncated files.
test('a file opened from a chat link is remembered by the Files chip (the reported bug)', async ({ page }) => {
  const panel = await openSessionPanel(page)

  // 1. Open the file by clicking its path in the chat. The explorer roots at the
  //    file's parent dir and previews it.
  let explorer = await clickChatFileLink(panel)
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('LINKED_FROM_CHAT_MARKER', { timeout: 15_000 })
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step1-opened-from-chat.png` })

  // 2. Files returns the tree to the actual host HOME, without losing the
  //    scope's chosen file. No cwd navigation: that would hide a failed restore.
  const homeRead = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/files/list' && url.searchParams.get('path') === '~'
  })
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const response = await homeRead
  expect(response.ok()).toBe(true)
  const home = (await response.json()).path as string
  expect(home).toBeTruthy()
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home)
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('LINKED_FROM_CHAT_MARKER', { timeout: 15_000 })
  await expect(
    explorer.locator('.session-file-explorer-node.selected .sfe-name', { hasText: 'linked-from-chat.md' }),
  ).toHaveCount(1, { timeout: 15_000 })
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step2-survives-reroot.png` })

  // 3. Now close it fully and reopen with the chip — the memory also survives a
  //    full close/reopen cycle, not just a re-root.
  await closeFiles(panel)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home)
  await expect(explorer.locator('.sfe-preview-empty')).toHaveCount(0, { timeout: 15_000 })
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('LINKED_FROM_CHAT_MARKER', { timeout: 15_000 })

  // 4. "go there automatically" — the tree expands from HOME through the file's ancestors so the
  //    restored file is a VISIBLE selected row, not just preview-pane content.
  await expect(
    explorer.locator('.session-file-explorer-node.selected .sfe-name', { hasText: 'linked-from-chat.md' }),
  ).toHaveCount(1, { timeout: 15_000 })
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step3-remembered-via-chip.png` })
})

test('‹ › walk back and forward through the files viewed, browser style', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)

  await expect(back(explorer)).toHaveCount(0)
  await expect(forward(explorer)).toHaveCount(0)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  // One file deep on a fresh stack: nowhere to go, so the ‹ › pair is not drawn
  // (an inherited stack would draw Back here, aimed at the other spec's file).
  await expect(back(explorer)).toHaveCount(0)
  await expect(forward(explorer)).toHaveCount(0)
  await explorer.locator('.sfe-name', { hasText: 'second-doc.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })

  // Two files deep: Back is live, Forward is not.
  await expect(back(explorer)).toBeEnabled()
  await expect(forward(explorer)).toBeDisabled()

  // Back → the previous file, and the tree selection follows it.
  await back(explorer).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  expect(await selectedName(explorer)).toBe('incident-report.md')
  await expect(back(explorer)).toBeDisabled()
  await expect(forward(explorer)).toBeEnabled()
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step3-back.png` })

  // Forward → the file we left. Back must NOT have truncated the tail.
  await forward(explorer).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })
  expect(await selectedName(explorer)).toBe('second-doc.md')
  await expect(forward(explorer)).toBeDisabled()
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step4-forward.png` })
})

test('⌘[ / ⌘] drive the same history from the keyboard', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  await explorer.locator('.sfe-name', { hasText: 'second-doc.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+BracketLeft`)
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  await page.keyboard.press(`${mod}+BracketRight`)
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step5-keyboard.png` })
})

test('the history survives closing and reopening the panel', async ({ page }) => {
  const panel = await openSessionPanel(page)
  let explorer = await openFiles(panel)

  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  await explorer.locator('.sfe-name', { hasText: 'second-doc.md' }).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })

  await closeFiles(panel)
  const homeRead = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/files/list' && url.searchParams.get('path') === '~'
  })
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const response = await homeRead
  expect(response.ok()).toBe(true)
  const home = (await response.json()).path as string
  expect(home).toBeTruthy()
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home)
  // Reopening restores the file WITHOUT pushing it again, so Back still reaches
  // the earlier file instead of the stack having collapsed to one entry.
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Second doc', { timeout: 15_000 })
  await expect(back(explorer)).toBeEnabled()
  await back(explorer).click()
  await expect(explorer.locator('.fv-md-preview, .fv-wysiwyg-editor')).toContainText('Controller restart loop', { timeout: 15_000 })
  await explorer.screenshot({ path: `${SCREENSHOT_DIR}/step6-history-persisted.png` })
})
