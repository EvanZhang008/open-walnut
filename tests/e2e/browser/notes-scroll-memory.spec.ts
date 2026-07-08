/**
 * E2E: the /notes workspace remembers WHERE you were (Obsidian parity).
 *
 *  1. Opening a note lands at the TOP (not auto-scrolled to the bottom).
 *  2. Scroll position is remembered across a route switch (notes → home → notes).
 *  3. Raw ⇄ rendered toggle keeps the same relative location.
 *  4. Open tabs (incl. non-active ones) survive a full page refresh.
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'
const NOTE_A = 'ScrollTest/Long Note.md'
const NOTE_B = 'ScrollTest/Other Note.md'

async function seedNotes() {
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} — lorem ipsum dolor sit amet.`).join('\n\n')
  for (const [p, c] of [
    [NOTE_A, `# Long\n\n${long}\n`],
    [NOTE_B, '# Other\n\nshort body\n'],
  ] as const) {
    await fetch(`${API}/api/notes-v2/content/${p}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: c }),
    })
  }
}

async function gotoNotes(page: Page) {
  await page.locator('a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
}

async function openNoteFromTree(page: Page, folder: string, name: string, opts?: { newTab?: boolean }) {
  const folderEl = page.locator('.notes-tree-folder', { hasText: folder })
  // Folder may already be expanded from a previous step — only click when the
  // target file isn't visible yet.
  const file = page.locator('.notes-tree-file', { hasText: name })
  if (!(await file.isVisible().catch(() => false))) await folderEl.click()
  // Single click replaces the active tab; ⌘/Ctrl-click opens a NEW tab.
  await file.click(opts?.newTab ? { modifiers: ['ControlOrMeta'] } : {})
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible({ timeout: 5000 })
}

const scrollBox = (page: Page) => page.locator('.notes-editor-content').first()

test('opens at top; remembers scroll across home↔notes; raw toggle keeps location; tabs survive refresh', async ({ page }) => {
  await seedNotes()
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await gotoNotes(page)
  await openNoteFromTree(page, 'ScrollTest', 'Long Note')
  // ⌘-click → second TAB (single click would replace the active tab), then
  // re-activate Long Note via the tab strip.
  await openNoteFromTree(page, 'ScrollTest', 'Other Note', { newTab: true })
  await page.locator('.notes-tab', { hasText: 'Long Note' }).click()
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible({ timeout: 5000 })

  // (1) fresh open lands at top, NOT bottom
  const box = scrollBox(page)
  await page.waitForTimeout(400)
  expect(await box.evaluate((el) => el.scrollTop)).toBeLessThan(50)

  // Scroll to ~middle and let the debounced memory persist
  await box.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5 })
  await page.waitForTimeout(700)
  const savedTop = await box.evaluate((el) => el.scrollTop)
  expect(savedTop).toBeGreaterThan(200)

  // (2) route away and back — position restored (±15%)
  await page.locator('a[href="/"]').first().click()
  await page.waitForLoadState('networkidle')
  await gotoNotes(page)
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(500)
  const restoredTop = await scrollBox(page).evaluate((el) => el.scrollTop)
  expect(Math.abs(restoredTop - savedTop)).toBeLessThan(savedTop * 0.15 + 40)

  // (3) rendered → raw keeps the same relative location (fraction-based)
  await page.locator('.notes-raw-toggle-btn').click()
  const cm = page.locator('.notes-raw-view .cm-scroller')
  await expect(cm).toBeVisible({ timeout: 3000 })
  await page.waitForTimeout(500)
  const rawFrac = await cm.evaluate((el) => {
    const max = el.scrollHeight - el.clientHeight
    return max > 0 ? el.scrollTop / max : 0
  })
  expect(Math.abs(rawFrac - 0.5)).toBeLessThan(0.15)

  // …and raw → rendered restores it too
  await page.locator('.notes-raw-toggle-btn').click()
  await page.waitForTimeout(500)
  const backTop = await scrollBox(page).evaluate((el) => el.scrollTop)
  expect(Math.abs(backTop - savedTop)).toBeLessThan(savedTop * 0.15 + 40)

  // (4) full refresh: both tabs still open, active tab + scroll position kept
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.notes-tab', { hasText: 'Long Note' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.notes-tab', { hasText: 'Other Note' })).toBeVisible()
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible()
  await page.waitForTimeout(600)
  const afterReloadTop = await scrollBox(page).evaluate((el) => el.scrollTop)
  expect(Math.abs(afterReloadTop - savedTop)).toBeLessThan(savedTop * 0.15 + 40)
})
