/**
 * Escape in the Files-panel source editor, verified in WEBKIT.
 *
 * Two things have to be true at once and they pull against each other:
 *
 *  1. An Escape nothing handles must have its default PREVENTED, or the Mac app
 *     (a WKWebView) hands the key to AppKit as `cancelOperation:`, nobody accepts
 *     it, and NSBeep fires. That loud "ding" on every Escape is what was reported.
 *  2. An Escape that reaches an editor must NOT already be `defaultPrevented`,
 *     because CodeMirror and ProseMirror both read that flag as "another owner has
 *     this event" and skip their own dispatch entirely. The first version of the
 *     beep fix prevented on window CAPTURE, which silently killed every Escape
 *     binding inside both editors — `simplifySelection` (collapse a multi-cursor
 *     or expanded selection) and `tabFocusMode`, the keyboard way out of an editor.
 *
 * WebKit on purpose: the guard folds its suppression into the event's own
 * `stopPropagation` by assigning over that method on the event instance. Whether
 * that assignment takes is an engine question, and the engine that matters for the
 * beep is WebKit. Chromium passing would prove nothing about the app the user runs.
 *
 * NSBeep itself is not observable from a browser test. What IS observable is the
 * condition the beep depends on, so that is what this asserts: `defaultPrevented`
 * false while the page can still act, true once it cannot.
 */
import { test, expect, type Page } from '@playwright/test'

test.use({ browserName: 'webkit' })

// The project is named "chromium", so the run's own labels and output folders keep
// saying chromium even when this override takes. Assert the engine instead of
// trusting the label: a silent fall back to Chromium would make every result here
// meaningless for the app the beep actually happens in.
test('these tests really run in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel'

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
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

/**
 * Deliberately on the BARE homepage, not in the Files panel. The fullscreen file
 * view claims Escape itself at window capture (that is how it exits fullscreen), so
 * inside it the key is legitimately spoken for and `defaultPrevented` is true early
 * by design. The beep case is the opposite situation, and the one the guard's own
 * notes name: "nothing open at all (the Files tab, an idle board)" — nobody claims
 * the key, so without the guard it walks out to AppKit.
 */
test('an unhandled Escape ends up prevented (no beep) without being prevented early', async ({ page }) => {
  // `dispatchEvent` is synchronous, so once it returns the event has finished
  // propagating and the flag on the event object IS the final answer. Reading it
  // that way avoids depending on which listener happens to be registered last.
  const readings = await page.evaluate(() => {
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let atCapture: boolean | null = null
    // Registered after the guard's own capture listener, which prevents nothing —
    // so this reads what an editor deeper in the tree would see.
    const onCapture = (e: Event) => { if (e === evt) atCapture = e.defaultPrevented }
    window.addEventListener('keydown', onCapture, true)
    document.body.dispatchEvent(evt)
    window.removeEventListener('keydown', onCapture, true)
    return { atCapture, atEnd: evt.defaultPrevented }
  })

  // The regression: this was `true`, and it is why both editors went deaf.
  expect(readings.atCapture, 'an editor must see an unclaimed Escape').toBe(false)
  // The original complaint: by the time the page is finished, the native default
  // must be off the table or AppKit rings the bell.
  expect(readings.atEnd, 'an unhandled Escape must not reach AppKit').toBe(true)
})

test('Escape reaches CodeMirror and collapses an expanded selection', async ({ page }) => {
  const explorer = await openFilesPanel(page)

  // Any text file in the fixture tree will do; this asserts on the editor, not
  // on the file. sync-caller.go is a stable fixture with several lines.
  await explorer.locator('.sfe-name', { hasText: 'sync-caller.go' }).first().click()
  const cm = page.locator('.fv-source-editor .cm-content')
  await expect(cm).toBeVisible({ timeout: 15_000 })

  await cm.click()
  // Select a range, then let CodeMirror's own Escape binding collapse it.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  const expanded = await page.evaluate(() => {
    const sel = window.getSelection()
    return sel ? sel.toString().length : 0
  })
  expect(expanded, 'the selection must be non-empty before Escape').toBeGreaterThan(0)

  await page.keyboard.press('Escape')

  // simplifySelection collapses to a single cursor: nothing selected any more.
  await expect.poll(async () => page.evaluate(() => {
    const sel = window.getSelection()
    return sel ? sel.toString().length : 0
  }), { timeout: 5_000 }).toBe(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/8-escape-collapsed-selection.png` })
})
