/**
 * Playwright E2E for the Calendar view (/calendar): navigation, view
 * switching, drag-a-task-onto-the-grid (start_date writes), chip moves,
 * drag-to-create, month overflow, and the homepage day-agenda panel.
 *
 * All drags are real pointer sequences (mouse.down/move/up) through the same
 * code paths a human uses — no page.goto for SPA nav (real sidebar clicks).
 */
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function createTaskViaApi(
  title: string,
  opts: Record<string, string> = {},
): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function getTaskViaApi(id: string): Promise<{ start_date?: string; due_date?: string }> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  if (!res.ok) throw new Error(`GET task failed: ${res.status}`)
  const body = (await res.json()) as { task: { start_date?: string; due_date?: string } }
  return body.task
}

/** Local YYYY-MM-DD for today / +offset days. */
function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function openCalendar(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
}

/**
 * Viewport point inside a day column at a given hour (SLOT_PX=24 → 48px/hour).
 * boundingBox() is already in viewport coords (reflects scroll), so the hour
 * offset is added to it directly — no scrollTop arithmetic.
 */
async function columnPoint(
  page: Page,
  day: string,
  hour: number,
  scope?: ReturnType<Page['locator']>,
): Promise<{ x: number; y: number }> {
  const root = scope ?? page.locator('body')
  // Scroll the grid so the target hour is in view before measuring.
  await root.locator('.cal-grid-scroll').evaluate((el, h) => {
    el.scrollTop = h * 48 - el.clientHeight / 2
  }, hour)
  const box = await root.locator(`.cal-day-col[data-day="${day}"]`).boundingBox()
  if (!box) throw new Error(`day column ${day} not visible`)
  return { x: box.x + box.width / 2, y: box.y + hour * 48 + 1 }
}

test.describe('Calendar view', () => {
  test('sidebar navigation opens week view with URL state', async ({ page }) => {
    await openCalendar(page)
    await expect(page).toHaveURL(/\/calendar/)
    // Default view = week; toolbar shows segmented control with Week active
    await expect(page.locator('.cal-view-btn.active')).toHaveText('Week')
    await expect(page.locator('.cal-grid[data-days="7"]')).toBeVisible()
  })

  test('view switching + Today/prev/next update the URL', async ({ page }) => {
    await openCalendar(page)

    await page.click('.cal-view-btn:has-text("Month")')
    await expect(page).toHaveURL(/view=month/)
    await expect(page.locator('.cal-month-grid')).toBeVisible()

    await page.click('.cal-view-btn:has-text("Day")')
    await expect(page).toHaveURL(/view=day/)
    await expect(page.locator('.cal-grid[data-days="1"]')).toBeVisible()

    // prev then Today: URL day param changes then returns to today
    await page.click('.cal-nav-btns button[aria-label="Previous"]')
    await expect(page).toHaveURL(new RegExp(`d=${localDay(-1)}`))
    await page.click('.cal-today-btn')
    await expect(page).toHaveURL(new RegExp(`d=${localDay(0)}`))
  })

  test('drag rail task onto a time slot writes a timed start_date', async ({ page }) => {
    const task = await createTaskViaApi('CalDragTimed')
    await openCalendar(page)

    const row = page.locator(`.cal-rail-row[data-task-id="${task.id}"]`)
    await row.scrollIntoViewIfNeeded()
    const rowBox = await row.boundingBox()
    if (!rowBox) throw new Error('rail row not visible')

    const today = localDay(0)
    const target = await columnPoint(page, today, 9)

    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    // dnd-kit PointerSensor needs >5px travel to activate; step through
    await page.mouse.move(target.x, target.y, { steps: 12 })
    // drop preview line appears over the column
    await expect(page.locator('.cal-drop-line')).toBeVisible()
    await page.mouse.up()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toMatch(new RegExp(`^${today}T\\d{2}:\\d{2}:00$`))

    // The chip now renders on the grid
    await expect(page.locator(`.cal-day-col .cal-chip[data-item-id="task-start:${task.id}"]`)).toBeVisible()
  })

  test('drag chip within the grid moves start_date; all-day drop strips time', async ({ page }) => {
    const today = localDay(0)
    // 05:00, away from the other tests' 9-14h chips — overlapping chips share
    // lanes (half-width), which shifts bounding boxes when a parallel test
    // drops a chip into the same slot mid-measure.
    const task = await createTaskViaApi('CalChipMove', { start_date: `${today}T05:00:00` })
    await openCalendar(page)

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()
    let box = await chip.boundingBox()
    if (!box) throw new Error('chip not visible')

    // Move down 2 hours (96px) → 07:00
    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + 96, { steps: 10 })
    // Mid-drag: the solid ghost tracks the pointer and carries the title
    await expect(page.locator('.cal-move-ghost-solid')).toBeVisible()
    await expect(page.locator('.cal-move-ghost-solid .cal-move-ghost-title')).toContainText('CalChipMove')
    await page.mouse.up()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(`${today}T07:00:00`)

    // Now drag into the all-day row → date-only
    await chip.scrollIntoViewIfNeeded()
    box = await chip.boundingBox()
    if (!box) throw new Error('chip not visible after move')
    const allday = await page.locator(`.cal-allday-cell[data-day="${today}"]`).boundingBox()
    if (!allday) throw new Error('all-day cell not visible')

    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(allday.x + allday.width / 2, allday.y + allday.height / 2, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(today)
  })

  test('Escape cancels a chip drag without writing', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalEscCancel', { start_date: `${today}T09:00:00` })
    await openCalendar(page)

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await expect(chip).toBeVisible()
    const box = await chip.boundingBox()
    if (!box) throw new Error('chip not visible')

    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    // give any (wrong) PATCH a moment to land, then assert unchanged
    await page.waitForTimeout(800)
    expect((await getTaskViaApi(task.id)).start_date).toBe(`${today}T09:00:00`)
  })

  test('click empty slot opens quick-create seeded with slot time', async ({ page }) => {
    await openCalendar(page)
    const today = localDay(0)
    const point = await columnPoint(page, today, 14)

    await page.mouse.click(point.x, point.y)
    const composer = page.locator('.cal-create-popover .quick-task-composer')
    await expect(composer).toBeVisible()

    const title = `CalSlotCreate ${Date.now()}`
    await composer.locator('.qtc-input').fill(title)
    // Single-panel composer: the form mirrors the sentence live and the slot's
    // time pre-fills Start — Enter creates immediately, no confirm stage.
    await composer.locator('.qtc-input').press('Enter')

    // Task exists with the seeded 14:00 start
    await expect
      .poll(async () => {
        const res = await fetch(`${API}/api/tasks?fields=list`)
        const body = (await res.json()) as { tasks: Array<{ title: string; start_date?: string }> }
        return body.tasks.find((t) => t.title === title)?.start_date
      }, { timeout: 10_000 })
      .toBe(`${today}T14:00:00`)
  })

  test('month cell with >3 items shows +N more popover', async ({ page }) => {
    const day = localDay(7) // next week, same month most of the time — use the URL to navigate anyway
    for (let i = 0; i < 5; i++) {
      await createTaskViaApi(`CalOverflow${i}`, { start_date: day })
    }
    await openCalendar(page)
    await page.click('.cal-view-btn:has-text("Month")')
    await expect(page.locator('.cal-month-grid')).toBeVisible()
    // Navigate months until the target day is on the grid (handles month boundary)
    for (let hop = 0; hop < 2 && !(await page.locator(`.cal-month-cell[data-day="${day}"]`).count()); hop++) {
      await page.click('.cal-nav-btns button[aria-label="Next"]')
      await page.waitForTimeout(200)
    }
    const cell = page.locator(`.cal-month-cell[data-day="${day}"]`)
    await expect(cell.locator('.cal-month-more')).toBeVisible()
    await cell.locator('.cal-month-more').click()
    const popover = page.locator('.cal-overflow-popover')
    await expect(popover).toBeVisible()
    expect(await popover.locator('.cal-chip').count()).toBeGreaterThanOrEqual(5)
  })

  // ── Phase 2: external calendar events (mock EventKit source in test-server) ──

  async function getEventViaApi(id: string): Promise<{ start: string; end: string } | undefined> {
    const today = localDay(0)
    const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    if (!res.ok) throw new Error(`GET events failed: ${res.status}`)
    const body = (await res.json()) as { events: Array<{ id: string; start: string; end: string }> }
    return body.events.find((e) => e.id === id)
  }

  test('event chips render: timed chip on the grid, readonly all-day chip in the all-day row', async ({ page }) => {
    await openCalendar(page)
    const chip = page.locator('.cal-day-col .cal-chip[data-item-id="event:ev-e2e-brief"]')
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('Morning brief')
    // readonly holiday renders in the all-day row
    await expect(page.locator('.cal-grid-allday .cal-chip[data-item-id="event:ev-e2e-holiday"]')).toBeVisible()
  })

  test('drag event chip moves it and persists through PATCH (duration kept)', async ({ page }) => {
    await openCalendar(page)
    const chip = page.locator('.cal-day-col .cal-chip[data-item-id="event:ev-e2e-brief"]')
    await chip.scrollIntoViewIfNeeded()
    const box = await chip.boundingBox()
    if (!box) throw new Error('event chip not visible')

    // down 2 hours (96px): 06:00 → 08:00, 30-min duration preserved
    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + 96, { steps: 10 })
    await page.mouse.up()

    const today = localDay(0)
    await expect
      .poll(async () => (await getEventViaApi('ev-e2e-brief'))?.start, { timeout: 5000 })
      .toBe(`${today}T08:00:00`)
    expect((await getEventViaApi('ev-e2e-brief'))?.end).toBe(`${today}T08:30:00`)
  })

  test('resize event chip bottom edge extends its end', async ({ page }) => {
    await openCalendar(page)
    // Own fixture event (ev-e2e-review, 03:00–03:30) — the move spec mutates
    // ev-e2e-brief in parallel.
    const chip = page.locator('.cal-day-col .cal-chip[data-item-id="event:ev-e2e-review"]')
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()
    const handle = chip.locator('.cal-chip-resize-handle')
    const hbox = await handle.boundingBox()
    if (!hbox) throw new Error('resize handle not visible')

    // pull the bottom edge down one hour (48px): 03:30 → ~04:30
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2)
    await page.mouse.down()
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2 + 48, { steps: 8 })
    await page.mouse.up()

    await expect
      .poll(async () => (await getEventViaApi('ev-e2e-review'))?.end, { timeout: 5000 })
      .toBe(`${localDay(0)}T04:30:00`)
    // start untouched by a resize
    expect((await getEventViaApi('ev-e2e-review'))?.start).toBe(`${localDay(0)}T03:00:00`)
  })

  test('Event tab in quick-create posts a new event to a writable calendar', async ({ page }) => {
    await openCalendar(page)
    const today = localDay(0)
    const point = await columnPoint(page, today, 15)
    await page.mouse.click(point.x, point.y)

    const popover = page.locator('.cal-create-popover')
    await expect(popover).toBeVisible()
    await popover.locator('.cal-create-tabs button:has-text("Event")').click()

    const title = `CalEvtCreate ${Date.now()}`
    const input = popover.locator('.cal-event-form-title')
    await input.fill(title)
    // writable-calendar select is populated from /api/calendar/sources
    await expect(popover.locator('select')).toBeEnabled()
    await popover.locator('.cal-event-form-create').click()

    await expect
      .poll(async () => {
        const res = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
        const body = (await res.json()) as { events: Array<{ title: string; start: string }> }
        return body.events.find((e) => e.title === title)?.start
      }, { timeout: 10_000 })
      .toBe(`${today}T15:00:00`)

    // the new chip appears live (calendar:updated push, no reload)
    await expect(page.locator(`.cal-chip:has-text("${title}")`).first()).toBeVisible()
  })

  test('toolbar Calendars popover toggles per-calendar visibility live', async ({ page }) => {
    await openCalendar(page)
    // ev-e2e-errand rides the dedicated "Personal" calendar so this toggle
    // can't break parallel specs asserting on cal-work chips.
    const chip = page.locator('.cal-day-col .cal-chip[data-item-id="event:ev-e2e-errand"]')
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()

    await page.click('[data-testid="cal-cals-btn"]')
    const popover = page.locator('[data-testid="cal-cals-popover"]')
    await expect(popover).toBeVisible()

    const row = popover.locator('.cal-cals-row', { hasText: 'Personal' })
    await row.locator('input[type="checkbox"]').uncheck()
    await expect(chip).toHaveCount(0, { timeout: 5000 })

    // Re-check → chips come back (no reload, cache kept the events)
    await row.locator('input[type="checkbox"]').check()
    await expect(page.locator('.cal-day-col .cal-chip[data-item-id="event:ev-e2e-errand"]')).toBeVisible({ timeout: 5000 })
    await page.locator('.cal-popover-backdrop').click()
  })

  test('right-click on a task chip offers Unschedule (clears start_date)', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalCtxUnschedule', { start_date: `${today}T02:00:00` })
    await openCalendar(page)

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()
    await chip.click({ button: 'right' })

    const menu = page.locator('[data-testid="cal-ctx-menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('button:has-text("Unschedule")').click()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date ?? null, { timeout: 5000 })
      .toBeNull()
    await expect(chip).toHaveCount(0)
  })

  test('right-click on an empty slot offers New task / New event', async ({ page }) => {
    await openCalendar(page)
    const today = localDay(0)
    const point = await columnPoint(page, today, 22)
    await page.mouse.click(point.x, point.y, { button: 'right' })

    const menu = page.locator('[data-testid="cal-ctx-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('button:has-text("New task…")')).toBeVisible()
    // Writable mock source is connected → event creation offered
    await menu.locator('button:has-text("New event…")').click()

    // Straight to the Event tab of the quick-create popover; the slot time
    // seeds the (now editable) start-time input
    const form = page.locator('.cal-create-popover .cal-event-form')
    await expect(form).toBeVisible()
    await expect(form.locator('input[aria-label="Start time"]')).toHaveValue('22:00')
    await page.keyboard.press('Escape')
  })

  test('clicking a task chip opens the item popover (not the task page) and can retime it', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalItemPopover', { start_date: `${today}T04:00:00` })
    await openCalendar(page)

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()

    // Still on /calendar — the click opens the popover instead of navigating
    await expect(page).toHaveURL(/\/calendar/)
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText('CalItemPopover')
    await expect(popover.locator('button:has-text("Open task")')).toBeVisible()

    // Change the time to 06:30 and save
    await popover.locator('input[type="time"]').first().fill('06:30')
    await popover.locator('.cal-item-save').click()
    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(`${today}T06:30:00`)
  })

  test('clicking an event chip opens an editable popover; saving PATCHes the event', async ({ page }) => {
    // Own throwaway event — parallel specs must not see this one move
    const today = localDay(0)
    const created = await fetch(`${API}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-home',
        title: `CalEvtPopover ${Date.now()}`,
        start: `${today}T20:00:00`,
        end: `${today}T20:30:00`,
      }),
    })
    const { event } = (await created.json()) as { event: { id: string } }

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()

    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText('Home · iCloud')

    // Rename + retime end to 21:15
    await popover.locator('.cal-item-title').fill('Renamed by popover')
    await popover.locator('input[type="time"]').nth(1).fill('21:15')
    await popover.locator('.cal-item-save').click()

    await expect
      .poll(async () => (await getEventViaApi(event.id))?.end, { timeout: 5000 })
      .toBe(`${today}T21:15:00`)
    const evAfter = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    const body = (await evAfter.json()) as { events: Array<{ id: string; title: string }> }
    expect(body.events.find((e) => e.id === event.id)?.title).toBe('Renamed by popover')
  })

  test('right-click on a writable event chip offers Delete event', async ({ page }) => {
    // Create a throwaway event via API so deleting it doesn't race other specs
    const today = localDay(0)
    const created = await fetch(`${API}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-work',
        title: `CalCtxDelete ${Date.now()}`,
        start: `${today}T23:00:00`,
        end: `${today}T23:30:00`,
      }),
    })
    const { event } = (await created.json()) as { event: { id: string } }

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeVisible()
    await chip.click({ button: 'right' })

    const menu = page.locator('[data-testid="cal-ctx-menu"]')
    await expect(menu).toBeVisible()
    // Two-step confirm: deleting writes through to the real calendar, so the
    // first click only arms the button.
    await menu.locator('button:has-text("Delete event")').click()
    await menu.locator('button:has-text("Delete — are you sure?")').click()

    await expect
      .poll(async () => (await getEventViaApi(event.id)) === undefined, { timeout: 5000 })
      .toBe(true)
    await expect(chip).toHaveCount(0)
  })

  test('event popover keeps Save reachable while editing times (no overflow)', async ({ page }) => {
    // Regression: date + start + end on one 300px row overflowed 84px; typing in
    // the end-time input auto-scrolled the popover and pushed Save fully outside
    // the hit-testable area — the click landed on the backdrop and the edit was
    // silently discarded (zero PATCH).
    const today = localDay(0)
    const created = await fetch(`${API}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-home',
        title: `CalPopoverOverflow ${Date.now()}`,
        start: `${today}T19:00:00`,
        end: `${today}T19:30:00`,
      }),
    })
    const { event } = (await created.json()) as { event: { id: string } }

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()

    // No horizontal overflow anywhere in the popover
    const overflow = await popover.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    // Focus + type in BOTH time inputs (the trigger for the auto-scroll bug),
    // then verify Save is still the element at its own centre point. Start
    // first: editing start shifts end to preserve duration (macOS Calendar
    // behavior), so the explicit end edit must come after.
    await popover.locator('input[type="time"]').nth(0).click()
    await popover.locator('input[type="time"]').nth(0).fill('20:00')
    await popover.locator('input[type="time"]').nth(1).click()
    await popover.locator('input[type="time"]').nth(1).fill('20:45')
    const saveHittable = await popover.locator('.cal-item-save').evaluate((btn) => {
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return btn === hit || btn.contains(hit)
    })
    expect(saveHittable).toBe(true)

    await popover.locator('.cal-item-save').click()
    await expect
      .poll(async () => {
        const ev = await getEventViaApi(event.id)
        return `${ev?.start}|${ev?.end}`
      }, { timeout: 5000 })
      .toBe(`${today}T20:00:00|${today}T20:45:00`)
    // cleanup so other runs' weeks stay tidy
    await fetch(`${API}/api/calendar/events/${event.id}`, { method: 'DELETE' })
  })

  test('editing a timed event date shifts the end date too (stays valid)', async ({ page }) => {
    // Regression: endDate was seeded at mount and never re-synced, so picking a
    // later day made end < start → permanently invalid, date un-editable.
    const today = localDay(0)
    const tomorrow = localDay(1)
    const created = await fetch(`${API}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-home',
        title: `CalDateShift ${Date.now()}`,
        start: `${today}T18:00:00`,
        end: `${today}T18:30:00`,
      }),
    })
    const { event } = (await created.json()) as { event: { id: string } }

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()

    // Clear first (fires change with ''), then retype — the transient empty
    // once poisoned the delta base and stranded the popover invalid forever.
    await popover.locator('input[type="date"]').fill('')
    await popover.locator('input[type="date"]').fill(tomorrow)
    await expect(popover.locator('.cal-item-error')).toHaveCount(0)
    const saveBtn = popover.locator('.cal-item-save')
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()

    await expect
      .poll(async () => {
        const res = await fetch(`${API}/api/calendar/events?from=${tomorrow}&to=${tomorrow}`)
        const body = (await res.json()) as { events: Array<{ id: string; start: string; end: string }> }
        const ev = body.events.find((e) => e.id === event.id)
        return ev ? `${ev.start}|${ev.end}` : undefined
      }, { timeout: 5000 })
      .toBe(`${tomorrow}T18:00:00|${tomorrow}T18:30:00`)
    await fetch(`${API}/api/calendar/events/${event.id}`, { method: 'DELETE' })
  })

  test('Escape closes the item popover even when nothing inside is focused', async ({ page }) => {
    // Regression: Escape was bound via onKeyDown on the popover div, so task
    // popovers (static title, no autofocus) never saw the key — backdrop click
    // was the only way out.
    const today = localDay(0)
    const task = await createTaskViaApi('CalEscClose', { start_date: `${today}T17:00:00` })

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
  })

  test('quick-create shows the Event tab even while the events fetch is slow', async ({ page }) => {
    // Regression: canCreateEvent derived only from the RESOLVED events response,
    // so a quick-create opened during a slow first load had no tab bar at all —
    // the reported "can't select Event". The gate is now optimistic while loading.
    await page.route('**/api/calendar/events*', async (route) => {
      await new Promise((r) => setTimeout(r, 3000))
      await route.continue()
    })
    await openCalendar(page)
    // Click an empty slot immediately — before the delayed events fetch lands.
    const point = await columnPoint(page, localDay(0), 22)
    await page.mouse.click(point.x, point.y)
    const tabs = page.locator('.cal-create-popover .cal-create-tabs')
    await expect(tabs).toBeVisible({ timeout: 2000 })
    await tabs.locator('button:has-text("Event")').click()
    // Popover must survive the tab click and show the event form.
    await expect(page.locator('.cal-create-popover input.cal-event-form-title')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('quick-create falls back to the Task tab when sources settle unwritable', async ({ page }) => {
    // Regression: the optimistic Event tab had no settle path — when the
    // delayed sources resolved to "no writable calendar" while the user sat on
    // the Event tab, the tab bar unmounted but the dead form stayed, and
    // Create surfaced a raw "onCreateEvent is not a function".
    await page.route('**/api/calendar/events*', async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [],
          sources: [{ id: 'eventkit', available: false, enabled: false, reason: 'not-configured' }],
        }),
      })
    })
    await openCalendar(page)
    const point = await columnPoint(page, localDay(0), 21)
    await page.mouse.click(point.x, point.y)
    const popover = page.locator('.cal-create-popover')
    await popover.locator('.cal-create-tabs button:has-text("Event")').click()
    await expect(popover.locator('input.cal-event-form-title')).toBeVisible()

    // Delayed unwritable sources land → auto-fallback to the Task tab.
    await expect(popover.locator('.quick-task-composer')).toBeVisible({ timeout: 5000 })
    await expect(popover.locator('input.cal-event-form-title')).toHaveCount(0)
    await expect(popover.locator('.cal-event-form-error')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('rail drop lands at the visually targeted hour on a scrolled grid', async ({ page }) => {
    // Regression (customer-journey BLOCKER): with the grid scrolled, dnd-kit's
    // activatorEvent+delta drifted by the scroll offset — a drop at visual 9:00
    // stored 10:30+ and the drop line rendered away from the cursor. The fix
    // tracks the live pointer, so the stored hour must equal the targeted one.
    const task = await createTaskViaApi('CalScrolledDrop')
    await openCalendar(page)

    const row = page.locator(`.cal-rail-row[data-task-id="${task.id}"]`)
    await row.scrollIntoViewIfNeeded()
    const rowBox = await row.boundingBox()
    if (!rowBox) throw new Error('rail row not visible')

    const today = localDay(0)
    // columnPoint scrolls the grid so hour 6 is centered (scrollTop far from
    // the mount auto-scroll) and returns the VISUAL point for 06:00.
    const target = await columnPoint(page, today, 6)

    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 12 })
    await expect(page.locator('.cal-drop-line')).toBeVisible()
    // The preview label must agree with the visual target too
    await expect(page.locator('.cal-drop-time')).toHaveText(/6:00/)
    await page.mouse.up()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(`${today}T06:00:00`)
  })

  test('event quick-create honors an edited end time', async ({ page }) => {
    // Regression (customer-journey MAJOR): the form had no end-time control —
    // every new event was silently forced to slot+1h.
    await openCalendar(page)
    // Tomorrow 11:00 — today 15:00 belongs to the parallel Event-tab spec,
    // whose freshly created chip would swallow this click (item popover
    // instead of the create form).
    const day = localDay(1)
    const point = await columnPoint(page, day, 11)
    await page.mouse.click(point.x, point.y)

    const popover = page.locator('.cal-create-popover')
    await expect(popover).toBeVisible()
    await popover.locator('.cal-create-tabs button:has-text("Event")').click()

    const title = `CalEvtEndTime ${Date.now()}`
    await popover.locator('.cal-event-form-title').fill(title)
    const end = popover.locator('input[aria-label="End time"]')
    await expect(end).toHaveValue('12:00') // default = slot + 1h
    await end.fill('13:30')
    await expect(popover.locator('select')).toBeEnabled()
    await popover.locator('.cal-event-form-create').click()

    await expect
      .poll(async () => {
        const res = await fetch(`${API}/api/calendar/events?from=${day}&to=${day}`)
        const body = (await res.json()) as { events: Array<{ title: string; start: string; end: string }> }
        const ev = body.events.find((e) => e.title === title)
        return ev ? `${ev.start}|${ev.end}` : undefined
      }, { timeout: 10_000 })
      .toBe(`${day}T11:00:00|${day}T13:30:00`)
  })

  test('leading-zero start retype keeps duration on a cross-midnight event', async ({ page }) => {
    // Regression (round-3 blocker): typing "0800PM" into the start input emits
    // a transient '' keystroke; the mid-correction guard treated the blank as
    // "invalid, skip the shift" and never re-armed — a 23:00→01:00 (2h) event
    // silently saved as 20:00→01:00 (5h). The guard now only skips on a REAL
    // parseable end<=start misorder.
    const today = localDay(0)
    const tomorrow = localDay(1)
    const created = await fetch(`${API}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-work',
        title: `CalXmid ${Date.now()}`,
        start: `${today}T23:00:00`,
        end: `${tomorrow}T01:00:00`,
      }),
    })
    const { event } = (await created.json()) as { event: { id: string } }

    await openCalendar(page)
    const chip = page.locator(`.cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()

    // Type the hour with a LEADING ZERO — per-keystroke input events (which
    // fill() skips) reproduce the transient '' emission. Click the HOUR
    // segment (left edge); a center click lands on the minutes.
    const start = popover.locator('input[type="time"]').nth(0)
    await start.click({ position: { x: 8, y: 10 } })
    await start.pressSequentially('0800PM')
    // End must have shifted with the 2h duration: 20:00 + 2h = 22:00 same day
    await expect(popover.locator('input[type="time"]').nth(1)).toHaveValue('22:00')
    await popover.locator('.cal-item-save').click()
    await expect
      .poll(async () => {
        const ev = await getEventViaApi(event.id)
        return `${ev?.start}|${ev?.end}`
      }, { timeout: 5000 })
      .toBe(`${today}T20:00:00|${today}T22:00:00`)
    await fetch(`${API}/api/calendar/events/${event.id}`, { method: 'DELETE' })
  })

  test('late-night slot seeds a valid range; cleared time input blocks Create', async ({ page }) => {
    // Regression 1: 23:00 slots seeded end = "hour clamped to 23, same minute"
    // → a zero-length 23:00–23:00 range, form pre-broken with an error the
    // user never caused. Now the end clamps to 23:59.
    await openCalendar(page)
    const day = localDay(2)
    const point = await columnPoint(page, day, 23)
    await page.mouse.click(point.x, point.y)
    const popover = page.locator('.cal-create-popover')
    await expect(popover).toBeVisible()
    await popover.locator('.cal-create-tabs button:has-text("Event")').click()
    await expect(popover.locator('input[aria-label="Start time"]')).toHaveValue('23:00')
    await expect(popover.locator('input[aria-label="End time"]')).toHaveValue('23:59')
    await expect(popover.locator('.cal-event-form-error')).toHaveCount(0)

    // Regression 2: Backspace-clearing a time input left Create ENABLED and
    // POSTed a malformed '<day>T:00' → raw server 400 in the form.
    await popover.locator('.cal-event-form-title').fill('CalLateNight probe')
    await popover.locator('input[aria-label="Start time"]').press('ControlOrMeta+a')
    await popover.locator('input[aria-label="Start time"]').press('Backspace')
    await expect(popover.locator('.cal-event-form-create')).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  test('double-clicking an empty slot or a chip keeps the popover open', async ({ page }) => {
    // Regression (customer papercut): the popover the 1st click opened put its
    // backdrop under the 2nd click, which toggle-closed everything.
    const today = localDay(0)
    const task = await createTaskViaApi('CalDblClick', { start_date: `${today}T03:00:00` })
    await openCalendar(page)

    const point = await columnPoint(page, today, 19)
    await page.mouse.dblclick(point.x, point.y)
    await expect(page.locator('.cal-create-popover')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.cal-create-popover')).toHaveCount(0)

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.dblclick()
    await expect(page.locator('[data-testid="cal-item-popover"]')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Escape closes the month overflow popover; a quick chip drag still works', async ({ page }) => {
    // Regression (customer-journey "flick drags silently dropped"): the +N more
    // popover had no window-level Escape handler, so Escape left its INVISIBLE
    // full-screen backdrop up — the next drag's pointerdown landed on the
    // backdrop, no gesture armed, and the trailing mouseup closed the popover,
    // making the retry "mysteriously" work. Speed was never the variable.
    const day = localDay(7)
    for (let i = 0; i < 5; i++) {
      await createTaskViaApi(`CalEscDrag${i}`, { start_date: `${day}T0${i + 1}:00:00` })
    }
    await openCalendar(page)
    await page.click('.cal-view-btn:has-text("Month")')
    await expect(page.locator('.cal-month-grid')).toBeVisible()
    for (let hop = 0; hop < 2 && !(await page.locator(`.cal-month-cell[data-day="${day}"]`).count()); hop++) {
      await page.click('.cal-nav-btns button[aria-label="Next"]')
      await page.waitForTimeout(200)
    }
    const cell = page.locator(`.cal-month-cell[data-day="${day}"]`)
    await cell.locator('.cal-month-more').click()
    await expect(page.locator('.cal-overflow-popover')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.cal-overflow-popover')).toHaveCount(0)
    await expect(page.locator('.cal-popover-backdrop')).toHaveCount(0)

    // Now a brisk drag (no per-step pauses) must move the chip
    const chip = cell.locator('.cal-chip').first()
    const id = await chip.getAttribute('data-item-id')
    const src = await chip.boundingBox()
    const dstDay = localDay(8)
    const dstBox = await page.locator(`.cal-month-cell[data-day="${dstDay}"]`).boundingBox()
    if (!src || !dstBox) throw new Error('month drag geometry missing')
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
    await page.mouse.down()
    await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height - 20, { steps: 8 })
    await page.mouse.up()
    const taskId = id!.split(':').slice(1).join(':')
    await expect
      .poll(async () => (await getTaskViaApi(taskId)).start_date, { timeout: 5000 })
      .toContain(dstDay)
  })

  test('homepage day-agenda side panel renders and creates', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalAgenda', { start_date: `${today}T10:00:00` })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="sidebar-toggle-calendar"]')
    const panel = page.locator('[data-testid="cal-side-panel"]')
    await expect(panel).toBeVisible()

    // Today's chip renders in the panel
    await expect(panel.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)).toBeVisible()

    // Calendar EVENTS render too (customer-journey MAJOR: the agenda shipped
    // tasks-only and users glancing at "Today" missed real meetings entirely)
    await expect(panel.locator('.cal-chip[data-item-id="event:ev-e2e-brief"]')).toBeVisible()

    // Clicking an empty slot opens the quick-create popover
    const point = await columnPoint(page, today, 16, panel)
    await page.mouse.click(point.x, point.y)
    await expect(page.locator('.cal-create-popover .quick-task-composer')).toBeVisible()
    await page.keyboard.press('Escape')

    // Toggle closes
    await panel.locator('button[title="Close calendar panel"]').click()
    await expect(panel).toHaveCount(0)
  })

  test('rail groups pinned tasks under their tier before the project groups', async ({ page, request }) => {
    const task = await createTaskViaApi('CalRailTier')
    // Pin into Focus via the API (tier sections read the same membership).
    await request.post(`${API}/api/focus/tasks/${task.id}`)
    await request.put(`${API}/api/focus/tasks/${task.id}/tier`, { data: { tier: 'focus' } })

    await openCalendar(page)
    const focusSection = page.locator('.cal-rail-group[data-rail-section="t:focus"]')
    await expect(focusSection).toBeVisible()
    await expect(focusSection.locator('.cal-rail-group-label')).toHaveText(/Focus/)
    await expect(focusSection.locator(`.cal-rail-row[data-task-id="${task.id}"]`)).toBeVisible()
    // Tier sections render ABOVE project groups (priority leads the rail).
    const sectionKeys = await page.locator('.cal-rail-group').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-rail-section') ?? ''),
    )
    const focusIdx = sectionKeys.indexOf('t:focus')
    const firstProjectIdx = sectionKeys.findIndex((k) => k.startsWith('p:'))
    expect(focusIdx).toBeGreaterThanOrEqual(0)
    if (firstProjectIdx !== -1) expect(focusIdx).toBeLessThan(firstProjectIdx)
    // And a tier-pinned task must not ALSO appear in its project group.
    await expect(page.locator(`.cal-rail-row[data-task-id="${task.id}"]`)).toHaveCount(1)
  })

  test('todo card drags onto the homepage calendar panel via the drag bus', async ({ page }) => {
    // Cross-panel drag: TodoPanel's dnd-kit context can't reach the calendar
    // panel, so the drop rides the drag bus. The stored hour must match the
    // visually targeted slot.
    const today = localDay(0)
    const task = await createTaskViaApi('CalBusDrag')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="sidebar-toggle-calendar"]')
    const panel = page.locator('[data-testid="cal-side-panel"]')
    await expect(panel).toBeVisible()

    // The panel may open on a pinned-tier tab (e.g. Focus) that hides a fresh
    // unpinned task — switch to All so the card list shows it.
    const allTab = page.locator('.todo-section-tab-all')
    if (await allTab.count()) await allTab.click()

    // The row renders either as a plain list item (whole-card draggable) or as
    // a pinned-style card (drag ONLY via its ☰ handle) depending on which
    // section variant the tab uses — grab whichever is present and pick the
    // correct grip point.
    const card = page.locator(`[data-task-id="${task.id}"]`).first()
    await card.scrollIntoViewIfNeeded()
    const isPinnedCard = await card.evaluate((el) => el.classList.contains('todo-pinned-card') || el.classList.contains('todo-focus-card'))
    const grip = isPinnedCard ? card.locator('.todo-pinned-drag-handle') : card
    const cardBox = await grip.boundingBox()
    if (!cardBox) throw new Error('todo card not visible')

    const target = await columnPoint(page, today, 15, panel)
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 15 })
    // The bus preview line appears in the panel's grid
    await expect(panel.locator('.cal-drop-line')).toBeVisible()
    await page.mouse.up()

    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(`${today}T15:00:00`)
    // The in-panel drop semantics must have been skipped: no group/reorder
    // artifacts — the task still renders as a plain row (now scheduled).
    await expect(panel.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)).toBeVisible()
  })

  test('task block: end_date spans the chip, bottom-edge resize writes it back', async ({ page }) => {
    const today = localDay(0)
    // 02:00–04:00, far from other tests' chips (overlap halves chip width).
    const task = await createTaskViaApi('CalEndSpan', {
      start_date: `${today}T02:00:00`,
      end_date: `${today}T04:00:00`,
    })
    await page.goto(`/calendar?view=day&d=${today}`)
    await page.waitForLoadState('networkidle')

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    const box = await chip.boundingBox()
    if (!box) throw new Error('chip not visible')
    // 2h at 48px/hour = 96px (not the point-in-time 24px slot).
    expect(box.height).toBeGreaterThan(90)

    // Drag the bottom resize handle +1h → end_date 05:00.
    const handle = chip.locator('.cal-chip-resize-handle')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('resize handle not visible')
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 48, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await getTaskViaApi(task.id)).end_date, { timeout: 5000 })
      .toBe(`${today}T05:00:00`)

    // Moving the block keeps its duration: +2h → 04:00–07:00.
    const box2 = await chip.boundingBox()
    if (!box2) throw new Error('chip not visible after resize')
    await page.mouse.move(box2.x + box2.width / 2, box2.y + 6)
    await page.mouse.down()
    await page.mouse.move(box2.x + box2.width / 2, box2.y + 6 + 96, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toBe(`${today}T04:00:00`)
    expect((await getTaskViaApi(task.id)).end_date).toBe(`${today}T07:00:00`)
  })

  test('chip right-click menu completes and deletes the task', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalCtxDelete', { start_date: `${today}T01:00:00` })
    await page.goto(`/calendar?view=day&d=${today}`)
    await page.waitForLoadState('networkidle')

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await chip.scrollIntoViewIfNeeded()
    await chip.click({ button: 'right' })
    const menu = page.locator('[data-testid="cal-ctx-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('button:has-text("Complete task")')).toBeVisible()

    // Delete is two-step (misclick protection), then the task is really gone.
    await menu.locator('button:has-text("Delete task")').click()
    await menu.locator('button:has-text("are you sure")').click()
    await expect
      .poll(async () => (await fetch(`${API}/api/tasks/${task.id}`)).status, { timeout: 5000 })
      .toBe(404)
  })

  test('drag-selected range seeds Start+End (never a Due) in the composer', async ({ page }) => {
    const today = localDay(0)
    await page.goto(`/calendar?view=day&d=${today}`)
    await page.waitForLoadState('networkidle')

    const col = await page.locator(`.cal-day-col[data-day="${today}"]`).boundingBox()
    const scroll = await page.locator('.cal-grid-scroll').boundingBox()
    if (!col || !scroll) throw new Error('grid not visible')
    await page.mouse.move(col.x + col.width / 2, scroll.y + 100)
    await page.mouse.down()
    await page.mouse.move(col.x + col.width / 2, scroll.y + 196, { steps: 8 })
    await page.mouse.up()

    const chips = page.locator('.cal-create-popover .qtc-chip')
    await expect(chips.first()).toBeVisible()
    const labels = await chips.allTextContents()
    expect(labels.some((l) => l.startsWith('Start '))).toBe(true)
    expect(labels.some((l) => l.startsWith('End '))).toBe(true)
    // The due chip must be the EMPTY ghost — a range is a working block, not a deadline.
    expect(labels.some((l) => l.includes('+ Due'))).toBe(true)
    await page.keyboard.press('Escape')
  })

  test('homepage calendar panel resizes by dragging its right edge and persists', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="sidebar-toggle-calendar"]')
    const panel = page.locator('[data-testid="cal-side-panel"]')
    await expect(panel).toBeVisible()

    const before = (await panel.boundingBox())!.width
    const handle = page.locator('.cal-side-resize-handle')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('resize handle not visible')

    // width:0 handle — the ±3px ::before zone straddles the seam.
    await page.mouse.move(hb.x, hb.y + 300)
    await page.mouse.down()
    await page.mouse.move(hb.x + 150, hb.y + 300, { steps: 8 })
    await page.mouse.up()

    const after = (await panel.boundingBox())!.width
    expect(after).toBeGreaterThan(before + 100)

    // Width is persisted (localStorage) and survives a reload.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(panel).toBeVisible()
    expect((await panel.boundingBox())!.width).toBeGreaterThan(before + 100)
  })
})

test.describe('Calendar touch drag (mobile)', () => {
  // Touch is a separate input pipeline: pointer events are synthesized from
  // touches and the browser will pointercancel the gesture for scrolling
  // unless the chip declares `touch-action: none`. A desktop-mouse pass says
  // nothing about this path — drive it with real CDP touch events.
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('all-day chip touch-drags into a time slot (phone layout)', async ({ page }) => {
    const today = localDay(0)
    const task = await createTaskViaApi('CalTouchAllDay', { start_date: today })

    await page.goto(`/calendar?view=day&d=${today}`)
    await page.waitForLoadState('networkidle')

    const chip = page.locator(`.cal-chip[data-item-id="task-start:${task.id}"]`)
    await expect(chip).toBeVisible()
    const chipBox = await chip.boundingBox()
    const gridBox = await page.locator('.cal-grid-scroll').boundingBox()
    if (!chipBox || !gridBox) throw new Error('chip or grid not visible')

    const cdp = await page.context().newCDPSession(page)
    const from = { x: chipBox.x + chipBox.width / 2, y: chipBox.y + chipBox.height / 2 }
    // Clearly inside the time grid (below gridTop) so the drop is timed.
    const to = { x: from.x, y: gridBox.y + 250 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x, y: from.y + ((to.y - from.y) * i) / 12 }],
      })
      await page.waitForTimeout(20)
    }
    // Mid-gesture the solid ghost must be tracking the finger — its absence
    // means the browser stole the gesture for scrolling (touch-action broke).
    await expect(page.locator('.cal-move-ghost-solid')).toBeVisible()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

    // Date-only start becomes a timed one; exact hour depends on device
    // pixel geometry, so assert the shape rather than a specific slot.
    await expect
      .poll(async () => (await getTaskViaApi(task.id)).start_date, { timeout: 5000 })
      .toMatch(new RegExp(`^${today}T\\d{2}:\\d{2}:00$`))
  })
})
