/**
 * The Backlog pin tier is gone (2026-10): the board keeps Focus, Satellite and
 * Parked. What used to be filed in Backlog is Parked now, and every door the old
 * name still comes through (an older phone build moving a task, a launcher that
 * remembered the tab, a prompt that still says "backlog") lands in Parked instead
 * of erroring or vanishing.
 *
 * Proven through the real fixture server and the real board: a task moved with
 * the retired name shows up under the Parked heading; no surface offers Backlog
 * any more (tab bar menu, View menu, the card's ⋮ tier row); a browser whose
 * stored tab was Backlog opens on Parked.
 */
import { test, expect } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView, sectionTab } from './todo-panel-helpers'
import { pinnedTierOf } from './draft-outcome-helpers'

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

test('a move with the retired name lands in Parked, and the board draws it there', async ({ page }) => {
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
  await page.addInitScript(() => {
    // Parked starts folded on a first visit; open it so the card is drawn.
    if (localStorage.getItem('walnut-todo-collapsed-sections') === null) localStorage.setItem('walnut-todo-collapsed-sections', '[]')
  })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  const navigation = page.locator('#home-task-navigation')
  const parked = navigation.locator('[data-navigation-id="wait"]')
  await expect(parked).toBeVisible({ timeout: 20_000 })
  await expect(parked).toContainText('Parked')
  await expect(navigation.locator('[data-navigation-id="backlog"]')).toHaveCount(0)
  await expect(navigation.locator('[data-drop-zone="backlog-drop-zone"]')).toHaveCount(0)
  const card = navigation.locator(`[data-drop-zone="wait-drop-zone"] [data-task-id="${id}"]`)
  await card.scrollIntoViewIfNeeded()
  await expect(card).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-parked-card.png`, clip: { x: 0, y: 0, width: 1100, height: 700 } })

  // The card's ⋮ tier row offers the three tiers and nothing called Backlog.
  await card.hover()
  await card.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.task-kebab-tier-btn')).toHaveText([/Focus/, /Satellite/, /Parked/])
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Parked/)
  await menu.screenshot({ path: `${SHOTS}/${test.info().project.name}-kebab-tiers.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
})

test('no surface offers Backlog: the tab bar menu and the View menu list Focus, Satellite, Parked', async ({ page }) => {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  const bar = page.locator('.todo-section-tabs')
  await bar.getByRole('button', { name: 'Tab bar options' }).click()
  const tabMenu = page.getByRole('menu', { name: 'Tab bar options' })
  const row = (name: string) => tabMenu.getByRole('menuitemcheckbox', { name, exact: true })
  for (const name of ['Focus', 'Satellite', 'Parked']) await expect(row(name)).toHaveCount(1)
  await expect(row('Backlog')).toHaveCount(0)
  await tabMenu.screenshot({ path: `${SHOTS}/${test.info().project.name}-tab-menu.png` })
  await page.keyboard.press('Escape')
  await expect(tabMenu).toHaveCount(0)

  await page.locator('#home-task-navigation .todo-panel-toolbar button[aria-label="View options"]').click()
  const panel = page.locator('.vd-panel')
  await expect(panel).toBeVisible()
  for (const key of ['focus', 'satellite', 'wait']) await expect(panel.locator(`[data-view-option="${key}"]`)).toHaveCount(1)
  await expect(panel.locator('[data-view-option="backlog"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('a browser whose stored tab was Backlog opens on Parked', async ({ page }) => {
  const id = await createPinnedTask(page, `stored tab probe ${Date.now()}`)
  const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'wait' } })
  expect(move.ok()).toBe(true)
  // The fixture shows every tab on the bar, so the Parked tab is there to read.
  await presetPanelView(page, { section: 'backlog', project: '' })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(sectionTab(page, 'Parked')).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(page.locator(`#home-task-navigation [data-drop-zone="wait-drop-zone"] [data-task-id="${id}"]`)).toBeVisible()
})
