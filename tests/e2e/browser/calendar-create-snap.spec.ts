/**
 * Three asks of Evan's on 2026-11-21, through the homepage's calendar side panel and the real
 * fixture server:
 *
 *  - "why I can drag start at xx:15 can only start at 00or 30": every time picked by pointer
 *    lands on a quarter hour (a click or a drag that makes an event, a move, a resize, an Alt
 *    copy), and what is saved is the time the grid showed;
 *  - "don't show this when calender item create so stupid, no need": a change he makes on the
 *    calendar shows on the grid and raises no notice (mod+z still takes it back);
 *  - "why sometimes the calender is not loaded and when i create it doesn;'t show up vents": a new
 *    event is on the grid the moment it is made, and a load the server refuses (a restart answers
 *    503 for a few seconds) says so in the panel and loads by itself once the server is back.
 *
 * Events this spec makes are removed again by title at the end.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  blurFocus, calendarEmptySlotPoint, calendarHourPx, calendarSlotPoint, cleanupTitled, createEvent, dragChip, drop,
  expectNoNotice, openPanel, titled, today, undo,
} from './calendar-helpers'

test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

const pad = (n: number) => String(n).padStart(2, '0')
const at = (min: number) => `${today}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`
const popover = (page: Page) => page.locator('.cal-create-popover')

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
})

async function makeEventHere(page: Page, title: string) {
  await expect(popover(page)).toBeVisible()
  await popover(page).getByRole('radio', { name: 'Event', exact: true }).click()
  await popover(page).getByLabel('Event title').fill(title)
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0)
}

test('a click a quarter past makes an event that starts at :15, on the grid at once, with no notice', async ({ page }) => {
  const title = `Quarter click ${Date.now()}`
  try {
    const panel = await openPanel(page)
    const free = await calendarEmptySlotPoint(panel, today, 13)
    const base = free.hour * 60 + free.minute
    // Two minutes past the quarter: it rounds to the quarter, not to the half hour.
    const p = await calendarSlotPoint(panel, today, free.hour, free.minute + 17)
    await page.mouse.click(p.x, p.y)
    await makeEventHere(page, title)
    // On the grid the moment it is made (no wait for a refetch), and nothing pops up.
    await expect(panel.locator(`.cal-chip:has-text("${title}")`)).toBeVisible({ timeout: 1_500 })
    await expectNoNotice(page)
    await expect.poll(async () => (await titled(title))[0]?.start).toBe(at(base + 15))
  } finally {
    await cleanupTitled(title)
  }
})

test('a drag out from :45 to :15 makes exactly that event', async ({ page }) => {
  const title = `Quarter drag ${Date.now()}`
  try {
    const panel = await openPanel(page)
    const free = await calendarEmptySlotPoint(panel, today, 15)
    const base = free.hour * 60 + free.minute
    const from = await calendarSlotPoint(panel, today, free.hour, free.minute + 45 + 2)
    const hourPx = await calendarHourPx(panel)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + hourPx / 2, { steps: 8 })
    await page.mouse.up()
    await makeEventHere(page, title)
    await expect(panel.locator(`.cal-chip:has-text("${title}")`)).toBeVisible({ timeout: 1_500 })
    await expectNoNotice(page)
    await expect.poll(async () => (await titled(title))[0]).toMatchObject({ start: at(base + 45), end: at(base + 75) })
  } finally {
    await cleanupTitled(title)
  }
})

test('a move, a resize and an Alt copy each land on quarter hours, and none raises a notice', async ({ page }) => {
  const title = `Quarter moves ${Date.now()}`
  const ev = await createEvent(title, `${today}T11:00:00`, `${today}T11:30:00`)
  try {
    const panel = await openPanel(page)
    const chip = panel.locator(`[data-item-id="event:${ev.id}"]`)
    await expect(chip).toBeVisible()
    // A quarter hour later: 11:15 (a time no other spec writes, so no block lands beside it mid-drag).
    await dragChip(page, panel, chip, { hours: 0.25 })
    await drop(page)
    await expect.poll(async () => (await titled(title)).find((e) => e.id === ev.id)?.start).toBe(at(11 * 60 + 15))
    await expectNoNotice(page)
    // Its bottom edge three quarters down: 11:45 to 12:30.
    await chip.scrollIntoViewIfNeeded()
    const hb = (await chip.locator('.cal-chip-resize-handle').boundingBox())!
    const hourPx = await calendarHourPx(panel)
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + hourPx * 0.75, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await titled(title)).find((e) => e.id === ev.id)?.end).toBe(at(12 * 60 + 30))
    await expectNoNotice(page)
    // An Alt copy a quarter on: 11:30, same length.
    await dragChip(page, panel, chip, { hours: 0.25 }, { alt: true })
    await drop(page, { alt: true })
    await expect.poll(async () => (await titled(title)).length).toBe(2)
    expect((await titled(title)).find((e) => e.id !== ev.id)).toMatchObject({ start: at(11 * 60 + 30), end: at(12 * 60 + 45) })
    await expectNoNotice(page)
    // The key still takes the copy back, with nothing said either.
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await titled(title)).length).toBe(1)
    await expectNoNotice(page)
  } finally {
    await cleanupTitled(title)
  }
})

test('a load the server refuses says so in the panel, then loads by itself', async ({ page }) => {
  const title = `Load retry ${Date.now()}`
  await createEvent(title, `${today}T18:00:00`, `${today}T18:30:00`)
  try {
    // A server restart: the calendar plugin answers 503 for its first seconds.
    let refused = 0
    await page.route('**/api/calendar/events?*', async (route) => {
      if (route.request().method() === 'GET' && refused < 2) {
        refused += 1
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'plugin_starting' }) })
        return
      }
      await route.continue()
    })
    const panel = await openPanel(page)
    await expect(panel.getByTestId('cal-alert')).toContainText('did not load')
    // Nobody clicks Retry: it comes back by itself (2 s, then 5 s).
    await expect(panel.locator(`.cal-chip:has-text("${title}")`)).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByTestId('cal-alert')).toHaveCount(0)
    expect(refused).toBe(2)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await cleanupTitled(title)
  }
})
