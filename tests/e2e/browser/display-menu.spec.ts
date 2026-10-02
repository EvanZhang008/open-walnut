/**
 * E2E: the home task panel's Display menu (spec 3.3, 6.5; checklist C1, C12 to C15, C18, C19,
 * C29b, C32, C36, C37, C42, C52, C56, C58, C64, C70). Display lays the list out, Filter picks
 * which tasks show. The first layer is the tabs kept on the bar (All + Pinned for a new user,
 * no tier word); other views wait in a portalled More views flyout; the menu never changes
 * height while open; Sort never drops a project's own order without asking. Each test seeds
 * its own tasks through the API (or stubs one read) from isolated UI prefs.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { isolateUiPrefs, openListProject } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'
import {
  displayButton, displayMenu, filterRow, moreViewsRow, openDisplayMenu, closeDisplayMenu,
  openFilterMenu, closeFilterMenu, setStatus, viewsFlyout,
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

const viewRows = (page: Page) => displayMenu(page).locator('[data-view-group="Show"] .dm-view[data-view-option]')
const tab = (page: Page, name: string) => page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
const option = (page: Page, key: string) => displayMenu(page).locator(`[data-view-option="${key}"]`)
const flyoutItem = (page: Page, key: string) => viewsFlyout(page).locator(`[data-view-option="${key}"]`)
const openMoreViews = async (page: Page) => {
  if (!(await viewsFlyout(page).isVisible())) await moreViewsRow(page).click()
  await expect(viewsFlyout(page)).toBeVisible()
}

/** Pick a view from More views; the flyout closes, the Display menu stays. */
async function pickMoreView(page: Page, key: string) {
  await openMoreViews(page)
  await flyoutItem(page, key).click()
  await expect(viewsFlyout(page)).toHaveCount(0)
  await expect(displayMenu(page)).toBeVisible()
}
const box = async (locator: Locator) => { const b = await locator.boundingBox(); expect(b).not.toBeNull(); return b! }

async function insideViewport(page: Page, locator: Locator): Promise<void> {
  const [b, vp] = [await box(locator), page.viewportSize()!]
  expect([b.x >= 0, b.y >= 0, b.x + b.width <= vp.width + 0.5, b.y + b.height <= vp.height + 0.5]).toEqual([true, true, true, true])
}

test('the first layer is the bar: All and Pinned for a new user, every other view in More views', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page, baseURL!)
  // C1: the old popover is gone from the home panel, before and after both new menus open.
  const toolbar = page.locator('#home-task-navigation .todo-panel-toolbar')
  await expect(toolbar.getByRole('button', { name: 'View options' })).toHaveCount(0)
  const btn = displayButton(page)
  expect(await btn.evaluate((el) => [el.title, el.getAttribute('aria-haspopup'), el.getAttribute('aria-expanded')]))
    .toEqual(['Display: view, sort, group, layout', 'dialog', 'false'])
  await expect(btn.locator('.vd-dot')).toHaveCount(0)
  await openDisplayMenu(page)
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
  const menu = displayMenu(page)
  expect(await menu.evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-label')])).toEqual(['dialog', 'Display options'])
  expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true)
  expect((await box(menu)).width).toBeLessThanOrEqual(320.5)
  // C13 / C13b: All and Pinned, titled, and no tier word anywhere the first layer shows.
  await expect(viewRows(page)).toHaveCount(2)
  expect(await viewRows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-view-option')))).toEqual(['all', 'pinned'])
  const titles = await viewRows(page).evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
  expect(titles.every((t) => t !== '' && !/\b(tier|focus|satellite|backlog|parked)\b/i.test(t))).toBe(true)
  expect(await menu.innerText()).not.toMatch(TIER_WORDS)
  await expect(menu.locator('[data-view-group="Show"] .dm-heading')).toHaveText('View')
  // Focus starts on the selected View row.
  await expect(option(page, 'all')).toBeFocused()
  // C12: no native checkbox; the tab bar switch is a role="switch".
  await expect(menu.locator('input[type="checkbox"]')).toHaveCount(0)
  expect(await option(page, 'quick-views').evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-checked'), el.title]))
    .toEqual(['switch', 'true', 'All, Pinned and the other views as tabs across the top'])
  for (const key of ['session-panels', 'sort', 'group', 'collapse']) await expect(option(page, key)).toHaveCount(1)
  await expect(option(page, 'session-panels').locator('[data-choice]')).toHaveCount(6)
  await menu.screenshot({ path: `${SHOTS}/display-menu-light.png` })
  // C13 / C15: More views is a portalled flyout holding the rest, each with its sentence.
  expect(await moreViewsRow(page).evaluate((el) => [el.getAttribute('aria-haspopup'), el.getAttribute('aria-expanded')])).toEqual(['menu', 'false'])
  await openMoreViews(page)
  await expect(moreViewsRow(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.locator('.dm-views-flyout')).toHaveCount(0)
  const keys = await viewsFlyout(page).locator('[data-view-option]').evaluateAll((els) => els.map((el) => el.getAttribute('data-view-option')!))
  const builtIn = keys.filter((k) => !k.startsWith('ct_'))
  expect(builtIn).toEqual(['focus', 'satellite', 'wait', 'recent', 'tasks'])
  expect(await viewsFlyout(page).locator('[data-view-option]').evaluateAll((els) => els.every((el) => !!el.getAttribute('title')))).toBe(true)
  await expect(flyoutItem(page, 'tasks')).toHaveAttribute('title', 'Projects: every task grouped by project, with filters applied')
  const [a, b] = [await box(menu), await box(viewsFlyout(page))]
  const x = Math.max(0, Math.min(a.x, b.x) - 8), y = Math.max(0, Math.min(a.y, b.y) - 8)
  const right = Math.min(1280, Math.max(a.x + a.width, b.x + b.width) + 8), bottom = Math.max(a.y + a.height, b.y + b.height) + 8
  await page.screenshot({ path: `${SHOTS}/display-more-views.png`, clip: { x, y, width: right - x, height: bottom - y } })
  await closeDisplayMenu(page)
  await expect(btn).toBeFocused()

  await openFilterMenu(page)
  await closeFilterMenu(page)
  await expect(page.locator('.vd-panel, .vd-rail, [data-rail-section]')).toHaveCount(0)
})

test('a view picked in Display switches the list and the tab bar, and the menu stays open', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  await openDisplayMenu(page)
  // C14: Pinned from the first layer: the tab follows, the menu stays.
  await option(page, 'pinned').click()
  await expect(option(page, 'pinned')).toHaveAttribute('aria-pressed', 'true')
  await expect(option(page, 'all')).toHaveAttribute('aria-pressed', 'false')
  await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true')
  await expect(displayMenu(page)).toBeVisible()

  // Focus from More views: the flyout closes, Display stays, the row names where you are.
  await pickMoreView(page, 'focus')
  await expect(moreViewsRow(page)).toContainText('More views (Focus)')
  await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')
  await expect(viewRows(page).locator('[aria-pressed="true"]')).toHaveCount(0)
  // C15: a tier view adds Tier layout, last; both keys pick.
  for (const key of ['tier-custom', 'tier-project']) {
    await option(page, key).click()
    await expect(option(page, key)).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(option(page, 'recent-updated')).toHaveCount(0)

  // Recent swaps the last row for Recent order.
  await pickMoreView(page, 'recent')
  await expect(moreViewsRow(page)).toContainText('More views (Recent)')
  await expect(option(page, 'tier-project')).toHaveCount(0)
  for (const key of ['recent-created', 'recent-updated']) {
    await option(page, key).click()
    await expect(option(page, key)).toHaveAttribute('aria-pressed', 'true')
  }

  // Every other built-in view key picks from the flyout too.
  for (const [key, label] of [['satellite', 'Satellite'], ['wait', 'Parked'], ['tasks', 'Projects']] as const) {
    await pickMoreView(page, key)
    await expect(moreViewsRow(page)).toContainText(`More views (${label})`)
  }
  await openMoreViews(page)
  await expect(flyoutItem(page, 'tasks')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(viewsFlyout(page)).toHaveCount(0)
  // Projects is not a tab: nothing on the bar is selected.
  await expect(page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(0)

  // Back to All; the last row is gone and the View row is checked again.
  await option(page, 'all').click()
  await expect(option(page, 'all')).toHaveAttribute('aria-pressed', 'true')
  await expect(moreViewsRow(page)).toHaveText(/^\s*More views\s*$/)
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
  await closeDisplayMenu(page)
})

test('the menu keeps its height and every row in place while the view changes (30 custom tiers)', async ({ page, baseURL }) => {
  // The server caps custom tiers at 20; the client must still hold 30, so the read is stubbed.
  const tiers = Array.from({ length: 30 }, (_, i) => ({ id: `ct_pw_display_${i}`, label: `Lane ${i + 1}` }))
  await page.route('**/api/focus/tiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tiers }) })
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await boot(page, baseURL!)
  await openDisplayMenu(page)
  // The bar keeps all 30, but the menu's first layer is capped; the rest wait in the flyout.
  expect(await viewRows(page).count()).toBeLessThanOrEqual(6)
  const height = async () => (await box(displayMenu(page))).height
  // Rows every view has (Session columns, Sort, Group: C29b) and the top of the slot the view
  // rows (Collapse all, Tier layout, Recent order) share never move while the view changes.
  const ys = async () => { const top = (await box(displayMenu(page))).y; return Promise.all([option(page, 'session-panels'), option(page, 'sort'), option(page, 'group'), displayMenu(page).locator('.dm-context')]
    .map(async (l) => Math.round((await box(l)).y - top))) }
  const h0 = await height()
  const y0 = await ys()
  await expect(option(page, 'sort')).toBeVisible()
  const steady = async () => {
    expect(Math.abs((await height()) - h0)).toBeLessThan(0.5)
    for (const [i, y] of (await ys()).entries()) expect(Math.abs(y - y0[i])).toBeLessThanOrEqual(1)
  }
  await pickMoreView(page, 'focus')
  await expect(option(page, 'tier-project')).toBeVisible()
  await steady()
  await pickMoreView(page, 'recent')
  await expect(option(page, 'recent-updated')).toBeVisible()
  await steady()
  await option(page, 'all').click()
  await expect(option(page, 'recent-updated')).toHaveCount(0)
  await expect(option(page, 'sort')).toBeVisible()
  await steady()

  // The flyout holds the long tail: in the viewport, scrolling inside, menu height unchanged.
  await openMoreViews(page)
  await expect(flyoutItem(page, 'ct_pw_display_29')).toHaveCount(1)
  await insideViewport(page, viewsFlyout(page))
  await insideViewport(page, displayMenu(page))
  expect(await viewsFlyout(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(Math.abs((await height()) - h0)).toBeLessThan(0.5)
  // C19: a click in the flyout never closes the menu behind it (it picks and closes only itself).
  await flyoutItem(page, 'ct_pw_display_29').scrollIntoViewIfNeeded()
  await flyoutItem(page, 'ct_pw_display_29').click()
  await expect(moreViewsRow(page)).toContainText('More views (Lane 30)')
  expect(Math.abs((await height()) - h0)).toBeLessThan(0.5)
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
  await openDisplayMenu(page)
  await pickMoreView(page, 'tasks')
  await closeDisplayMenu(page)
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
  // C56: like hiding it from the bar's own menu: Display closes and keeps focus, a toast says so.
  await expect(displayMenu(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Display')
  await expect(page.getByText('Tab bar hidden. Turn it back on in Display', { exact: true }).first()).toBeVisible()
  await openDisplayMenu(page)
  await expect(option(page, 'quick-views')).toHaveAttribute('aria-checked', 'false')
  // On All with no chip the row does not exist at all.
  await expect(filterRow(page)).toHaveCount(0)

  // C70: Pinned while the bar is off: the row leads with the view, which is not a chip.
  await option(page, 'pinned').click()
  const viewItem = filterRow(page).locator('.fb-view-item')
  await expect(viewItem).toHaveText(/View:\s*Pinned/)
  await expect(viewItem).toHaveAttribute('aria-label', 'View: Pinned, change in Display')
  await expect(viewItem.locator('.fb-chip-x')).toHaveCount(0)
  await expect(page.getByTestId('filter-badge')).toHaveCount(0)
  await closeDisplayMenu(page)
  await expect(displayButton(page)).toHaveAttribute('title', /Pinned/)
  await viewItem.click()
  await expect(displayMenu(page)).toBeVisible()
  await expect(option(page, 'pinned')).toHaveAttribute('aria-pressed', 'true')
  await closeDisplayMenu(page)
  // Clear removes chips (the badge counts them, never the view item), never the view.
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
  await expect(page.getByTestId('filter-badge')).toHaveText('1')
  await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
  await expect(page.getByTestId('filter-badge')).toHaveCount(0)
  await expect(viewItem).toHaveText(/View:\s*Pinned/)
  // Back to All with no chip: the row leaves the DOM.
  await openDisplayMenu(page)
  await option(page, 'all').click()
  await closeDisplayMenu(page)
  await expect(filterRow(page)).toHaveCount(0)

  // C56: searching a finished task with the bar off: the row offers it, one click shows it.
  await page.locator('#home-task-navigation .todo-search-bar input').fill(`hidden bar finished ${stamp}`)
  const include = filterRow(page).getByRole('button', { name: /Include Complete \(\d+\)/ })
  await expect(include).toBeVisible({ timeout: 15_000 })
  await include.click()
  await expect(page.locator(`#home-task-navigation [data-task-id="${done}"]`).first()).toBeVisible({ timeout: 15_000 })
  await page.locator('#home-task-navigation .todo-search-bar input').fill('')
})

test('a view put on the bar joins the first layer in bar order and leaves More views', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Tab bar options' }).click()
  await page.locator('.wn-context-menu').getByRole('menuitemcheckbox', { name: 'Focus', exact: true }).click()
  await page.keyboard.press('Escape')
  await openDisplayMenu(page)
  // C64: All, Pinned, Focus, the order the bar draws them.
  const keys = await viewRows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-view-option')!))
  expect(keys.filter((k) => !k.startsWith('ct_'))).toEqual(['all', 'pinned', 'focus'])
  await option(page, 'focus').click()
  await expect(option(page, 'focus')).toHaveAttribute('aria-pressed', 'true')
  await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')
  await openMoreViews(page)
  await expect(flyoutItem(page, 'focus')).toHaveCount(0)
  await expect(flyoutItem(page, 'satellite')).toHaveCount(1)
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
  // C32: Up/Down walk the View rows; the focused row shows the ring.
  await expect(option(page, 'all')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(option(page, 'pinned')).toBeFocused()
  expect(await option(page, 'pinned').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
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
  // Enter on a View row picks it.
  await option(page, 'pinned').focus()
  await page.keyboard.press('Enter')
  await expect(option(page, 'pinned')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(moreViewsRow(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(viewsFlyout(page)).toBeVisible()
  await expect(viewsFlyout(page).locator('[data-view-option]').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(viewsFlyout(page)).toHaveCount(0)
  await expect(moreViewsRow(page)).toBeFocused()

  // C36: the selected View row keeps its check and >= 4.5:1 text in light and dark.
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const selected = option(page, 'pinned')
    await expect(selected.locator('.dm-check svg')).toHaveCount(1)
    expect(await contrastOf(selected.locator('.dm-view-label'))).toBeGreaterThanOrEqual(4.5)
    expect(await contrastOf(option(page, 'all').locator('.dm-view-label'))).toBeGreaterThanOrEqual(4.5)
    await displayMenu(page).screenshot({ path: `${SHOTS}/display-menu-${theme}-focus.png` })
  }
  await page.keyboard.press('Escape')
  await expect(displayMenu(page)).toHaveCount(0)
  await expect(displayButton(page)).toBeFocused()
})

test('Display and its flyout stay inside the viewport, never drag a row, and the label follows the panel width', async ({ page, baseURL }) => {
  const [pin] = await seedProject(page, `Display Drag ${Date.now()}`, [{ title: `drag probe ${Date.now()}` }])
  expect((await page.request.post(`/api/focus/tasks/${pin}`)).ok()).toBe(true)
  await boot(page, baseURL!)
  for (const size of [{ width: 1280, height: 720 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(size)
    await openDisplayMenu(page)
    await openMoreViews(page)
    for (const el of [displayMenu(page), viewsFlyout(page)]) await insideViewport(page, el)
    await closeDisplayMenu(page)
  }
  // C19: a press-and-move inside the menu over the list never starts a row drag.
  await page.setViewportSize({ width: 1280, height: 720 })
  await openDisplayMenu(page)
  const row = page.locator(`#home-task-navigation [data-task-id="${pin}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  const before = await row.evaluate((el) => getComputedStyle(el).transform)
  const m = await box(displayMenu(page).locator('.dm-heading'))
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
