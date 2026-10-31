/**
 * Where a time sits on the calendar's time grid, read from the grid itself.
 *
 * The grid fits the day to the window and has a zoom (416945b31, 2026-10-13), so an
 * hour is `--cal-hour-px` tall (TimeGrid.tsx), not a fixed 48 px, and the grid starts
 * at its `data-start-minute`. Specs that clicked
 * `hour * 48` px down a day column landed hours late: on a 30 px grid "2 PM" was a
 * click near 11 PM, on whatever event a test had put there (quick-task-composer.spec.ts,
 * 2026-10-31: the item popover opened instead of the create popover).
 * tests/scripts/browser-spec-ratchets.test.ts keeps the fixed 48 out of the specs.
 */
import type { Locator, Page } from '@playwright/test'

/** The pixel height of one hour on the time grid inside `scope`. */
export async function calendarHourPx(scope: Page | Locator): Promise<number> {
  const px = await scope.locator('.cal-grid').first().evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--cal-hour-px')))
  if (!Number.isFinite(px) || px <= 0) throw new Error(`the time grid has no --cal-hour-px (read ${px})`)
  return px
}

/**
 * Scroll the grid so `hour:minute` of `day` is in view and return the point just
 * below that time in the day's column, in viewport coordinates (a mouse target).
 */
export async function calendarSlotPoint(
  scope: Page | Locator,
  day: string,
  hour: number,
  minute = 0,
): Promise<{ x: number; y: number }> {
  const hourPx = await calendarHourPx(scope)
  // The grid may start later than midnight ("Show 7 AM to 1 AM"): its first minute is on the element.
  const startMinute = Number(await scope.locator('.cal-grid').first().getAttribute('data-start-minute')) || 0
  const offset = ((hour * 60 + minute - startMinute) / 60) * hourPx
  await scope.locator('.cal-grid-scroll').first().evaluate((el, y) => { el.scrollTop = y - el.clientHeight / 2 }, offset)
  const box = await scope.locator(`.cal-day-col[data-day="${day}"]`).first().boundingBox()
  if (!box) throw new Error(`day column ${day} not visible`)
  return { x: box.x + box.width / 2, y: box.y + offset + 1 }
}

/**
 * The first half hour of `day`, from `fromHour` on, where a click lands on the empty
 * column and not on a chip. Every spec shares one fixture server, and today's column
 * fills with the tasks and events other specs scheduled there (2026-10-31: a 2 PM click
 * opened another spec's "CalSlotCreate" task), so a spec that only needs AN empty slot
 * asks for one instead of naming a time.
 */
export async function calendarEmptySlotPoint(
  scope: Page | Locator,
  day: string,
  fromHour = 14,
): Promise<{ x: number; y: number; hour: number; minute: number }> {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page)
  for (let step = 0; step < 48; step++) {
    const at = (fromHour * 60 + step * 30) % (24 * 60)
    const hour = Math.floor(at / 60)
    const minute = at % 60
    // Five past: a press there rounds to this half hour's start (TimeGrid snaps to
    // 15 minutes, then the create to the nearest 30), clear of the line above it.
    const p = await calendarSlotPoint(scope, day, hour, minute + 5)
    // The whole half hour must be empty, not only the point pressed: 20 minutes on.
    const later = p.y + (20 / 60) * (await calendarHourPx(scope))
    const free = await page.evaluate(({ x, ys, d }) => ys.every((y) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit && !hit.closest('.cal-chip') && hit.closest('.cal-day-col')?.getAttribute('data-day') === d
    }), { x: p.x, ys: [p.y, later], d: day })
    if (free) return { ...p, hour, minute }
  }
  throw new Error(`no empty half hour in ${day}`)
}
