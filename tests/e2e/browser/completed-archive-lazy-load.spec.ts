/**
 * The home board loads a recent window of completed tasks, and the archive only
 * when a view shows completed rows.
 *
 * Before: every page load asked for the whole list. On a live board of 6,578
 * tasks, 6,400 of them completed, that was 6.8MB of JSON serialized by the
 * server and parsed by the browser for 77 rendered rows. Now the list request
 * carries `completedWithinDays`, the server answers with the open tasks plus the
 * recent completions and a `completedHidden` count, and the first view that
 * shows completed rows (Status with Complete here, spec 5.8) loads the rest once.
 *
 * The window is rewritten to 0 days on the wire so a task completed a moment ago
 * counts as "old"; the client cannot be asked to backdate a completion.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { filterChip, setStatus } from './filter-bar-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/completed-archive-lazy-load'

// Four trips through the Filter menu; the default 30s is too tight on a loaded machine.
test.setTimeout(120_000)

async function createTaskViaApi(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local' }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { task: { id: string; title: string } }).task
}

/** A REST-created task lands pinned (Satellite); pinned rows are exempt from the window. */
async function unpinViaApi(id: string): Promise<void> {
  const res = await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`unpin failed: ${res.status} ${await res.text()}`)
}

async function completeViaApi(id: string): Promise<void> {
  const res = await fetch(`${API}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'COMPLETE' }),
  })
  if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`)
}

/** Whole-list GETs, split by whether they asked for the recent window only. */
function watchListRequests(page: Page): { windowed: () => number; whole: () => number } {
  let windowed = 0
  let whole = 0
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const url = new URL(req.url())
    if (url.pathname !== '/api/tasks' || url.searchParams.get('fields') !== 'list' || url.searchParams.has('ids')) return
    if (url.searchParams.has('completedWithinDays')) windowed += 1
    else whole += 1
  })
  return { windowed: () => windowed, whole: () => whole }
}

/** Status open + Complete (the old Show completed), or back to the default open set. */
async function setShowCompleted(page: Page, on: boolean): Promise<void> {
  await setStatus(page, on ? ['To Do', 'In Progress', 'Need Action', 'Complete'] : ['To Do', 'In Progress', 'Need Action'])
  if (on) await expect(filterChip(page, 'status')).toContainText('Open, Complete')
  else await expect(filterChip(page, 'status')).toHaveCount(0)
}

test('a board load leaves old completions on the server; Status with Complete loads them once', async ({ page }) => {
  await isolateUiPrefs(page)
  const open = await createTaskViaApi('Archive open')
  const done = await createTaskViaApi('Archive done')
  await unpinViaApi(open.id)
  await unpinViaApi(done.id)
  await completeViaApi(done.id)

  // A 0-day window: anything completed before the request is archive.
  let hiddenReported = -1
  await page.route('**/api/tasks?*', async (route) => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('completedWithinDays')) return route.continue()
    url.searchParams.set('completedWithinDays', '0')
    const response = await route.fetch({ url: url.toString() })
    const body = (await response.json()) as { completedHidden?: number }
    hiddenReported = body.completedHidden ?? -1
    await route.fulfill({ response, json: body })
  })
  // Stacked sections, the All chip, and the Inbox group open, all before the
  // first render (presetPanelView's keys, minus its own list XHR, which the
  // request counter below must not see).
  await page.addInitScript(() => {
    localStorage.setItem('walnut-todo-active-section', 'all')
    localStorage.setItem('walnut-todo-active-tab', '')
    localStorage.setItem('walnut-todo-list-opened', JSON.stringify(['']))
  })
  const requests = watchListRequests(page)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const rowFor = (title: string) =>
    page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card', { hasText: title })
  await expect(rowFor(open.title).first()).toBeVisible({ timeout: 10_000 })
  // The completed task never reached the browser: not hidden by CSS, absent.
  await expect(rowFor(done.title)).toHaveCount(0)
  expect(requests.windowed()).toBeGreaterThan(0)
  expect(requests.whole()).toBe(0)
  expect(hiddenReported).toBeGreaterThanOrEqual(1)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/recent-window-${test.info().project.name}.png` })

  // Showing completed rows asks for the archive: one whole-list read, and the
  // completed task appears as a done row.
  await setShowCompleted(page, true)
  await expect.poll(() => requests.whole(), { timeout: 10_000 }).toBe(1)
  const doneRow = rowFor(done.title).first()
  await expect(doneRow).toBeVisible({ timeout: 10_000 })
  await expect(doneRow).toHaveClass(/-done\b/)
  // The footer names the same set in the Status word (C8).
  await expect(page.getByTestId('todo-filter-footer-completed')).toContainText('Complete shown')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archive-loaded-${test.info().project.name}.png` })

  // Toggling again does not re-read the archive: it is loaded for this page.
  await setShowCompleted(page, false)
  await expect(rowFor(done.title)).toHaveCount(0)
  await setShowCompleted(page, true)
  await expect(doneRow).toBeVisible({ timeout: 10_000 })
  expect(requests.whole()).toBe(1)

  // isolateUiPrefs keeps the filter record out of the shared prefs; reset anyway.
  await setShowCompleted(page, false)
})

test('the list answers completedWithinDays with the count it left out', async () => {
  const open = await createTaskViaApi('Window open')
  const done = await createTaskViaApi('Window done')
  await unpinViaApi(done.id)
  await completeViaApi(done.id)
  const res = await fetch(`${API}/api/tasks?fields=list&completedWithinDays=0&ids=${open.id},${done.id}`)
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { tasks: Array<{ id: string }>; completedHidden: number; total: number }
  expect(body.tasks.map((t) => t.id)).toEqual([open.id])
  expect(body.completedHidden).toBe(1)
  expect(body.total).toBe(2)
})
