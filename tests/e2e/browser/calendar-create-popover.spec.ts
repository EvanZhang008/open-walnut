/**
 * The calendar's new-item popover, laid out like a desktop calendar's new-event popover
 * (2026-11-16, the user: "this calendar ui look very bad, I want something like apple",
 * "default event instead of task", and remember which one was chosen).
 *
 *  - It opens on Event; the side picked last (Event or Task) is kept across a reload.
 *  - A placeholder block appears in the grid at the slot at once, and the popover opens
 *    BESIDE it with an arrow, never over it.
 *  - The when-line edits in place, and the block follows the times.
 *  - Created events land in the grid; Cancel leaves nothing behind.
 *
 * Real pointer input through the real fixture server (test-server.ts calendars: Work
 * listed first, Home and Personal, Holidays read-only). Nothing is page.route-mocked
 * except isolateUiPrefs, which keeps another spec's stored choices out.
 */
import { devices, test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { calendarEmptySlotPoint, calendarHourPx } from './calendar-helpers'
import { withCssColor } from './css-color'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.use({ viewport: { width: 1280, height: 860 } })
// CAL_SHOTS=<dir>: keep a screenshot of each state, and a video of each test.
const SHOTS = process.env.CAL_SHOTS
if (SHOTS) test.use({ video: 'on' })
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${page.context().browser()?.browserType().name()}-${name}.png` })
}
test.setTimeout(120_000)

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const KIND_KEY = 'open-walnut-view:calendar.createKind'

function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function openCalendar(page: Page, view: 'Week' | 'Day' = 'Week'): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
  await page.getByRole('tab', { name: view, exact: true }).click()
  await expect(page.locator('.cal-grid')).toBeVisible()
}

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1
}

const popover = (page: Page) => page.locator('.cal-create-popover')
const placeholder = (page: Page) => page.getByTestId('cal-create-placeholder')
const tab = (page: Page, name: 'Event' | 'Task') => popover(page).getByRole('tab', { name, exact: true })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
})

test('a new item is an Event by default, and the side picked last is kept across a reload', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const open = async () => {
    const slot = await calendarEmptySlotPoint(page, today, 9)
    await page.mouse.click(slot.x, slot.y)
    await expect(popover(page)).toBeVisible()
  }

  // Nothing stored: Event.
  expect(await page.evaluate((k) => localStorage.getItem(k), KIND_KEY)).toBeNull()
  await open()
  await expect(tab(page, 'Event')).toHaveAttribute('aria-selected', 'true')
  await expect(popover(page).locator('.cal-event-form')).toBeVisible()
  await expect(placeholder(page)).toContainText('New Event')

  // Pick Task: the placeholder says so, and the choice is stored.
  await tab(page, 'Task').click()
  await expect(popover(page).locator('.quick-task-composer')).toBeVisible()
  await expect(placeholder(page)).toContainText('New Task')
  await shot(page, 'task-side')
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KIND_KEY)).toBe('"task"')
  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
  await expect(placeholder(page)).toHaveCount(0)

  // A reload (the app restarting reads the same store) opens on Task.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.cal-grid')).toBeVisible()
  await open()
  await expect(tab(page, 'Task')).toHaveAttribute('aria-selected', 'true')
  await expect(popover(page).locator('.quick-task-composer')).toBeVisible()

  // Back to Event, kept the same way.
  await tab(page, 'Event').click()
  await expect(popover(page).locator('.cal-event-form')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.cal-grid')).toBeVisible()
  await open()
  await expect(tab(page, 'Event')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
})

test('click: the placeholder appears at the slot and the popover opens beside it with an arrow', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 10)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()

  const block = placeholder(page)
  await expect(block).toBeVisible()
  // In today's column, starting at the half hour clicked, one hour long.
  await expect(block.locator('xpath=..')).toHaveAttribute('data-day', today)
  const hourPx = await calendarHourPx(page)
  const b = await box(block)
  expect(Math.abs(b.height - hourPx)).toBeLessThan(2)
  const p = await box(popover(page))
  expect(overlaps(b, p)).toBe(false)
  // Beside it: horizontally clear, vertically level with it.
  expect(p.x >= b.x + b.width || p.x + p.width <= b.x).toBe(true)
  expect(p.y < b.y + b.height && p.y + p.height > b.y).toBe(true)
  const arrow = page.locator('.cal-create-arrow')
  await expect(arrow).toBeVisible()
  await shot(page, 'week-click')
  const edge = await arrow.getAttribute('data-edge')
  expect(['left', 'right']).toContain(edge)

  // The when-line reads as text: a date and two times.
  const start = popover(page).getByLabel('Start time')
  const end = popover(page).getByLabel('End time')
  const startVal = await start.inputValue()
  expect(startVal).toBe(`${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`)
  await expect(popover(page).getByRole('button', { name: 'Date', exact: true })).toHaveAttribute('data-day', today)

  // Moving the start keeps the hour and moves the block with it.
  const topBefore = b.y
  const [h, m] = startVal.split(':').map(Number)
  const later = (h * 60 + m + 30) % (24 * 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  await start.fill(`${pad(Math.floor(later / 60))}:${pad(later % 60)}`)
  await expect(end).toHaveValue(`${pad(Math.floor((later + 60) / 60) % 24)}:${pad((later + 60) % 60)}`)
  await expect.poll(async () => Math.round((await box(block)).y - topBefore)).toBe(Math.round(hourPx / 2))

  // Cancel: nothing left in the grid, nothing created.
  await popover(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(placeholder(page)).toHaveCount(0)
  await expect(page.locator('.cal-create-arrow')).toHaveCount(0)
})

test('drag-select, change the calendar and add: the event lands in the grid where the block was', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 16)
  const hourPx = await calendarHourPx(page)
  // From the slot's start, 90 minutes down.
  await page.mouse.move(slot.x, slot.y)
  await page.mouse.down()
  await page.mouse.move(slot.x, slot.y + hourPx * 1.5 - 4, { steps: 10 })
  // While dragging: a solid "New Event" block with its range.
  await expect(page.locator('.cal-create-sel')).toContainText('New Event')
  await page.mouse.up()

  await expect(popover(page)).toBeVisible()
  const block = placeholder(page)
  await expect(block).toBeVisible()
  const pad = (n: number) => String(n).padStart(2, '0')
  const startMin = slot.hour * 60 + slot.minute
  await expect(popover(page).getByLabel('Start time')).toHaveValue(`${pad(slot.hour)}:${pad(slot.minute)}`)
  await expect(popover(page).getByLabel('End time')).toHaveValue(`${pad(Math.floor((startMin + 90) / 60))}:${pad((startMin + 90) % 60)}`)
  expect(Math.abs((await box(block)).height - hourPx * 1.5)).toBeLessThan(2)
  expect(overlaps(await box(block), await box(popover(page)))).toBe(false)

  // Another calendar: its own list (no native select), the block takes its colour.
  const picker = popover(page).getByTestId('cal-event-form-calendar')
  await expect(picker).toHaveAttribute('data-value', 'cal-work')
  // A click outside the list closes the list alone.
  await picker.click()
  await expect(page.locator('.cal-cal-list')).toBeVisible()
  await page.mouse.click(1240, 840)
  await expect(page.locator('.cal-cal-list')).toHaveCount(0)
  await expect(popover(page)).toBeVisible()
  await picker.click()
  await page.locator('.cal-cal-option[data-calendar-id="cal-personal"]').click()
  await expect(picker).toHaveAttribute('data-value', 'cal-personal')
  await expect(picker).toContainText('Personal (iCloud)')
  await expect.poll(() => block.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(175, 82, 222)')

  const title = `AppleCreate ${Date.now()}`
  await popover(page).getByLabel('Event title').fill(title)
  await expect(block).toContainText(title)
  await shot(page, 'week-drag-titled')
  await popover(page).getByRole('button', { name: 'Add Event', exact: true }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(placeholder(page)).toHaveCount(0)

  const chip = page.locator(`.cal-day-col[data-day="${today}"] .cal-chip:has-text("${title}")`)
  await expect(chip).toBeVisible()
  await shot(page, 'week-created')
  let createdId = ''
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    const body = (await res.json()) as { events: Array<{ id: string; title: string; calendarId: string; start: string; end: string }> }
    const ev = body.events.find((e) => e.title === title)
    createdId = ev?.id ?? ''
    return ev ? `${ev.calendarId} ${ev.start.slice(11, 16)}-${ev.end.slice(11, 16)}` : null
  }, { timeout: 10_000 }).toBe(`cal-personal ${pad(slot.hour)}:${pad(slot.minute)}-${pad(Math.floor((startMin + 90) / 60))}:${pad((startMin + 90) % 60)}`)
  const del = await fetch(`${API}/api/calendar/events/${encodeURIComponent(createdId)}`, { method: 'DELETE' })
  expect(del.status).toBe(200)
})

test('day view: a full-width block gets the popover above or below it, still not covering it', async ({ page }) => {
  await openCalendar(page, 'Day')
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 11)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()
  const b = await box(placeholder(page))
  const p = await box(popover(page))
  expect(overlaps(b, p)).toBe(false)
  await shot(page, 'day-click')
  await expect(page.locator('.cal-create-arrow')).toHaveAttribute('data-edge', /^(top|bottom|left|right)$/)
  // The month flyout edits the date in place; Escape closes it alone.
  await popover(page).getByRole('button', { name: 'Date', exact: true }).click()
  await expect(page.locator('.cal-day-flyout')).toBeVisible()
  await shot(page, 'day-date-flyout')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cal-day-flyout')).toHaveCount(0)
  await expect(popover(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
})

test('all-day: a click on the all-day row shows a placeholder chip there', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const cell = page.locator(`.cal-allday-cell[data-day="${today}"]`)
  const c = await box(cell)
  await page.mouse.click(c.x + c.width - 6, c.y + c.height - 4)
  await expect(popover(page)).toBeVisible()
  await expect(cell.getByTestId('cal-create-placeholder')).toBeVisible()
  await shot(page, 'allday-click')
  await expect(popover(page).locator('.cal-when-allday input')).toBeChecked()
  expect(overlaps(await box(cell.getByTestId('cal-create-placeholder')), await box(popover(page)))).toBe(false)
  await page.keyboard.press('Escape')
  await expect(cell.getByTestId('cal-create-placeholder')).toHaveCount(0)
})

test('Home Today panel: the popover opens beside the narrow day column, off the grid, and creates there', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.getByTestId('cal-side-panel')
  if (!(await panel.isVisible())) await page.getByTestId('sidebar-toggle-calendar').click()
  await expect(panel).toBeVisible()
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(panel, today, 13)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()
  const block = panel.getByTestId('cal-create-placeholder')
  await expect(block).toBeVisible()
  const b = await box(block)
  const p = await box(popover(page))
  const grid = await box(panel.locator('.cal-grid-cols'))
  expect(overlaps(b, p)).toBe(false)
  // Beside the panel's column: the day stays readable under it.
  expect(p.x >= grid.x + grid.width - 1 || p.x + p.width <= grid.x + 1).toBe(true)
  await expect(tab(page, 'Event')).toHaveAttribute('aria-selected', 'true')
  await shot(page, 'home-panel-click')

  const title = `HomePanelCreate ${Date.now()}`
  await popover(page).getByLabel('Event title').fill(title)
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0)
  await expect(panel.locator(`.cal-chip:has-text("${title}")`)).toBeVisible()
  await shot(page, 'home-panel-created')
  const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
  const ev = ((await res.json()) as { events: Array<{ id: string; title: string }> }).events.find((e) => e.title === title)
  expect(ev).toBeTruthy()
  await fetch(`${API}/api/calendar/events/${encodeURIComponent(ev!.id)}`, { method: 'DELETE' })
})

test('context menu: "New task…" opens on Task with the placeholder, and the switch still works', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 12)
  await page.mouse.click(slot.x, slot.y, { button: 'right' })
  const menu = page.locator('[data-testid="cal-ctx-menu"]')
  await expect(menu).toBeVisible()
  await menu.locator('button:has-text("New task…")').click()
  await expect(tab(page, 'Task')).toHaveAttribute('aria-selected', 'true')
  await expect(placeholder(page)).toContainText('New Task')
  expect(overlaps(await box(placeholder(page)), await box(popover(page)))).toBe(false)
  await tab(page, 'Event').click()
  await expect(tab(page, 'Event')).toHaveAttribute('aria-selected', 'true')
  await expect(popover(page).locator('.cal-event-form')).toBeVisible()
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KIND_KEY)).toBe('"event"')
  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
})

test('Task side: a press on the popover padding keeps it open; switching sides keeps the edited times', async ({ page }) => {
  await openCalendar(page)
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 8)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()
  const start = popover(page).getByLabel('Start time')
  const [h, m] = (await start.inputValue()).split(':').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const moved = `${pad((h + 1) % 24)}:${pad(m)}`
  await start.fill(moved)
  await tab(page, 'Task').click()
  await expect(popover(page).locator('.quick-task-composer')).toBeVisible()
  // The popover's own padding is not "outside the composer".
  const p = await box(popover(page))
  // Mid-height on the left padding: clear of the rounded corners, which are not the popover.
  await page.mouse.click(p.x + 5, p.y + p.height / 2)
  await expect(popover(page)).toBeVisible()
  await tab(page, 'Event').click()
  await expect(popover(page).getByLabel('Start time')).toHaveValue(moved)
  await expect(popover(page).getByLabel('Event title')).toBeFocused()
  await page.keyboard.press('Escape')
})

test('a drag past midnight keeps its real end: the end date shows and the event ends the next day', async ({ page }) => {
  // The default hours run on into the next morning (GRID_EXTENDED_END).
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: false })))
  await openCalendar(page, 'Day')
  const today = localDay(0)
  const tomorrow = localDay(1)
  const hourPx = await calendarHourPx(page)
  const col = page.locator(`.cal-day-col[data-day="${today}"]`)
  // Bring 23:00 into view, then drag two hours down from it.
  await page.locator('.cal-grid-scroll').evaluate((el, y) => { el.scrollTop = y }, 22 * hourPx)
  const c = await box(col)
  const y23 = c.y + 23 * hourPx + 3
  await page.mouse.move(c.x + 60, y23)
  await page.mouse.down()
  await page.mouse.move(c.x + 60, y23 + 2 * hourPx - 6, { steps: 10 })
  await page.mouse.up()
  await expect(popover(page)).toBeVisible()
  await expect(popover(page).getByLabel('Start time')).toHaveValue('23:00')
  await expect(popover(page).getByLabel('End time')).toHaveValue('01:00')
  await expect(popover(page).getByRole('button', { name: 'End date', exact: true })).toHaveAttribute('data-day', tomorrow)
  expect(Math.abs((await box(placeholder(page))).height - 2 * hourPx)).toBeLessThan(2)
  await expect(popover(page).locator('.cal-event-form-error')).toHaveCount(0)

  const title = `PastMidnight ${Date.now()}`
  await popover(page).getByLabel('Event title').fill(title)
  await popover(page).getByRole('button', { name: 'Add Event', exact: true }).click()
  await expect(popover(page)).toHaveCount(0)
  let id = ''
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${tomorrow}`)
    const ev = ((await res.json()) as { events: Array<{ id: string; title: string; start: string; end: string }> }).events.find((e) => e.title === title)
    id = ev?.id ?? ''
    return ev ? `${ev.start.slice(0, 16)} ${ev.end.slice(0, 16)}` : null
  }, { timeout: 10_000 }).toBe(`${today}T23:00 ${tomorrow}T01:00`)
  await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
})

test('Enter before the calendars are read still creates the event, once they arrive', async ({ page }) => {
  await openCalendar(page)
  // The one route here: hold the calendar list so the title is typed and sent before it lands.
  await page.route('**/api/calendar/sources', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  const today = localDay(0)
  const slot = await calendarEmptySlotPoint(page, today, 7)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()
  await expect(popover(page).getByTestId('cal-event-form-calendar')).toContainText('Loading calendars')
  const title = `EarlyEnter ${Date.now()}`
  await popover(page).getByLabel('Event title').fill(title)
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0, { timeout: 10_000 })
  let id = ''
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    id = ((await res.json()) as { events: Array<{ id: string; title: string }> }).events.find((e) => e.title === title)?.id ?? ''
    return !!id
  }, { timeout: 10_000 }).toBe(true)
  await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

/**
 * The popover and the switches are glass (2026-11-17, the user: "calendar should be glass view
 * please"): a backdrop blur over a tint of at least 84%, and every text in the popover keeps
 * 4.5:1 over the worst backdrop the blur can give it in each theme. The backdrop is the
 * page's own background pulled halfway to the opposite pole (a bright event block behind a
 * dark popover, a dark one behind a light popover), then the tint, then each card's own tint.
 */
for (const theme of ['light', 'dark'] as const) {
  test(`glass, ${theme}: the popover and the view switch blur what is behind them, and every text reads 4.5:1`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('open-walnut-theme', t), theme)
    await openCalendar(page)
    const slot = await calendarEmptySlotPoint(page, localDay(0), 10)
    await page.mouse.click(slot.x, slot.y)
    await expect(popover(page)).toBeVisible()
    await page.locator('.cal-event-form-title').fill('Design review')
    const report = await page.evaluate(withCssColor((toRgba) => () => {
      // Channels in 0..1 for the contrast sums below; the shared parser reads every form an engine computes.
      const parse = (c: string): [number, number, number, number] => {
        const [r, g, b, a] = toRgba(c)
        return [r / 255, g / 255, b / 255, a]
      }
      const over = (top: number[], base: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]))
      const lum = (c: number[]) => {
        const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
      }
      const ratio = (a: number[], b: number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
        return (x + 0.05) / (y + 0.05)
      }
      const pop = document.querySelector('.cal-create-popover') as HTMLElement
      const dark = document.documentElement.dataset.theme === 'dark'
      const pageBg = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3)
      const pole = dark ? [1, 1, 1] : [0, 0, 0]
      const backdrop = over([...pole, 0.5], pageBg)
      const popStyle = getComputedStyle(pop)
      const popBg = parse(popStyle.backgroundColor)
      const surface = over(popBg, backdrop)
      const low: string[] = []
      let checked = 0
      const walker = document.createTreeWalker(pop, NodeFilter.SHOW_ELEMENT)
      for (let el = walker.currentNode as HTMLElement | null; el; el = walker.nextNode() as HTMLElement | null) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || (el instanceof HTMLInputElement && el.type === 'text' && el.value)
        if (!own || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue
        const chain: HTMLElement[] = []
        for (let a: HTMLElement | null = el; a && a !== pop; a = a.parentElement) chain.unshift(a)
        let bg = surface
        for (const a of chain) bg = over(parse(getComputedStyle(a).backgroundColor), bg)
        const fg = parse(getComputedStyle(el).color)
        const r = ratio(over(fg, bg), bg)
        checked++
        if (r < 4.5) low.push(`${el.className || el.tagName} "${(el.textContent || (el as HTMLInputElement).value).trim().slice(0, 24)}" ${r.toFixed(2)}`)
      }
      const sw = getComputedStyle(document.querySelector('.cal-view-switch')!)
      const active = getComputedStyle(document.querySelector('.cal-view-switch .cal-view-btn.active')!)
      return {
        dark,
        blur: popStyle.backdropFilter || (popStyle as unknown as Record<string, string>).webkitBackdropFilter,
        alpha: popBg[3],
        arrowBlur: getComputedStyle(document.querySelector('.cal-create-arrow')!).backdropFilter,
        low,
        checked,
        track: sw.backgroundColor,
        thumb: active.backgroundColor,
        thumbShadow: active.boxShadow,
      }
    }))
    expect(report.dark).toBe(theme === 'dark')
    expect(report.blur).toMatch(/blur\(30px\)/)
    expect(report.arrowBlur).toMatch(/blur\(30px\)/)
    expect(report.alpha).toBeGreaterThanOrEqual(0.84)
    expect(report.alpha).toBeLessThan(1)
    expect(report.checked).toBeGreaterThanOrEqual(6)
    expect(report.low, 'text under 4.5:1 on the glass').toEqual([])
    // The view switch: a see-through track and a raised thumb.
    expect(parse01(report.track)).toBeLessThan(0.5)
    expect(report.thumbShadow).not.toBe('none')
    await shot(page, `glass-${theme}`)
  })
}

test('glass: Reduce transparency paints the popover solid, with no blur', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium can emulate prefers-reduced-transparency')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  await openCalendar(page)
  const slot = await calendarEmptySlotPoint(page, localDay(0), 10)
  await page.mouse.click(slot.x, slot.y)
  await expect(popover(page)).toBeVisible()
  const s = await popover(page).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter }))
  expect(s.blur).toBe('none')
  expect(parse01(s.bg)).toBe(1)
})

/** The alpha of a computed colour (rgb/rgba/color(srgb …)). */
function parse01(c: string): number {
  const a = c.match(/\/\s*([\d.]+)\)/)?.[1] ?? c.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1]
  return a === undefined ? 1 : Number(a)
}
