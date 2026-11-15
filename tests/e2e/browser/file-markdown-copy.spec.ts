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
import { goToSessionFolder } from './todo-panel-helpers'
import { copyEditorSelection, selectTextInEditor } from './prosemirror-caret'

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
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  await goToSessionFolder(explorer)
  return explorer
}

/** Select `needle` in the editor and copy it with the browser's copy command. */
async function selectAndCopy(page: Page, needle: string): Promise<string> {
  await selectTextInEditor(page.locator('.fv-wysiwyg-editor .ProseMirror'), needle)
  return copyEditorSelection(page)
}

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click({ timeout: 60_000 })
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
