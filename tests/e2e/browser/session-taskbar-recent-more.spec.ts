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

test('every dot on the bar wears its task status in the task pills\' colors: red, green, blue, grey only for a wait', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const ids = await sessionIds(page)
  // Five sessions, one per status: Needs you, To read, Working (its turn over), snoozed, Done.
  const want: Array<{ sid: string; us: Record<string, unknown>; phase?: string; state: string; color: string }> = [
    { sid: ids[0]!, us: { state: 'needs', since: new Date().toISOString() }, state: 'needs', color: 'rgb(255, 59, 48)' },
    { sid: ids[1]!, us: { state: 'read', toRead: 'turn', since: new Date().toISOString() }, state: 'needs', color: 'rgb(255, 59, 48)' },
    { sid: ids[2]!, us: { state: 'working', since: new Date().toISOString() }, state: 'working', color: 'rgb(52, 199, 89)' },
    { sid: ids[3]!, us: { state: 'waiting', snoozed: { until: '2099-01-01' }, since: new Date().toISOString() }, state: 'waiting', color: '' },
    { sid: ids[4]!, us: { state: 'done', since: new Date().toISOString() }, phase: 'COMPLETE', state: 'done', color: '' },
  ]
  const bySid = new Map(want.map((w) => [w.sid, w]))
  await page.route((url) => url.pathname.endsWith('/api/tasks'), async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { tasks: Array<Record<string, unknown>> }
    for (const t of body.tasks) {
      const w = bySid.get(t.session_id as string)
      if (w) { t.user_status = w.us; if (w.phase) t.phase = w.phase }
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.route((url) => url.pathname.endsWith('/api/sessions/status'), async (route) => {
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    const rows = (body.statuses ?? body) as Record<string, Record<string, unknown>>
    for (const sid of bySid.keys()) if (rows[sid]) { rows[sid].process_status = 'idle'; rows[sid].pendingPermissionTool = null }
    await route.fulfill({ response: res, json: body })
  })
  // Three chips, two Recent pills.
  await page.evaluate(({ chips, recent, r, c }) => {
    localStorage.setItem(c, JSON.stringify({ v: 1, value: chips }))
    localStorage.setItem(r, JSON.stringify({ v: 1, value: recent }))
  }, { chips: want.slice(0, 3).map((w) => w.sid), recent: want.slice(3).map((w) => w.sid), r: RECENT_KEY, c: CHIPS_KEY })
  await page.reload()
  await page.waitForLoadState('networkidle')
  const css = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    return { muted: s.getPropertyValue('--fg-muted').trim(), accent: s.getPropertyValue('--accent').trim() }
  })
  for (const w of want) {
    const el = page.locator(`.session-taskbar [data-session-id="${w.sid}"]`).first()
    await expect(el).toHaveAttribute('data-state', w.state)
    await expect(el).not.toHaveAttribute('data-running', /.*/)
    const bg = await el.locator('.session-taskbar-dot').evaluate((d) => getComputedStyle(d).backgroundColor)
    if (w.color) expect(bg, `${w.state} dot`).toBe(w.color)
    // Done is the accent blue, a wait the muted grey: compare through a probe in the same page.
    else {
      const ref = await page.evaluate((v) => { const p = document.createElement('i'); p.style.background = v; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c }, w.state === 'done' ? css.accent : css.muted)
      expect(bg, `${w.state} dot`).toBe(ref)
    }
  }
  await beat(page)
  await beat(page)
  await page.evaluate(({ r, c }) => { localStorage.setItem(r, JSON.stringify({ v: 1, value: null })); localStorage.setItem(c, JSON.stringify({ v: 1, value: [] })) }, { r: RECENT_KEY, c: CHIPS_KEY })
})
