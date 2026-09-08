/**
 * Markdown shortcut: typing ``` at the start of a line turns the paragraph into
 * a code block THE MOMENT the third backtick lands (Notion/Slack behaviour) —
 * no trailing space or Enter required. The stock TipTap rule waited for that
 * whitespace, so the shortcut looked broken (user report, 2026-09-08).
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'

// One note PER TEST — parallel workers share the fixture server.
let NOTE = ''
async function seedNote(title: string, repeat: number) {
  NOTE = `FenceTest/${title.replace(/[^a-z0-9]+/gi, ' ').trim().slice(0, 40)} ${repeat}.md`
  await fetch(`${API}/api/notes-v2/content/${NOTE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Fence\n\nintro line\n' }),
  })
}

async function openNote(page: Page) {
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')
  const folderEl = page.locator('.notes-tree-folder', { hasText: 'FenceTest' })
  await folderEl.waitFor({ state: 'visible', timeout: 60_000 })
  const name = NOTE.slice('FenceTest/'.length, -'.md'.length)
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
  await expect(editor.locator('p', { hasText: 'intro line' })).toBeVisible()
  return editor
}

/**
 * Caret on a fresh empty paragraph after the intro line. The caret is placed by
 * clicking the block's right edge, not the End key: on macOS WebKit (the Mac
 * app) End scrolls instead of moving the caret.
 */
async function newLine(page: Page, editor: ReturnType<Page['locator']>) {
  const block = editor.locator('p', { hasText: 'intro line' })
  const box = await block.boundingBox()
  if (!box) throw new Error('block not laid out')
  await block.click({ position: { x: box.width - 3, y: box.height / 2 } })
  await page.keyboard.press('Enter')
}

test.beforeEach(async ({}, info) => {
  await seedNote(info.title, info.repeatEachIndex)
})
// The dev-mode fixture compiles the /notes route on first load; under machine
// load that alone can take most of the default 30s.
test.setTimeout(120_000)

test('the third backtick alone turns the line into a code block', async ({ page }) => {
  const editor = await openNote(page)
  await newLine(page, editor)
  await page.keyboard.type('``')
  await expect(editor.locator('pre')).toHaveCount(0)
  await page.keyboard.type('`')
  await expect(editor.locator('pre code')).toHaveCount(1)
  // The fence characters themselves are consumed, not left inside the block.
  await expect(editor.locator('pre code')).toHaveText('')
  await page.keyboard.type('const a = 1')
  await expect(editor.locator('pre code')).toContainText('const a = 1')
  // Round-trip: the markdown on disk carries a real fence.
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/notes-v2/content/${NOTE}`)
    return ((await res.json()) as { content: string }).content
  }, { timeout: 10_000 }).toContain('```\nconst a = 1\n```')
})

test('Backspace on the fresh empty code block returns to a plain paragraph', async ({ page }) => {
  const editor = await openNote(page)
  await newLine(page, editor)
  await page.keyboard.type('```')
  await expect(editor.locator('pre code')).toHaveCount(1)
  // CodeBlock's own Backspace (exit an empty block) wins over undoInputRule, so
  // the recovery is an empty paragraph — the fence chars are not resurrected.
  // ⌘Z is the way back to the typed text.
  await page.keyboard.press('Backspace')
  await expect(editor.locator('pre')).toHaveCount(0)
  await page.keyboard.type('plain again')
  await expect(editor.locator('p', { hasText: 'plain again' })).toHaveCount(1)
})

test('inline `code` still works and the stock ~~~lang␠ rule is still registered', async ({ page }) => {
  const editor = await openNote(page)
  await newLine(page, editor)
  await page.keyboard.type('say `hi` now')
  await expect(editor.locator('p code', { hasText: 'hi' })).toHaveCount(1)
  await page.keyboard.press('Enter')
  // The parent rules ride behind ours: the tilde fence still converts on Space
  // and keeps its language tag.
  await page.keyboard.type('~~~ts ')
  await expect(editor.locator('pre code')).toHaveCount(1)
  await expect(editor.locator('pre code')).toHaveClass(/language-ts/)
})
