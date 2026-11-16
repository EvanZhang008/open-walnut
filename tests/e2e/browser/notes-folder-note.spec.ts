/**
 * Folder notes in the Notes tree. A page with sub-pages is stored as `P/P.md`
 * with its children in `P/` (the Obsidian convention the notes importers write),
 * and the tree used to show a `P` folder with a `P` note right under it: two rows
 * with one name, and no telling which to click. Now the folder row IS the page:
 * clicking its name opens `P/P.md` (and unfolds it), the chevron folds, the note
 * is not listed again, and the row shows as selected while that note is open.
 * A folder without a same-named note behaves exactly as before.
 *
 * Real clicks only. Runs in both engines: Chromium by default, WebKit with
 * `PW_WEBKIT=1 ... --project=webkit`.
 */
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(90_000)

const API = 'http://localhost:3457'
// Unique per run: the e2e home is shared by every spec and retries.
const ROOT = `FolderNote${Date.now().toString(36)}`
const NOTES: Array<[string, string]> = [
  [`${ROOT}/${ROOT}.md`, '# Home\n\nhome page body\n'],
  [`${ROOT}/Child A/Child A.md`, '# Child A\n\nchild a body\n'],
  [`${ROOT}/Child A/Deep page.md`, '# Deep\n\ndeep page body\n'],
  // Lowercase `plain.md` in `Plain/`: not a folder note (exact match only).
  [`${ROOT}/Plain/plain.md`, '# plain\n\nlowercase body\n'],
  [`${ROOT}/Plain/Other.md`, '# Other\n\nother body\n'],
]

async function seed() {
  for (const [p, content] of NOTES) {
    const res = await fetch(`${API}/api/notes-v2/content/${encodeURI(p)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.ok, `seed ${p}`).toBe(true)
  }
}

// Leave the shared e2e home as it was found.
test.afterAll(async () => {
  await fetch(`${API}/api/notes-v2/folder/${encodeURIComponent(ROOT)}`, { method: 'DELETE' }).catch(() => {})
})

const row = (page: Page, path: string) => page.locator(`.notes-tree-body [data-node-path="${path}"]`)
const editor = (page: Page) => page.locator('.notes-editor-pane .notes-editor .tiptap').first()

test('a folder with a same-named note is one row that opens the note', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await seed()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('a[href="/notes"]').first().click()

  const home = row(page, ROOT)
  await expect(home).toBeVisible({ timeout: 30_000 })
  await expect(home).toHaveClass(/notes-tree-folder-note/)
  await expect(home).toHaveAttribute('title', `Open ${ROOT}`)

  // Click the NAME: opens the folder note, unfolds the folder, marks it selected.
  await home.locator('.notes-tree-name').click()
  await expect(editor(page)).toContainText('home page body', { timeout: 10_000 })
  await expect(home).toHaveClass(/\bselected\b/)
  const childA = row(page, `${ROOT}/Child A`)
  await expect(childA).toBeVisible()
  // The folder note itself has no row of its own.
  await expect(row(page, `${ROOT}/${ROOT}.md`)).toHaveCount(0)

  // Clicking the name again keeps the folder open (folding is the chevron's job).
  await home.locator('.notes-tree-name').click()
  await expect(childA).toBeVisible()

  // A nested folder note: same, and the selection moves to it.
  await childA.locator('.notes-tree-name').click()
  await expect(editor(page)).toContainText('child a body', { timeout: 10_000 })
  await expect(childA).toHaveClass(/\bselected\b/)
  await expect(home).not.toHaveClass(/\bselected\b/)
  const deep = row(page, `${ROOT}/Child A/Deep page.md`)
  await expect(deep).toBeVisible()
  await expect(row(page, `${ROOT}/Child A/Child A.md`)).toHaveCount(0)

  // The chevron folds without opening anything else.
  await childA.locator('.notes-tree-arrow').click()
  await expect(deep).toBeHidden()
  await expect(editor(page)).toContainText('child a body')
  await expect(childA).toHaveClass(/\bselected\b/)
  await childA.locator('.notes-tree-arrow').click()
  await expect(deep).toBeVisible()

  // A sibling note opens as before; the folder row is no longer selected.
  await deep.click()
  await expect(editor(page)).toContainText('deep page body', { timeout: 10_000 })
  await expect(childA).not.toHaveClass(/\bselected\b/)

  // A plain folder (its `plain.md` differs in case) is unchanged: the name
  // toggles, both notes are listed, nothing opens.
  const plain = row(page, `${ROOT}/Plain`)
  await expect(plain).not.toHaveClass(/notes-tree-folder-note/)
  await expect(plain).not.toHaveAttribute('title', /.+/)
  await plain.locator('.notes-tree-name').click()
  await expect(row(page, `${ROOT}/Plain/plain.md`)).toBeVisible()
  await expect(row(page, `${ROOT}/Plain/Other.md`)).toBeVisible()
  await expect(editor(page)).toContainText('deep page body')
  await plain.locator('.notes-tree-name').click()
  await expect(row(page, `${ROOT}/Plain/plain.md`)).toBeHidden()

  // Right-click: the note and the folder each get their own actions.
  await childA.click({ button: 'right' })
  const menu = page.locator('.notes-context-menu')
  await expect(menu).toBeVisible()
  for (const label of ['Open in new tab', 'Rename note', 'Delete note', 'New Note', 'New Folder', 'Delete folder']) {
    await expect(menu.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  // A plain folder's menu has no note actions.
  await page.locator('.notes-tree-header h3').click()
  await expect(menu).toBeHidden()
  await plain.click({ button: 'right' })
  await expect(menu.getByRole('button', { name: 'Delete folder', exact: true })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Rename note', exact: true })).toHaveCount(0)
  await page.locator('.notes-tree-header h3').click()
  await expect(menu).toBeHidden()

  // Rename note: the input appears in the folder row; after the rename the note
  // is an ordinary note in the folder and the row is a plain folder again.
  await childA.click({ button: 'right' })
  await menu.getByRole('button', { name: 'Rename note', exact: true }).click()
  const input = childA.locator('input.notes-tree-inline-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Child A')
  await input.fill('Child A intro')
  await input.press('Enter')
  const renamed = row(page, `${ROOT}/Child A/Child A intro.md`)
  await expect(renamed).toBeVisible({ timeout: 10_000 })
  await expect(childA).not.toHaveClass(/notes-tree-folder-note/)
  const tree = await (await fetch(`${API}/api/notes-v2`)).json() as { tree: Array<{ path: string; children?: unknown[] }> }
  expect(JSON.stringify(tree.tree)).toContain(`${ROOT}/Child A/Child A intro.md`)
  expect(JSON.stringify(tree.tree)).not.toContain(`${ROOT}/Child A/Child A.md`)

  expect(errors).toEqual([])
})
