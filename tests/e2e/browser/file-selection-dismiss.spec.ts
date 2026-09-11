import { test, expect, type Page } from '@playwright/test'
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
  await Promise.all([
    page.waitForURL(new URL('/', baseURL!).href, { waitUntil: 'domcontentloaded' }),
    page.evaluate((url) => { window.location.href = url }, baseURL!),
  ])
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]')
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  await page.locator(PANEL).getByRole('button', { name: 'Files', exact: true }).click()
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
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
    await expect.poll(() => paintedPassages(page)).toEqual([])
    await panel.screenshot({ path: `${prefix}-cleared.png`, scale: 'css' })
  })
}

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
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect(matches).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await panel.screenshot({ path: `${prefix}-cleared.png`, scale: 'css' })
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
  await page.locator('.notes-bubble-menu:visible').getByTitle('Ask the session about this selection', { exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect.poll(() => paintedPassages(page)).toEqual([])
})
