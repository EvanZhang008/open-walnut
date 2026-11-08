import { test, expect, type Page } from '@playwright/test'
import { goToSessionFolder, isolateUiPrefs } from './todo-panel-helpers'
import { dragPhrase } from './selection-helpers'

const SESSION_ID = 'pw-vscode-session'
const PANEL = `.session-panel[data-session-id="${SESSION_ID}"]`
const EDITOR = `${PANEL} .fv-wysiwyg-editor .ProseMirror`

function paintedPassages(page: Page) {
  return page.evaluate(() => {
    const highlights = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
    return Array.from(highlights.get('walnut-selmatch') ?? []).filter((range) => !range.collapsed).map(String)
  })
}

/** The page's selection outside the focused field: the path field selects its own path on focus
 *  (so a typed path replaces it), and Chromium reports a focused field's selected text here too. */
function pageSelection(page: Page) {
  return page.evaluate(() => {
    const text = window.getSelection()?.toString() ?? ''
    const field = document.activeElement
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return text
    return text === field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) ? '' : text
  })
}

async function openFile(page: Page, name: string) {
  const file = page.locator(`${PANEL} .session-file-explorer-node[title$="/${name}"]`)
  await expect(file, `fixture file ${name}`).toBeVisible()
  await file.click()
  await expect(page.locator(EDITOR)).toBeVisible()
}

async function selectPassage(page: Page, phrase: string, matches = 1) {
  await expect(page.locator(EDITOR)).toContainText(phrase)
  await page.evaluate(async () => { await document.fonts.ready })
  await dragPhrase(page, EDITOR, phrase)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(phrase)
  await expect.poll(() => paintedPassages(page)).toEqual(Array(matches).fill(phrase))
}

test.use({ viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'serial', timeout: 90_000 })

test.beforeEach(async ({ page, baseURL }) => {
  // This spec's own reading places only: a file opens at the place it was last read at and holds
  // it for its first seconds (use-file-reading-place.ts), and the shared fixture's ui-prefs would
  // bring in a place another spec left for the same fixture file.
  await isolateUiPrefs(page)
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]')
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  await page.locator(PANEL).getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = page.locator(`${PANEL} .session-file-explorer`)
  await expect(explorer).toBeVisible()
  await goToSessionFolder(explorer)
})

for (const sample of [
  { name: 'table', file: 'design-options.md', phrase: 'ours to build' },
  { name: 'prose', file: 'incident-report.md', phrase: 'watching' },
]) {
  test(`clicking outside the file editor clears ${sample.name} selection highlights`, async ({ page }, testInfo) => {
    await openFile(page, sample.file)
    await selectPassage(page, sample.phrase)
    const panel = page.locator(PANEL)
    const prefix = `/tmp/walnut-file-selection/${testInfo.project.name}-${sample.name}`
    await panel.screenshot({ path: `${prefix}-selected.png`, scale: 'css' })
    await panel.locator('.sfe-root-path').click()
    await expect(panel.locator('.sfe-root-path-input')).toBeFocused()
    await expect(page.locator('.notes-bubble-menu:visible')).toHaveCount(0)
    await expect.poll(() => pageSelection(page)).toBe('')
    await expect.poll(() => paintedPassages(page)).toEqual([])
    await panel.screenshot({ path: `${prefix}-cleared.png`, scale: 'css' })
  })
}

// 2026-11-01, the user: "after I deselect, the highlight stays". A click on blank
// space beside the doc takes focus from its editor and leaves the selection in the
// page, unpainted (WebKit and Chromium both); its matches must go with it.
test('a click on blank space beside the editor clears the matches the editor left behind', async ({ page }, testInfo) => {
  await openFile(page, 'incident-report.md')
  await selectPassage(page, 'timeline entry', 160)
  // Blank space in the file's own line: the empty end of its lead, past the name. A fixed
  // fraction of the view's width lands on a tool once the bar gains one (the Terminal dock
  // toggle moved Source under it, and the click switched views instead).
  const lead = page.locator(`${PANEL} .fv-doc-bar-lead`).first()
  const box = (await lead.boundingBox())!
  const spot = { x: box.x + box.width - 6, y: box.y + box.height / 2 }
  const hit = await lead.evaluate((el, p) => {
    const at = document.elementFromPoint(p.x, p.y)
    return !!at && el.contains(at) && !at.closest('button, a, input, [role="button"], [role="group"]')
  }, spot)
  expect(hit, 'the spot is blank bar, no control').toBe(true)
  await page.mouse.click(spot.x, spot.y)
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.ProseMirror') ? 'editor' : 'elsewhere')).toBe('elsewhere')
  await expect.poll(() => paintedPassages(page)).toEqual([])
  await page.locator(PANEL).screenshot({ path: `/tmp/walnut-file-selection/${testInfo.project.name}-blank-click-cleared.png`, scale: 'css' })
  // Back in the editor with a new selection, the matches paint again.
  await selectPassage(page, 'watching')
})

test('keyboard selection changes clear matches and switching files drops old paint', async ({ page }) => {
  await openFile(page, 'incident-report.md')
  await selectPassage(page, 'timeline entry', 160)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect.poll(() => paintedPassages(page)).toEqual([])
  await selectPassage(page, 'watching')
  await openFile(page, 'design-options.md')
  await expect.poll(() => paintedPassages(page)).toEqual([])
  await selectPassage(page, 'ours to build')
})

test('source selection matches stop painting after an outside click', async ({ page }, testInfo) => {
  const panel = page.locator(PANEL)
  await panel.locator('.session-file-explorer-node[title$="/sync-controller.go"]').click()
  const source = `${PANEL} .fv-source-editor .cm-content`
  await expect(page.locator(source)).toContainText('HasSyncedForItems')
  await page.evaluate(async () => { await document.fonts.ready })
  await dragPhrase(page, source, 'HasSyncedForItems')
  const matches = panel.locator('.cm-selectionMatch')
  await expect(matches).toHaveCount(1)
  await expect(matches).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const prefix = `/tmp/walnut-file-selection/${testInfo.project.name}-source`
  await panel.screenshot({ path: `${prefix}-selected.png`, scale: 'css' })
  await panel.locator('.sfe-root-path').click()
  await expect(panel.locator('.sfe-root-path-input')).toBeFocused()
  await expect.poll(() => pageSelection(page)).toBe('')
  await expect(matches).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await panel.screenshot({ path: `${prefix}-cleared.png`, scale: 'css' })
})

test('selection actions escape a narrow file pane and remain clickable after resize and scroll', async ({ page }, testInfo) => {
  await openFile(page, 'incident-report.md')
  const panel = page.locator(PANEL)
  const divider = (await panel.locator('.sfe-divider').boundingBox())!
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
  await page.mouse.down()
  await page.mouse.move(divider.x + 200, divider.y + divider.height / 2, { steps: 10 })
  await page.mouse.up()
  await selectPassage(page, 'watching')
  const menu = page.locator('.notes-bubble-menu:visible')
  await expect(menu).toBeVisible()
  expect(await menu.evaluate(el => el.parentElement?.parentElement === document.body)).toBe(true)
  const fits = () => menu.evaluate(el => {
    const rect = el.getBoundingClientRect()
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && Array.from(el.querySelectorAll('button')).every(button => {
        const box = button.getBoundingClientRect()
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })
  })
  await expect.poll(fits).toBe(true)
  await page.setViewportSize({ width: 760, height: 800 })
  try {
    await expect.poll(fits).toBe(true)
  } finally {
    await testInfo.attach('bubble-resize-state', {
      contentType: 'application/json',
      body: JSON.stringify(await page.evaluate(({ editorSelector }) => {
        const boxOf = (el: Element | null) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, visibility: style.visibility, display: style.display, overflowX: style.overflowX, overflowY: style.overflowY }
        }
        const editor = document.querySelector(editorSelector)
        const selection = window.getSelection()
        const range = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
        const ancestors = []
        for (let el = editor; el; el = el.parentElement) ancestors.push({ className: el.className, box: boxOf(el) })
        return {
          selection: selection?.toString(), range: range && { left: range.left, top: range.top, right: range.right, bottom: range.bottom },
          activeElement: document.activeElement?.className, ancestors,
          menus: Array.from(document.querySelectorAll('.notes-bubble-menu')).map(el => ({ box: boxOf(el), style: el.getAttribute('style') })),
        }
      }, { editorSelector: EDITOR })),
    })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  // Back on a desktop width the session keeps its Files tab, its open file and the selection's
  // actions: a resize out of the phone layout keeps what it showed (usePhoneOverlayHistory
  // keepOnBreakpoint), and those actions still fit the window.
  await expect(panel.locator('.session-file-explorer')).toHaveCount(1)
  await expect.poll(fits).toBe(true)
  await goToSessionFolder(panel.locator('.session-file-explorer'))
  await openFile(page, 'incident-report.md')
  await selectPassage(page, 'watching')
  await expect.poll(fits).toBe(true)
  const scroller = (await panel.locator('.fv-wysiwyg-editor').boundingBox())!
  await page.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2)
  await page.mouse.wheel(0, 30)
  await expect.poll(fits).toBe(true)
  await page.mouse.wheel(0, 1200)
  await expect(menu).toHaveCount(0)
  await page.mouse.wheel(0, -1200)
  await expect(menu).toBeVisible()
  await expect.poll(fits).toBe(true)
  await page.screenshot({ path: `/tmp/walnut-file-selection/${testInfo.project.name}-bubble-narrow.png`, scale: 'css' })
  await menu.getByTestId('bubble-ask-here').click()
  const card = panel.locator('.fv-thread-layer .thread-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.thread-card-input')).toBeFocused()
  await card.locator('.thread-card-input').press('Escape')
  await expect(card).toHaveCount(0)
})

test('a selection toolbar leaves with Home and returns with its selected passage', async ({ page }) => {
  const panel = page.locator(PANEL)
  await panel.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await page.getByTestId('sidebar-core-app-tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(url => url.pathname === '/')
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await goToSessionFolder(panel.locator('.session-file-explorer'))
  await openFile(page, 'incident-report.md')
  await selectPassage(page, 'watching')
  const menu = page.locator('.notes-bubble-menu:visible')
  await expect(menu).toBeVisible()
  // Leave Home the way a user does, through the sidebar, and come back the same
  // way. Browser Back is not used here: in the WebKit run, Back from this Home
  // entry landed on the earlier `/?s1=…&task=…` entry, not on /tasks, so one Back
  // does not mean "the page before Home" in this flow.
  await page.getByTestId('sidebar-core-app-tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(menu).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(url => url.pathname === '/')
  await expect(page.locator(EDITOR)).toBeVisible()
  await selectPassage(page, 'watching')
  await expect(menu).toBeVisible()
  await menu.getByTestId('bubble-ask-here').click()
  await expect(panel.locator('.fv-thread-layer .thread-card-input')).toBeFocused()
})

test('copying and formatting still act on the selected passage', async ({ page }, testInfo) => {
  await openFile(page, `selection-format-${testInfo.project.name}.md`)
  const italic = page.locator(`${EDITOR} em`).filter({ hasText: 'watching' })
  const wasItalic = await italic.count() > 0
  await selectPassage(page, 'watching')
  await page.evaluate(() => {
    document.addEventListener('copy', (event) => {
      (window as unknown as { copiedPassage: string | undefined }).copiedPassage = event.clipboardData?.getData('text/plain')
    }, { once: true })
  })
  await page.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedPassage: string }).copiedPassage)).toBe('watching')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('watching')
  await page.locator('.notes-bubble-menu:visible').getByTitle('Italic (Cmd+I)', { exact: true }).click()
  await expect(italic).toHaveCount(wasItalic ? 0 : 1)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('watching')
  await expect.poll(() => paintedPassages(page)).toEqual(['watching'])
  await page.locator('.notes-bubble-menu:visible').getByTitle('Italic (Cmd+I)', { exact: true }).click()
  await expect(italic).toHaveCount(wasItalic ? 1 : 0)
  await page.locator('.notes-bubble-menu:visible').getByTitle('Quote this passage in the chat', { exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect.poll(() => paintedPassages(page)).toEqual([])
})
