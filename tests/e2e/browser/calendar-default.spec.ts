/**
 * The default calendar, through the real UI and the real fixture server.
 *
 * Settings → Calendar Accounts → Default calendar picks where new events go; the calendar's
 * quick-create Event tab preselects it instead of whichever writable calendar EventKit lists
 * first. Nothing is page.route-mocked: the picker writes through PUT /sources/eventkit into the
 * fixture's isolated config, and the created event is read back from the server.
 *
 * Fixture calendars (tests/e2e/browser/test-server.ts): Work (Google, listed first), Home and
 * Personal (iCloud), Holidays (iCloud, read-only).
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a WKWebView) with
 * `PW_WEBKIT=1 npx playwright test calendar-default --project webkit`.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import { isolateUiPrefs } from './todo-panel-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/default-cal'

function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function setDefault(id: string | null): Promise<void> {
  const res = await fetch(`${API}/api/calendar/sources/eventkit`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_calendar_id: id }),
  })
  expect(res.status).toBe(200)
}

async function serverDefault(): Promise<string | null> {
  const res = await fetch(`${API}/api/calendar/sources`)
  return ((await res.json()) as { defaultCalendar?: { id: string | null } }).defaultCalendar?.id ?? null
}

async function shot(page: Page, name: string, locator?: ReturnType<Page['locator']>) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const path = `${SHOTS}/e2e-${engine}-${name}.png`
  if (locator) await locator.screenshot({ path, scale: 'css' })
  else await page.screenshot({ path, scale: 'css' })
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
  await setDefault(null)
})

test.afterEach(async () => {
  await setDefault(null)
})

test('Settings picker lists writable calendars by account, saves the choice, and clears it', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-calendar')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')

  const row = page.getByTestId('calendar-default-row')
  const select = page.getByTestId('calendar-default-select')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(select).toHaveValue('')
  // One group per account; the read-only calendar is not offered.
  await expect(select.locator('optgroup')).toHaveCount(2)
  await expect(select.locator('optgroup[label="Google"] option')).toHaveText(['Work'])
  await expect(select.locator('optgroup[label="iCloud"] option')).toHaveText(['Home', 'Personal'])
  await expect(select.locator('option', { hasText: 'Holidays' })).toHaveCount(0)

  await select.selectOption('cal-personal')
  await expect.poll(serverDefault, { timeout: 10_000 }).toBe('cal-personal')
  await expect(select).toHaveValue('cal-personal')
  await expect(page.locator('#calendar [role="alert"]')).toHaveCount(0)
  await shot(page, 'settings-picker', page.locator('#calendar'))

  // Leave the pane and come back: the choice is read back from the server.
  await page.getByTestId('settings-nav-general').click()
  await nav.click()
  await expect(page.getByTestId('calendar-default-select')).toHaveValue('cal-personal')

  await page.getByTestId('calendar-default-select').selectOption('')
  await expect.poll(serverDefault, { timeout: 10_000 }).toBeNull()
})

test('quick-create preselects the default calendar and the event lands there', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()

  // 19:00: no fixture event sits there (a 16:00 click opened the invited series instead).
  async function openEventForm(hour = 19) {
    const today = localDay(0)
    await page.locator('.cal-grid-scroll').evaluate((el, h) => { el.scrollTop = h * 48 - el.clientHeight / 2 }, hour)
    const box = await page.locator(`.cal-day-col[data-day="${today}"]`).boundingBox()
    if (!box) throw new Error('today column not visible')
    await page.mouse.click(box.x + box.width / 2, box.y + hour * 48 + 1)
    const popover = page.locator('.cal-create-popover')
    await expect(popover).toBeVisible()
    await popover.locator('.cal-create-tabs button:has-text("Event")').click()
    return popover
  }

  // No default: unchanged behaviour, the first writable calendar.
  let popover = await openEventForm()
  await expect(popover.getByTestId('cal-event-form-calendar')).toHaveValue('cal-work')
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)

  // With a default that is NOT listed first.
  // Each open reads /sources afresh, so a default set elsewhere applies without a reload.
  await setDefault('cal-personal')
  popover = await openEventForm()
  const select = popover.getByTestId('cal-event-form-calendar')
  await expect(select).toHaveValue('cal-personal')
  await expect(select.locator('option:checked')).toHaveText('Personal (iCloud) · default')
  await shot(page, 'quick-create-default', popover)

  const title = `DefaultCal ${Date.now()}`
  await popover.locator('.cal-event-form-title').fill(title)
  await popover.locator('.cal-event-form-create').click()
  const today = localDay(0)
  let createdId = ''
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    const body = (await res.json()) as { events: Array<{ id: string; title: string; calendarId: string }> }
    const ev = body.events.find((e) => e.title === title)
    createdId = ev?.id ?? ''
    return ev?.calendarId
  }, { timeout: 10_000 }).toBe('cal-personal')
  await expect(page.locator(`.cal-chip:has-text("${title}")`).first()).toBeVisible()

  // A second open in the same page still starts on the default (not on the last pick).
  await page.keyboard.press('Escape')
  // 21:00: the event just made sits at 19:00.
  const again = await openEventForm(21)
  await expect(again.getByTestId('cal-event-form-calendar')).toHaveValue('cal-personal')
  await page.keyboard.press('Escape')

  // Clean the shared fixture: the event is a Walnut-created private block.
  const del = await fetch(`${API}/api/calendar/events/${encodeURIComponent(createdId)}`, { method: 'DELETE' })
  expect(del.status).toBe(200)
})

test('quick-create picks nothing when the configured default is unusable, and says why', async ({ page }) => {
  // The one page.route here: a default that went read-only cannot be saved through PUT (it
  // validates), so the server's answer is rewritten to the shape it gives for one.
  const warning = 'The default calendar "Holidays" (iCloud) is read-only. Pick another in Settings → Calendar Accounts → Default calendar.'
  await page.route('**/api/calendar/sources', async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as Record<string, unknown>
    body.defaultCalendar = { id: null, configuredId: 'cal-holidays', title: 'Holidays', account: 'iCloud', warning }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
  const today = localDay(0)
  await page.locator('.cal-grid-scroll').evaluate((el) => { el.scrollTop = 20 * 48 - el.clientHeight / 2 })
  const box = await page.locator(`.cal-day-col[data-day="${today}"]`).boundingBox()
  if (!box) throw new Error('today column not visible')
  await page.mouse.click(box.x + box.width / 2, box.y + 20 * 48 + 1)
  const popover = page.locator('.cal-create-popover')
  await expect(popover).toBeVisible()
  await popover.locator('.cal-create-tabs button:has-text("Event")').click()

  const select = popover.getByTestId('cal-event-form-calendar')
  await expect(select).toHaveValue('')
  await expect(select.locator('option:checked')).toHaveText('Pick a calendar')
  await expect(popover.getByTestId('cal-event-form-default-warning')).toHaveText(warning)
  await popover.locator('.cal-event-form-title').fill('Unusable default probe')
  await expect(popover.locator('.cal-event-form-create')).toBeDisabled()

  // Picking one clears the warning and enables Create; nothing is created by this test.
  await select.selectOption('cal-home')
  await expect(popover.getByTestId('cal-event-form-default-warning')).toHaveCount(0)
  await expect(popover.locator('.cal-event-form-create')).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
