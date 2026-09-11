/**
 * ⌘C inside the Files panel's markdown editor copies WHAT WAS SELECTED.
 *
 * The 2026-09-10 report: selecting a few words inside a table cell and copying
 * put a one-cell markdown table on the clipboard:
 *
 *   | Isolation between plugins is ours to build and prove. |
 *   | --- |
 *
 * tiptap-markdown's copy serializer wrote the slice's open ancestors (table →
 * row → cell) around the words. `MarkdownCopy` (markdown-copy.ts) replaces it;
 * the pure rule has its own unit corpus (tests/web/notes-roundtrip/
 * markdown-copy.test.ts). This spec is the wiring proof through the real
 * editor: a DOM selection inside a cell, the browser's own copy command, and
 * the text/plain flavour ProseMirror hands the clipboard.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
/** Not under test-results/: that dir is wiped by every concurrent run. */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/markdown-copy'

async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 30_000 })
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/**
 * Select `needle` inside the editor's DOM and copy it with the browser's copy
 * command. Returns the text/plain flavour ProseMirror put on the clipboard,
 * read off the copy event itself (no clipboard permission dance, and it is the
 * exact string the OS clipboard receives).
 */
async function selectAndCopy(page: Page, needle: string): Promise<string> {
  const editor = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(editor).toContainText(needle)
  await page.evaluate((needle) => {
    const root = document.querySelector('.fv-wysiwyg-editor .ProseMirror') as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    while ((node = walker.nextNode() as Text | null)) {
      const i = node.data.indexOf(needle)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + needle.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      root.focus()
      ;(window as any).__copied = undefined
      document.addEventListener('copy', (e) => {
        ;(window as any).__copied = e.clipboardData?.getData('text/plain')
      }, { once: true })
      return
    }
    throw new Error(`text not in editor: ${needle}`)
  }, needle)
  await page.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).not.toBeUndefined()
  return page.evaluate(() => (window as any).__copied as string)
}

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/', { timeout: 60_000 })
  await page.waitForLoadState('networkidle')
})

test('words selected inside a table cell copy as those words, not a table', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const row = explorer.locator('.session-file-explorer-node[title$="/design-options.md"]').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(explorer.locator('.fv-wysiwyg-editor table')).toBeVisible({ timeout: 20_000 })

  const partial = await selectAndCopy(page, 'ours to build')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/cell-words-selected.png`, fullPage: false })
  expect(partial).toBe('ours to build')

  const sentence = 'Isolation between plugins is ours to build and prove.'
  expect(await selectAndCopy(page, sentence)).toBe(sentence)

  expect(await selectAndCopy(page, 'Functions')).toBe('Functions')

  // Words in the heading copy without the `#` too: same rule, one textblock.
  expect(await selectAndCopy(page, 'options')).toBe('options')
})
