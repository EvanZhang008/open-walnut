/**
 * `<` and `>` typed as prose in the Files-panel editor stay `<` and `>` on the
 * clipboard, in the composer, and on disk.
 *
 * The 2026-09-23 report: a sentence in a design doc (`Orchestrator -> Service
 * URL -> Pod`) was copied out of the Files panel with ⌘C, pasted into the
 * session composer, and read `-&gt;` there; the message went to the CLI that
 * way. tiptap-markdown's text serializer HTML-escaped every text node, so the
 * plain-text copy flavour AND every save carried entities. `LiteralText`
 * (web/src/components/notes/extensions/literal-text.ts) replaces that
 * serializer; the pure rule has its unit corpus in
 * tests/web/notes-roundtrip/angle-brackets.test.ts. This spec is the wiring
 * proof through the real editor, the browser's own copy and paste commands, the
 * real composer, and the bytes the save writes.
 */
import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const SID = 'pw-vscode-session'
const TASK = 'pw-task-vscode'
/** Not under test-results/: that dir is wiped by every concurrent run. */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/angle-brackets'

const SENTENCE = 'Sync: Orchestrator -> Service URL -> Pod Rev1 and Rev2 both in pool but different ratio, as traffic control.'
const DOC = `# Traffic control

${SENTENCE}

Editable line: original.

| Flow | Ratio |
| --- | --- |
| Rev1 -> Rev2 | 90 / 10 |
`

const preview = (p: Page) => p.locator('.fv-wysiwyg-editor .ProseMirror')
const save = (p: Page) => p.locator('.fv-save-btn')

/** Seed a fresh file into the fixture session's cwd and open it in the Files tab. */
async function open(p: Page, text: string) {
  const res = await p.request.get(`/api/sessions/${SID}`)
  expect(res.ok()).toBe(true)
  const data = await res.json()
  const cwd = data.session?.cwd ?? data.cwd
  expect(cwd).toMatch(/walnut-pw-/)
  const name = `angles-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  const abs = `${cwd}/${name}`
  await writeFile(abs, text)
  await p.locator('.todo-search-input').fill(SID)
  const row = p.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
  await row.locator('.todo-item-title').click()
  const panel = p.locator(`.session-panel[data-session-id="${SID}"]`)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..').click()
  await expect(preview(p)).toContainText('Traffic control')
  await expect(save(p)).toBeDisabled()
  return { abs, name, panel }
}

/** Select `needle` in the editor's DOM; returns nothing, the caller copies. */
async function select(p: Page, needle: string) {
  await expect(preview(p)).toContainText(needle)
  await p.evaluate((needle) => {
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
}

/** ⌘C on the current selection; returns the text/plain flavour ProseMirror wrote. */
async function copySelection(p: Page): Promise<string> {
  await p.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => p.evaluate(() => (window as any).__copied)).not.toBeUndefined()
  return p.evaluate(() => (window as any).__copied as string)
}

test.describe.configure({ timeout: 120_000 })

test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
    localStorage.setItem('open-walnut-live-edit', '0')
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 15_000 })
})

test('copying an arrow sentence and pasting it into the composer keeps the arrows', async ({ page }) => {
  const { panel } = await open(page, DOC)

  // Whole sentence, from one paragraph.
  await select(page, SENTENCE)
  const copied = await copySelection(page)
  expect(copied).toBe(SENTENCE)
  expect(copied).not.toContain('&gt;')

  // The user's next move: paste into this session's composer.
  const composer = panel.locator('.session-panel-input .chat-input-textarea')
  await composer.click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(composer).toHaveValue(new RegExp('Orchestrator -> Service URL -> Pod'))
  await expect(composer).not.toHaveValue(/&gt;/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/composer-after-paste.png`, fullPage: false })

  // Words around an arrow inside a table cell copy as those words.
  await select(page, 'Rev1 -> Rev2')
  expect(await copySelection(page)).toBe('Rev1 -> Rev2')
})

test('typing an arrow in the editor and saving writes the arrow to disk', async ({ page }) => {
  const { abs } = await open(page, DOC)

  await select(page, 'original.')
  await page.keyboard.insertText('A -> B, x < y.')
  await expect(preview(page)).toContainText('Editable line: A -> B, x < y.')
  await expect(save(page)).toBeEnabled()
  await save(page).click()
  await expect(save(page)).toBeDisabled({ timeout: 15_000 })

  await expect.poll(() => readFile(abs, 'utf8'), { timeout: 12_000 }).toContain('Editable line: A -> B, x < y.')
  const saved = await readFile(abs, 'utf8')
  expect(saved).not.toContain('&gt;')
  expect(saved).not.toContain('&lt;')
  // The untouched arrows elsewhere in the file are still arrows too.
  expect(saved).toContain(SENTENCE)
  expect(saved).toContain('| Rev1 -> Rev2 | 90 / 10 |')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/editor-after-save.png`, fullPage: false })
})
