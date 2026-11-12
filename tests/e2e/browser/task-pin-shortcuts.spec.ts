import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/task-pin-shortcuts'
const KEY = 'open-walnut-view:task-menu.pin-shortcuts'

test.use({ viewport: { width: 1280, height: 850 } })
test.setTimeout(120_000)

async function openMenu(page: Page, id: string) {
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`).first()
  const menu = page.locator('.task-kebab-menu:visible')
  // Right after typing, the search's server results can redraw the row under the pointer and
  // swallow the press: press again until the menu is open.
  await expect(async () => {
    if (!(await menu.isVisible())) await row.getByRole('button', { name: 'More actions' }).click()
    await expect(menu).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  return menu
}

test('pin shortcuts default to two, can be chosen and kept without growing the menu', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
  const errors: string[] = []
  // A fetch a reload cancels reads in WebKit as an "access control checks" error.
  page.on('pageerror', e => { if (!/due to access control checks|Load failed/.test(e.message)) errors.push(e.message) })
  const title = `Pin shortcuts ${Date.now()}`
  const { task } = await (await request.post('/api/tasks', { data: { title, source: 'local' } })).json()
  const { tier } = await (await request.post('/api/focus/tiers', { data: { label: `ExtendedCustomTierNameForShortcut${Date.now() % 100000}` } })).json()
  await request.post('/api/focus/batch', { data: { task_ids: [task.id], tier: 'focus' } })
  try {
    await page.setContent(`<a href="${API}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
    await page.locator('.todo-search-input').fill(title)
    let menu = await openMenu(page, task.id)
    const strip = () => menu.locator('.task-kebab-tier-options')
    await expect(strip().locator('[data-testid^="kebab-pin-"]')).toHaveCount(2)
    await expect(menu.getByTestId('kebab-pin-wait')).toHaveCount(0)
    await expect(menu.getByTestId('kebab-unpin')).toHaveCount(0)
    await expect(menu.getByTestId(`kebab-pin-${tier.id}`)).toHaveCount(0)
    await expect(menu.getByTestId('kebab-pin-focus')).toHaveAttribute('aria-pressed', 'true')
    const visibleDefaults = await strip().evaluate(el => {
      const b = el.getBoundingClientRect()
      return [...el.querySelectorAll('button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= b.left && r.right <= b.right + 1 })
    })
    expect(visibleDefaults).toBe(true)
    const aligned = await menu.getByTestId('kebab-group-pin').evaluate(el => {
      const label = el.querySelector('.task-kebab-tier-label')!.getBoundingClientRect()
      const button = el.querySelector('.task-kebab-tier-options button')!.getBoundingClientRect()
      return Math.abs((label.top + label.bottom) / 2 - (button.top + button.bottom) / 2) < 2
    })
    expect(aligned).toBe(true)
    const height = (await menu.boundingBox())!.height
    await menu.getByTestId('kebab-pin-more').click()
    let flyout = page.getByTestId('task-pin-flyout')
    await expect(flyout).toBeVisible()
    await expect(flyout.getByTestId('kebab-unpin')).toHaveCount(0)
    await expect(flyout.getByTestId('kebab-pin-wait')).toHaveCount(0)
    await expect(flyout.getByTestId(`kebab-pin-option-${tier.id}`)).toBeVisible()
    await flyout.getByTestId('kebab-pin-customize').click()
    await flyout.getByTestId(`kebab-pin-show-${tier.id}`).click()
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), KEY)).toEqual(['focus', 'satellite', tier.id])
    await flyout.getByTestId('kebab-pin-customize-done').click()
    await page.keyboard.press('Escape')
    await expect(flyout).toHaveCount(0)
    await expect(menu).toBeVisible()
    await menu.getByTestId('kebab-pin-more').click()
    await page.mouse.click(1270, 840)
    await expect(page.getByTestId('task-pin-flyout')).toHaveCount(0)
    await expect(menu).toHaveCount(0)
    menu = await openMenu(page, task.id)
    expect((await menu.boundingBox())!.height).toBeCloseTo(height, 0)
    await expect(menu.getByTestId(`kebab-pin-${tier.id}`)).toBeAttached()
    await expect(menu.getByTestId('kebab-unpin')).toHaveCount(0)
    const oneLine = await strip().locator('button').evaluateAll(buttons => new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size)
    expect(oneLine).toBe(1)
    await menu.getByTestId(`kebab-pin-${tier.id}`).scrollIntoViewIfNeeded()
    await menu.getByTestId(`kebab-pin-${tier.id}`).click()
    await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.focus_tier).toBe(tier.id)
    await page.reload()
    await page.locator('.todo-search-input').fill(title)
    menu = await openMenu(page, task.id)
    await expect(menu.getByTestId(`kebab-pin-${tier.id}`)).toHaveAttribute('aria-pressed', 'true')
    expect(await menu.locator('.task-kebab-tier-options').evaluate(el => {
      const b = el.getBoundingClientRect(); const lit = el.querySelector('[aria-pressed="true"]')!.getBoundingClientRect()
      return lit.left >= b.left - 1 && lit.right <= b.right + 1
    }), 'the lit tier shows whole in the row').toBe(true)
    await menu.getByTestId('kebab-pin-more').click()
    flyout = page.getByTestId('task-pin-flyout')
    await flyout.getByTestId('kebab-pin-customize').click()
    await flyout.getByTestId(`kebab-pin-show-${tier.id}`).click()
    await flyout.getByTestId('kebab-pin-customize-done').click()
    await expect(flyout.getByTestId(`kebab-pin-option-${tier.id}`)).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await fs.mkdir(SHOTS, { recursive: true })
    await menu.screenshot({ path: `${SHOTS}/default-menu.png` })
    for (const size of [{ width: 800, height: 500 }, { width: 390, height: 844 }]) {
      await page.keyboard.press('Escape')
      // WebKit leaves focus in the search field after a click elsewhere, and a focused
      // field at phone width opens the full-screen search: leave it before narrowing.
      await page.locator('.todo-search-input').blur()
      await page.setViewportSize(size)
      menu = await openMenu(page, task.id)
      expect(await menu.locator('.task-kebab-tier-options button').evaluateAll(buttons => new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size)).toBe(1)
      expect(await menu.locator('.task-kebab-tier-options').evaluate(el => {
        const b = el.getBoundingClientRect()
        return [...el.querySelectorAll('button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= b.left && r.right <= b.right + 1 })
      })).toBe(true)
      const fit = await menu.evaluate(el => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1 })
      expect(fit).toBe(true)
      await menu.getByTestId('kebab-pin-more').click()
      flyout = page.getByTestId('task-pin-flyout')
      await expect(flyout.getByTestId('kebab-unpin')).toHaveCount(0)
      await expect(flyout.getByTestId('kebab-pin-wait')).toHaveCount(0)
      if (size.width === 390) {
        await flyout.screenshot({ path: `${SHOTS}/phone-more.png` })
        await page.keyboard.press('Escape')
        await menu.screenshot({ path: `${SHOTS}/phone-menu.png` })
        await menu.getByTestId('kebab-pin-more').click()
      }
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-customize').click()
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-show-focus').click()
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-customize-done').click()
      await page.keyboard.press('Escape')
      await expect(menu.getByTestId('kebab-pin-focus')).toHaveCount(0)
      await menu.getByTestId('kebab-pin-more').click()
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-customize').click()
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-show-focus').click()
      await page.getByTestId('task-pin-flyout').getByTestId('kebab-pin-customize-done').click()
      await page.keyboard.press('Escape')
    }
    // Old clients may still write wait. The new UI displays it as Satellite without rewriting it.
    await page.keyboard.press('Escape')
    // Back to the desktop width: the phone's search field opens the full-screen search.
    await page.setViewportSize({ width: 1280, height: 850 })
    expect((await request.post('/api/focus/batch', { data: { task_ids: [task.id], tier: 'wait' } })).ok()).toBe(true)
    await page.reload()
    await page.locator('.todo-search-input').fill(title)
    menu = await openMenu(page, task.id)
    await expect(menu.getByTestId('kebab-pin-satellite')).toHaveAttribute('aria-pressed', 'true')
    await expect(menu.getByTestId('kebab-pin-wait')).toHaveCount(0)
    expect((await (await request.get(`/api/tasks/${task.id}`)).json()).task.focus_tier).toBe('wait')
    await menu.getByTestId('kebab-pin-satellite').click()
    await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.pinned).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await request.delete(`/api/focus/tasks/${task.id}`)
    await request.delete(`/api/tasks/${task.id}?force=true`)
    await request.delete(`/api/focus/tiers/${tier.id}`)
  }
})
