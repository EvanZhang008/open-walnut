/**
 * Retired pin tiers: Backlog (2026-10) and then Parked (2026-11-11, the user: "just have 2 focus,
 * satellite, remove park"). The board keeps Focus, Satellite and the custom tiers. The server
 * still files the old names (Backlog folds into `wait`, and `wait` is stored as it is) so an
 * older phone build, a plugin or an agent keeps working, and every door the old names still
 * come through (a move from an old client, a launcher that remembered the tab) lands in
 * Satellite on the web instead of erroring or vanishing.
 *
 * Proven through the real fixture server and the real board: a task moved with a retired name
 * is stored as `wait` and drawn in Satellite; no surface offers Backlog or Parked (tab bar menu,
 * Display's View page, the card's ⋮ pin choices); a browser whose stored tab was Backlog or
 * Parked opens on Satellite.
 */
import { test, expect } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView, sectionTab } from './todo-panel-helpers'
import { pinnedTierOf } from './draft-outcome-helpers'
import { displayMenu, openDisplayMenu, openViewsPage } from './filter-bar-helpers'

const SHOTS = '/tmp/no-backlog-tier/pw'

async function createPinnedTask(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project: 'Work', pinned: true } })
  if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  return id
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test('a move with a retired name is stored as before, and the board draws it in Satellite', async ({ page }) => {
  const stamp = Date.now()
  const id = await createPinnedTask(page, `retired tier probe ${stamp}`)

  // The old client path: PUT tier=backlog is still a 200, the task is in wait_tasks
  // and the wire keeps an always-empty backlog_tasks for older decoders.
  const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'backlog' } })
  expect(move.status(), await move.text()).toBe(200)
  const split = (await move.json()) as { wait_tasks: string[]; backlog_tasks: string[] }
  expect(split.wait_tasks).toContain(id)
  expect(split.backlog_tasks).toEqual([])
  expect(await pinnedTierOf(page, id)).toBe('wait')
  const stored = (await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { focus_tier?: string } }
  expect(stored.task.focus_tier).toBe('wait')

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  // Neither retired tier has a heading or a drop zone; the card is in Satellite's.
  const navigation = page.locator('#home-task-navigation')
  for (const retired of ['backlog', 'wait']) {
    await expect(navigation.locator(`[data-navigation-id="${retired}"]`)).toHaveCount(0)
    await expect(navigation.locator(`[data-drop-zone="${retired}-drop-zone"]`)).toHaveCount(0)
  }
  const card = navigation.locator(`[data-drop-zone="satellite-drop-zone"] [data-task-id="${id}"]`)
  await card.scrollIntoViewIfNeeded()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-retired-card.png`, clip: { x: 0, y: 0, width: 1100, height: 700 } })

  // The card's ⋮ pin choices light Satellite and offer neither retired tier.
  await card.hover()
  await card.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('kebab-pin-satellite')).toHaveAttribute('aria-pressed', 'true')
  for (const retired of ['backlog', 'wait']) await expect(menu.getByTestId(`kebab-pin-${retired}`)).toHaveCount(0)
  await expect(menu).not.toContainText(/Parked|Backlog/)
  await menu.screenshot({ path: `${SHOTS}/${test.info().project.name}-kebab-tiers.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
})

test('no surface offers Backlog or Parked: the tab bar menu and the View menu list Focus and Satellite', async ({ page }) => {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  const bar = page.locator('.todo-section-tabs')
  await bar.getByRole('button', { name: 'Tab bar options' }).click()
  const tabMenu = page.getByRole('menu', { name: 'Tab bar options' })
  const row = (name: string) => tabMenu.getByRole('menuitemcheckbox', { name, exact: true })
  for (const name of ['Focus', 'Satellite']) await expect(row(name)).toHaveCount(1)
  for (const name of ['Backlog', 'Parked']) await expect(row(name)).toHaveCount(0)
  await tabMenu.screenshot({ path: `${SHOTS}/${test.info().project.name}-tab-menu.png` })
  await page.keyboard.press('Escape')
  await expect(tabMenu).toHaveCount(0)

  // The Display menu: the tiers are views on its View page, and the retired ones are on neither page.
  await openDisplayMenu(page)
  const panel = displayMenu(page)
  for (const key of ['backlog', 'wait']) await expect(panel.locator(`[data-view-option="${key}"]`)).toHaveCount(0)
  const views = await openViewsPage(page)
  for (const key of ['focus', 'satellite']) await expect(views.locator(`.dm-view[data-view-option="${key}"]`)).toHaveCount(1)
  for (const key of ['backlog', 'wait']) await expect(panel.locator(`[data-view-option="${key}"]`)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

for (const stored of ['backlog', 'wait']) {
  test(`a browser whose stored tab was the retired ${stored} tab opens on Satellite`, async ({ page }) => {
    const id = await createPinnedTask(page, `stored tab probe ${stored} ${Date.now()}`)
    // An old client's write: the task is stored in the retired tier.
    const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'wait' } })
    expect(move.ok()).toBe(true)
    await presetPanelView(page, { section: stored, project: '' })
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await expect(sectionTab(page, 'Satellite')).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await expect(page.locator(`#home-task-navigation [data-drop-zone="satellite-drop-zone"] [data-task-id="${id}"]`)).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('walnut-todo-active-section'))).toBe('satellite')
  })
}
