/**
 * The done lane and the card menu (spec 6.1, 7.4, 8.1, 5.1): Move to lane (the
 * menu rules), a card moved into Resolved stays open until the user completes
 * it, the rollup's still open filter and Always do this, Complete with Undo and
 * Show, waiting on hides outside wait lanes, and a board that cannot be written
 * (C7 C13 C43 C44 C64 C73 C76).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, getTask, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
  // A card the user put in Waiting on CR, waiting on a CR (C76).
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[5]}`, { lane: 'waiting-cr', waiting_on: 'CR-48213' })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation by link click (never page.goto), then the leader's Board tab. */
async function openBoard(page: Page, leader = team.leader, sid = team.leaderSid, project = team.project): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project })
  await page.route('https://tickets.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ticket</p>' }))
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const row = page.locator(`.todo-panel-item[data-task-id="${leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  // The task summaries arrive in one read after the cards: wait so nothing grows under a measure.
  if (leader === team.leader) await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)

const laneIds = (pane: Locator, lane: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${lane}"] [data-testid="kanban-card"]`)
  .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''))

/** Mouse drag: down on the card's title, 10 steps to the point, `whileOver` with the button still down, then up. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, whileOver?: () => Promise<void>): Promise<void> {
  const b = (await from.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 50, b.y + b.height / 2 + 8, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.waitForTimeout(150)
  if (whileOver) await whileOver()
  await page.mouse.up()
}

/** A point in the bottom (after) or top (before) half of a card. */
async function pointOn(l: Locator, half: 'top' | 'bottom'): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height * (half === 'top' ? 0.25 : 0.75) }
}

/** The card's kebab, then Move to lane, then the lane. */
async function moveByMenu(page: Page, pane: Locator, id: string, laneName: string): Promise<void> {
  await card(pane, id).hover()
  await card(pane, id).getByTestId('kanban-card-more').click()
  const menu = page.getByTestId('kanban-card-menu')
  await expect(menu).toBeVisible()
  await menu.getByTestId('kanban-card-menu-move').click()
  const fly = page.getByTestId('kanban-card-move-flyout')
  await expect(fly).toBeVisible()
  await fly.getByRole('menuitemradio', { name: laneName }).click()
  await expect(menu).toHaveCount(0)
}
const toasts = (pane: Locator) => pane.getByTestId('kanban-toasts')
const phaseOf = async (id: string) => (await getTask(api, id))?.phase
async function letGo(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test('C7 C43: Move to lane is a menu in the viewport with a portalled flyout; the card goes to the top; no drag starts', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const id = team.idle[1]
  await card(pane, id).hover()
  await card(pane, id).getByTestId('kanban-card-more').click()
  const menu = page.getByTestId('kanban-card-menu')
  const vp = page.viewportSize()!
  const mb = (await menu.boundingBox())!
  expect(mb.x).toBeGreaterThanOrEqual(0)
  expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height)
  expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true)
  expect(await menu.locator('select').count()).toBe(0)
  // A press on the menu never reaches dnd-kit: holding and moving the mouse on it drags nothing.
  const item = (await menu.getByTestId('kanban-card-menu-summary').boundingBox())!
  await page.mouse.move(item.x + 10, item.y + 5)
  await page.mouse.down()
  await page.mouse.move(item.x + 60, item.y + 40, { steps: 6 })
  await expect(page.getByTestId('kanban-card-drag-overlay')).toHaveCount(0)
  await page.mouse.up()
  await card(pane, id).hover()
  if (!(await menu.isVisible())) await card(pane, id).getByTestId('kanban-card-more').click()
  await menu.getByTestId('kanban-card-menu-move').click()
  const fly = page.getByTestId('kanban-card-move-flyout')
  expect(await fly.evaluate((el) => el.parentElement === document.body)).toBe(true)
  const current = fly.locator('[data-lane-id="investigating"]')
  await expect(current).toHaveAttribute('aria-checked', 'true')
  await expect(current).toHaveAttribute('aria-disabled', 'true')
  await fly.getByRole('menuitemradio', { name: 'Mitigating' }).click()
  await expect(menu).toHaveCount(0)
  await letGo(page)
  await expect.poll(async () => (await laneIds(pane, 'mitigating'))[0]).toBe(id)
  await expect(card(pane, id)).not.toHaveClass(/is-placeholder/)
  await expect(toasts(pane)).toContainText('to Mitigating')
  // A right click opens the same menu at the pointer.
  await card(pane, team.idle[2]).scrollIntoViewIfNeeded()
  const tb = (await card(pane, team.idle[2]).getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.click(tb.x + 30, tb.y + 6, { button: 'right' })
  const at = (await menu.boundingBox())!
  expect(Math.abs(at.y - (tb.y + 6))).toBeLessThan(40)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('C13: into Resolved the task stays open, says so, and completes from the card', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const id = team.idle[3]
  await moveByMenu(page, pane, id, 'Resolved')
  const t = toasts(pane).getByTestId('kanban-toast').filter({ hasText: 'Moved to Resolved. The task is still open.' })
  await expect(t).toBeVisible()
  await expect(t.getByTestId('kanban-toast-complete')).toHaveText('Complete task')
  await expect(t.getByTestId('kanban-toast-always')).toHaveText('Always do this')
  expect(await phaseOf(id)).toBe('NEED_ACTION')
  await t.getByTestId('kanban-toast-dismiss').click()
  await pane.getByTestId('kanban-done-rail').click().catch(() => undefined)
  await letGo(page)
  await expect(card(pane, id).getByTestId('kanban-card-status')).toHaveText(/^Task still open/)
  await expect(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="resolved"] [data-testid="kanban-lane-count"]')).toHaveText('24 (1 open)')
  await card(pane, id).getByTestId('kanban-card-complete-inline').click()
  await expect.poll(() => phaseOf(id)).toBe('COMPLETE')
  await expect(card(pane, id).getByTestId('kanban-card-status')).toHaveText(/^Done just now/)
})

test('C64: the rollup counts by lane and filters the still open; Always do this completes on every drop', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const a = team.idle[4]
  const open0 = Number(((await pane.getByTestId('kanban-rollup').textContent()) ?? '').match(/(\d+) open/)?.[1] ?? '0')
  await moveByMenu(page, pane, a, 'Resolved')
  await expect(pane.getByTestId('kanban-rollup')).toContainText(`${open0 - 1} open`)
  await expect(pane.getByTestId('kanban-rollup-still-open')).toHaveText('1 task still open')
  await pane.getByTestId('kanban-rollup-still-open').click()
  await expect(pane.locator('[data-testid="kanban-card"]:visible')).toHaveCount(1)
  await expect(card(pane, a)).toBeVisible()
  await pane.getByTestId('kanban-rollup-still-open').click()
  const t = toasts(pane).getByTestId('kanban-toast').filter({ hasText: 'The task is still open.' }).first()
  if (await t.count()) await t.getByTestId('kanban-toast-always').click()
  else {
    await moveByMenu(page, pane, a, 'Investigating')
    await moveByMenu(page, pane, a, 'Resolved')
    await toasts(pane).getByTestId('kanban-toast-always').first().click()
  }
  await expect.poll(() => phaseOf(a)).toBe('COMPLETE')
  const lanes = (await call<{ lanes: Array<{ id: string; complete_on_drop?: boolean }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)).lanes
  expect(lanes.find((l) => l.id === 'resolved')?.complete_on_drop).toBe(true)
  const b = team.idle[6]
  await moveByMenu(page, pane, b, 'Resolved')
  await expect.poll(() => phaseOf(b)).toBe('COMPLETE')
})

test('C73: Complete from the card: a toast with Undo and Show; Show opens the rail and focuses the card; Undo puts it all back', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const id = team.idle[0]
  const lane0 = await card(pane, id).getAttribute('data-lane')
  const phase0 = await phaseOf(id)
  const complete = async () => {
    await card(pane, id).hover()
    await card(pane, id).getByTestId('kanban-card-complete').click()
    const t = toasts(pane).getByTestId('kanban-toast').filter({ hasText: 'Completed "' }).first()
    await expect(t).toBeVisible()
    await expect.poll(() => phaseOf(id)).toBe('COMPLETE')
    return t
  }
  // Undo puts the phase and the lane back (any toast action closes its toast).
  await (await complete()).getByTestId('kanban-toast-undo').click()
  await expect.poll(() => phaseOf(id)).toBe(phase0)
  await letGo(page)
  await expect(card(pane, id)).toHaveAttribute('data-lane', lane0 ?? '', { timeout: 15_000 })
  // The server agrees (an auto card comes back as placed: the done lane stays its sticky auto lane).
  const row = async () => (await call<{ cards: Record<string, { lane?: string; lane_auto?: { lane: string } }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)).cards[id]
  await expect.poll(async () => { const r = await row(); return r?.lane || r?.lane_auto?.lane }).toBe(lane0)
  // Show opens the done rail and focuses the card there.
  await (await complete()).getByTestId('kanban-toast-show').click()
  await expect(pane.locator('[data-testid="kanban-lane"][data-lane-id="resolved"]')).toBeVisible()
  await expect(card(pane, id)).toBeFocused({ timeout: 5_000 })
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'resolved')
  await call(api, 'PATCH', `/api/tasks/${id}`, { phase: phase0 })
})

test('C76: waiting on shows only in wait lanes; moved out it hides (search too) and the toast offers Clear; moved back it returns', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const id = team.idle[5]
  await expect(card(pane, id).getByTestId('kanban-card-waiting')).toHaveText(/Waiting on\s*CR-48213/)
  await moveByMenu(page, pane, id, 'Mitigating')
  await letGo(page)
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'mitigating', { timeout: 15_000 })
  await expect(card(pane, id).getByTestId('kanban-card-waiting')).toHaveCount(0)
  await expect(toasts(pane).getByTestId('kanban-toast-clear-waiting').first()).toHaveText('Clear waiting on')
  await pane.getByTestId('kanban-search').fill('CR-48213')
  await expect(card(pane, id)).toBeHidden()
  await pane.getByTestId('kanban-search').fill('')
  await moveByMenu(page, pane, id, 'Waiting on CR')
  await letGo(page)
  await expect(card(pane, id).getByTestId('kanban-card-waiting')).toHaveText(/Waiting on\s*CR-48213/, { timeout: 15_000 })
})

test('C44: a board that cannot be written (501): every write control is off with the reason, and nothing drags', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await page.route(/\/api\/v1\/tasks\/[^/]+\/board\/(cards|lanes)/, (r) => (r.request().method() === 'GET' ? r.continue()
    : r.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_implemented', message: 'Boards are edited on the Mac' } }) })))
  const id = team.idle[2]
  await moveByMenu(page, pane, id, 'Mitigating')
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-read-only', 'true', { timeout: 10_000 })
  await card(pane, id).hover()
  for (const t of ['kanban-card-complete', 'kanban-card-message']) {
    await expect(card(pane, id).getByTestId(t)).toHaveAttribute('aria-disabled', 'true')
  }
  await expect(card(pane, id).getByTestId('kanban-card-complete')).toHaveAttribute('title', 'Boards are edited on the Mac')
  await expect(pane.getByTestId('kanban-add-task').first()).toHaveAttribute('aria-disabled', 'true')
  const cursor = await card(pane, id).evaluate((el) => getComputedStyle(el).cursor)
  expect(cursor).toBe('default')
  await drag(page, card(pane, id), await pointOn(card(pane, team.idle[0]), 'top'))
  await expect(page.getByTestId('kanban-card-drag-overlay')).toHaveCount(0)
})
