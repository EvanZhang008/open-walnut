/**
 * The home board loads a recent window of completed tasks, and the archive only
 * when a view shows completed rows.
 *
 * Before: every page load asked for the whole list. On a live board of 6,578
 * tasks, 6,400 of them completed, that was 6.8MB of JSON serialized by the
 * server and parsed by the browser for 77 rendered rows. Now the list request
 * carries `completedWithinDays`, the server answers with the open tasks plus the
 * recent completions and a `completedHidden` count, and the first view that
 * shows completed rows (Status Complete here, spec 5.8) loads the rest once.
 *
 * The window is rewritten to 0 days on the wire so a task completed a moment ago
 * counts as "old"; the client cannot be asked to backdate a completion.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { filterChip, setStatus } from './filter-bar-helpers'
import { setStatusSectionOpen, showSectionCard, statusSection, statusSectionCountOf, statusSectionToggle } from './status-section-helpers'

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

/**
 * Status Complete alone (a pick narrower than Open, so the list draws the completed
 * rows itself), or back to the default open set. Open + Complete keeps the status
 * sections and leaves completed rows in the Completed section.
 */
async function setShowCompleted(page: Page, on: boolean): Promise<void> {
  await setStatus(page, on ? ['Complete'] : ['To Do', 'In Progress', 'Need Action'])
  if (on) await expect(filterChip(page, 'status')).toHaveText(/Complete/)
  else await expect(filterChip(page, 'status')).toHaveCount(0)
}

test('a board load leaves old completions on the server; Status Complete loads them once', async ({ page }) => {
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
  // The folded Completed section counts the archive it has not loaded yet.
  await expect(statusSectionToggle(page, 'done')).toHaveAttribute('aria-expanded', 'false')
  expect(await statusSectionCountOf(page, 'done')).toBeGreaterThanOrEqual(hiddenReported)
  expect(requests.whole()).toBe(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/recent-window-${test.info().project.name}.png` })

  // Open + Complete holds every open phase, so it keeps the sections: the completed
  // task stays out of the list and the folded Completed section reads nothing yet.
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
  await expect(filterChip(page, 'status')).toContainText('Open, Complete')
  await expect(statusSectionToggle(page, 'done')).toHaveAttribute('aria-expanded', 'false')
  await expect(rowFor(done.title)).toHaveCount(0)
  await page.waitForTimeout(1_500)
  expect(requests.whole()).toBe(0)

  // Showing completed rows in the list asks for the archive: one whole-list read,
  // and the completed task appears as a done row.
  await setShowCompleted(page, true)
  await expect.poll(() => requests.whole(), { timeout: 10_000 }).toBe(1)
  const doneRow = rowFor(done.title).first()
  await expect(doneRow).toBeVisible({ timeout: 10_000 })
  await expect(doneRow).toHaveClass(/-done\b/)
  // A Status narrower than Open shows its rows in the list, with no status sections.
  await expect(statusSection(page, 'done')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archive-loaded-${test.info().project.name}.png` })

  // Toggling again does not re-read the archive: it is loaded for this page.
  await setShowCompleted(page, false)
  await expect(rowFor(done.title)).toHaveCount(0)
  await setShowCompleted(page, true)
  await expect(doneRow).toBeVisible({ timeout: 10_000 })
  expect(requests.whole()).toBe(1)

  // The other way in: opening the Completed section draws the archived task there,
  // from the archive already loaded for this page (no second read).
  await setShowCompleted(page, false)
  await expect(rowFor(done.title)).toHaveCount(0)
  await setStatusSectionOpen(page, 'done', true)
  const sectionCard = await showSectionCard(page, 'done', done.id)
  await expect(sectionCard).toHaveClass(/todo-pinned-card-done/)
  expect(requests.whole()).toBe(1)
  await setStatusSectionOpen(page, 'done', false)
  await expect(rowFor(done.title)).toHaveCount(0)
})

test('the Completed section reads the archive only when its Show more runs past the loaded rows, once, without a Status chip', async ({ page }) => {
  await isolateUiPrefs(page)
  const done = await createTaskViaApi('Archive section done')
  await unpinViaApi(done.id)
  await completeViaApi(done.id)
  await page.route('**/api/tasks?*', async (route) => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('completedWithinDays')) return route.continue()
    url.searchParams.set('completedWithinDays', '0')
    await route.continue({ url: url.toString() })
  })
  await page.addInitScript(() => {
    localStorage.setItem('walnut-todo-active-section', 'all')
    localStorage.setItem('walnut-todo-active-tab', '')
    localStorage.setItem('walnut-todo-list-opened', JSON.stringify(['']))
  })
  const requests = watchListRequests(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(statusSection(page, 'done')).toBeVisible({ timeout: 15_000 })
  expect(requests.whole()).toBe(0)
  // Opening the section draws the completions already loaded; it reads nothing more.
  await setStatusSectionOpen(page, 'done', true)
  await page.waitForTimeout(1_500)
  expect(requests.whole()).toBe(0)
  await expect(filterChip(page, 'status')).toHaveCount(0)
  // "Show more" past the loaded rows reads the archive, once, and the archived task appears.
  await showSectionCard(page, 'done', done.id)
  await expect.poll(() => requests.whole(), { timeout: 30_000 }).toBe(1)
  // Folding and opening again does not re-read it.
  await setStatusSectionOpen(page, 'done', false)
  await setStatusSectionOpen(page, 'done', true)
  await showSectionCard(page, 'done', done.id)
  expect(requests.whole()).toBe(1)
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
