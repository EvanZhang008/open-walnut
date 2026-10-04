/**
 * Playwright: the Display menu's Sort and Group work in EVERY view, and the
 * filter pages name their defaults.
 *
 * Why this exists (2026-10-04): a tier view drew Sort and Group as dead rows
 * ("Only in All and Projects") with a separate Tier layout row under them that
 * did what Group does. The user: "group, tier layout, that is the same thing ...
 * should be unified ... and sort, why can't it?". Now each tier keeps its own
 * sort and its Group is the old view mode, Recent sorts and groups its feed, and
 * All and Pinned set every list they draw. On the Status page the three open
 * statuses sit under one Open row, and every page tags its default.
 *
 * All data is owned by the test: two custom tiers nobody else pins into and
 * projects named with a per-run stamp.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { arrange, chooseViewOption, openHome } from './home-navigation-helpers'
import {
  closeDisplayMenu, closeFilterMenu, displayMenu, filterPage, filterValue, openDisplayMenu, openFilterPage,
} from './filter-bar-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/display-order-every-view'

test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
test.setTimeout(180_000)

const litter = { tasks: [] as string[], tiers: [] as string[], projects: [] as string[] }

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.tiers = []; litter.projects = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const tier of litter.tiers) await fetch(`${API}/api/focus/tiers/${tier}`, { method: 'DELETE' }).catch(() => undefined)
  for (const name of litter.projects) await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createTask(title: string, project: string, priority: string): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project, priority, source: 'local', pinned: false })
  litter.tasks.push(task.id)
  if (project && !litter.projects.includes(project)) litter.projects.push(project)
  // Distinct created_at, so Created and the priority tie-break are deterministic.
  await new Promise((r) => setTimeout(r, 25))
  return task.id
}

async function newTier(label: string): Promise<string> {
  const { tier } = await api<{ tier: { id: string } }>('POST', '/api/focus/tiers', { label })
  litter.tiers.push(tier.id)
  return tier.id
}

async function pinInto(id: string, tier: string): Promise<void> {
  await api('POST', `/api/focus/tasks/${id}`)
  await api('PUT', `/api/focus/tasks/${id}/tier`, { tier })
}

/** The tier's ids in the server's pin order. */
async function pinOrder(tier: string): Promise<string[]> {
  const bar = await api<{ custom_tier_tasks?: Record<string, string[]> }>('GET', '/api/focus/tasks')
  return bar.custom_tier_tasks?.[tier] ?? []
}

/** The tier's cards, in DOM order, as task ids. */
function drawn(page: Page, tier: string): Promise<string[]> {
  return page.locator(`[data-drop-zone="${tier}-drop-zone"] [data-task-id]`)
    .evaluateAll((els) => els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => (el as HTMLElement).dataset.taskId ?? ''))
}

const pressedChoice = async (page: Page, row: 'sort' | 'group'): Promise<string | null> => {
  const on = displayMenu(page).locator(`[data-view-option="${row}"] [data-choice][aria-pressed="true"]`)
  return (await on.count()) ? on.first().getAttribute('data-choice') : null
}

/** Real pointer drag of one card onto another inside the same tier. */
async function dragCard(page: Page, fromId: string, toId: string, tier: string): Promise<void> {
  const zone = page.locator(`[data-drop-zone="${tier}-drop-zone"]`)
  const from = zone.locator(`[data-task-id="${fromId}"]`)
  const to = zone.locator(`[data-task-id="${toId}"]`)
  const a = (await from.boundingBox())!
  const sx = a.x + Math.min(60, a.width / 2)
  const sy = a.y + a.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 3, sy - 6)
  await page.mouse.move(sx + 6, sy - 12)
  const b = (await to.boundingBox())!
  const tx = b.x + Math.min(70, b.width / 2)
  const ty = b.y + b.height * 0.3
  for (let i = 1; i <= 16; i++) await page.mouse.move(sx + (tx - sx) * i / 16, sy + (ty - sy) * i / 16)
  await page.waitForTimeout(250)
  await page.mouse.up()
}

test('a tier view sorts and groups its own cards; a reorder in a sorted tier switches it to Manual, and another sorted tier keeps its pin order', async ({ page, baseURL }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const alder = `SortAlder${stamp}`
  const birch = `SortBirch${stamp}`
  const tierA = await newTier(`SortA${stamp}`)
  const tierB = await newTier(`SortB${stamp}`)
  // Pin order on purpose: priorities and projects interleaved.
  const a1 = await createTask('Alder backlog', alder, 'backlog')
  const a2 = await createTask('Birch immediate', birch, 'immediate')
  const a3 = await createTask('Alder none', alder, 'none')
  const a4 = await createTask('Birch important', birch, 'important')
  const a5 = await createTask('Alder immediate', alder, 'immediate')
  for (const id of [a1, a2, a3, a4, a5]) await pinInto(id, tierA)
  const b1 = await createTask('Other none', alder, 'none')
  const b2 = await createTask('Other immediate', alder, 'immediate')
  const b3 = await createTask('Other important', alder, 'important')
  for (const id of [b1, b2, b3]) await pinInto(id, tierB)

  await openHome(page, baseURL!)
  // Tier B by Priority, set from its own view.
  await chooseViewOption(page, tierB)
  await expect(page.locator(`[data-drop-zone="${tierB}-drop-zone"]`)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => drawn(page, tierB), { timeout: 20_000 }).toEqual([b1, b2, b3])
  await arrange(page, 'Priority')
  await expect.poll(() => drawn(page, tierB)).toEqual([b2, b3, b1])

  // Tier A: the same two rows, live; no Tier layout row, no "only in" note.
  await chooseViewOption(page, tierA)
  await expect.poll(() => drawn(page, tierA), { timeout: 20_000 }).toHaveLength(5)
  await openDisplayMenu(page)
  expect(await pressedChoice(page, 'sort')).toBe('manual')
  expect(await pressedChoice(page, 'group')).toBe('project')
  expect(await displayMenu(page).innerText()).not.toMatch(/Tier layout|Recent order|Only in/)
  await closeDisplayMenu(page)

  // Flat + Manual is the pin order; Flat + Priority is priority, newest first among equals.
  await arrange(page, 'Flat')
  await expect.poll(() => drawn(page, tierA)).toEqual([a1, a2, a3, a4, a5])
  await arrange(page, 'Priority')
  await expect.poll(() => drawn(page, tierA)).toEqual([a5, a2, a4, a1, a3])
  // By project + Priority: each project's run in priority order, the runs where their first card is.
  await arrange(page, 'By project')
  await expect.poll(() => drawn(page, tierA)).toEqual([a5, a1, a3, a2, a4])
  await expect(page.locator(`[data-drop-zone="${tierA}-drop-zone"] .tier-project-label`)).toHaveCount(2)
  await page.screenshot({ path: `${SHOTS}/tier-priority-by-project.png` })

  // The sort is the tier's own and survives a reload.
  await page.reload()
  await expect.poll(() => drawn(page, tierA), { timeout: 30_000 }).toEqual([a5, a1, a3, a2, a4])
  await openDisplayMenu(page)
  expect(await pressedChoice(page, 'sort')).toBe('priority')
  await closeDisplayMenu(page)

  // A sorted tier draws no divider lines and offers none.
  await arrange(page, 'Flat')
  await expect.poll(() => drawn(page, tierA)).toEqual([a5, a2, a4, a1, a3])
  const bar = page.getByTestId('tier-view-bar')
  await bar.locator('[data-testid="plus-menu-trigger"], .navigation-more').first().click()
  await expect(page.locator('[data-testid="plus-menu"]')).toBeVisible()
  await expect(page.locator('[data-testid="plus-menu"]').getByText('Add separator')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Drag the last card to the top: the tier switches to Manual, what was drawn stays put
  // with the one move made, and that is the pin order now.
  await dragCard(page, a3, a5, tierA)
  await expect.poll(() => drawn(page, tierA)).toEqual([a3, a5, a2, a4, a1])
  await expect(page.getByText(/switched to Manual order/).first()).toBeVisible()
  await expect.poll(() => pinOrder(tierA)).toEqual([a3, a5, a2, a4, a1])
  await openDisplayMenu(page)
  expect(await pressedChoice(page, 'sort')).toBe('manual')
  await closeDisplayMenu(page)
  // Tier B was written by the same drop, and kept its hand order under its sort.
  expect(await pinOrder(tierB)).toEqual([b1, b2, b3])
  await chooseViewOption(page, tierB)
  await expect.poll(() => drawn(page, tierB)).toEqual([b2, b3, b1])
  await page.screenshot({ path: `${SHOTS}/tier-after-drop.png` })
})

test('Pinned reads every tier it draws: lists that differ press nothing and say so, one pick sets them all', async ({ page, baseURL }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const tierA = await newTier(`MixA${stamp}`)
  const tierB = await newTier(`MixB${stamp}`)
  for (const [tier, n] of [[tierA, 2], [tierB, 2]] as const) {
    for (let i = 0; i < n; i++) await pinInto(await createTask(`Mix ${tier} ${i}`, `Mix${stamp}`, i ? 'immediate' : 'backlog'), tier)
  }
  await openHome(page, baseURL!)
  await chooseViewOption(page, tierA)
  await expect.poll(() => drawn(page, tierA), { timeout: 20_000 }).toHaveLength(2)
  await arrange(page, 'Priority')
  await chooseViewOption(page, 'pinned')
  await openDisplayMenu(page)
  expect(await pressedChoice(page, 'sort')).toBeNull()
  await expect(displayMenu(page).locator('.dm-note')).toHaveText('Lists in this view differ')
  await displayMenu(page).screenshot({ path: `${SHOTS}/pinned-mixed.png` })
  await displayMenu(page).locator('[data-view-option="sort"] [data-choice="updated"]').click()
  await expect.poll(() => pressedChoice(page, 'sort')).toBe('updated')
  await expect(displayMenu(page).locator('.dm-note')).toHaveCount(0)
  const sorts = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-tier-sorts') ?? '{}'))
  expect(sorts[tierA]).toBe('updated')
  expect(sorts[tierB]).toBe('updated')
  expect(sorts.focus).toBe('updated')
  await closeDisplayMenu(page)
})

test('All: the Pinned heading menu sets every tier\'s Group and Sort, the tier heading menu just its own', async ({ page, baseURL }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const tierA = await newTier(`HeadA${stamp}`)
  const tierB = await newTier(`HeadB${stamp}`)
  const a1 = await createTask('Head backlog', `HeadOak${stamp}`, 'backlog')
  const a2 = await createTask('Head immediate', `HeadElm${stamp}`, 'immediate')
  const a3 = await createTask('Head important', `HeadOak${stamp}`, 'important')
  for (const id of [a1, a2, a3]) await pinInto(id, tierA)
  await pinInto(await createTask('Head other', `HeadOak${stamp}`, 'none'), tierB)
  await openHome(page, baseURL!)
  await chooseViewOption(page, 'all')
  await expect.poll(() => drawn(page, tierA), { timeout: 20_000 }).toEqual([a1, a3, a2])
  const item = (role: 'menuitemradio' | 'menuitem', name: string) => page.locator('.wn-context-menu').getByRole(role, { name, exact: true })
  const openHeading = async (id: string, label: string) => {
    const head = page.locator(`#home-task-navigation [data-navigation-id="${id}"]`).first()
    await head.hover()
    await head.getByRole('button', { name: `${label} menu`, exact: true }).click()
    await expect(page.locator('.wn-context-menu')).toBeVisible()
  }

  // Pinned: Manual and By project are what every tier holds, so both read as picked.
  await openHeading('pinned', 'Pinned')
  await expect(item('menuitemradio', 'Manual order')).toHaveAttribute('aria-checked', 'true')
  await expect(item('menuitemradio', 'By project')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.wn-context-menu')).toContainText('Sort every tier by')
  await page.locator('.wn-context-menu').screenshot({ path: `${SHOTS}/pinned-heading-menu.png` })
  await item('menuitemradio', 'In one list').click()
  await openHeading('pinned', 'Pinned')
  await item('menuitemradio', 'Priority').click()
  await expect.poll(() => drawn(page, tierA)).toEqual([a2, a3, a1])
  const sorts = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-tier-sorts') ?? '{}'))
  expect([sorts[tierA], sorts[tierB], sorts.focus]).toEqual(['priority', 'priority', 'priority'])

  // One tier back to Manual from its own heading: the Pinned menu now names no sort.
  await openHeading(tierA, `HeadA${stamp}`)
  await item('menuitemradio', 'Manual order').click()
  await expect.poll(() => drawn(page, tierA)).toEqual([a1, a2, a3])
  await openHeading('pinned', 'Pinned')
  for (const name of ['Manual order', 'Priority', 'Created', 'Last updated']) {
    await expect(item('menuitemradio', name)).toHaveAttribute('aria-checked', 'false')
  }
  await expect(item('menuitemradio', 'In one list')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
})

test('Recent sorts by Priority, Created or Updated (no Manual) and groups by project under quiet labels', async ({ page, baseURL }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const p1 = `RecentOak${stamp}`
  const p2 = `RecentElm${stamp}`
  const r1 = await createTask('Recent oak backlog', p1, 'backlog')
  const r2 = await createTask('Recent elm immediate', p2, 'immediate')
  const r3 = await createTask('Recent oak immediate', p1, 'immediate')
  const mine = new Set([r1, r2, r3])
  const feed = async () => (await page.locator('.todo-pinned-list-recent [data-task-id]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.taskId ?? ''))).filter((id) => mine.has(id))
  await openHome(page, baseURL!)
  await chooseViewOption(page, 'recent')
  await expect.poll(feed, { timeout: 20_000 }).toEqual([r3, r2, r1])
  await openDisplayMenu(page)
  await expect(displayMenu(page).locator('[data-view-option="sort"] [data-choice="manual"]')).toHaveCount(0)
  await closeDisplayMenu(page)
  // Touch the first one: Updated puts it on top, Created keeps creation order.
  await api('PATCH', `/api/tasks/${r1}`, { title: 'Recent oak backlog touched' })
  await arrange(page, 'Updated')
  await expect.poll(feed).toEqual([r1, r3, r2])
  await arrange(page, 'Created')
  await expect.poll(feed).toEqual([r3, r2, r1])
  await arrange(page, 'Priority')
  await expect.poll(feed).toEqual([r3, r2, r1])
  await arrange(page, 'Created')
  // By project: each project's rows together under its label, the projects in the order
  // their first row comes.
  await arrange(page, 'By project')
  await expect.poll(feed).toEqual([r3, r1, r2])
  const label = (p: string) => page.locator(`.todo-pinned-list-recent .recent-project-label[data-project="${p}"]`)
  await expect(label(p1)).toHaveCount(1)
  await expect(label(p2)).toHaveCount(1)
  await expect(label(p1).locator('.tier-project-label-count')).toHaveText('2')
  await page.locator('.todo-panel').screenshot({ path: `${SHOTS}/recent-by-project.png` })
  await arrange(page, 'Flat')
  await expect(page.locator('.todo-pinned-list-recent .recent-project-label')).toHaveCount(0)
})

test('Status: an Open row over its three statuses toggles them as one; every page tags its default', async ({ page, baseURL }) => {
  await openHome(page, baseURL!)
  await openFilterPage(page, 'status')
  const open = filterValue(page, 'status', 'Open')
  await expect(open).toHaveAttribute('aria-pressed', 'true')
  await expect(open.locator('.fb-opt-default')).toHaveText('Default')
  expect(await filterPage(page, 'status').locator('.fb-opt.is-child .fb-opt-label').allInnerTexts()).toEqual(['To Do', 'In Progress', 'Need Action'])
  // The open block is all that is on: Open cannot be turned off (aria-disabled, so forced).
  await expect(open).toHaveAttribute('aria-disabled', 'true')
  await open.click({ force: true })
  await expect(open).toHaveAttribute('aria-pressed', 'true')
  // One child off: Open draws a dash; a click puts the whole block back.
  await filterValue(page, 'status', 'In Progress').click()
  await expect(open).toHaveAttribute('aria-pressed', 'mixed')
  await open.click()
  await expect(open).toHaveAttribute('aria-pressed', 'true')
  await expect(filterValue(page, 'status', 'In Progress')).toHaveAttribute('aria-pressed', 'true')
  // With Complete on, Open turns the block off and leaves Complete.
  await filterValue(page, 'status', 'Complete').click()
  await open.click()
  for (const s of ['To Do', 'In Progress', 'Need Action']) await expect(filterValue(page, 'status', s)).toHaveAttribute('aria-pressed', 'false')
  await expect(filterValue(page, 'status', 'Complete')).toHaveAttribute('aria-pressed', 'true')
  await filterPage(page, 'status').screenshot({ path: `${SHOTS}/status-open-off.png` })
  // Only on Open: just the block, the default again.
  await open.hover()
  await page.getByRole('button', { name: 'Only Open', exact: true }).click()
  await expect(open).toHaveAttribute('aria-pressed', 'true')
  await expect(filterValue(page, 'status', 'Complete')).toHaveAttribute('aria-pressed', 'false')
  await closeFilterMenu(page)

  // Date tags Available now; Project starts with Any project, which clears a pick.
  await openFilterPage(page, 'date')
  await expect(filterValue(page, 'date', 'Available now').locator('.fb-opt-default')).toHaveText('Default')
  await closeFilterMenu(page)
  await openFilterPage(page, 'project')
  const any = filterValue(page, 'project', 'Any project')
  await expect(any).toHaveAttribute('aria-pressed', 'true')
  const first = filterPage(page, 'project').locator('.fb-opt-body:not([data-default-row])').first()
  await first.click()
  await expect(any).toHaveAttribute('aria-pressed', 'false')
  await any.click()
  await expect(any).toHaveAttribute('aria-pressed', 'true')
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await closeFilterMenu(page)
})
