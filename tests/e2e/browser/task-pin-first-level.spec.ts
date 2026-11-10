import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/task-pin-first-level'

test.use({ viewport: { width: 1280, height: 850 } })
test.setTimeout(120_000)

async function openMenu(page: Page, id: string) {
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`).first()
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('kebab-group-pin').locator('.task-kebab-group-toggle')).toHaveCount(0)
  for (const tier of ['focus', 'satellite', 'wait']) await expect(menu.getByTestId(`kebab-pin-${tier}`)).toBeVisible()
  return menu
}

test('first-level pin choices switch tiers, unpin, undo and keep custom names inside the menu', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
  const title = `First-level pin ${Date.now()}`
  const created = await request.post('/api/tasks', { data: { title, source: 'local' } })
  expect(created.ok()).toBe(true)
  const { task } = await created.json()
  // Pin inheritance from the test runner's caller is not this test's starting state.
  expect((await request.delete(`/api/focus/tasks/${task.id}`)).ok()).toBe(true)
  const custom = await request.post('/api/focus/tiers', { data: { label: 'ExtendedCustomTierNameForWrapping' } })
  expect(custom.ok()).toBe(true)
  const tierId = (await custom.json()).tier.id
  const storedTier = async () => {
    const data = await (await request.get(`/api/tasks/${task.id}`)).json()
    return data.task.pinned ? (data.task.focus_tier ?? 'satellite') : null
  }
  try {
    await page.setContent(`<a href="${API}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
    await page.locator('.todo-search-input').fill(title)
    let menu = await openMenu(page, task.id)
    await expect(menu.getByTestId('kebab-unpin')).toHaveCount(0)
    await expect(menu.locator('[aria-pressed="true"]')).toHaveCount(0)
    // A pin and its chosen tier share one request, even when that write is held.
    let releasePin!: () => void
    const held = new Promise<void>((resolve) => { releasePin = resolve })
    let enteredPin!: () => void
    const pinEntered = new Promise<void>((resolve) => { enteredPin = resolve })
    let tierRequests = 0
    await page.route(`**/api/focus/tasks/${task.id}/tier`, async route => { tierRequests++; await route.continue() })
    await page.route('**/api/focus/batch', async route => { enteredPin(); await held; await route.continue() })
    await menu.getByTestId('kebab-pin-focus').click()
    await expect(menu).toHaveCount(0)
    await pinEntered
    expect(tierRequests).toBe(0)
    releasePin()
    await expect.poll(storedTier).toBe('focus')
    expect(tierRequests).toBe(0)
    await page.unroute('**/api/focus/batch')
    await page.unroute(`**/api/focus/tasks/${task.id}/tier`)
    for (const tier of ['wait', tierId, 'satellite']) {
      menu = await openMenu(page, task.id)
      await expect(menu.locator('[data-testid^="kebab-pin-"][aria-pressed="true"]')).toHaveCount(1)
      await menu.getByTestId(`kebab-pin-${tier}`).click()
      await expect.poll(storedTier).toBe(tier)
    }
    menu = await openMenu(page, task.id)
    await expect(menu.getByTestId('kebab-pin-satellite')).toHaveAttribute('aria-pressed', 'true')
    await fs.mkdir(SHOTS, { recursive: true })
    await menu.screenshot({ path: `${SHOTS}/first-level.png` })
    await menu.getByTestId('kebab-unpin').click()
    await expect.poll(storedTier).toBeNull()
    await page.keyboard.press('Meta+z')
    await expect.poll(storedTier).toBe('satellite')
    // The old shortcut still works: pressing the current tier unpins too.
    menu = await openMenu(page, task.id)
    await menu.getByTestId('kebab-pin-satellite').click()
    await expect.poll(storedTier).toBeNull()

    await page.setViewportSize({ width: 800, height: 500 })
    menu = await openMenu(page, task.id)
    await menu.getByTestId(`kebab-pin-${tierId}`).scrollIntoViewIfNeeded()
    const fit = await menu.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { left: box.left >= 0, right: box.right <= innerWidth, top: box.top >= 0, bottom: box.bottom <= innerHeight, noHorizontalScroll: el.scrollWidth <= el.clientWidth + 1 }
    })
    expect(fit).toEqual({ left: true, right: true, top: true, bottom: true, noHorizontalScroll: true })
    await page.keyboard.press('Escape')
    menu = await openMenu(page, task.id)
    await menu.getByTestId('kebab-pin-focus').click()
    await expect.poll(storedTier).toBe('focus')
    await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await request.delete(`/api/focus/tasks/${task.id}`)
    await request.delete(`/api/tasks/${task.id}?force=true`)
    await request.delete(`/api/focus/tiers/${tierId}`)
  }
})
