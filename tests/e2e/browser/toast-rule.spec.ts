/**
 * The toast rule (.claude/skills/walnut-ui-requirements/standard.md, "Toasts"), on the real UI:
 * what the person just did and can see gets no toast, and mod+z still takes it back; a change that
 * takes its object out of sight keeps its Undo toast.
 *
 * 2026-11-21: creating a calendar event popped "Event created" with an Undo in the far corner while
 * the new block sat under the pointer; every move, resize, copy and pin did the same. The source
 * ratchet is tests/web/toast-reason-ratchet.test.ts; this walks the flows it names.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { calendarEmptySlotPoint, calendarHourPx } from './calendar-helpers'

test.use({ viewport: { width: 1280, height: 860 } })
test.setTimeout(120_000)

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const toasts = (page: Page) => page.locator('.notification-toast')

function localDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface Ev { id: string; title: string; start: string; end: string }
async function eventTitled(title: string, day: string): Promise<Ev | undefined> {
  const res = await fetch(`${API}/api/calendar/events?from=${day}&to=${day}`)
  return ((await res.json()) as { events: Ev[] }).events.find((e) => e.title === title)
}

/** The page's own idea of the platform, which decides its undo key (undo-key.ts). */
async function undo(page: Page) {
  const mod = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform ?? '') ? 'Meta' : 'Control')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.keyboard.press(`${mod}+z`)
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
})

test('creating and moving a calendar event shows no toast, and mod+z still takes the move back', async ({ page }) => {
  const today = localDay(0)
  const title = `Toast rule event ${Date.now()}`
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.click('a[href="/calendar"]')
    await page.getByRole('tab', { name: 'Day', exact: true }).click()
    await expect(page.locator('.cal-grid')).toBeVisible()

    // Create from the popover: the block lands on the grid, nothing pops up in the corner.
    const slot = await calendarEmptySlotPoint(page, today, 10)
    await page.mouse.click(slot.x, slot.y)
    const popover = page.locator('.cal-create-popover')
    await expect(popover).toBeVisible()
    await popover.getByLabel('Event title').fill(title)
    await popover.getByRole('button', { name: 'Add Event', exact: true }).click()
    const chip = page.locator(`.cal-day-col[data-day="${today}"] .cal-chip:has-text("${title}")`).first()
    await expect(chip).toBeVisible()
    await expect.poll(() => eventTitled(title, today).then((e) => !!e), { timeout: 10_000 }).toBe(true)
    const created = (await eventTitled(title, today))!
    await page.waitForTimeout(800)
    await expect(toasts(page).filter({ hasText: 'Event created' })).toHaveCount(0)

    // Move it an hour later by dragging: the block moves under the pointer, no toast.
    const hourPx = await calendarHourPx(page)
    await chip.scrollIntoViewIfNeeded()
    const box = (await chip.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + hourPx, { steps: 10 })
    await page.mouse.up()
    await expect.poll(async () => (await eventTitled(title, today))?.start).not.toBe(created.start)
    await page.waitForTimeout(800)
    await expect(toasts(page).filter({ hasText: 'Event moved' })).toHaveCount(0)

    // Its Undo is the key: back where it was, and no "Undone" line either.
    await undo(page)
    await expect.poll(async () => (await eventTitled(title, today))?.start, { timeout: 15_000 }).toBe(created.start)
    await expect(toasts(page).filter({ hasText: 'Undone' })).toHaveCount(0)
  } finally {
    const ev = await eventTitled(title, today)
    if (ev) await fetch(`${API}/api/calendar/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' })
  }
})

test('pinning a task shows no toast; deleting it keeps its Undo toast, and the Undo brings it back', async ({ page, request }) => {
  await presetPanelView(page, { section: 'all' })
  const title = `Toast rule task ${Date.now()}`
  const made = await request.post('/api/tasks', { data: { title, source: 'local', pinned: false } })
  expect(made.ok()).toBe(true)
  const { task } = (await made.json()) as { task: { id: string } }
  await request.delete(`/api/focus/tasks/${task.id}`).catch(() => {})
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.locator('.todo-search-input').fill(title)
    const row = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`).first()
    await expect(row).toBeVisible({ timeout: 20_000 })

    // Pin to Focus from the row's menu: the pin shows on the task, so no toast.
    await row.hover()
    await row.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByTestId('kebab-pin-focus').click()
    await expect.poll(async () => ((await (await request.get(`/api/tasks/${task.id}`)).json()) as { task: { pinned?: boolean } }).task.pinned).toBe(true)
    await page.waitForTimeout(800)
    await expect(toasts(page).filter({ hasText: 'Pinned' })).toHaveCount(0)
    await expect(toasts(page).filter({ hasText: 'Moved to' })).toHaveCount(0)

    // Delete from its details: the row goes, so the Undo is on a toast.
    const pinnedRow = page.locator(`[data-task-id="${task.id}"]`).first()
    await expect(pinnedRow).toBeVisible()
    await pinnedRow.hover()
    await pinnedRow.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
    const modal = page.locator('.task-detail-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('task-detail-delete').click()
    const gone = toasts(page).filter({ hasText: 'Task deleted' })
    await expect(gone).toContainText(title)
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveCount(0)
    await gone.locator('.notification-toast-action', { hasText: 'Undo' }).click()
    await expect(page.locator(`[data-task-id="${task.id}"]`).first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(6_000)
    expect((await request.get(`/api/tasks/${task.id}`)).ok()).toBe(true)
  } finally {
    await request.delete(`/api/tasks/${task.id}?force=true`).catch(() => {})
  }
})
