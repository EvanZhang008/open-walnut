/**
 * Every calendar setting is kept (2026-11-17, the user: "also all settings is remembered").
 * The person changes each one with real clicks, then:
 *   - reloads a bare /calendar (no ?view in the link): every one holds;
 *   - opens /calendar on ANOTHER device (a fresh browser context with nothing stored, the
 *     same server): every synced one holds there too.
 *
 * Both devices share one in-memory /api/ui-prefs store for this test (the real route's
 * GET/PUT shape), so another spec's stored choices never leak in and the second device
 * reads only what the first one wrote. tests/web/calendar-settings-kept.test.ts lists every
 * storage key the calendar's source uses and fails when one is missing from that list or,
 * if synced, from the spec named there: a new setting cannot ship unkept.
 */
import { devices, test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { PHONE, openDrawer } from './phone-helpers'
import { calendarEmptySlotPoint } from './calendar-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.use({ viewport: { width: 1280, height: 860 } })
test.setTimeout(120_000)

const KEYS = {
  view: 'open-walnut-view:calendar.view',
  phoneView: 'open-walnut-view:calendar.phoneView',
  createKind: 'open-walnut-view:calendar.createKind',
  rail: 'open-walnut-calendar-rail-open',
  grid: 'open-walnut-calendar-grid-settings',
  railFilter: 'walnut-calendar-rail-filter',
} as const

type Prefs = Record<string, { v: string | null; ts: number }>

/** One server-side prefs store shared by every device of the test. */
async function useSharedPrefs(context: BrowserContext, store: Prefs): Promise<void> {
  await context.route(/\/api\/ui-prefs(\?|$)/, async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}') as { prefs?: Prefs }
      for (const [k, e] of Object.entries(body.prefs ?? {})) if (!store[k] || e.ts >= store[k].ts) store[k] = e
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return
    }
    // The shared fixture's boot shape (todo-panel-helpers isolateUiPrefs): the chat slot closed.
    const prefs = { 'open-walnut-home-chat-visible': { v: 'false', ts: 1 }, ...store }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs }) })
  })
}

async function device(browser: Browser, store: Prefs, phone = false): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    ...(phone
      ? { viewport: PHONE.viewport, screen: PHONE.screen, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent }
      : { viewport: { width: 1280, height: 860 }, ...(process.env.PW_WEBKIT ? { userAgent: devices['Desktop Safari'].userAgent } : {}) }),
  })
  await useSharedPrefs(context, store)
  return context.newPage()
}

async function openCalendar(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
}

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A press on an empty slot of today, which opens the new-item popover. */
async function clickEmptySlot(page: Page): Promise<void> {
  const slot = await calendarEmptySlotPoint(page, today(), 10)
  await page.mouse.click(slot.x, slot.y)
  await expect(page.locator('.cal-create-popover')).toBeVisible()
}

const viewTab = (page: Page, name: 'Day' | 'Week' | 'Month') =>
  page.locator('.cal-view-switch').getByRole('tab', { name, exact: true })

/** What every kept setting reads as on this page. */
async function expectChanged(page: Page, where: string): Promise<void> {
  await expect(viewTab(page, 'Day'), `${where}: view`).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.cal-page'), `${where}: view`).toHaveAttribute('data-view', 'day')
  await expect(page.getByTestId('cal-rail'), `${where}: task list hidden`).toHaveCount(0)
  await expect(page.locator('.cal-zoom-value'), `${where}: zoom`).toHaveText('125%')
  await expect(page.locator('.cal-hours-toggle'), `${where}: full day`).toHaveAttribute('aria-pressed', 'true')
  // The new-item kind: a click on an empty slot opens on Task.
  await clickEmptySlot(page)
  const tabs = page.locator('.cal-create-popover .cal-create-tabs')
  await expect(tabs.getByRole('tab', { name: 'Task', exact: true }), `${where}: new-item kind`).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cal-create-popover')).toHaveCount(0)
}

test('every calendar setting holds after a reload and on another device', async ({ browser }) => {
  const store: Prefs = {}
  const a = await device(browser, store)
  await openCalendar(a)

  // Defaults, nothing stored: Week, task list shown, 100%, 7 AM to 1 AM, Event.
  await expect(viewTab(a, 'Week')).toHaveAttribute('aria-selected', 'true')
  await expect(a.getByTestId('cal-rail')).toBeVisible()
  await expect(a.locator('.cal-zoom-value')).toHaveText('100%')
  await expect(a.locator('.cal-hours-toggle')).toHaveAttribute('aria-pressed', 'false')

  // Change each one with the controls a person uses.
  await a.getByTestId('cal-rail').getByPlaceholder('Filter…').fill('alpha')
  await viewTab(a, 'Day').click()
  await a.getByRole('button', { name: 'Hide task list' }).click()
  await a.getByRole('button', { name: 'Zoom in calendar' }).click()
  await a.getByRole('button', { name: 'Show full day' }).click()
  await clickEmptySlot(a)
  await a.locator('.cal-create-popover .cal-create-tabs').getByRole('tab', { name: 'Task', exact: true }).click()
  await a.keyboard.press('Escape')

  // A reload of a bare /calendar: the link names no view, the kept one shows.
  await a.goto('/calendar')
  await expect(a.locator('.cal-toolbar')).toBeVisible()
  expect(new URL(a.url()).searchParams.get('view')).toBeNull()
  await expectChanged(a, 'after a reload')
  // The task list's filter text is this device's (a search box, not a setting): kept here.
  await a.getByRole('button', { name: 'Show task list' }).click()
  await expect(a.getByTestId('cal-rail').getByPlaceholder('Filter…')).toHaveValue('alpha')
  await a.getByRole('button', { name: 'Hide task list' }).click()

  // Every synced setting reached the server store.
  await expect.poll(() => Object.keys(store).filter((k) => k !== KEYS.railFilter && Object.values(KEYS).includes(k as never)).sort())
    .toEqual([KEYS.createKind, KEYS.grid, KEYS.rail, KEYS.view].sort())
  expect(store[KEYS.railFilter]).toBeUndefined()

  // Another device: nothing in its storage, the same server.
  const other = await device(browser, store)
  await openCalendar(other)
  await expectChanged(other, 'on another device')

  // A link that names a view still wins, and does not change the kept one.
  await other.goto('/calendar?view=month')
  await expect(other.locator('.cal-page')).toHaveAttribute('data-view', 'month')
  await other.goto('/calendar')
  await expect(other.locator('.cal-page')).toHaveAttribute('data-view', 'day')

  await a.context().close()
  await other.context().close()
})

test('a phone keeps its own view, after a reload and on another phone, and leaves the desktop one alone', async ({ browser }) => {
  const store: Prefs = {}
  const phone = await device(browser, store, true)
  const openOnPhone = async (page: Page) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openDrawer(page)
    await page.locator('#primary-sidebar').getByRole('link', { name: 'Calendar' }).click()
    await expect(page.locator('.cal-page')).toBeVisible({ timeout: 15_000 })
  }
  await openOnPhone(phone)
  // A phone opens on one day.
  await expect(phone.locator('.cal-page')).toHaveAttribute('data-view', 'day')
  await viewTab(phone, 'Month').click()
  await expect(phone.locator('.cal-page')).toHaveAttribute('data-view', 'month')

  await phone.goto('/calendar')
  await expect(phone.locator('.cal-page')).toHaveAttribute('data-view', 'month')
  await expect.poll(() => store[KEYS.phoneView]?.v).toBe('"month"')
  expect(store[KEYS.view]).toBeUndefined()

  const otherPhone = await device(browser, store, true)
  await openOnPhone(otherPhone)
  await expect(otherPhone.locator('.cal-page')).toHaveAttribute('data-view', 'month')

  // The desktop still opens on its own default, Week.
  const desk = await device(browser, store)
  await openCalendar(desk)
  await expect(desk.locator('.cal-page')).toHaveAttribute('data-view', 'week')

  for (const p of [phone, otherPhone, desk]) await p.context().close()
})
