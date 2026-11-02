/**
 * A notes search row says which note it is: the file name leads (as in the tree
 * and the tabs), its folder heads the group (the tree search) or follows the name
 * (Cmd+K), and the note's own title shows under the name only when it says
 * something else. 2026-11-01: a note named like `LaunchHook.md` showed only as an
 * unrelated first-heading sentence, so the user could not tell it was the one.
 *
 * The search answer is stubbed with neutral rows so the shape is exact; the
 * ranking that finds a file by its name's words is pinned in
 * tests/web/routes/notes-v2-hybrid-search.test.ts. Real clicks and keys only.
 * Runs in both engines: Chromium by default, WebKit with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(90_000)

const SHOTS = '/tmp/notes-search-file-name'
const ROWS = [
  { id: 'n1', path: 'ideas/LaunchHook.md', title: 'How I doubled my output in a week', snippet: '...post a <mark>launch</mark> screenshot along the way...', matchType: 'exact', stringScore: 0.96 },
  { id: 'n2', path: 'ideas/Launch notes.md', title: 'Launch notes', snippet: '<mark>Launch</mark> notes for the spring', matchType: 'exact', stringScore: 0.93 },
  { id: 'n3', path: 'Reading list.md', title: 'Books to read', snippet: 'a book on rocket <mark>launch</mark> history', matchType: 'exact', stringScore: 0.7 },
]

async function routeSearch(page: Page) {
  await page.route((url) => url.pathname === '/api/notes-v2/search', (route) =>
    route.fulfill({ json: { results: ROWS, queryTokens: ['launch'] } }))
}

async function openNotes(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await expect(page.locator('.notes-search-input').first()).toBeVisible({ timeout: 30_000 })
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('the tree search leads each row with its file name, under its folder', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await routeSearch(page)
  await openNotes(page)
  await page.locator('.notes-search-input').first().fill('launch')
  const results = page.locator('.notes-search-results')
  await expect(results.locator('.notes-search-result')).toHaveCount(3, { timeout: 15_000 })

  const rows = results.locator('.notes-search-result')
  await expect(rows.nth(0).locator('.notes-search-file-name')).toHaveText('LaunchHook')
  await expect(rows.nth(0).locator('.notes-search-note-title')).toHaveText('How I doubled my output in a week')
  // A title that only repeats the file name is not shown twice.
  await expect(rows.nth(1).locator('.notes-search-file-name')).toHaveText('Launch notes')
  await expect(rows.nth(1).locator('.notes-search-note-title')).toHaveCount(0)
  // A root note has no folder header; its name still leads.
  await expect(rows.nth(2).locator('.notes-search-file-name')).toHaveText('Reading list')
  await expect(rows.nth(2).locator('.notes-search-note-title')).toHaveText('Books to read')
  // The folder heads its group, once for the two notes in it.
  await expect(results.locator('.notes-search-folder')).toHaveText(['ideas'])
  // The name is marked where the query hits it.
  await expect(rows.nth(0).locator('.notes-search-file-name mark')).toHaveText('Launch')
  // The whole vault path is on hover.
  await expect(rows.nth(0).locator('.notes-search-file-name')).toHaveAttribute('title', 'ideas/LaunchHook.md')
  // Names never wrap the row wider than the panel.
  const box = await rows.nth(0).boundingBox()
  const panel = await results.boundingBox()
  expect(box && panel && box.x + box.width <= panel.x + panel.width + 1).toBe(true)
  await shot(page, 'tree', results)

  // A double click opens the row's note and closes the search (a single click
  // only previews it: tests/e2e/browser/notes-search-preview.spec.ts).
  await rows.nth(0).dblclick()
  await expect(page.locator('.notes-search-results')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Cmd+K leads each row with its file name and folder', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await routeSearch(page)
  await openNotes(page)
  await page.locator('.notes-tree-panel, .notes-tree').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.locator('.notes-cmdk-input, .notes-cmdk input').first()
  await expect(palette).toBeVisible({ timeout: 15_000 })
  await palette.fill('launch')
  const items = page.locator('.notes-cmdk-item:not(.notes-cmdk-create)')
  await expect(items).toHaveCount(3, { timeout: 15_000 })
  await expect(items.nth(0).locator('.notes-cmdk-item-title')).toHaveText('LaunchHook')
  await expect(items.nth(0).locator('.notes-cmdk-item-path')).toHaveText('ideas')
  await expect(items.nth(0).locator('.notes-cmdk-item-note-title')).toHaveText('How I doubled my output in a week')
  await expect(items.nth(1).locator('.notes-cmdk-item-note-title')).toHaveCount(0)
  await expect(items.nth(2).locator('.notes-cmdk-item-title')).toHaveText('Reading list')
  await expect(items.nth(2).locator('.notes-cmdk-item-path')).toHaveCount(0)
  await shot(page, 'cmdk', page.locator('.notes-cmdk').first())
  await page.keyboard.press('Escape')
})
