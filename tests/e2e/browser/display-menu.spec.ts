/**
 * E2E: the home task panel's one menu under Display (spec 3.3, 6.5; checklist C1, C12 to C15,
 * C18, C19, C29b, C32, C36, C37, C42, C52, C56, C58, C64, C70). Page one holds the filter rows,
 * then Sort, Group, the View row, Show tab bar and Session columns, then the rows only some views
 * have. The View row opens the View page: the tabs kept on the bar first (All + Pinned for a new
 * user, no tier word), a hairline, then every other view; a pick there switches the list and
 * closes the menu. Rows every view has sit at the same place in every view; Sort never drops a
 * project's own order without asking. Each test seeds its own tasks through the API (or stubs
 * one read) from isolated UI prefs.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { isolateUiPrefs, openListProject } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'
import {
  displayButton, displayMenu, filterRow, filterSearch, openDisplayMenu, closeDisplayMenu,
  openViewsPage, setStatus, viewRow, viewsPage,
} from './filter-bar-helpers'

const SHOTS = '/tmp/filterbar/shots'
const TIER_WORDS = /\b(tier|focus|satellite|backlog|parked)\b/i
const QUICK_VIEWS_KEY = 'walnut-todo-quick-views-visible'

test.setTimeout(240_000)

/** A new user's panel: the tab bar on, the bar's tab list untouched (All + Pinned). */
async function boot(page: Page, baseURL: string, extra?: Record<string, string>): Promise<void> {
  await isolateUiPrefs(page)
  await page.addInitScript(([qv, seed]) => {
    try {
      if (sessionStorage.getItem('pw-display-seeded')) return
      sessionStorage.setItem('pw-display-seeded', '1')
      localStorage.setItem(qv as string, 'true')
      localStorage.setItem('walnut-todo-collapsed-sections', '[]')
      for (const [k, v] of Object.entries(seed as Record<string, string>)) localStorage.setItem(k, v)
    } catch { /* ignore */ }
  }, [QUICK_VIEWS_KEY, extra ?? {}] as const)
  await openHome(page, baseURL, 90_000)
}

/** Create tasks in one fresh project; returns their ids in creation order. */
async function seedProject(page: Page, project: string, specs: { title: string; done?: boolean }[]): Promise<string[]> {
  const ids: string[] = []
  for (const spec of specs) {
    const res = await page.request.post('/api/tasks', { data: { title: spec.title, source: 'local', project } })
    expect(res.ok(), await res.text()).toBe(true)
    const id = (await res.json()).task.id as string
    if (spec.done) expect((await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true)
    ids.push(id); cleanup.push(id)
  }
  return ids
}

// Every task a test seeds is unpinned and deleted when it ends, pass or fail.
const cleanup: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of cleanup.splice(0)) for (const url of [`/api/focus/tasks/${id}`, `/api/tasks/${id}`]) await request.delete(url).catch(() => {})
})

const tab = (page: Page, name: string) => page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
/** A row (or a segment) of the menu's open page, by its `data-view-option` key. */
const option = (page: Page, key: string) => displayMenu(page).locator(`[data-view-option="${key}"]`)
/** One view on the View page. */
const viewChoice = (page: Page, key: string) => viewsPage(page).locator(`.dm-view[data-view-option="${key}"]`)
/** The View row's value: the current view's name. */
const viewSummary = (page: Page) => viewRow(page).locator('.fb-prop-summary')

/** The View page's views in order: the bar's tabs above the hairline, the rest below it. */
async function viewLayers(page: Page): Promise<{ first: string[]; more: string[] }> {
  return viewsPage(page).locator('.dm-views').evaluate((list) => {
    const layers = { first: [] as string[], more: [] as string[] }
    let below = false
    for (const el of Array.from(list.children)) {
      if (el.classList.contains('dm-flyout-sep')) below = true
      else if (el.matches('.dm-view[data-view-option]')) (below ? layers.more : layers.first).push(el.getAttribute('data-view-option')!)
    }
    return layers
  })
}

/** Pick a view on the View page: the menu closes and focus returns to Display. */
async function pickView(page: Page, key: string) {
  await openViewsPage(page)
  await viewChoice(page, key).click()
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(displayButton(page)).toBeFocused()
}
const box = async (locator: Locator) => { const b = await locator.boundingBox(); expect(b).not.toBeNull(); return b! }

async function insideViewport(page: Page, locator: Locator): Promise<void> {
  const [b, vp] = [await box(locator), page.viewportSize()!]
  expect([b.x >= 0, b.y >= 0, b.x + b.width <= vp.width + 0.5, b.y + b.height <= vp.height + 0.5]).toEqual([true, true, true, true])
}

test('one menu: the filter rows, then the display rows; the View page lists the bar first, every other view below', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page, baseURL!)
  // C1: the old popover is gone from the home panel, and Display is the toolbar's one menu button.
  const toolbar = page.locator('#home-task-navigation .todo-panel-toolbar')
  await expect(toolbar.getByRole('button', { name: 'View options' })).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0)
  const btn = displayButton(page)
  expect(await btn.evaluate((el) => [el.getAttribute('title'), el.getAttribute('aria-haspopup'), el.getAttribute('aria-expanded')]))
    .toEqual(['Display: sort, group, layout', 'dialog', 'false'])
  await expect(btn.locator('.vd-dot')).toHaveCount(0)
  await openDisplayMenu(page)
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
  const menu = displayMenu(page)
  expect(await menu.evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('data-page')]))
    .toEqual(['dialog', 'Filter and display', 'home'])
  expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true)
  expect((await box(menu)).width).toBeLessThanOrEqual(320.5)
  // Focus starts in the one search box, which searches filters and views alike.
  await expect(filterSearch(page)).toBeFocused()
  await expect(filterSearch(page)).toHaveAttribute('placeholder', 'Search filters and views')
  // Page one, top to bottom: the filter rows, Sort and Group, View / Show tab bar / Session
  // columns, then the rows only some views have (All: Collapse all).
  const sections = await menu.locator('.fb-home, .dm-section').evaluateAll((els) =>
    els.map((el) => (el.classList.contains('fb-home') ? 'filters' : [...el.classList].find((c) => c !== 'dm-section'))))
  expect(sections).toEqual(['filters', 'dm-order', 'dm-settings', 'dm-context'])
  expect(await menu.locator('.dm-settings > [data-view-option]').evaluateAll((els) => els.map((el) => el.getAttribute('data-view-option'))))
    .toEqual(['view', 'quick-views', 'session-panels'])
  // C13 / C13b: no view sits on page one; the View row names the current one, and no tier
  // word shows anywhere on the page.
  for (const key of ['all', 'pinned', 'focus', 'tasks']) await expect(option(page, key)).toHaveCount(0)
  expect(await viewRow(page).evaluate((el) => [el.getAttribute('aria-haspopup'), el.getAttribute('title')]))
    .toEqual(['true', 'View: All, Pinned and the other views'])
  await expect(viewRow(page).locator('.fb-item-text')).toHaveText('View')
  await expect(viewSummary(page)).toHaveText('All')
  expect(await menu.innerText()).not.toMatch(TIER_WORDS)
  // C12: no native checkbox; the tab bar switch is a role="switch".
  await expect(menu.locator('input[type="checkbox"]')).toHaveCount(0)
  expect(await option(page, 'quick-views').evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-checked'), el.getAttribute('title')]))
    .toEqual(['switch', 'true', 'All, Pinned and the other views as tabs across the top'])
  for (const key of ['session-panels', 'sort', 'group', 'collapse']) await expect(option(page, key)).toHaveCount(1)
  await expect(option(page, 'session-panels').locator('[data-choice]')).toHaveCount(6)
  await menu.screenshot({ path: `${SHOTS}/display-menu-light.png` })

  // C13 / C15: the View row opens the View page: All and Pinned (the bar's tabs) above a
  // hairline, every other view below it, each with its sentence.
  await viewRow(page).click()
  await expect(viewsPage(page)).toBeVisible()
  await expect(menu).toHaveAttribute('data-page', 'view')
  await expect(viewsPage(page).locator('.fb-page-title')).toHaveText('View')
  await expect(filterSearch(page)).toHaveAttribute('placeholder', 'Search views')
  const layers = await viewLayers(page)
  expect(layers.first).toEqual(['all', 'pinned'])
  expect(layers.more.filter((k) => !k.startsWith('ct_'))).toEqual(['focus', 'satellite', 'wait', 'recent', 'tasks'])
  await expect(viewsPage(page).locator('.dm-flyout-sep')).toHaveCount(1)
  const titles = await viewsPage(page).locator('.dm-view').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
  expect(titles.every((t) => t !== '')).toBe(true)
  for (const key of layers.first) expect(await viewChoice(page, key).getAttribute('title')).not.toMatch(TIER_WORDS)
  await expect(viewChoice(page, 'tasks')).toHaveAttribute('title', 'Projects: every task grouped by project, with filters applied')
  // The current view is pressed, checked and takes focus.
  await expect(viewChoice(page, 'all')).toHaveAttribute('aria-pressed', 'true')
  await expect(viewChoice(page, 'all').locator('.fb-check svg')).toHaveCount(1)
  await expect(viewChoice(page, 'all')).toBeFocused()
  await menu.screenshot({ path: `${SHOTS}/display-views-page.png` })
  // Back returns to page one with focus on the View row.
  await viewsPage(page).getByRole('button', { name: 'Back to all filters' }).click()
  await expect(menu).toHaveAttribute('data-page', 'home')
  await expect(viewRow(page)).toBeFocused()
  await closeDisplayMenu(page)
  await expect(btn).toBeFocused()
  await expect(page.locator('.vd-panel, .vd-rail, [data-rail-section]')).toHaveCount(0)
})

test('a view picked on the View page switches the list and the tab bar, closes the menu, and the View row names it', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  // C14: Pinned from the View page: the tab follows, the menu closes, focus is back on Display.
  await pickView(page, 'pinned')
  await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true')
  await openDisplayMenu(page)
  await expect(viewSummary(page)).toHaveText('Pinned')
  await openViewsPage(page)
  await expect(viewChoice(page, 'pinned')).toHaveAttribute('aria-pressed', 'true')
  await expect(viewChoice(page, 'all')).toHaveAttribute('aria-pressed', 'false')

  // Focus, from below the hairline: the bar draws its tab while it is the view.
  await viewChoice(page, 'focus').click()
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')
  await openDisplayMenu(page)
  await expect(viewSummary(page)).toHaveText('Focus')
  // A tier view has the same Sort and Group as every view, live (the old Tier layout row is
  // its Group); both pick and the menu stays open. No row says it only works elsewhere.
  for (const [row, key] of [['group', 'none'], ['group', 'project'], ['sort', 'priority'], ['sort', 'manual']] as const) {
    await option(page, row).locator(`[data-choice="${key}"]`).click()
    await expect(option(page, row).locator(`[data-choice="${key}"]`)).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(displayMenu(page)).toBeVisible()
  await expect(option(page, 'sort').locator('[data-choice]')).toHaveCount(4)
  expect(await displayMenu(page).innerText()).not.toMatch(/Tier layout|Recent order|Only in/)
  await closeDisplayMenu(page)

  // Recent: the same two rows; its Sort has no Manual (a feed has no hand order).
  await pickView(page, 'recent')
  await openDisplayMenu(page)
  await expect(viewSummary(page)).toHaveText('Recent')
  await expect(option(page, 'sort').locator('[data-choice="manual"]')).toHaveCount(0)
  for (const [row, key] of [['sort', 'date'], ['sort', 'updated'], ['group', 'project'], ['group', 'none']] as const) {
    await option(page, row).locator(`[data-choice="${key}"]`).click()
    await expect(option(page, row).locator(`[data-choice="${key}"]`)).toHaveAttribute('aria-pressed', 'true')
  }
  await closeDisplayMenu(page)

  // Every other built-in view picks from the View page too.
  for (const [key, label] of [['satellite', 'Satellite'], ['tasks', 'Projects']] as const) {
    await pickView(page, key)
    await openDisplayMenu(page)
    await expect(viewSummary(page)).toHaveText(label)
    await closeDisplayMenu(page)
  }
  await openViewsPage(page)
  await expect(viewChoice(page, 'tasks')).toHaveAttribute('aria-pressed', 'true')
  await closeDisplayMenu(page)
  // Projects is not a tab: nothing on the bar is selected.
  await expect(page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(0)

  // Search on page one finds views as well as filter values: `View  Parked`, one click picks it.
  await openDisplayMenu(page)
  await filterSearch(page).fill('Parked')
  const hit = displayMenu(page).locator('.fb-hit[data-view-option="wait"]')
  await expect(hit.locator('.fb-hit-dim')).toHaveText('View')
  await expect(hit.locator('.fb-hit-value')).toHaveText('Parked')
  await hit.click()
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(tab(page, 'Parked')).toHaveAttribute('aria-selected', 'true')

  // Back to All: the last row is Collapse all again and the View row says All.
  await pickView(page, 'all')
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
  await openDisplayMenu(page)
  await expect(viewSummary(page)).toHaveText('All')
  await expect(option(page, 'collapse')).toHaveCount(1)
  await closeDisplayMenu(page)
})

test('page one keeps its height and every row in place in every view; the View page scrolls the long tail (30 custom tiers)', async ({ page, baseURL }) => {
  // The server caps custom tiers at 20; the client must still hold 30, so the read is stubbed.
  const tiers = Array.from({ length: 30 }, (_, i) => ({ id: `ct_pw_display_${i}`, label: `Lane ${i + 1}` }))
  await page.route('**/api/focus/tiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tiers }) })
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await boot(page, baseURL!)
  await openDisplayMenu(page)
  const height = async () => (await box(displayMenu(page))).height
  // Rows every view has (Sort, Group, View, Session columns: C29b) sit at the same place in
  // every view; only the last row, Collapse all, comes and goes (views with project groups).
  const ys = async () => { const top = (await box(displayMenu(page))).y; return Promise.all([option(page, 'sort'), option(page, 'group'), option(page, 'view'), option(page, 'session-panels')]
    .map(async (l) => Math.round((await box(l)).y - top))) }
  await expect(option(page, 'sort')).toBeVisible()
  const h0 = await height()
  const y0 = await ys()
  // The height without the Collapse row, the same in every view that has none.
  let hBare: number | null = null
  const steady = async (withCollapse: boolean) => {
    const h = await height()
    if (withCollapse) expect(Math.abs(h - h0)).toBeLessThan(0.5)
    else { expect(h).toBeLessThan(h0); hBare ??= h; expect(Math.abs(h - hBare)).toBeLessThan(0.5) }
    for (const [i, y] of (await ys()).entries()) expect(Math.abs(y - y0[i])).toBeLessThanOrEqual(1)
  }
  await closeDisplayMenu(page)
  for (const [key, withCollapse] of [['focus', false], ['recent', false], ['all', true]] as const) {
    await pickView(page, key)
    await openDisplayMenu(page)
    await expect(option(page, 'group')).toBeVisible()
    await expect(option(page, 'collapse')).toHaveCount(withCollapse ? 1 : 0)
    await steady(withCollapse)
    await closeDisplayMenu(page)
  }

  // The bar keeps all 30, but the View page's first layer is capped; the long tail is below
  // the hairline, inside a menu capped at 520px whose body scrolls.
  await openViewsPage(page)
  const layers = await viewLayers(page)
  expect(layers.first.length).toBeLessThanOrEqual(6)
  expect(layers.more).toContain('ct_pw_display_29')
  expect((await box(displayMenu(page))).height).toBeLessThanOrEqual(520.5)
  await insideViewport(page, displayMenu(page))
  expect(await displayMenu(page).locator('.fb-menu-body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  // The search box narrows the list, and says so when nothing is left.
  await filterSearch(page).fill('Lane 30')
  await expect(viewsPage(page).locator('.dm-view')).toHaveCount(1)
  await filterSearch(page).fill('no such lane')
  await expect(viewsPage(page).locator('.dm-view')).toHaveCount(0)
  await expect(viewsPage(page).locator('.fb-empty')).toHaveText('No view matches "no such lane"')
  await filterSearch(page).fill('')
  // C19: a pick in the long tail lands; page one is the same size in that view too.
  await viewChoice(page, 'ct_pw_display_29').scrollIntoViewIfNeeded()
  await viewChoice(page, 'ct_pw_display_29').click()
  await expect(displayMenu(page)).toHaveCount(0)
  await openDisplayMenu(page)
  await expect(viewSummary(page)).toHaveText('Lane 30')
  await steady(false)
  await closeDisplayMenu(page)
})

const readLs = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)
const sortKeys = async (page: Page) => ({ sort: await readLs(page, 'walnut-todo-sortBy'), own: await readLs(page, 'walnut-todo-project-sort') })

/** The seeded rows of one project, top to bottom (Projects view). */
async function rowOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  return page.locator('.todo-panel-list [data-task-id]').evaluateAll(
    (els, wanted) => [...new Set(els.map((el) => el.getAttribute('data-task-id')!).filter((id) => (wanted as string[]).includes(id)))],
    ids as string[])
}

test('Sort, Group and Collapse write the board settings; Sort never drops a project order without asking', async ({ page, baseURL }) => {
  const stamp = Date.now()
  const project = `Display Sort ${stamp}`
  const other = `Display Other ${stamp}`
  const ids = await seedProject(page, project, [{ title: `sort a ${stamp}` }, { title: `sort b ${stamp}` }, { title: `sort c ${stamp}` }])
  await seedProject(page, other, [{ title: `sort other ${stamp}` }])
  // Touch A last, so Updated and Created disagree about the top row.
  expect((await page.request.patch(`/api/tasks/${ids[0]}`, { data: { title: `sort a touched ${stamp}` } })).ok()).toBe(true)
  await boot(page, baseURL!, { 'walnut-todo-project-sort': JSON.stringify({ [project]: 'priority', [other]: 'date' }) })
  await pickView(page, 'tasks')
  await openListProject(page, project)
  await expect.poll(() => rowOrder(page, ids)).toHaveLength(3)

  // C52: two projects keep their own order: no segment is pressed, the menu says so.
  await openDisplayMenu(page)
  const sort = option(page, 'sort')
  await expect(sort.locator('[aria-pressed="true"]')).toHaveCount(0)
  await expect(displayMenu(page).locator('.dm-note')).toHaveText('2 projects use their own order')
  const before = await sortKeys(page)
  await sort.locator('[data-choice="priority"]').click()
  await expect(displayMenu(page).locator('.dm-confirm')).toContainText('Use Priority for every project? This replaces 2 project orders.')
  await displayMenu(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(displayMenu(page).locator('.dm-confirm')).toHaveCount(0)
  expect(await sortKeys(page)).toEqual(before)
  await sort.locator('[data-choice="date"]').click()
  await displayMenu(page).getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(sort.locator('[data-choice="date"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(displayMenu(page).locator('.dm-note')).toHaveCount(0)
  expect(JSON.parse((await readLs(page, 'walnut-todo-project-sort')) ?? '{}')).toEqual({})
  expect(await readLs(page, 'walnut-todo-sortBy')).toContain('date')

  // C37: Sort writes the legacy sortBy and the list follows (Created: newest first).
  await expect.poll(() => rowOrder(page, ids)).toEqual([ids[2], ids[1], ids[0]])
  await sort.locator('[data-choice="updated"]').click()
  await expect(sort.locator('[data-choice="updated"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await readLs(page, 'walnut-todo-sortBy')).toContain('updated')
  await expect.poll(async () => (await rowOrder(page, ids))[0]).toBe(ids[0])
  // With no project orders left, re-picking the pressed segment writes nothing.
  const settled = await sortKeys(page)
  await sort.locator('[data-choice="updated"]').click()
  await expect(displayMenu(page).locator('.dm-confirm')).toHaveCount(0)
  expect(await sortKeys(page)).toEqual(settled)

  // Group: Flat and back.
  const group = option(page, 'group')
  await group.locator('[data-choice="none"]').click()
  await expect(group.locator('[data-choice="none"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await readLs(page, 'walnut-todo-groupBy')).toContain('none')
  await expect(page.locator('.todo-group-project-header')).toHaveCount(0)
  await group.locator('[data-choice="project"]').click()
  await expect(group.locator('[data-choice="project"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.todo-group-project-header').first()).toBeVisible()

  // Collapse all / Expand all: the menu stays open and the words flip at once.
  const collapse = option(page, 'collapse')
  const first = (await collapse.innerText()).trim()
  expect(['Collapse all projects', 'Expand all projects']).toContain(first)
  await collapse.click()
  await expect(displayMenu(page)).toBeVisible()
  await expect(collapse).toHaveText(first === 'Collapse all projects' ? 'Expand all projects' : 'Collapse all projects')
  await collapse.click()
  await expect(collapse).toHaveText(first)
  await closeDisplayMenu(page)
})

test('turning the tab bar off from its own menu lands focus on Display and says where it went', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Tab bar options' }).click()
  await page.locator('.wn-context-menu').getByRole('menuitemcheckbox', { name: 'Show tab bar', exact: true }).click()
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0)
  // C56: the menu's opener left with the bar; focus is on the control that brings it back.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Display')
  await expect(page.getByText('Tab bar hidden. Turn it back on in Display', { exact: true }).first()).toBeVisible()
  await openDisplayMenu(page)
  await expect(option(page, 'quick-views')).toHaveAttribute('aria-checked', 'false')
  await option(page, 'quick-views').click()
  await expect(option(page, 'quick-views')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.todo-section-tabs')).toBeVisible()
  await closeDisplayMenu(page)
})

test('with the tab bar off, the filter row names the view and opens Display', async ({ page, baseURL }) => {
  const stamp = Date.now()
  const project = `Display Hidden ${stamp}`
  await boot(page, baseURL!)
  const [done] = await seedProject(page, project, [{ title: `hidden bar finished ${stamp}`, done: true }])
  await openDisplayMenu(page)
  await option(page, 'quick-views').click()
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0)
  // A switch (2026-10-04: "don't make the menu disappear, it is a toggle"): the menu stays
  // open both ways, so the bar is seen going and coming back, and no toast is needed.
  await expect(displayMenu(page)).toBeVisible()
  await expect(option(page, 'quick-views')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('Tab bar hidden. Turn it back on in Display', { exact: true })).toHaveCount(0)
  await option(page, 'quick-views').click()
  await expect(page.locator('.todo-section-tabs')).toBeVisible()
  await expect(displayMenu(page)).toBeVisible()
  await option(page, 'quick-views').click()
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0)
  // On All with no chip there is no row, open or shut.
  await expect(filterRow(page)).toHaveCount(0)
  await closeDisplayMenu(page)
  await expect(filterRow(page)).toHaveCount(0)

  // C70: Pinned while the bar is off: the row leads with the view, which is not a chip.
  await pickView(page, 'pinned')
  const viewItem = filterRow(page).locator('.fb-view-item')
  await expect(viewItem).toHaveText(/View:\s*Pinned/)
  await expect(viewItem).toHaveAttribute('aria-label', 'View: Pinned, change in Display')
  await expect(viewItem.locator('.fb-chip-x')).toHaveCount(0)
  await expect(page.getByTestId('filter-badge')).toHaveCount(0)
  await expect(displayButton(page)).toHaveAttribute('title', /Pinned/)
  // The view item opens the same menu, whose View row names the view.
  await viewItem.click()
  await expect(displayMenu(page)).toBeVisible()
  await expect(viewSummary(page)).toHaveText('Pinned')
  await closeDisplayMenu(page)
  // Clear removes chips (the badge counts them, never the view item), never the view.
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
  await expect(page.getByTestId('filter-badge')).toHaveText('1')
  await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
  await expect(page.getByTestId('filter-badge')).toHaveCount(0)
  await expect(viewItem).toHaveText(/View:\s*Pinned/)
  // Back to All with no chip: the row leaves the DOM.
  await pickView(page, 'all')
  await expect(filterRow(page)).toHaveCount(0)

  // C56: searching a finished task with the bar off: the row offers it, one click shows it.
  await page.locator('#home-task-navigation .todo-search-bar input').fill(`hidden bar finished ${stamp}`)
  const include = filterRow(page).getByRole('button', { name: /Include Complete \(\d+\)/ })
  await expect(include).toBeVisible({ timeout: 15_000 })
  await include.click()
  await expect(page.locator(`#home-task-navigation [data-task-id="${done}"]`).first()).toBeVisible({ timeout: 15_000 })
  await page.locator('#home-task-navigation .todo-search-bar input').fill('')
})

test('a tier view: opening Display covers neither the tier heading nor the tab bar, and the row comes in below both', async ({ page, baseURL }) => {
  // 2026-10-04: with Focus open, a two-line `No filters yet` row floated over the Focus
  // heading and the tab bar, and switching the bar off from the menu closed the menu.
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page, baseURL!, { 'open-walnut-todo-width': '50' })
  await pickView(page, 'focus')
  const heading = page.getByTestId('tier-view-bar')
  const tabs = page.locator('#home-task-navigation .todo-section-tabs')
  await expect(heading).toBeVisible()
  await expect(tabs).toBeVisible()
  const [h0, t0] = [await box(heading), await box(tabs)]
  await openDisplayMenu(page)
  await expect(filterRow(page)).toHaveCount(0)
  const [h1, t1] = [await box(heading), await box(tabs)]
  expect(Math.abs(h1.y - h0.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(t1.y - t0.y)).toBeLessThanOrEqual(1)
  // The menu hangs from Display on the right: at the heading's name and the bar's first tab,
  // the heading and the bar are what the pointer meets.
  const onTop = (sel: string, b: { x: number; y: number; height: number }) => page.evaluate(
    ([s, x, y]) => !!document.elementFromPoint(x as number, y as number)?.closest(s as string), [sel, b.x + 12, b.y + b.height / 2] as const)
  expect(await onTop('[data-testid="tier-view-bar"]', h1)).toBe(true)
  expect(await onTop('.todo-section-tabs', t1)).toBe(true)
  await page.locator('.todo-panel').first().screenshot({ path: `${SHOTS}/tier-view-menu-open.png` })
  // The switch keeps the menu open both ways.
  await option(page, 'quick-views').click()
  await expect(tabs).toHaveCount(0)
  await expect(displayMenu(page)).toBeVisible()
  await option(page, 'quick-views').click()
  await expect(tabs).toBeVisible()
  await expect(displayMenu(page)).toBeVisible()
  await closeDisplayMenu(page)
  // A chip: the row comes in under the heading and the bar, one line, right above the list.
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
  const [r, t2] = [await box(filterRow(page)), await box(tabs)]
  expect(r.y).toBeGreaterThanOrEqual(t2.y + t2.height - 1)
  expect(r.height).toBeLessThanOrEqual(33)
  const list = await box(page.locator('#home-task-navigation .home-navigation-scroll').first())
  expect(r.y + r.height).toBeLessThanOrEqual(list.y + 1)
  await page.locator('.todo-panel').first().screenshot({ path: `${SHOTS}/tier-view-row-under-bars.png` })
  await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
  await expect(filterRow(page)).toHaveCount(0)
})

test('a view put on the bar moves above the hairline on the View page, in bar order', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Tab bar options' }).click()
  await page.locator('.wn-context-menu').getByRole('menuitemcheckbox', { name: 'Focus', exact: true }).click()
  await page.keyboard.press('Escape')
  await openViewsPage(page)
  // C64: All, Pinned, Focus, the order the bar draws them; Focus is no longer below the hairline.
  const layers = await viewLayers(page)
  expect(layers.first.filter((k) => !k.startsWith('ct_'))).toEqual(['all', 'pinned', 'focus'])
  expect(layers.more).not.toContain('focus')
  expect(layers.more).toContain('satellite')
  await viewChoice(page, 'focus').click()
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')
  await openViewsPage(page)
  await expect(viewChoice(page, 'focus')).toHaveAttribute('aria-pressed', 'true')
  await closeDisplayMenu(page)
})

/** WCAG contrast of an element's text over its background, composited up to the first opaque ancestor. */
const contrastOf = (locator: Locator): Promise<number> => locator.evaluate((el) => {
  const rgba = (c: string) => { const v = (c.match(/[\d.]+/g) ?? []).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] }
  const lum = (c: number[]) => [0, 1, 2].map((i) => { const s = c[i] / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const chain: number[][] = []
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = rgba(getComputedStyle(n).backgroundColor)
    if (c[3] > 0) chain.unshift(c)
    if (c[3] >= 1) break
  }
  const bg = chain.reduce((acc, c) => [0, 1, 2].map((i) => c[i] * c[3] + acc[i] * (1 - c[3])), [255, 255, 255])
  const [hi, lo] = [lum(rgba(getComputedStyle(el).color)), lum(bg)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
})

test('keyboard reaches every Display control, with a visible ring and readable checks in both themes', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await boot(page, baseURL!)
  await openDisplayMenu(page)
  // C42: no motion when the system asks for none.
  expect(await displayMenu(page).evaluate((el) => getComputedStyle(el).animationDuration)).toMatch(/^0s$|^0ms$/)
  expect(await option(page, 'quick-views').locator('.dm-switch-track').evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/)
  // C32: focus starts in the search box; Down enters the rows, Up from the first row returns
  // to the box, and the focused row shows the ring.
  const status = displayMenu(page).locator('.fb-prop[data-filter-dim="status"]')
  await expect(filterSearch(page)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(status).toBeFocused()
  expect(await status.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  await page.keyboard.press('ArrowUp')
  await expect(filterSearch(page)).toBeFocused()
  // Segments (All has Group): Left/Right move AND pick (roving tabindex), the ring follows.
  const group = option(page, 'group')
  await group.locator('[data-choice="project"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect(group.locator('[data-choice="none"]')).toBeFocused()
  await expect(group.locator('[data-choice="none"]')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(group.locator('[data-choice="project"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await group.locator('[data-choice]').evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex))).toEqual([0, -1])
  expect(await group.locator('[data-choice="project"]').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  // Down from Group (its active segment) is the View row; Right opens the View page on the current view.
  await page.keyboard.press('ArrowDown')
  await expect(viewRow(page)).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(viewsPage(page)).toBeVisible()
  await expect(viewChoice(page, 'all')).toBeFocused()
  // Up/Down walk the views with the ring; Left goes back to the View row.
  await page.keyboard.press('ArrowDown')
  await expect(viewChoice(page, 'pinned')).toBeFocused()
  expect(await viewChoice(page, 'pinned').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  await page.keyboard.press('ArrowLeft')
  await expect(displayMenu(page)).toHaveAttribute('data-page', 'home')
  await expect(viewRow(page)).toBeFocused()
  // Enter on a view picks it: the menu closes and focus is back on Display.
  await page.keyboard.press('ArrowRight')
  await expect(viewChoice(page, 'all')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(viewChoice(page, 'pinned')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(displayButton(page)).toBeFocused()
  await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true')

  // C36: the selected view keeps its check and >= 4.5:1 text in light and dark.
  await openViewsPage(page)
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const selected = viewChoice(page, 'pinned')
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await expect(selected.locator('.fb-check svg')).toHaveCount(1)
    expect(await contrastOf(selected.locator('.dm-view-label'))).toBeGreaterThanOrEqual(4.5)
    expect(await contrastOf(viewChoice(page, 'all').locator('.dm-view-label'))).toBeGreaterThanOrEqual(4.5)
    await displayMenu(page).screenshot({ path: `${SHOTS}/display-menu-${theme}-focus.png` })
  }
  await page.keyboard.press('Escape')
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(displayButton(page)).toBeFocused()
})

test('Display stays inside the viewport on both pages, never drags a row, and the label follows the panel width', async ({ page, baseURL }) => {
  const [pin] = await seedProject(page, `Display Drag ${Date.now()}`, [{ title: `drag probe ${Date.now()}` }])
  expect((await page.request.post(`/api/focus/tasks/${pin}`)).ok()).toBe(true)
  await boot(page, baseURL!)
  for (const size of [{ width: 1280, height: 720 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(size)
    await openDisplayMenu(page)
    await insideViewport(page, displayMenu(page))
    await openViewsPage(page)
    await insideViewport(page, displayMenu(page))
    await closeDisplayMenu(page)
  }
  // C19: a press-and-move inside the menu over the list never starts a row drag.
  await page.setViewportSize({ width: 1280, height: 720 })
  await openDisplayMenu(page)
  const row = page.locator(`#home-task-navigation [data-task-id="${pin}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  const before = await row.evaluate((el) => getComputedStyle(el).transform)
  // The press starts on the menu's `Filter` title, a spot with no control under it.
  const m = await box(displayMenu(page).locator('.fb-group-title'))
  await page.mouse.move(m.x + 10, m.y + 4)
  await page.mouse.down()
  await page.mouse.move(m.x + 40, m.y + 60, { steps: 6 })
  expect(await row.evaluate((el) => getComputedStyle(el).transform)).toBe(before)
  await page.mouse.up()
  await expect(displayMenu(page)).toBeVisible()
  await closeDisplayMenu(page)

  // C58: a panel >= 420px wide spells the label; a narrower one keeps the icon alone.
  // The container query reads the toolbar scope's width; size it like a wide and a narrow panel.
  const scope = page.locator('#home-task-navigation .fb-toolbar-scope').first()
  await scope.evaluate((el) => { (el as HTMLElement).style.width = '480px' })
  await expect(displayButton(page).locator('.tp-btn-label')).toHaveText('Display')
  await scope.evaluate((el) => { (el as HTMLElement).style.width = '400px' })
  await expect(displayButton(page).locator('.tp-btn-label')).toBeHidden()
  await expect(displayButton(page)).toHaveAttribute('aria-label', 'Display')
  expect(Math.round((await box(displayButton(page))).width)).toBeLessThanOrEqual(30)
})
