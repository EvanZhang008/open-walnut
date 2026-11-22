/**
 * Where a time sits on the calendar's time grid, read from the grid itself.
 *
 * The grid fits the day to the window and has a zoom (416945b31, 2026-10-13), so an
 * hour is `--cal-hour-px` tall (TimeGrid.tsx), not a fixed 48 px, and the grid starts
 * at its `data-start-minute`. Specs that clicked
 * `hour * 48` px down a day column landed hours late: on a 30 px grid "2 PM" was a
 * click near 11 PM, on whatever event a test had put there (quick-task-composer.spec.ts,
 * 2026-10-31: the item popover opened instead of the create popover).
 * tests/scripts/calendar-spec-ratchets.test.ts keeps the fixed 48 out of the specs.
 */
import { expect, type Locator, type Page } from '@playwright/test'

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
  // The grid may start later than midnight (7 AM to 1 AM, the "24 hours" toggle off): its first minute is on the element.
  const startMinute = Number(await scope.locator('.cal-grid').first().getAttribute('data-start-minute')) || 0
  const offset = ((hour * 60 + minute - startMinute) / 60) * hourPx
  await scope.locator('.cal-grid-scroll').first().evaluate((el, y) => { el.scrollTop = y - el.clientHeight / 2 }, offset)
  const col = scope.locator(`.cal-day-col[data-day="${day}"]`).first()
  // A day outside the shown range has no column, and boundingBox() would wait out the test.
  if (!(await col.count())) {
    const shown = await scope.locator('.cal-day-col').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day))
    throw new Error(`day column ${day} is not on the grid (it shows ${shown.join(', ')})`)
  }
  const box = await col.boundingBox()
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
    // Five past: a press there rounds to this half hour's start (the grid snaps every
    // pointer time to 15 minutes), clear of the line above it.
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

/**
 * Switch the calendar's open new-item popover to its Task side and return the task
 * composer in it. The popover opens on Event and keeps the side picked last
 * (6974c18ae4, usePageView calendar.createKind), so a spec about the task composer
 * picks Task itself, whatever an earlier spec left. Two specs that read the composer
 * right after the slot click failed on every run once Event became the default
 * (private-tasks, voice-field-commit, 2026-11-17); tests/scripts/calendar-spec-ratchets.test.ts
 * keeps every spec that creates a task from the popover on this helper.
 */
export async function pickCalendarTaskSide(page: Page): Promise<Locator> {
  const popover = page.locator('.cal-create-popover')
  const task = popover.getByRole('radio', { name: 'Task', exact: true })
  await task.click()
  await expect(task).toHaveAttribute('aria-checked', 'true')
  const composer = popover.locator('.quick-task-composer')
  await expect(composer).toBeVisible()
  return composer
}

/** Click an empty half hour of `day` (from `fromHour` on) and open the popover's Task side. */
export async function openCalendarTaskCreator(
  page: Page,
  day: string,
  fromHour?: number,
): Promise<{ composer: Locator; slot: { x: number; y: number; hour: number; minute: number } }> {
  const slot = await calendarEmptySlotPoint(page, day, fromHour)
  await page.mouse.click(slot.x, slot.y)
  return { composer: await pickCalendarTaskSide(page), slot }
}

// ── The fixture server's calendar, and the keys and drags of a person on the grid ──

export const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

export interface Ev { id: string; title: string; start: string; end: string; calendarId: string; hasAttendees?: boolean; walnutCreated?: boolean; color?: string }

export function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const today = localDay()

export async function events(from = localDay(-7), to = localDay(7)): Promise<Ev[]> {
  const res = await fetch(`${API}/api/calendar/events?from=${from}&to=${to}`)
  expect(res.ok).toBe(true)
  return ((await res.json()) as { events: Ev[] }).events
}
export async function eventById(id: string): Promise<Ev | undefined> {
  return (await events()).find((e) => e.id === id)
}
export async function titled(title: string): Promise<Ev[]> {
  return (await events()).filter((e) => e.title === title)
}
export async function createEvent(title: string, start: string, end: string): Promise<Ev> {
  const res = await fetch(`${API}/api/calendar/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId: 'cal-home', title, start, end }),
  })
  expect(res.status).toBeLessThan(300)
  return ((await res.json()) as { event: Ev }).event
}
export async function deleteEvent(id: string): Promise<void> {
  await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export async function cleanupTitled(title: string): Promise<void> {
  for (const e of await titled(title)) await deleteEvent(e.id)
}

/** The page's own idea of the platform, which decides its undo keys (undo-key.ts). */
export async function modKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    return /mac|iphone|ipad/i.test(ua?.platform ?? navigator.platform ?? navigator.userAgent ?? '') ? 'Meta' : 'Control'
  })
}
export async function undo(page: Page) { await page.keyboard.press(`${await modKey(page)}+z`) }
export async function redo(page: Page) { await page.keyboard.press(`${await modKey(page)}+Shift+z`) }

export async function openPanel(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.getByTestId('sidebar-toggle-calendar').click()
  const panel = page.getByTestId('cal-side-panel')
  await expect(panel.locator('.cal-grid')).toBeVisible()
  return panel
}

/** The tint a block is drawn in, resolved by the browser (a var() becomes its value). */
export async function tintOf(el: Locator): Promise<string> {
  return el.evaluate((node) => getComputedStyle(node).getPropertyValue('--cal-chip-tint').trim().toLowerCase())
}

/** No notice is up (a calendar change the person sees in place says nothing more), checked
 *  for a moment so one that comes late is caught too. */
export async function expectNoNotice(page: Page) {
  for (let i = 0; i < 4; i++) {
    await expect(page.locator('[data-testid="notification-toast"]')).toHaveCount(0)
    await page.waitForTimeout(150)
  }
}


/** Press on a chip's top and carry it `hours` later (onto `day`'s column when given), holding
 *  Alt when `alt`; returns before the release. Measured from the chip itself, so a scroll the
 *  chip needed cannot move the target. */
export async function dragChip(page: Page, scope: Locator, chip: Locator, move: { hours: number; day?: string }, opts: { alt?: boolean } = {}) {
  // After an Undo the chip is drawn again where it went back to: wait until it holds still there.
  let box = { x: 0, y: 0, width: 0, height: 0 }
  await expect(async () => {
    await chip.scrollIntoViewIfNeeded({ timeout: 2_000 })
    const a = (await chip.boundingBox())!
    await page.waitForTimeout(150)
    const b = (await chip.boundingBox())!
    expect(b).toEqual(a)
    box = b
  }).toPass({ timeout: 10_000 })
  const hourPx = await calendarHourPx(scope)
  let x = box.x + box.width / 2
  if (move.day) {
    const col = (await scope.locator(`.cal-day-col[data-day="${move.day}"]`).first().boundingBox())!
    x = col.x + col.width / 2
  }
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2, box.y + 4)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 4 + move.hours * hourPx, { steps: 10 })
}

/** Nothing focused, as after a click on the page itself: mod+Z is the app's, not a field's. */
export async function blurFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}
export async function drop(page: Page, opts: { alt?: boolean } = {}) {
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}

