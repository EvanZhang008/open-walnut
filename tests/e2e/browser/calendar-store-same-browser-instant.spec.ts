/**
 * One browser, one calendar store.
 *
 * The homepage day agenda (CalendarSidePanel, rendered from MainPage which never
 * unmounts) and /calendar are BOTH live whenever you are on /calendar. Each used
 * to keep a private `useState` event list, so the same day range was fetched
 * twice and an edit on one surface only reached the other through the
 * `calendar:updated` echo plus a full refetch — the home agenda kept showing a
 * meeting's old time for as long as that took.
 *
 * Both assertions hold the request at the network layer, so anything that still
 * rode the server round-trip would fail them:
 *   1. two surfaces asking for the SAME range issue ONE GET, not two;
 *   2. an edit on /calendar reaches the home agenda before the PATCH is answered.
 */
import { expect, test, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const HOLD_MS = 3000
/** How long a same-frame update may take to reach the other surface. */
const INSTANT_MS = 700
/** TimeGrid geometry: SLOT_MINUTES=30 at SLOT_PX=24 → 48px per hour. */
const topForHour = (hour: number) => `${((hour * 60) / 30) * 24}px`

function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function createEventViaApi(title: string, start: string, end: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/calendar/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId: 'cal-work', title, start, end }),
  })
  if (!res.ok) throw new Error(`POST event failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { event: { id: string } }
  return body.event
}

/** Open the homepage day agenda; it stays mounted for the rest of the test. */
async function openHomeAgenda(page: Page) {
  await page.click('[data-testid="sidebar-toggle-calendar"]')
  const panel = page.locator('[data-testid="cal-side-panel"]')
  await expect(panel).toBeVisible()
  return panel
}

/** The home panel is display:none while another route renders — read the DOM. */
function hiddenText(locator: ReturnType<Page['locator']>) {
  return () => locator.evaluate((el) => el.textContent ?? '')
}

test('two surfaces on the same day range issue ONE events GET', async ({ page }) => {
  const today = localDay(0)
  let dayRangeStarted = 0
  let dayRangeAnswered = 0

  await page.route('**/api/calendar/events?*', async (route) => {
    const url = route.request().url()
    if (!url.includes(`from=${today}`) || !url.includes(`to=${today}`)) {
      await route.continue()
      return
    }
    dayRangeStarted++
    await new Promise((r) => setTimeout(r, HOLD_MS))
    dayRangeAnswered++
    await route.continue()
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await openHomeAgenda(page)
  await expect.poll(() => dayRangeStarted, { timeout: 5000 }).toBe(1)

  // Second surface, same range: /calendar switched to Day view on today.
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
  await page.click('.cal-view-btn:has-text("Day")')
  // Scoped to .cal-page: the home agenda renders a one-day grid too.
  await expect(page.locator('.cal-page .cal-grid[data-days="1"]')).toBeVisible()

  // Still inside the hold: the second surface got its data from the shared
  // in-flight request instead of opening a second one.
  expect(dayRangeAnswered).toBe(0)
  expect(dayRangeStarted).toBe(1)
})

test('an event edit on /calendar reaches the home agenda before the PATCH is answered', async ({ page }) => {
  const today = localDay(0)
  const original = `CalStoreSync ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const event = await createEventViaApi(original, `${today}T09:00:00`, `${today}T09:30:00`)

  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openHomeAgenda(page)

    const homeChip = panel.locator(`.cal-chip[data-item-id="event:${event.id}"]`)
    await homeChip.scrollIntoViewIfNeeded()
    await expect(homeChip).toContainText(original)
    expect(await homeChip.evaluate((el) => (el as HTMLElement).style.top)).toBe(topForHour(9))

    await page.click('a[href="/calendar"]')
    await expect(page.locator('.cal-toolbar')).toBeVisible()
    await page.click('.cal-view-btn:has-text("Day")')
    // Scoped to .cal-page: the same chip also renders in the (hidden) home agenda.
    const pageChip = page.locator(`.cal-page .cal-day-col .cal-chip[data-item-id="event:${event.id}"]`)
    await pageChip.scrollIntoViewIfNeeded()
    await expect(pageChip).toBeVisible()

    // Hold every PATCH for this event: the server does not even see the request
    // until the hold ends, so no echo can arrive before the assertions below.
    let patchesAnswered = 0
    await page.route('**/api/calendar/events/*', async (route) => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return }
      await new Promise((r) => setTimeout(r, HOLD_MS))
      patchesAnswered++
      await route.continue()
    })

    const renamed = `${original} renamed`
    await pageChip.click()
    const popover = page.locator('[data-testid="cal-item-popover"]')
    await expect(popover).toBeVisible()
    await popover.locator('.cal-item-title').fill(renamed)
    await popover.locator('input[type="time"]').nth(0).fill('13:00')
    await popover.locator('.cal-item-save').click()

    // The home agenda is mounted but hidden under /calendar — read its DOM.
    await expect.poll(hiddenText(homeChip), { timeout: INSTANT_MS, intervals: [50, 50, 50, 50, 100, 100, 100] })
      .toContain(renamed)
    await expect.poll(
      () => homeChip.evaluate((el) => (el as HTMLElement).style.top),
      { timeout: INSTANT_MS, intervals: [50, 50, 50, 50, 100, 100, 100] },
    ).toBe(topForHour(13))
    expect(patchesAnswered).toBe(0)

    // Let the held PATCH land: the confirmation must not undo what the user did.
    await expect.poll(() => patchesAnswered, { timeout: HOLD_MS * 3 }).toBe(1)
    await page.waitForTimeout(1000)
    await expect(pageChip).toContainText(renamed)
    expect(await hiddenText(homeChip)()).toContain(renamed)

    const after = await fetch(`${API}/api/calendar/events?from=${today}&to=${today}`)
    const body = (await after.json()) as { events: Array<{ id: string; title: string; start: string }> }
    const stored = body.events.find((e) => e.id === event.id)
    expect(stored?.title).toBe(renamed)
    expect(stored?.start).toBe(`${today}T13:00:00`)
  } finally {
    await fetch(`${API}/api/calendar/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' }).catch(() => {})
  }
})
