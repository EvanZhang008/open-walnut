/**
 * The notes searches say when this replica's copy leaves notes out (4f of
 * docs/plan/walnut-companion-unified-replica.md): a search answered with `partial` shows its
 * sentence above the results, in the tree's search box and in Cmd+K; one without (every
 * replica that keeps everything, and the Mac) shows nothing new.
 *
 * The fixture is the Mac, so the search answer is the real one with `partial` added by a
 * page.route while the test says so. Navigation is by real clicks and keys.
 * Runs in both engines: Chromium by default, WebKit with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(90_000)

const SHOTS = '/tmp/g8-keep'
const PARTIAL = { why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not in these results.' }

async function routeSearch(page: Page, state: { partial: boolean }) {
  await page.route((url) => url.pathname === '/api/notes-v2/search', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    await route.fulfill({ response: res, json: state.partial ? { ...body, partial: PARTIAL } : body })
  })
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
  await region.screenshot({ path: `${SHOTS}/notes-partial-${engine}-${name}.png`, scale: 'css' })
}

test('the tree search shows the sentence only when the copy leaves notes out', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const state = { partial: false }
  await routeSearch(page, state)
  await openNotes(page)
  const input = page.locator('.notes-search-input').first()
  const results = page.locator('.notes-search-results')

  // Kept in full: the results as before, no sentence.
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notes-v2/search')
  await input.fill('note')
  await first
  await expect(results).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('notes-search-partial')).toHaveCount(0)

  // Partial: the sentence above the results.
  state.partial = true
  const second = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notes-v2/search')
  await input.fill('notes')
  await second
  const line = page.getByTestId('notes-search-partial')
  await expect(line).toHaveText(PARTIAL.message, { timeout: 15_000 })
  await shot(page, 'tree', page.locator('.notes-tree-panel, .notes-tree').first())

  // The next answer without it: the sentence goes.
  state.partial = false
  const third = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notes-v2/search')
  await input.fill('note')
  await third
  await expect(line).toHaveCount(0, { timeout: 15_000 })
  await input.fill('')
  expect(errors).toEqual([])
})

test('Cmd+K shows the sentence only when the copy leaves notes out', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const state = { partial: true }
  await routeSearch(page, state)
  await openNotes(page)
  await page.locator('.notes-tree-panel, .notes-tree').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.locator('.notes-cmdk-input, .notes-cmdk input').first()
  await expect(palette).toBeVisible({ timeout: 15_000 })
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notes-v2/search')
  await palette.fill('note')
  await answered
  const line = page.getByTestId('notes-cmdk-partial')
  await expect(line).toHaveText(PARTIAL.message, { timeout: 15_000 })
  await shot(page, 'cmdk', page.locator('.notes-cmdk').first())
  state.partial = false
  const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notes-v2/search')
  await palette.fill('notes')
  await again
  await expect(line).toHaveCount(0, { timeout: 15_000 })
  await page.keyboard.press('Escape')
})
