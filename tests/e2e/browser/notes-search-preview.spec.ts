/**
 * The Notes sidebar search behaves like VS Code's search view (2026-11-02, the user:
 * "a click is only a preview ... you cannot make it vanish the moment I click"):
 *   - a new or changed query shows its results from the top (the list used to keep
 *     the tree's scroll position, so a search opened halfway down);
 *   - a single click opens the hit and keeps the search: its query, its list and
 *     where the list is scrolled; a second click on another hit opens that one;
 *   - a double click, or Enter on the hit the arrow keys are on, opens it and
 *     closes the search; Escape and the clear button close it.
 *
 * Real notes in the fixture vault (40, enough to scroll at any viewport), real
 * search answers, real clicks and keys. Runs in both engines: Chromium by
 * default, WebKit with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { test, expect, type Page, type Response } from '@playwright/test'

test.setTimeout(120_000)

const COUNT = 40

function tag(): string {
  return `pvdrill${test.info().project.name}`
}

function noteName(i: number): string {
  return `${tag()}-${String(i).padStart(2, '0')}`
}

async function seedNotes(page: Page): Promise<void> {
  for (let i = 1; i <= COUNT; i++) {
    const name = noteName(i)
    const body = [`# Drill note ${i}`, '', `A ${tag()} marker line for search.`, '', ...Array.from({ length: 6 }, (_, k) => `Line ${k + 1}.`)].join('\n')
    const res = await page.request.put(`/api/notes-v2/content/${name}.md`, { data: { content: body } })
    expect(res.ok(), await res.text()).toBe(true)
  }
}

async function openNotes(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await expect(page.locator('.notes-search-input').first()).toBeVisible({ timeout: 30_000 })
}

const body = (page: Page) => page.locator('.notes-tree-body').first()
const rows = (page: Page) => page.locator('.notes-search-results .notes-search-result')
const scrollTop = (page: Page) => body(page).evaluate((el) => Math.round(el.scrollTop))

/** Type a query and wait for both answers (the instant string one and the hybrid upgrade). */
async function search(page: Page, q: string): Promise<void> {
  const input = page.locator('.notes-search-input').first()
  const answers = Promise.all([
    page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/notes-v2/search' && u.searchParams.get('q') === q && u.searchParams.get('mode') === 'string' }),
    page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/notes-v2/search' && u.searchParams.get('q') === q && u.searchParams.get('mode') === 'hybrid' }),
  ])
  await input.fill(q)
  await answers
  await expect(rows(page).first()).toBeVisible({ timeout: 15_000 })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await seedNotes(page)
})

test('a new query shows its results from the top, even from a tree scrolled down', async ({ page }) => {
  await openNotes(page)
  // The tree lists the 40 notes: scroll it down first, as a long vault would be.
  await expect(page.locator(`.notes-tree-body [data-node-path="${noteName(COUNT)}.md"]`)).toHaveCount(1, { timeout: 15_000 })
  await body(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
  expect(await scrollTop(page)).toBeGreaterThan(200)

  await search(page, `${tag()} marker`)
  expect(await scrollTop(page)).toBe(0)

  // Scrolled down in the results, then a changed query: from the top again.
  await body(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
  expect(await scrollTop(page)).toBeGreaterThan(200)
  await search(page, `${tag()} marker line`)
  expect(await scrollTop(page)).toBe(0)
})

test('the hybrid upgrade of the same query leaves the list where the user scrolled it', async ({ page }) => {
  // Hold the hybrid answer back so the user can scroll between the two answers.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route((url) => url.pathname === '/api/notes-v2/search' && url.searchParams.get('mode') === 'hybrid', async (route) => {
    await held
    await route.continue()
  })
  await openNotes(page)
  const q = `${tag()} marker`
  const stringAnswer = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/notes-v2/search' && u.searchParams.get('mode') === 'string' && u.searchParams.get('q') === q })
  await page.locator('.notes-search-input').first().fill(q)
  await stringAnswer
  await expect(rows(page).first()).toBeVisible({ timeout: 15_000 })
  await body(page).evaluate((el) => { el.scrollTop = 150 })
  const kept = await scrollTop(page)
  expect(kept).toBeGreaterThan(100)
  const hybridAnswer = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/notes-v2/search' && u.searchParams.get('mode') === 'hybrid' && u.searchParams.get('q') === q })
  release()
  await hybridAnswer
  await page.waitForTimeout(300) // the answer's render
  expect(await scrollTop(page)).toBe(kept)
})

test('a click previews and keeps the search; a double click opens and closes it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openNotes(page)
  const input = page.locator('.notes-search-input').first()
  const q = `${tag()} marker`
  await search(page, q)

  // Scroll the list a little, then click a hit: it opens, the search stays put.
  await body(page).evaluate((el) => { el.scrollTop = 120 })
  const kept = await scrollTop(page)
  const first = rows(page).nth(3)
  const tabs = page.locator('.notes-tab')
  const firstName = (await first.locator('.notes-search-file-name').innerText()).trim()
  await first.click()
  await expect(page.locator('.notes-tab.active .notes-tab-label')).toHaveText(firstName, { timeout: 15_000 })
  await expect(input).toHaveValue(q)
  await expect(first).toHaveClass(/selected/)
  expect(await scrollTop(page)).toBe(kept)
  const tabCount = await tabs.count()

  // A second hit, in turn: it opens in the same preview tab, the search still stays.
  const second = rows(page).nth(5)
  const secondName = (await second.locator('.notes-search-file-name').innerText()).trim()
  await second.click()
  await expect(page.locator('.notes-tab.active .notes-tab-label')).toHaveText(secondName, { timeout: 15_000 })
  await expect(input).toHaveValue(q)
  await expect(rows(page)).not.toHaveCount(0)
  // A preview replaces the previewed note in its tab: no tab per click.
  await expect(tabs).toHaveCount(tabCount)

  // A double click opens the hit and closes the search.
  const third = rows(page).nth(1)
  const thirdName = (await third.locator('.notes-search-file-name').innerText()).trim()
  await third.dblclick()
  await expect(page.locator('.notes-tab.active .notes-tab-label')).toHaveText(thirdName, { timeout: 15_000 })
  await expect(input).toHaveValue('')
  await expect(page.locator('.notes-search-results')).toHaveCount(0)
  await expect(tabs).toHaveCount(tabCount)
  expect(errors).toEqual([])
})

test('Escape and the clear button close the search; arrows and Enter open a hit', async ({ page }) => {
  await openNotes(page)
  const input = page.locator('.notes-search-input').first()
  const q = `${tag()} marker`

  await search(page, q)
  await input.press('Escape')
  await expect(input).toHaveValue('')
  await expect(page.locator('.notes-search-results')).toHaveCount(0)

  await search(page, q)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.notes-search-results')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0)

  // Arrow down twice lands on the second hit; Enter opens it and closes the search.
  await search(page, q)
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  const active = page.locator('.notes-search-result-active')
  await expect(active).toHaveCount(1)
  await expect(active).toHaveAttribute('data-search-idx', '1')
  const name = (await active.locator('.notes-search-file-name').innerText()).trim()
  await input.press('Enter')
  await expect(page.locator('.notes-tab.active .notes-tab-label')).toHaveText(name, { timeout: 15_000 })
  await expect(input).toHaveValue('')
  await expect(page.locator('.notes-search-results')).toHaveCount(0)

  // Enter typed before the first answer opens that query's first hit once it lands. The query
  // asks twice at once (the instant `string` answer and the `hybrid` one), and the first of them
  // to land is the one opened: on a loaded runner that was the hybrid answer, whose open closed
  // the search and dropped the string request (2026-11-02, CI). So the tab is the first hit of
  // an answer to this query, whichever came first.
  const q2 = `${tag()} marker line`
  const firstHits: string[] = []
  const onAnswer = async (r: Response) => {
    const u = new URL(r.url())
    if (u.pathname !== '/api/notes-v2/search' || u.searchParams.get('q') !== q2) return
    const first = ((await r.json().catch(() => null)) as { results?: Array<{ path: string }> } | null)?.results?.[0]?.path
    if (first) firstHits.push(first.replace(/\.md$/, '').split('/').pop()!)
  }
  page.on('response', onAnswer)
  await input.fill(q2)
  await input.press('Enter')
  await expect(input).toHaveValue('', { timeout: 15_000 })
  const tabLabel = page.locator('.notes-tab.active .notes-tab-label')
  await expect.poll(async () => {
    const label = (await tabLabel.textContent())?.trim() ?? ''
    return firstHits.includes(label) ? 'a first hit' : `${label} (first hits: ${firstHits.join(', ') || 'none yet'})`
  }, { timeout: 15_000 }).toBe('a first hit')
  page.off('response', onAnswer)
})
