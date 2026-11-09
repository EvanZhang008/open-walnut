/**
 * The taskbar's Recent shows at most two pills; the rest are in one "N more" menu at the end of
 * the strip (2026-11-09, the user: "max shoudl be 2 and a drop down that has more"). The menu
 * opens on a click, lists them in the same order with the same open and x, and is placed by the
 * menu rules (useMenuPlacement): never off screen. Checked with 0, 1, 2, 3 and 10 recent sessions.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const RECENT_KEY = 'open-walnut-layout:home-recent'
const CHIPS_KEY = 'open-walnut-layout:home-minimized'

/** A beat a person can follow, only while recording (PW_VIDEO, walnut-dev webkit --video). */
const beat = (page: Page) => (process.env.PW_VIDEO ? page.waitForTimeout(1200) : Promise.resolve())

async function sessionIds(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/tasks')
  const { tasks } = await res.json() as { tasks: Array<{ session_id?: string; phase?: string }> }
  const ids = [...new Set(tasks.map((t) => t.session_id).filter((s): s is string => !!s))]
  expect(ids.length, 'the fixture holds ten sessions').toBeGreaterThanOrEqual(10)
  return ids.slice(0, 10)
}

async function loadWithRecent(page: Page, ids: string[]) {
  await page.evaluate(({ ids, r, c }) => {
    localStorage.setItem(c, JSON.stringify({ v: 1, value: [] }))
    localStorage.setItem(r, JSON.stringify({ v: 1, value: ids.length ? ids : null }))
  }, { ids, r: RECENT_KEY, c: CHIPS_KEY })
  await page.reload()
  await page.waitForLoadState('networkidle')
}

const pills = (page: Page) => page.locator('.session-taskbar-recent-pill')
const more = (page: Page) => page.getByTestId('session-taskbar-recent-more')
const menu = (page: Page) => page.getByTestId('session-taskbar-recent-more-menu')

test('Recent shows at most two pills, the rest behind "N more": 0, 1, 2, 3 and 10 sessions', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const ids = await sessionIds(page)

  for (const n of [0, 1, 2]) {
    await loadWithRecent(page, ids.slice(0, n))
    if (n === 0) await expect(page.getByTestId('session-taskbar-recent')).toHaveCount(0)
    await expect(pills(page)).toHaveCount(n)
    await expect(more(page)).toHaveCount(0)
    await beat(page)
  }

  for (const n of [3, 10]) {
    const list = ids.slice(0, n)
    await loadWithRecent(page, list)
    await expect(pills(page)).toHaveCount(2)
    // The two newest are pills, in order.
    expect(await pills(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))).toEqual(list.slice(0, 2))
    await expect(more(page)).toHaveText(`${n - 2} more`)
    await expect(menu(page)).toHaveCount(0)
    await beat(page)
    await more(page).click()
    await expect(menu(page)).toBeVisible()
    const rows = menu(page).locator('.session-taskbar-more-row')
    await expect(rows).toHaveCount(n - 2)
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))).toEqual(list.slice(2))
    // Never off screen.
    const box = (await menu(page).boundingBox())!
    const vp = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
    await beat(page)
    // The keyboard: the first row has the focus on open, and the arrows walk the rows and their x.
    await expect(rows.first().locator('.session-taskbar-open')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(rows.first().locator('.session-taskbar-close')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.first().locator('.session-taskbar-open')).toBeFocused()
    // x on a row takes it off Recent; the menu stays open with one row fewer, the focus on the row
    // that took its place (with none left, the menu and its button go: on the last pill).
    await rows.first().getByRole('menuitem', { name: /Remove .* from Recent/ }).click()
    await expect(rows).toHaveCount(n - 3)
    if (n - 3 > 0) await expect(rows.first().locator('.session-taskbar-open')).toBeFocused()
    else {
      await expect(more(page)).toHaveCount(0)
      await expect(pills(page).last().locator('.session-taskbar-open')).toBeFocused()
    }
    await expect(pills(page)).toHaveCount(2)
    await beat(page)
    // Escape closes it.
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
  }

  // A row opens its session where the user is (a column on Home) and leaves Recent.
  const list = ids.slice(0, 10)
  await loadWithRecent(page, list)
  await more(page).click()
  const target = list[5]!
  await menu(page).locator(`.session-taskbar-more-row[data-session-id="${target}"] .session-taskbar-open`).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${target}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`[data-session-id="${target}"].session-taskbar-recent-pill`)).toHaveCount(0)
  await beat(page)
  // Leave the fixture's bar empty for the next spec.
  await page.evaluate(({ r }) => localStorage.setItem(r, JSON.stringify({ v: 1, value: null })), { r: RECENT_KEY })
})

test('in a short window the "N more" menu is cut to fit, and the row the keyboard moves to is scrolled into view', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 900, height: 300 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const ids = await sessionIds(page)
  await loadWithRecent(page, ids)
  await more(page).click()
  const m = menu(page)
  await expect(m).toBeVisible()
  const inView = async () => {
    const box = (await m.boundingBox())!
    const at = (await page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().toJSON())) as DOMRect
    return at.top >= box.y - 1 && at.bottom <= box.y + box.height + 1
  }
  await page.keyboard.press('End')
  await expect(m.locator('.session-taskbar-more-row').last().locator('.session-taskbar-close')).toBeFocused()
  expect(await inView(), 'the last row is shown').toBe(true)
  await page.keyboard.press('Home')
  expect(await inView(), 'the first row is shown').toBe(true)
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown')
  expect(await inView(), 'a row reached by the arrows is shown').toBe(true)
  await page.keyboard.press('Escape')
  await page.evaluate(({ r }) => localStorage.setItem(r, JSON.stringify({ v: 1, value: null })), { r: RECENT_KEY })
})
