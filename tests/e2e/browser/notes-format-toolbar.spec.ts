/**
 * The always-visible format toolbar on the /notes editor (the row under the
 * title bar). Every button drives the same commands as the bubble/slash menus,
 * so these checks are about the ROW: it is there without selecting anything,
 * it reflects the caret's block, and its actions land in the doc AND on disk.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const API = 'http://localhost:3457'

// One note PER TEST: the specs run in parallel workers against one fixture
// server, so a shared note would let one test's edits land in another's
// on-disk assertions.
let note = ''
async function seedNote(title: string, repeat: number) {
  note = `ToolbarTest/${title.replace(/[^a-z0-9]+/gi, ' ').trim().slice(0, 40)} ${repeat}.md`
  await fetch(`${API}/api/notes-v2/content/${note}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Toolbar\n\nfirst line\n\nsecond line\n' }),
  })
}

async function readNote(): Promise<string> {
  const res = await fetch(`${API}/api/notes-v2/content/${note}`)
  return ((await res.json()) as { content: string }).content
}

async function openNote(page: Page) {
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'ToolbarTest' })
  await folderEl.waitFor({ state: 'visible', timeout: 60_000 })
  const name = note.slice('ToolbarTest/'.length, -'.md'.length)
  // `.first()`: once opened, the note is ALSO listed under the tree's Recent
  // group; either row opens the same note.
  const file = page.locator('.notes-tree-file', { hasText: name }).first()
  if (!(await file.isVisible().catch(() => false))) await folderEl.click()
  await file.click()
  const editor = page.locator('.notes-editor .tiptap').first()
  await expect(editor).toBeVisible({ timeout: 5000 })
  // TipTap applies `autofocus: 'start'` on a 0ms timer after mount. On a loaded
  // machine that timer can fire AFTER our first click and yank the caret to the
  // top of the doc (typed text then lands in the H1) — wait for it.
  await expect(editor).toBeFocused({ timeout: 10_000 })
  await expect(editor.locator('p', { hasText: 'first line' })).toBeVisible()
  return editor
}

/**
 * Put the caret at the END of a block by clicking its right edge. Not the End
 * key: on macOS WebKit (the Mac app) End scrolls instead of moving the caret.
 */
async function caretToEnd(block: Locator) {
  const box = await block.boundingBox()
  if (!box) throw new Error('block not laid out')
  await block.click({ position: { x: box.width - 3, y: box.height / 2 } })
}

const toolbar = (page: Page) => page.locator('.notes-format-toolbar')
const tool = (page: Page, label: string) => toolbar(page).getByRole('button', { name: label })
const blockBtn = (page: Page) => toolbar(page).locator('.notes-format-block-btn')

async function pickBlock(page: Page, label: string) {
  await blockBtn(page).click()
  const menu = page.locator('.notes-format-block-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemradio', { name: label }).click()
  await expect(menu).toHaveCount(0)
}

/** Select a whole paragraph (triple-click → ProseMirror text selection over the block). */
async function selectBlock(editor: Locator, text: string) {
  await editor.locator('p', { hasText: text }).click({ clickCount: 3 })
}

test.beforeEach(async ({}, info) => {
  await seedNote(info.title, info.repeatEachIndex)
})
test.setTimeout(120_000)

test('toolbar is present without a selection and mirrors the caret block', async ({ page }) => {
  const editor = await openNote(page)
  await expect(toolbar(page)).toBeVisible()
  // Nothing selected, caret in a paragraph → "Normal text".
  await editor.locator('p', { hasText: 'first line' }).click()
  await expect(blockBtn(page)).toHaveText(/Normal text/)
  // Move into the H1 → the label follows.
  await editor.locator('h1', { hasText: 'Toolbar' }).click()
  await expect(blockBtn(page)).toHaveText(/Heading 1/)
  // Indent/outdent only make sense in a list.
  await expect(tool(page, 'Indent (Tab)')).toBeDisabled()
})

test('marks: Bold applies, Clear formatting removes it, Undo brings it back', async ({ page }) => {
  const editor = await openNote(page)
  await selectBlock(editor, 'first line')
  await tool(page, 'Bold (⌘B)').click()
  await expect(editor.locator('p strong', { hasText: 'first line' })).toHaveCount(1)
  await expect(tool(page, 'Bold (⌘B)')).toHaveClass(/active/)
  await expect.poll(readNote, { timeout: 10_000 }).toContain('**first line**')

  // Past ProseMirror's 500ms history-grouping window, so Undo reverts ONLY the
  // clear below, not the bold with it.
  await page.waitForTimeout(600)
  await tool(page, 'Clear formatting').click()
  await expect(editor.locator('p strong')).toHaveCount(0)

  await tool(page, 'Undo (⌘Z)').click()
  await expect(editor.locator('p strong', { hasText: 'first line' })).toHaveCount(1)
})

test('block picker turns a paragraph into a heading, a list, then a code block', async ({ page }) => {
  const editor = await openNote(page)
  await editor.locator('p', { hasText: 'second line' }).click()

  await pickBlock(page, 'Heading 2')
  await expect(editor.locator('h2', { hasText: 'second line' })).toHaveCount(1)
  await expect(blockBtn(page)).toHaveText(/Heading 2/)
  await expect.poll(readNote, { timeout: 10_000 }).toContain('## second line')

  await pickBlock(page, 'Bulleted list')
  await expect(editor.locator('ul li', { hasText: 'second line' })).toHaveCount(1)
  await expect(blockBtn(page)).toHaveText(/Bulleted list/)
  await expect(tool(page, 'Indent (Tab)')).toBeEnabled()

  // A second item, indented under the first through the toolbar button.
  await caretToEnd(editor.locator('ul li p', { hasText: 'second line' }))
  await page.keyboard.press('Enter')
  await page.keyboard.type('child')
  await tool(page, 'Indent (Tab)').click()
  await expect(editor.locator('ul li ul li', { hasText: 'child' })).toHaveCount(1)
  await tool(page, 'Outdent (⇧Tab)').click()
  await expect(editor.locator('ul li ul li')).toHaveCount(0)
  await expect(editor.locator('ul > li')).toHaveCount(2)

  // "Normal text" lifts the item OUT of the list (not a paragraph inside it).
  await pickBlock(page, 'Normal text')
  await expect(editor.locator('ul li', { hasText: 'child' })).toHaveCount(0)
  await expect(editor.locator('p', { hasText: 'child' })).toHaveCount(1)

  await pickBlock(page, 'Code block')
  await expect(editor.locator('pre code', { hasText: 'child' })).toHaveCount(1)
  // Marks are meaningless inside a code block: the mark buttons switch off.
  await expect(tool(page, 'Bold (⌘B)')).toBeDisabled()
  await expect(blockBtn(page)).toHaveText(/Code block/)
})

test('Table and Divider insert; the toolbar hides in raw mode and returns', async ({ page }) => {
  const editor = await openNote(page)
  await caretToEnd(editor.locator('p', { hasText: 'second line' }))
  await page.keyboard.press('Enter')
  await tool(page, 'Divider').click()
  await expect(editor.locator('hr')).toHaveCount(1)
  await tool(page, 'Table').click()
  await expect(editor.locator('table')).toHaveCount(1)
  // Caret is inside the new table → block conversion is off, marks stay on.
  await expect(blockBtn(page)).toBeDisabled()
  await expect(tool(page, 'Bold (⌘B)')).toBeEnabled()

  await page.locator('.notes-raw-toggle-btn').click()
  await expect(toolbar(page)).toHaveCount(0)
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(toolbar(page)).toBeVisible()
})

test('keyboard: a focused toolbar button activates on Enter', async ({ page }) => {
  const editor = await openNote(page)
  await selectBlock(editor, 'first line')
  // Focus the button without clicking it (Enter must be the activation).
  await tool(page, 'Italic (⌘I)').focus()
  await page.keyboard.press('Enter')
  await expect(editor.locator('p em', { hasText: 'first line' })).toHaveCount(1)
})

test('Global Notes popup (home): the toolbar row is there and its picker paints ABOVE the popup', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const { selectSection } = await import('./todo-panel-helpers')
  await selectSection(page, 'Notes')
  await page.getByRole('button', { name: 'Expand notes to fullscreen' }).click()
  const popup = page.locator('.notes-popup-overlay')
  await expect(popup).toBeVisible()
  const bar = popup.locator('.notes-format-toolbar')
  await expect(bar).toBeVisible()
  await bar.locator('.notes-format-block-btn').click()
  const menu = page.locator('.notes-format-block-menu')
  await expect(menu).toBeVisible()
  // The overlay is z-index 10000 and both are portalled to <body>: the menu must
  // be the element actually under the pointer, not painted beneath the popup card.
  const item = menu.getByRole('menuitemradio', { name: 'Heading 3' })
  const box = (await item.boundingBox())!
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.notes-format-block-menu') !== null, [box.x + box.width / 2, box.y + box.height / 2])
  expect(hit).toBe(true)
  await item.click()
  await expect(popup.locator('.notes-editor .tiptap h3')).toHaveCount(1)
})
