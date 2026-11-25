/**
 * The Notes page steps every locked- and hidden-note spec takes (docs/reference/locked-notes.md):
 * seed plain notes in a test folder, open the page, open a note from the tree, use the header's
 * Lock menu, type in the editor. Fake text only.
 */
import { expect, type Page } from '@playwright/test'

export const API = 'http://localhost:3457'

/** A name part each run of a test makes its own (repeat-each and reruns share one fixture server). */
export const stamp = (info: { repeatEachIndex: number }) => `${info.repeatEachIndex}-${Date.now() % 100000}`

/** Write plain notes, `[path, text]` each, as the person. */
export async function putNotes(notes: Array<[string, string]>) {
  for (const [p, content] of notes) {
    const r = await fetch(`${API}/api/notes-v2/content/${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    expect(r.ok).toBe(true)
  }
}

/** A note's name as the tree shows it: its file name without the folder and `.md`. */
export const nameIn = (folder: string, p: string) => p.slice(`${folder}/`.length, -'.md'.length)

export async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')
}

export const editorOf = (page: Page) => page.locator('.notes-editor-pane .notes-editor .tiptap').first()

/** Open `p` (a note in `folder`) from the tree, opening the folder first when it is closed. */
export async function openNoteIn(page: Page, folder: string, p: string) {
  const dir = page.locator('.notes-tree-folder', { hasText: folder })
  await dir.waitFor({ state: 'visible', timeout: 60_000 })
  const file = page.locator('.notes-tree-file', { hasText: nameIn(folder, p) }).first()
  if (!(await file.isVisible().catch(() => false))) await dir.click()
  await file.click()
}

/** The header's Lock control: its menu (with exactly `expectRows` when given), then one of its rows. */
export async function lockMenu(page: Page, row: 'Hide from AI' | 'Encrypt' | 'Unhide', expectRows?: string[]) {
  await page.getByTestId('note-lock').click()
  const menu = page.getByTestId('note-protect-menu')
  await expect(menu).toBeVisible()
  if (expectRows) await expect(menu.getByRole('menuitem')).toHaveText(expectRows)
  await menu.getByRole('menuitem', { name: row }).click()
}

export async function typeAtEnd(page: Page, line: string, words: string) {
  await editorOf(page).locator('p', { hasText: line }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(words)
}
