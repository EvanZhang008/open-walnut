/**
 * Composable task filters, driven through the real UI.
 *
 * The point of the shared query model (src/core/task-query.ts) is that ONE
 * predicate answers "pinned AND completed AND touched in the last 6 hours" for
 * REST, the agent tool, the home panel, and /tasks. tests/e2e/task-query-filters
 * proves the server half; this spec proves the two BROWSER surfaces, by clicking
 * the same controls a user clicks:
 *
 *   1. compose pinned=Yes + Status Done + Updated ≤ 6h → exactly the one fixture
 *      that has all three, the separate Focus/Pinned area is suppressed (the
 *      dedup rule), and the matching row appears exactly ONCE.
 *   2. project + the "recently updated" preset (Updated ≤ 24h) → only that
 *      project's recent task; its stale twin and the other project are dropped.
 *   3. chips remove ONE condition each, and Clear all restores the full list.
 *   4. /tasks (reached by a real sidebar click, never page.goto) with the same
 *      conditions matches the homepage's hit set.
 *
 * Fixtures live in test-server.ts (`pw-tq-*`, projects Lantern / Meadow) with
 * FIXED ages off one seed instant, so a relative window is deterministic.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { selectSection, selectProject } from './todo-panel-helpers'

const SHOTS = '/tmp/task-query-filters'

// The four query fixtures this spec reasons about.
const PINNED_DONE_RECENT = 'pw-tq-pinned-done-recent'   // Lantern, COMPLETE, pinned, updated 1h ago
const OPEN_RECENT = 'pw-tq-open-recent'                 // Lantern, IN_PROGRESS, unpinned, updated 2h ago
const DONE_STALE = 'pw-tq-done-stale'                   // Lantern, COMPLETE, unpinned, updated 3d ago
const OTHER_RECENT = 'pw-tq-other-project-recent'       // Meadow, TODO, updated 2h ago
const OTHER_STALE = 'pw-tq-other-project-stale'         // Meadow, AWAIT_HUMAN_ACTION, updated 8d ago

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

// Surface roots. Every trigger / chip locator is scoped to one of these: MainPage
// stays MOUNTED (CSS-hidden) behind /tasks, so on that route both surfaces' View
// triggers and chip strips are in the DOM and an unscoped locator is ambiguous.
const HOME = '.todo-panel'
const TASKS_PAGE = '.tasks-page'

// Pin membership and the persisted panel view are GLOBAL fixture state, and
// these tests drive the shared View panel. Serialize so one test's open panel or
// active condition can never land inside another's assertion.
test.describe.configure({ mode: 'serial' })

/**
 * The dedup scenario needs a pinned task the tier area actually RENDERS, and the
 * fixture's only pin is completed (tiers drop completed pins by design). Seed one
 * open pin here, and unpin + delete it in afterAll — pin membership is global
 * server state, so leaving it behind would follow other specs around.
 * Setup only; never the action under test.
 */
let openPinId = ''

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
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
  if (!openPinId) return
  await fetch(`${API}/api/focus/tasks/${openPinId}`, { method: 'DELETE' }).catch(() => {})
  await fetch(`${API}/api/tasks/${openPinId}`, { method: 'DELETE' }).catch(() => {})
})

/**
 * Open a surface's View panel (idempotent — a second click would close it).
 *
 * The TRIGGER must be surface-scoped: MainPage stays mounted (CSS-hidden) behind
 * /tasks, so on that route two triggers exist. The PANEL itself is portalled to
 * <body> and only one is ever open, so it needs no scope.
 */
async function openViewPanel(page: Page, surface = HOME): Promise<Locator> {
  const panel = page.locator('.vd-panel')
  if (!(await panel.isVisible())) {
    await page.locator(`${surface} button[aria-label="View options"]`).click()
  }
  await expect(panel).toBeVisible()
  return panel
}

async function closeViewPanel(page: Page): Promise<void> {
  const panel = page.locator('.vd-panel')
  if (await panel.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  }
}

/** Toggle one value of an array dimension inside the query section. */
async function toggleQueryChip(panel: Locator, group: string, value: string): Promise<void> {
  await panel.locator('.vd-query .vd-field', { hasText: group })
    .locator(`.vd-cat[data-filter-value="${value}"]`).first().click()
}

/** Set a tri-state (Pinned / Blocked) to Any | Yes | No. */
async function setTriState(panel: Locator, label: string, choice: 'any' | 'yes' | 'no'): Promise<void> {
  await panel.locator('.vd-query .vd-field', { hasText: label })
    .locator(`.vd-seg-btn[data-tri-state="${choice}"]`).first().click()
}

/** Pick the time basis (Created | Updated | Either) and a relative preset. */
async function setTimeWindow(
  panel: Locator,
  basis: 'created' | 'updated' | 'created_or_updated',
  preset: 'any' | '1h' | '6h' | '24h' | '7d' | '30d',
): Promise<void> {
  await panel.locator(`.vd-query .vd-seg-btn[data-time-basis="${basis}"]`).click()
  await panel.locator(`.vd-query .vd-cat[data-time-preset="${preset}"]`).click()
}

const chipStrip = (page: Page, surface = HOME) => page.locator(`${surface} .task-filter-chips`)
const chip = (page: Page, key: string, surface = HOME) =>
  page.locator(`${surface} .task-filter-chips .usage-chip[data-chip-key="${key}"]`)

/** Rows in the home panel's main task list, by fixture id. */
const homeRow = (page: Page, taskId: string) =>
  page.locator(`.todo-panel-list .todo-panel-item[data-task-id="${taskId}"]`)

/** Cards in the pinned TIER area (never the Recent feed, which is an activity
 *  log and is deliberately untouched by the pinned dedup rule). */
const tierCard = (page: Page, taskId: string) =>
  page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)

/** /tasks table rows. */
const tableRow = (page: Page, taskId: string) =>
  page.locator(`[data-testid="tasks-table"] .tp-row[data-task-id="${taskId}"]`)

/** Home: stacked sections + the unscoped project chip, so nothing is hidden by
 *  an axis this spec isn't testing. */
async function openHomePanel(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
  await selectSection(page, 'All')
  await selectProject(page, 'All')
}

test('pinned + done + last 6 hours resolves to the single matching task', async ({ page }) => {
  await openHomePanel(page)

  // Preconditions, and the reason the feature exists:
  //  • the COMPLETED pin is reachable NOWHERE — the tier area drops completed
  //    pins (splitTiers / useFocusBar) and the main list hides done tasks;
  //  • the OPEN pin renders in the tier area, so the dedup assertion below has a
  //    real "before" state rather than a vacuously empty region.
  await expect(tierCard(page, PINNED_DONE_RECENT)).toHaveCount(0)
  await expect(homeRow(page, PINNED_DONE_RECENT)).toHaveCount(0)
  await expect(tierCard(page, openPinId)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(1)

  // An ACTIVE filter that isn't `pinned` must leave the tier area alone: the
  // suppression below has to be attributable to the pinned condition, not to
  // "some filter is on". The open pin was just created, so it passes this window.
  const preflight = await openViewPanel(page)
  await setTimeWindow(preflight, 'updated', '30d')
  await closeViewPanel(page)
  // A day preset stays in days all the way to the chip label.
  await expect(chip(page, 'time')).toContainText('Updated ≤ 30d')
  await expect(tierCard(page, openPinId)).toBeVisible()
  await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(1)

  const panel = await openViewPanel(page)
  await setTriState(panel, 'Pinned', 'yes')
  await toggleQueryChip(panel, 'Status', 'complete')
  await setTimeWindow(panel, 'updated', '6h')
  await closeViewPanel(page)

  // The composed AND picks the one fixture with all three properties.
  await expect(homeRow(page, PINNED_DONE_RECENT)).toBeVisible({ timeout: 10_000 })
  // ...and exactly once, anywhere in the panel. An explicit pinned condition
  // routes pins through the normal list, so a second copy means the Focus-area
  // suppression broke.
  await expect(homeRow(page, PINNED_DONE_RECENT)).toHaveCount(1)
  await expect(page.locator(`.todo-panel-item[data-task-id="${PINNED_DONE_RECENT}"]`)).toHaveCount(1)

  // Each leg of the AND is load-bearing:
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)   // recent, but not pinned and not done
  await expect(homeRow(page, DONE_STALE)).toHaveCount(0)    // done, but outside 6h and not pinned
  await expect(homeRow(page, OTHER_RECENT)).toHaveCount(0)  // recent, but neither pinned nor done
  await expect(homeRow(page, openPinId)).toHaveCount(0)     // pinned + recent, but NOT done

  // Focus/Pinned area suppressed while a pinned condition is set — the open pin
  // that was rendering a tier card a moment ago is gone from the tier region, so
  // no pinned hit can be shown (and counted) twice.
  await expect(tierCard(page, openPinId)).toHaveCount(0)
  await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(0)

  // The chips advertise all three conditions.
  await expect(chip(page, 'pinned')).toContainText('Yes')
  await expect(chip(page, 'completion:complete')).toContainText('Done')
  await expect(chip(page, 'time')).toContainText('Updated \u2264 6h')

  await page.screenshot({ path: `${SHOTS}/01-pinned-done-6h.png`, fullPage: true })
})

test('project plus the recently-updated preset narrows to that project alone', async ({ page }) => {
  await openHomePanel(page)

  const panel = await openViewPanel(page)
  // "Recently updated" = the Updated basis plus the last-24h preset.
  await toggleQueryChip(panel, 'Project', 'Meadow')
  await setTimeWindow(panel, 'updated', '24h')
  await closeViewPanel(page)

  await expect(homeRow(page, OTHER_RECENT)).toBeVisible({ timeout: 10_000 })
  // Same project, updated 8 days ago — the time leg drops it.
  await expect(homeRow(page, OTHER_STALE)).toHaveCount(0)
  // Recent enough, wrong project — the project leg drops these.
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)
  await expect(homeRow(page, PINNED_DONE_RECENT)).toHaveCount(0)

  // Only pw-tq-* rows are asserted above because the fixture list is shared, so
  // pin down the exact hit set among them: one project's one recent task.
  const hits = await page.locator('.todo-panel-list .todo-panel-item[data-task-id^="pw-tq-"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-id')).sort())
  expect(hits).toEqual([OTHER_RECENT])

  await expect(chip(page, 'project:Meadow')).toContainText('Meadow')
  await expect(chip(page, 'time')).toContainText('Updated \u2264 24h')

  await page.screenshot({ path: `${SHOTS}/02-project-recent.png`, fullPage: true })
})

test('chips remove one condition each and Clear all restores the list', async ({ page }) => {
  await openHomePanel(page)

  // Three conditions over the OPEN fixtures. Deliberately no Done condition: on
  // this surface "hide completed" is still owned by the legacy ✓ Done toggle, so
  // a Status=Done chip alone shows nothing and would make each removal below
  // unobservable. Scenario 1 covers the completed-row path (via pinned).
  const panel = await openViewPanel(page)
  await toggleQueryChip(panel, 'Project', 'Meadow')
  await toggleQueryChip(panel, 'Priority', 'important')
  await setTimeWindow(panel, 'updated', '30d')
  await closeViewPanel(page)

  await expect(chipStrip(page).locator('.usage-chip')).toHaveCount(3)
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_STALE)).toHaveCount(0)  // Meadow, in window, but backlog
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)  // in window, but Lantern

  // Remove the PRIORITY chip → the backlog task in the same project joins, and
  // nothing else moves. One chip removes exactly one condition.
  await chip(page, 'priority:important').click()
  await expect(chip(page, 'priority:important')).toHaveCount(0)
  await expect(homeRow(page, OTHER_STALE)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible()
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)  // project condition still on
  await expect(chipStrip(page).locator('.usage-chip')).toHaveCount(2)

  // Remove the PROJECT chip → the other project's task joins too.
  await chip(page, 'project:Meadow').click()
  await expect(chip(page, 'project:Meadow')).toHaveCount(0)
  await expect(homeRow(page, OPEN_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(chipStrip(page).locator('.usage-chip')).toHaveCount(1)
  // Clear all is offered from the FIRST chip — it also resets the surface's own
  // view state, so a single condition must not need a different gesture.
  await expect(chipStrip(page).locator('.usage-chip-clear-all')).toBeVisible()

  await page.screenshot({ path: `${SHOTS}/03a-chips-removed-one-by-one.png`, fullPage: true })

  // Re-add a condition so Clear all has MORE than one to drop, then assert it
  // drops every one of them in a single click.
  const panel2 = await openViewPanel(page)
  await toggleQueryChip(panel2, 'Project', 'Meadow')
  await closeViewPanel(page)
  await expect(chipStrip(page).locator('.usage-chip')).toHaveCount(2)
  await expect(homeRow(page, OPEN_RECENT)).toHaveCount(0)

  await chipStrip(page).locator('.usage-chip-clear-all').click()
  // No conditions left → the whole strip unmounts.
  await expect(chipStrip(page)).toHaveCount(0)

  // Unfiltered again: every open fixture is back, completed ones stay hidden
  // (that is the panel's own ✓ Done default, not a query condition).
  await expect(homeRow(page, OPEN_RECENT)).toBeVisible({ timeout: 10_000 })
  await expect(homeRow(page, OTHER_RECENT)).toBeVisible()
  await expect(homeRow(page, OTHER_STALE)).toBeVisible()
  await expect(homeRow(page, PINNED_DONE_RECENT)).toHaveCount(0)

  await page.screenshot({ path: `${SHOTS}/03b-clear-all-restored.png`, fullPage: true })
})

test('/tasks reached through the UI matches the homepage hit set', async ({ page }) => {
  await openHomePanel(page)

  // The scenario-1 query, which is the interesting one for parity: it selects a
  // COMPLETED row, so the two surfaces can only agree if the shared evaluator
  // (not each surface's own completed-hiding rule) decides the answer.
  const panel = await openViewPanel(page)
  await setTriState(panel, 'Pinned', 'yes')
  await toggleQueryChip(panel, 'Status', 'complete')
  await setTimeWindow(panel, 'updated', '6h')
  await closeViewPanel(page)

  await expect(homeRow(page, PINNED_DONE_RECENT)).toBeVisible({ timeout: 10_000 })
  const homeHits = await page.locator('.todo-panel-list .todo-panel-item[data-task-id^="pw-tq-"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-id')).sort())
  expect(homeHits).toEqual([PINNED_DONE_RECENT])

  // Real SPA navigation (a sidebar click, never page.goto).
  await page.locator('.sidebar a[href="/tasks"]').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 20_000 })

  // Each surface owns its own filter STATE (mounting / does not filter /tasks),
  // so set the same conditions here through this surface's copy of the shared
  // panel. Parity is about the matched set for a given query, not about the two
  // surfaces sharing one state object.
  const tasksPanel = await openViewPanel(page, TASKS_PAGE)
  await setTriState(tasksPanel, 'Pinned', 'yes')
  // This page seeds completion todo+in_progress; add Done and drop the open two
  // so the effective condition is Done-only, exactly like the homepage.
  await toggleQueryChip(tasksPanel, 'Status', 'complete')
  await toggleQueryChip(tasksPanel, 'Status', 'todo')
  await toggleQueryChip(tasksPanel, 'Status', 'in_progress')
  await setTimeWindow(tasksPanel, 'updated', '6h')
  await closeViewPanel(page)

  await expect(tableRow(page, PINNED_DONE_RECENT)).toBeVisible({ timeout: 10_000 })
  const tableHits = await page.locator('[data-testid="tasks-table"] .tp-row[data-task-id^="pw-tq-"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-id')).sort())
  expect(tableHits).toEqual(homeHits)

  // The same chips component, on the second surface.
  await expect(chip(page, 'pinned', TASKS_PAGE)).toContainText('Yes')
  await expect(chip(page, 'completion:complete', TASKS_PAGE)).toContainText('Done')

  await page.screenshot({ path: `${SHOTS}/04-tasks-page-parity.png`, fullPage: true })
})
