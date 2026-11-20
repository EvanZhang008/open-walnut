/**
 * The calendar's history and drags, through the real UI and the real fixture server:
 *
 *  - a move, a resize, a copy or a new event is undone with mod+Z and redone with mod+shift+Z (ctrl+Y off
 *    the Mac), several steps each way, on the app's one undo stack (undo-stack.ts);
 *  - Alt (Option) held while dragging an event copies it: the original stays, a new event lands
 *    where it was dropped, and the drag says so (a "+" on the block, the original not faded);
 *    a copy of a meeting with other people on it never carries them (nobody is invited);
 *  - a plain drag still moves, to another time and to another day;
 *  - every block shown while dragging is drawn in the colour the item has once dropped
 *    (item-tint.ts), the new event's calendar colour included.
 *
 * Every write is read back from the server. Events this spec makes live on the "Home" fixture
 * calendar, which no other spec writes to; each is removed again at the end.
 *
 * Chromium by default; WebKit with `PW_WEBKIT=1 ... --project webkit`.
 */
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import { isolateUiPrefs } from './todo-panel-helpers'
import { calendarEmptySlotPoint } from './calendar-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = process.env.CAL_REDO_SHOTS ?? '/tmp/calendar-redo-copy'

interface Ev { id: string; title: string; start: string; end: string; calendarId: string; hasAttendees?: boolean; walnutCreated?: boolean; color?: string }

function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const today = localDay()

async function events(from = localDay(-7), to = localDay(7)): Promise<Ev[]> {
  const res = await fetch(`${API}/api/calendar/events?from=${from}&to=${to}`)
  expect(res.ok).toBe(true)
  return ((await res.json()) as { events: Ev[] }).events
}
async function eventById(id: string): Promise<Ev | undefined> {
  return (await events()).find((e) => e.id === id)
}
async function titled(title: string): Promise<Ev[]> {
  return (await events()).filter((e) => e.title === title)
}
async function createEvent(title: string, start: string, end: string): Promise<Ev> {
  const res = await fetch(`${API}/api/calendar/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId: 'cal-home', title, start, end }),
  })
  expect(res.status).toBeLessThan(300)
  return ((await res.json()) as { event: Ev }).event
}
async function deleteEvent(id: string): Promise<void> {
  await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
async function cleanupTitled(title: string): Promise<void> {
  for (const e of await titled(title)) await deleteEvent(e.id)
}

/** The page's own idea of the platform, which decides its undo keys (undo-key.ts). */
async function modKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    return /mac|iphone|ipad/i.test(ua?.platform ?? navigator.platform ?? navigator.userAgent ?? '') ? 'Meta' : 'Control'
  })
}
async function undo(page: Page) { await page.keyboard.press(`${await modKey(page)}+z`) }
async function redo(page: Page) { await page.keyboard.press(`${await modKey(page)}+Shift+z`) }

async function openPanel(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.getByTestId('sidebar-toggle-calendar').click()
  const panel = page.getByTestId('cal-side-panel')
  await expect(panel.locator('.cal-grid')).toBeVisible()
  return panel
}

/** The tint a block is drawn in, resolved by the browser (a var() becomes its value). */
async function tintOf(el: Locator): Promise<string> {
  return el.evaluate((node) => getComputedStyle(node).getPropertyValue('--cal-chip-tint').trim().toLowerCase())
}

async function hourPxOf(scope: Locator): Promise<number> {
  return scope.locator('.cal-grid').first().evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--cal-hour-px')))
}

/** Press on a chip's top and carry it `hours` later (onto `day`'s column when given), holding
 *  Alt when `alt`; returns before the release. Measured from the chip itself, so a scroll the
 *  chip needed cannot move the target. */
async function dragChip(page: Page, scope: Locator, chip: Locator, move: { hours: number; day?: string }, opts: { alt?: boolean } = {}) {
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
  const hourPx = await hourPxOf(scope)
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
async function blurFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}
async function drop(page: Page, opts: { alt?: boolean } = {}) {
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}

async function shot(page: Page, name: string, scope?: Locator) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const target = scope ?? page
  await target.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
})

test('a move is undone and redone, several steps each way, and the server follows every step', async ({ page }) => {
  const title = `Redo move ${Date.now()}`
  const ev = await createEvent(title, `${today}T19:00:00`, `${today}T19:30:00`)
  try {
    const panel = await openPanel(page)
    const chip = panel.locator(`[data-item-id="event:${ev.id}"]`)
    await expect(chip).toBeVisible()

    // Step 1: 19:00 -> 20:00 (a plain drag moves; the original does not stay behind).
    await dragChip(page, panel, chip, { hours: 1 })
    await expect(panel.locator('.cal-move-ghost-solid')).not.toHaveAttribute('data-copy', 'true')
    await drop(page)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T20:00:00`)
    expect((await eventById(ev.id))?.end).toBe(`${today}T20:30:00`)
    expect(await titled(title)).toHaveLength(1)
    await expect(page.getByText('Event moved').first()).toBeVisible()

    // Step 2: a resize, 20:00-20:30 -> 20:00-21:00.
    await chip.scrollIntoViewIfNeeded()
    const handle = chip.locator('.cal-chip-resize-handle')
    const hb = (await handle.boundingBox())!
    const hourPx = await hourPxOf(panel)
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + hourPx / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await eventById(ev.id))?.end).toBe(`${today}T21:00:00`)

    // Two undos: back through the resize, then the move.
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await eventById(ev.id))?.end).toBe(`${today}T20:30:00`)
    await expect(page.getByText('Undone').first()).toBeVisible()
    await undo(page)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T19:00:00`)
    expect((await eventById(ev.id))?.end).toBe(`${today}T19:30:00`)
    await expect(page.getByRole('button', { name: 'Redo' }).first()).toBeVisible()
    await shot(page, 'after-two-undos', panel)

    // Two redos: the move again, then the resize again.
    await redo(page)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T20:00:00`)
    expect((await eventById(ev.id))?.end).toBe(`${today}T20:30:00`)
    await redo(page)
    await expect.poll(async () => (await eventById(ev.id))?.end).toBe(`${today}T21:00:00`)
    // Nothing more to redo; the last redo can be undone again.
    await redo(page)
    await expect(page.getByText('Nothing to redo').first()).toBeVisible()
    await undo(page)
    await expect.poll(async () => (await eventById(ev.id))?.end).toBe(`${today}T20:30:00`)
    // The toast's own Redo button does it again too.
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await expect.poll(async () => (await eventById(ev.id))?.end).toBe(`${today}T21:00:00`)
    expect(await titled(title)).toHaveLength(1)
  } finally {
    await cleanupTitled(title)
  }
})

test('Alt-drag copies an event: the original stays, the copy can be undone and redone', async ({ page }) => {
  const title = `Alt copy ${Date.now()}`
  const ev = await createEvent(title, `${today}T19:00:00`, `${today}T20:00:00`)
  try {
    const panel = await openPanel(page)
    const chip = panel.locator(`[data-item-id="event:${ev.id}"]`)
    await expect(chip).toBeVisible()

    await dragChip(page, panel, chip, { hours: 2 }, { alt: true })
    // The drag says it copies: a "+" block, the original not faded.
    const ghost = panel.locator('.cal-move-ghost-solid')
    await expect(ghost).toHaveAttribute('data-copy', 'true')
    await expect(chip).not.toHaveClass(/cal-chip-ghosted/)
    expect(await tintOf(ghost)).toBe(await tintOf(chip))
    await shot(page, 'alt-drag-in-hand', panel)
    await drop(page, { alt: true })

    await expect.poll(async () => (await titled(title)).length).toBe(2)
    const [orig, copy] = [await eventById(ev.id), (await titled(title)).find((e) => e.id !== ev.id)!]
    expect(orig).toMatchObject({ start: `${today}T19:00:00`, end: `${today}T20:00:00` })
    expect(copy).toMatchObject({ start: `${today}T21:00:00`, end: `${today}T22:00:00`, calendarId: 'cal-home' })
    await expect(panel.locator(`[data-item-id="event:${copy.id}"]`)).toBeVisible()
    await expect(page.getByText('Event copied').first()).toBeVisible()

    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await titled(title)).map((e) => e.id)).toEqual([ev.id])
    await redo(page)
    await expect.poll(async () => (await titled(title)).length).toBe(2)
    const again = (await titled(title)).find((e) => e.id !== ev.id)!
    expect(again).toMatchObject({ start: `${today}T21:00:00`, end: `${today}T22:00:00` })
    await undo(page)
    await expect.poll(async () => (await titled(title)).map((e) => e.id)).toEqual([ev.id])
    expect(await eventById(ev.id)).toMatchObject({ start: `${today}T19:00:00`, end: `${today}T20:00:00` })

    // Alt let go before the drop: it is a move.
    await dragChip(page, panel, chip, { hours: 2 }, { alt: true })
    await page.keyboard.up('Alt')
    await expect(panel.locator('.cal-move-ghost-solid')).not.toHaveAttribute('data-copy', 'true')
    await expect(chip).toHaveClass(/cal-chip-ghosted/)
    await page.mouse.up()
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T21:00:00`)
    expect(await titled(title)).toHaveLength(1)
  } finally {
    await cleanupTitled(title)
  }
})

test('a copy of a meeting with other people on it never carries them, and asks nothing', async ({ page }) => {
  const ID = 'ev-e2e-invited-series#1770000000'
  const before = await eventById(ID)
  expect(before).toMatchObject({ hasAttendees: true })
  const title = before!.title
  const panel = await openPanel(page)
  const chip = panel.locator(`[data-item-id="event:${ID}"]`)
  const start = (await titled(title)).map((e) => e.id)
  try {
    await dragChip(page, panel, chip, { hours: 3 }, { alt: true })
    await drop(page, { alt: true })
    await expect.poll(async () => (await titled(title)).length).toBe(start.length + 1)
    // No "may notify the organizer" confirmation: nothing of theirs is written.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const copy = (await titled(title)).find((e) => !start.includes(e.id))!
    expect(copy).toMatchObject({ hasAttendees: false, walnutCreated: true, start: `${today}T19:00:00`, end: `${today}T20:00:00` })
    expect(await eventById(ID)).toEqual(before)
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await titled(title)).map((e) => e.id).sort()).toEqual([...start].sort())
    expect(await eventById(ID)).toEqual(before)
  } finally {
    for (const e of await titled(title)) if (!start.includes(e.id)) await deleteEvent(e.id)
  }
})

test('a task chip moves, undoes and redoes; Alt on a task is a plain move', async ({ page }) => {
  const title = `Redo task ${Date.now()}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', start_date: `${today}T19:00:00`, end_date: `${today}T19:30:00` }),
  })
  const task = ((await res.json()) as { task: { id: string } }).task
  const read = async () => ((await (await fetch(`${API}/api/tasks/${task.id}`)).json()) as { task: { start_date?: string; end_date?: string } }).task
  try {
    const panel = await openPanel(page)
    const chip = panel.locator(`[data-item-id="task-start:${task.id}"]`)
    await expect(chip).toBeVisible()
    await dragChip(page, panel, chip, { hours: 2 }, { alt: true })
    await expect(panel.locator('.cal-move-ghost-solid')).not.toHaveAttribute('data-copy', 'true')
    expect(await tintOf(panel.locator('.cal-move-ghost-solid'))).toBe(await tintOf(chip))
    await drop(page, { alt: true })
    await expect.poll(async () => (await read()).start_date).toBe(`${today}T21:00:00`)
    expect((await read()).end_date).toBe(`${today}T21:30:00`)
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await read()).start_date).toBe(`${today}T19:00:00`)
    expect((await read()).end_date).toBe(`${today}T19:30:00`)
    await redo(page)
    await expect.poll(async () => (await read()).start_date).toBe(`${today}T21:00:00`)
  } finally {
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' })
  }
})

test('drag-to-create is drawn in the new event\'s own colour from the first frame to the created chip', async ({ page }) => {
  const title = `Tint create ${Date.now()}`
  try {
    // The new event's calendar is known once the calendar list is read (a moment after the panel
    // opens); before that a drag has no calendar to take its colour from.
    const calendarsRead = page.waitForResponse((r) => r.url().includes('/api/calendar/sources') && r.ok())
    const panel = await openPanel(page)
    await calendarsRead
    const from = await calendarEmptySlotPoint(panel, today, 22)
    const to = { x: from.x, y: from.y + (await hourPxOf(panel)) }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    const sel = panel.locator('.cal-create-sel')
    await expect(sel).toBeVisible()
    const during = await tintOf(sel)
    await shot(page, 'create-drag-in-hand', panel)
    await page.mouse.up()
    const placeholder = page.getByTestId('cal-create-placeholder')
    await expect(placeholder).toBeVisible()
    expect(await tintOf(placeholder)).toBe(during)
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await titled(title)).length).toBe(1)
    const created = (await titled(title))[0]
    const createdChip = panel.locator(`[data-item-id="event:${created.id}"]`)
    await expect(createdChip).toBeVisible()
    expect(await tintOf(createdChip)).toBe(during)
    expect(created.color?.toLowerCase()).toBe(during)
    // A created event is one more step of the same history.
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await titled(title)).length).toBe(0)
    await redo(page)
    await expect.poll(async () => (await titled(title)).length).toBe(1)
  } finally {
    await cleanupTitled(title)
  }
})

test('the calendar page: a drag to another day moves, Alt-drag there copies, both undo', async ({ page }) => {
  const title = `Week copy ${Date.now()}`
  // A day beside today inside the same week, so both show in the week view.
  const dow = new Date().getDay()
  const other = localDay(dow === 6 ? -1 : 1)
  const ev = await createEvent(title, `${today}T19:00:00`, `${today}T19:30:00`)
  try {
    await page.goto('/')
    await page.click('a[href="/calendar"]')
    await expect(page.locator('.cal-toolbar')).toBeVisible()
    await page.getByRole('tab', { name: 'Week', exact: true }).click()
    const grid = page.locator('.cal-view')
    const chip = grid.locator(`[data-item-id="event:${ev.id}"]`)
    await expect(chip).toBeVisible()

    await dragChip(page, grid, chip, { hours: 0, day: other })
    await drop(page)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${other}T19:00:00`)
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T19:00:00`)

    await dragChip(page, grid, chip, { hours: 1, day: other }, { alt: true })
    await drop(page, { alt: true })
    await expect.poll(async () => (await titled(title)).length).toBe(2)
    expect((await titled(title)).find((e) => e.id !== ev.id)).toMatchObject({ start: `${other}T20:00:00`, end: `${other}T20:30:00` })
    expect(await eventById(ev.id)).toMatchObject({ start: `${today}T19:00:00` })
    await shot(page, 'week-alt-copy', grid)
    await blurFocus(page)
    await undo(page)
    await expect.poll(async () => (await titled(title)).map((e) => e.id)).toEqual([ev.id])
  } finally {
    await cleanupTitled(title)
  }
})

test('an undo pressed while the move is still being written waits for it, then takes it back', async ({ page }) => {
  const title = `In flight ${Date.now()}`
  const ev = await createEvent(title, `${today}T19:00:00`, `${today}T19:30:00`)
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let patches = 0
  try {
    const panel = await openPanel(page)
    // Hold the first write (as a meeting's write waits for the Mac's confirmation).
    await page.route(`**/api/calendar/events/${encodeURIComponent(ev.id)}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      patches++
      if (patches === 1) await held
      await route.continue()
    })
    const chip = panel.locator(`[data-item-id="event:${ev.id}"]`)
    await dragChip(page, panel, chip, { hours: 1 })
    await drop(page)
    await blurFocus(page)
    await undo(page)
    await page.waitForTimeout(400)
    expect(patches).toBe(1) // the undo has not been sent ahead of the write it takes back
    release()
    // The held move lands first, then the undo's write takes it back.
    await expect.poll(() => patches, { timeout: 10_000 }).toBe(2)
    await expect.poll(async () => (await eventById(ev.id))?.start).toBe(`${today}T19:00:00`)
    await page.waitForTimeout(500)
    expect((await eventById(ev.id))?.start).toBe(`${today}T19:00:00`)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await cleanupTitled(title)
  }
})

test('an undo after a change made elsewhere leaves that change, and a redo never writes over it', async ({ page }) => {
  const title = `Elsewhere ${Date.now()}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', start_date: `${today}T19:00:00`, end_date: `${today}T19:30:00` }),
  })
  const task = ((await res.json()) as { task: { id: string } }).task
  const read = async () => ((await (await fetch(`${API}/api/tasks/${task.id}`)).json()) as { task: { start_date?: string } }).task
  try {
    const panel = await openPanel(page)
    const chip = panel.locator(`[data-item-id="task-start:${task.id}"]`)
    await dragChip(page, panel, chip, { hours: 1 })
    await drop(page)
    await expect.poll(async () => (await read()).start_date).toBe(`${today}T20:00:00`)
    // Another surface (an agent, the phone) moves it on; this page hears it and redraws the chip.
    const topBefore = await chip.evaluate((el) => (el as HTMLElement).style.top)
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start_date: `${today}T22:00:00`, end_date: `${today}T22:30:00` }) })
    await expect.poll(() => chip.evaluate((el) => (el as HTMLElement).style.top), { timeout: 10_000 }).not.toBe(topBefore)
    await blurFocus(page)
    await undo(page)
    await expect(page.getByText('Not undone: it changed since').first()).toBeVisible()
    await redo(page)
    await page.waitForTimeout(800)
    expect((await read()).start_date).toBe(`${today}T22:00:00`)
  } finally {
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' })
  }
})
