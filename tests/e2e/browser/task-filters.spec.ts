/**
 * Composable task filters, driven through the real UI.
 *
 * The point of the shared query model (src/core/task-query.ts) is that ONE
 * predicate answers "completed AND touched in the last 6 hours" for REST, the
 * agent tool, the home panel, and /tasks. tests/e2e/task-query-filters proves
 * the server half; this spec proves the two BROWSER surfaces, by clicking the
 * same controls a user clicks. The home panel filters through the Filter
 * popover and its filter row (`.fb-*`, spec 9); /tasks keeps the query-only
 * View panel (`.vd-panel`, D7) with one merged Status section:
 *
 *   1. Status Complete + Updated in 6h -> exactly the one fixture that has both,
 *      drawn ONCE in the panel; the home Filter has no Pinned dimension, the
 *      Pinned VIEW answers "what is pinned" instead.
 *   2. project + the "recently updated" preset (Updated in 24h) -> only that
 *      project's recent task; its stale twin and the other project are dropped.
 *   3. chips remove ONE condition each, and Clear restores the full list.
 *   4. /tasks (reached by a real sidebar click, never page.goto) with the same
 *      conditions matches the homepage's hit set.
 *
 * Fixtures live in test-server.ts (`pw-tq-*`, projects Lantern / Meadow) with
 * FIXED ages off one seed instant, so a relative window is deterministic.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView, selectSection } from './todo-panel-helpers'
import {
  addFilter, closeFilterMenu, expandMoreFilters, filterChip, filterDimRow, filterMenu, filterRow, filterValue,
  openFilterMenu, openFilterPage, removeFilterChip, setStatus,
} from './filter-bar-helpers'

const SHOTS = '/tmp/task-query-filters'

// The query fixtures this spec reasons about.
const PINNED_DONE_RECENT = 'pw-tq-pinned-done-recent'   // Lantern, COMPLETE, pinned, updated 1h ago
const OPEN_RECENT = 'pw-tq-open-recent'                 // Lantern, IN_PROGRESS, unpinned, updated 2h ago
const DONE_STALE = 'pw-tq-done-stale'                   // Lantern, COMPLETE, unpinned, updated 3d ago
const OTHER_RECENT = 'pw-tq-other-project-recent'       // Meadow, TODO, updated 2h ago
const OTHER_STALE = 'pw-tq-other-project-stale'         // Meadow, TODO, backlog, updated 8d ago

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

// MainPage stays MOUNTED (CSS-hidden) behind /tasks, so on that route both
// surfaces are in the DOM: every /tasks locator is scoped to TASKS_PAGE.
const TASKS_PAGE = '.tasks-page'

// Pin membership is GLOBAL fixture state; serialize so one test's pin or
// /tasks query can never land inside another's assertion.
// Long click paths: give each test room on a loaded machine.
test.describe.configure({ mode: 'serial', timeout: 90_000 })

/** An open pin the Pinned view renders (the fixture's only pin is completed). Setup only. */
let openPinId = ''

/** Flip `ui.show_priority` on the fixture server (merging the rest of `ui`). */
async function setShowPriority(on: boolean): Promise<void> {
  const body = (await (await fetch(`${API}/api/config`)).json()) as { config?: { ui?: Record<string, unknown> } }
  const res = await fetch(`${API}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui: { ...(body.config?.ui ?? {}), show_priority: on } }),
  })
  if (!res.ok) throw new Error(`config write failed: ${res.status} ${await res.text()}`)
}

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
  // Priority is hidden by default (Settings, Tasks, Show task priority), which
  // also drops the Priority dimension this spec filters through.
  await setShowPriority(true)
  const created = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `tq open pin ${Date.now()}`, source: 'local', project: 'Lantern' }),
  })
  if (!created.ok) throw new Error(`seed create failed: ${created.status} ${await created.text()}`)
  openPinId = ((await created.json()) as { task: { id: string } }).task.id
  const pinned = await fetch(`${API}/api/focus/tasks/${openPinId}`, { method: 'POST' })
  if (!pinned.ok) throw new Error(`seed pin failed: ${pinned.status} ${await pinned.text()}`)
})

test.afterAll(async () => {
  await setShowPriority(false).catch(() => {})
  if (!openPinId) return
  await fetch(`${API}/api/focus/tasks/${openPinId}`, { method: 'DELETE' }).catch(() => {})
  await fetch(`${API}/api/tasks/${openPinId}`, { method: 'DELETE' }).catch(() => {})
})

test.beforeEach(async ({ page }) => {
  // walnut-todo-filters / -filter-recent are mirrored by ui-prefs-sync: keep them per context.
  await isolateUiPrefs(page)
})

// ── /tasks: the query-only View panel ──

async function openTasksPanel(page: Page): Promise<Locator> {
  const panel = page.locator('.vd-panel')
  if (!(await panel.isVisible())) await page.locator(`${TASKS_PAGE} button[aria-label="View options"]`).click()
  await expect(panel).toBeVisible()
  return panel
}

async function closeTasksPanel(page: Page): Promise<void> {
  const panel = page.locator('.vd-panel')
  if (await panel.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  }
}

/** Rail section ids of the /tasks panel (ViewDropdown); a drift fails with a named error. */
const RAIL_SECTION: Record<string, string> = {
  Status: 'q-status', Priority: 'q-priority', Project: 'q-project', Source: 'q-source', Sprint: 'q-sprint',
  Tag: 'q-tags', Pinned: 'q-flags', Blocked: 'q-flags', Time: 'q-time',
}

async function openRailSection(panel: Locator, group: string): Promise<void> {
  const id = RAIL_SECTION[group]
  if (!id) throw new Error(`openRailSection: unknown rail group "${group}"; update RAIL_SECTION to match ViewDropdown`)
  await panel.locator(`.vd-rail-btn[data-rail-section="${id}"]`).click()
  await expect(panel.locator(`.vd-rail-btn.vd-active[data-rail-section="${id}"]`)).toBeVisible()
}

async function toggleQueryChip(panel: Locator, group: string, value: string): Promise<void> {
  await openRailSection(panel, group)
  await panel.locator('.vd-query .vd-field', { hasText: group }).locator(`.vd-cat[data-filter-value="${value}"]`).first().click()
}

/** Make the merged /tasks Status section exactly `phases` (adds first, so it never passes through empty). */
async function setTasksStatus(panel: Locator, phases: string[]): Promise<void> {
  await openRailSection(panel, 'Status')
  const field = panel.locator('.vd-query .vd-field', { hasText: 'Status' })
  for (const p of phases) {
    const v = field.locator(`.vd-cat[data-filter-value="${p}"]`)
    if ((await v.getAttribute('aria-pressed')) !== 'true') await v.click()
    await expect(v).toHaveAttribute('aria-pressed', 'true')
  }
  // Read the pressed values first: a nth() handle shifts as each click unpresses one.
  const pressed = await field.locator('.vd-cat[aria-pressed="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-filter-value') ?? ''))
  for (const value of pressed.filter((p) => !phases.includes(p))) {
    await field.locator(`.vd-cat[data-filter-value="${value}"]`).click()
  }
  await expect(field.locator('.vd-cat[aria-pressed="true"]')).toHaveCount(phases.length)
}

async function setTimeWindow(panel: Locator, basis: 'created' | 'updated' | 'created_or_updated', preset: string): Promise<void> {
  await openRailSection(panel, 'Time')
  await panel.locator(`.vd-query .vd-seg-btn[data-time-basis="${basis}"]`).click()
  await panel.locator(`.vd-query .vd-cat[data-time-preset="${preset}"]`).click()
}

const tasksChip = (page: Page, key: string) => page.locator(`${TASKS_PAGE} .task-filter-chips .usage-chip[data-chip-key="${key}"]`)
const tableRow = (page: Page, taskId: string) => page.locator(`[data-testid="tasks-table"] .tp-row[data-task-id="${taskId}"]`)
const tableHits = (page: Page) => page.locator('[data-testid="tasks-table"] .tp-row[data-task-id^="pw-tq-"]')
  .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-id')).sort())

// ── Home: the Filter popover and the filter row ──

/** Rows in the home panel's main task list, by fixture id. */
const homeRow = (page: Page, taskId: string) => page.locator(`.todo-panel-list .todo-panel-item[data-task-id="${taskId}"]`)
/** Every pw-tq-* task the home panel draws anywhere (a pin area card or a list row), once each. */
const homeHits = (page: Page) => page.locator('.todo-panel [data-task-id^="pw-tq-"]')
  .evaluateAll((rows) => [...new Set(rows.map((r) => r.getAttribute('data-task-id')))].sort())

/** Home on the All view, no project scoping, every project unfolded. */
async function openHomePanel(page: Page): Promise<void> {
  await presetPanelView(page)
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
  await selectSection(page, 'All')
  await expect(filterRow(page)).toHaveCount(0)
}

/** Time window through the menu: the Time page's basis segment, then the preset value (a single-select pick closes the menu). */
async function setHomeTime(page: Page, basis: 'created' | 'updated' | 'created_or_updated', preset: string): Promise<void> {
  const pane = await openFilterPage(page, 'time')
  await pane.locator(`[data-time-basis="${basis}"]`).click()
  const v = filterValue(page, 'time', preset)
  if ((await v.getAttribute('aria-pressed')) !== 'true') await v.click()
  await expect(v).toHaveAttribute('aria-pressed', 'true')
  // The row holds two lines while the menu is open, so a third chip may sit behind +N until it closes.
  await closeFilterMenu(page)
  await expect(filterChip(page, 'time')).toBeVisible()
}

test('Status Complete + last 6 hours resolves to the single matching task, drawn once', async ({ page }) => {
  await openHomePanel(page)
  // Preconditions: completed tasks are hidden by the default Status (open), the open pin renders.
  await expect(page.locator(`.todo-panel [data-task-id="${PINNED_DONE_RECENT}"]`)).toHaveCount(0)
  await expect(page.locator(`.todo-panel [data-task-id="${openPinId}"]`).first()).toBeVisible({ timeout: 10_000 })

  // A window alone keeps the open pin (it was just created): the narrowing below is the Status leg's.
  await setHomeTime(page, 'updated', '30d')
  await expect(filterChip(page, 'time')).toContainText('Updated in 30d')
  await expect(page.locator(`.todo-panel [data-task-id="${openPinId}"]`).first()).toBeVisible()

  await setStatus(page, ['Complete'])
  await setHomeTime(page, 'updated', '6h')
  await expect(page.locator(`.todo-panel [data-task-id="${PINNED_DONE_RECENT}"]`).first()).toBeVisible({ timeout: 10_000 })
  // Exactly once anywhere in the panel: a done pin that Status lets through draws as its
  // tier's card (the list dedupes against the pin area), never as a second row.
  await expect(page.locator(`.todo-panel [data-task-id="${PINNED_DONE_RECENT}"]`)).toHaveCount(1)
  await expect(page.locator(`.todo-panel-list [data-task-id="${PINNED_DONE_RECENT}"]`)).toHaveCount(0)
  expect(await homeHits(page)).toEqual([PINNED_DONE_RECENT])
  await expect(page.locator(`.todo-panel [data-task-id="${openPinId}"]`)).toHaveCount(0)  // pinned + recent, NOT complete
  await expect(filterChip(page, 'status')).toContainText('Complete')
  await expect(filterChip(page, 'time')).toContainText('Updated in 6h')

  // The home Filter has no Pinned property (G2): the Pinned view answers it.
  await openFilterMenu(page)
  await expandMoreFilters(page)
  await expect(filterMenu(page).locator('[data-filter-dim="pinned"]')).toHaveCount(0)
  await closeFilterMenu(page)
  await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
  await selectSection(page, 'Pinned')
  await expect(page.locator(`.todo-panel [data-task-id="${openPinId}"]`).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`.todo-panel [data-task-id="${OPEN_RECENT}"]`)).toHaveCount(0)
  // The tab bar is off by default: the view name leads the filter row instead (G37).
  await expect(filterRow(page).locator('.fb-view-item')).toHaveText('View: Pinned')
  await page.screenshot({ path: `${SHOTS}/01-complete-6h.png`, fullPage: true })
})

test('project plus the recently-updated preset narrows to that project alone', async ({ page }) => {
  await openHomePanel(page)
  await addFilter(page, 'project', 'Meadow')
  await setHomeTime(page, 'updated', '24h')

  await expect(homeRow(page, OTHER_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_STALE)).toHaveCount(0)   // same project, updated 8 days ago
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)   // recent, wrong project
  expect(await homeHits(page)).toEqual([OTHER_RECENT])
  await expect(filterChip(page, 'project')).toContainText('Meadow')
  await expect(filterChip(page, 'time')).toContainText('Updated in 24h')
  await page.screenshot({ path: `${SHOTS}/02-project-recent.png`, fullPage: true })
})

test('chips remove one condition each and Clear restores the list', async ({ page }) => {
  await openHomePanel(page)
  await addFilter(page, 'project', 'Meadow')
  await addFilter(page, 'priority', 'Important')
  await setHomeTime(page, 'updated', '30d')

  await expect(filterRow(page).locator('.fb-chip[data-chip-dim]')).toHaveCount(3)
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_STALE)).toHaveCount(0)  // Meadow, in window, but backlog
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)  // in window, but Lantern

  // Removing the PRIORITY chip lets the backlog task in the same project join; nothing else moves.
  await removeFilterChip(page, 'priority')
  await expect(homeRow(page, OTHER_STALE)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible()
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)
  await expect(filterRow(page).locator('.fb-chip[data-chip-dim]')).toHaveCount(2)

  // Removing the PROJECT chip lets the other project's task join too.
  await removeFilterChip(page, 'project')
  await expect(homeRow(page, OPEN_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(filterRow(page).locator('.fb-chip[data-chip-dim]')).toHaveCount(1)
  await expect(filterRow(page).getByRole('button', { name: 'Clear all filters' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/03a-chips-removed-one-by-one.png`, fullPage: true })

  await addFilter(page, 'project', 'Meadow')
  await expect(filterRow(page).locator('.fb-chip[data-chip-dim]')).toHaveCount(2)
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)
  await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
  // No conditions left and the popover shut: the row unmounts.
  await expect(filterRow(page)).toHaveCount(0)
  await expect(homeRow(page, OPEN_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible()
  await expect(homeRow(page, OTHER_STALE)).toBeVisible()
  await expect(homeRow(page, PINNED_DONE_RECENT)).toHaveCount(0)  // Status is back to open
  await page.screenshot({ path: `${SHOTS}/03b-clear-restored.png`, fullPage: true })
})

test('/tasks reached through the UI matches the homepage hit set', async ({ page }) => {
  await openHomePanel(page)
  // A COMPLETED hit: the two surfaces agree only if the shared evaluator decides it.
  await addFilter(page, 'project', 'Lantern')
  await setStatus(page, ['Complete'])
  await setHomeTime(page, 'updated', '6h')
  await expect(page.locator(`.todo-panel [data-task-id="${PINNED_DONE_RECENT}"]`).first()).toBeVisible({ timeout: 10_000 })
  const home = await homeHits(page)
  expect(home).toEqual([PINNED_DONE_RECENT])

  // Real SPA navigation (a sidebar click, never page.goto).
  await page.locator('.sidebar a[href="/tasks"]').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 20_000 })

  // Each surface owns its own filter state: set the same conditions through /tasks' panel.
  const panel = await openTasksPanel(page)
  await toggleQueryChip(panel, 'Project', 'Lantern')
  await setTasksStatus(panel, ['COMPLETE'])
  await setTimeWindow(panel, 'updated', '6h')
  await closeTasksPanel(page)

  await expect(tableRow(page, PINNED_DONE_RECENT)).toBeVisible({ timeout: 10_000 })
  expect(await tableHits(page)).toEqual(home)
  await expect(tasksChip(page, 'phase:COMPLETE')).toContainText('Complete')
  // C50 on /tasks: the chip names the Status dim and the toolbar says Open and
  // Complete; no standalone Done (or Phase) word on the filter controls.
  await expect(tasksChip(page, 'phase:COMPLETE').locator('.usage-chip-dim')).toHaveText('Status')
  const controls = `${await page.locator(`${TASKS_PAGE} .tp-toolbar`).innerText()}\n${await page.locator(`${TASKS_PAGE} .task-filter-chips`).innerText()}`
  expect(controls).not.toMatch(/\b(Done|Doing|Phase)\b/)
  await expect(page.locator(`${TASKS_PAGE} .tp-toolbar .tp-chip`, { hasText: 'Complete' })).toHaveClass(/\bon\b/)
  await expect(tasksChip(page, 'time')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/04-tasks-page-parity.png`, fullPage: true })

  // /tasks persists its query: leave it clean for whatever runs next.
  const again = await openTasksPanel(page)
  await toggleQueryChip(again, 'Project', 'Lantern')
  await setTasksStatus(again, ['TODO', 'IN_PROGRESS', 'NEED_ACTION'])
  await openRailSection(again, 'Time')
  await again.locator('.vd-query .vd-cat[data-time-preset="any"]').click()
  await closeTasksPanel(page)
})

test('the menu spells out the active filters on its property rows and each chip x removes one', async ({ page }) => {
  await openHomePanel(page)
  await addFilter(page, 'project', 'Meadow', { keepOpen: true })
  await openFilterPage(page, 'time')
  await filterValue(page, 'time', '24h').click()
  await openFilterMenu(page)
  const summaryOf = (dim: 'project' | 'time') => filterDimRow(page, dim).locator('.fb-prop-summary')
  await expect(summaryOf('project')).toHaveText('Meadow')
  // A set property leaves the fold: Time window sits among the first rows now.
  await expect(summaryOf('time')).toHaveText('Updated in 24h')
  await expect(filterMenu(page).locator('.fb-menu-foot')).toContainText('Clear filters')
  // The row stays live under the open menu: its x removes exactly one condition.
  await filterChip(page, 'project').locator('.fb-chip-x').click()
  await expect(filterChip(page, 'project')).toHaveCount(0)
  await expect(summaryOf('project')).toHaveText('Any')
  await filterChip(page, 'time').locator('.fb-chip-x').click()
  await expect(filterMenu(page).locator('.fb-menu-foot')).toHaveCount(0)
  await expect(filterRow(page)).toContainText('No filters')
  await page.screenshot({ path: `${SHOTS}/05-summary-chips.png`, fullPage: true })
  await closeFilterMenu(page)
})

test('popover search finds options across dimensions and Enter adds them', async ({ page }) => {
  await openHomePanel(page)
  await openFilterMenu(page)
  const search = filterMenu(page).getByRole('textbox', { name: 'Search filters' })
  await search.fill('meadow')
  const hit = page.locator('.fb-search-results [role="option"][data-filter-dim="project"][data-filter-value="Meadow"]')
  await expect(hit).toBeVisible()
  await search.press('Enter')
  await expect(filterChip(page, 'project')).toContainText('Meadow')
  await expect(hit).toHaveClass(/\bis-selected\b/)
  // First Escape clears the search (back to the rows), second closes.
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(filterDimRow(page, 'status')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)

  await expect(homeRow(page, OTHER_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)
  await removeFilterChip(page, 'project')
  await expect(filterRow(page)).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/06-search-enter.png`, fullPage: true })
})

test('a tag filters on both surfaces and its chip removes it', async ({ page }) => {
  // Two tagged tasks, unpinned so they render in the main list (a REST create
  // pins by default). Tags of this run only: chromium and webkit share one board.
  const ns = `sev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const [TAG2, TAG3] = [`${ns}:2`, `${ns}:3`]
  const ids: string[] = []
  for (const tag of [TAG2, TAG3]) {
    const res = await fetch(`${API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `tq tagged ${tag} ${Date.now()}`, source: 'local', project: 'Lantern', tags: [tag], pinned: false }),
    })
    if (!res.ok) throw new Error(`seed create failed: ${res.status} ${await res.text()}`)
    ids.push(((await res.json()) as { task: { id: string } }).task.id)
  }
  const [sev2, sev3] = ids
  const tasksTagChip = (tag: string) => page.locator(`${TASKS_PAGE} .task-filter-chips .tag-chip[title="${tag}"]`)

  try {
    await openHomePanel(page)
    await expect(homeRow(page, sev2)).toBeVisible({ timeout: 10_000 })
    await expect(homeRow(page, sev3)).toBeVisible()

    await openFilterMenu(page)
    await filterMenu(page).getByRole('textbox', { name: 'Search filters' }).fill(TAG2)
    const hit = page.locator('.fb-search-results [role="option"][data-filter-dim="tags"]').first()
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(filterChip(page, 'tags')).toBeVisible()
    await filterMenu(page).getByRole('textbox', { name: 'Search filters' }).fill('')
    // A set Tags leaves the fold and names its value on page one.
    await expect(filterDimRow(page, 'tags').locator('.fb-prop-summary')).not.toHaveText('Any')
    await filterMenu(page).screenshot({ path: `${SHOTS}/07a-tags-popover.png` })
    await closeFilterMenu(page)

    // Only the TAG2 task is left in the whole list.
    await expect(homeRow(page, sev3)).toHaveCount(0)
    await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)
    const hits = await page.locator('.todo-panel-list .todo-panel-item[data-task-id]')
      .evaluateAll((rows) => [...new Set(rows.map((r) => r.getAttribute('data-task-id')))])
    expect(hits).toEqual([sev2])
    await page.screenshot({ path: `${SHOTS}/07b-tag-filtered.png` })

    // The chip's x drops the condition; both tasks and the fixtures are back.
    await removeFilterChip(page, 'tags')
    await expect(filterRow(page)).toHaveCount(0)
    await expect(homeRow(page, sev2)).toBeVisible({ timeout: 10_000 })
    await expect(homeRow(page, sev3)).toBeVisible()
    await expect(homeRow(page, OPEN_RECENT)).toBeVisible()

    // /tasks builds its own tag list through the same helper: pick the other tag there.
    await page.locator('.sidebar a[href="/tasks"]').click()
    await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 20_000 })
    await expect(tableRow(page, sev2)).toBeVisible({ timeout: 10_000 })
    const tasksPanel = await openTasksPanel(page)
    await toggleQueryChip(tasksPanel, 'Tag', TAG3)
    await closeTasksPanel(page)
    await expect(tableRow(page, sev3)).toBeVisible({ timeout: 10_000 })
    await expect(tableRow(page, sev2)).toHaveCount(0)
    await expect(tasksTagChip(TAG3)).toBeVisible()
    await tasksTagChip(TAG3).locator('.tag-chip-remove').click()
    await expect(tasksTagChip(TAG3)).toHaveCount(0)
    await expect(tableRow(page, sev2)).toBeVisible({ timeout: 10_000 })
  } finally {
    for (const id of ids) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
  }
})
