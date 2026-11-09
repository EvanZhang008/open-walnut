/**
 * Playwright: the Recent tab lists the tasks the person OPENED, newest first, in one flat list,
 * and greys the ones open in this window right now.
 *
 * Why this exists (2026-11-06, the user, on a screenshot of Recent sorted by last update with
 * Needs you / Waiting / Completed groups under it): "add all the recent opened not recently
 * updated ... so user can find, like this open this this this, and then they can find it, and
 * grey out the one current open in the window", then "very simple flat list for recent".
 * An agent's update must not move a row; a load restoring the screen is not an open; a task
 * opened elsewhere (another window or device) joins the list when this window comes back.
 *
 * All data is owned by the test (a per-run project).
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { withCssColor } from './css-color'
import { chooseViewOption, openHome } from './home-navigation-helpers'
import { closeDisplayMenu, displayMenu, openDisplayMenu } from './filter-bar-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/recent-opened-tab'
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `RecentOpened${STAMP}`
const KEY = 'walnut-todo-recent-opened'

// The clip is the acceptance record of this view (one per test, kept on pass too).
test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, video: { mode: 'on', size: { width: 1280, height: 860 } } })
test.setTimeout(180_000)

const made: string[] = []

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterAll(async () => {
  for (const id of made) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  await fetch(`${API}/api/projects/${encodeURIComponent(PROJECT)}`, { method: 'DELETE' }).catch(() => undefined)
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createTask(title: string): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
}

/** The Recent rows this test owns, top to bottom. */
async function recentRows(page: Page, mine: readonly string[]): Promise<string[]> {
  const ids = await page.locator('.todo-pinned-list-recent [data-task-id]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.taskId ?? ''))
  return ids.filter((id) => mine.includes(id))
}

const recentCard = (page: Page, id: string) => page.locator(`.todo-pinned-list-recent [data-task-id="${id}"]`)
/** A task's pinned card in the All view's tiers (not a Recent row). */
const tierCard = (page: Page, id: string) =>
  page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) .todo-pinned-card[data-task-id="${id}"]`).first()

/**
 * Contrast ratio of a Recent row's title against the fill behind it, as drawn: the title's
 * colour faded by every opacity on its way up, over the row's fills composited down to the
 * first opaque one (the selected row's blue is a translucent tint over the panel).
 */
async function titleContrast(page: Page, id: string): Promise<number> {
  return recentCard(page, id).locator('.todo-pinned-title').evaluate(withCssColor((toRgba) => (el: Element) => {
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
    const lum = (c: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    }
    let alpha = 1
    const fills: number[][] = []
    let base: number[] | null = null
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      alpha *= Number(cs.opacity)
      if (base) continue
      const bg = toRgba(cs.backgroundColor)
      if (bg[3] >= 1) base = bg
      else if (bg[3] > 0) fills.push(bg)
    }
    let behind = base ?? [255, 255, 255]
    for (const f of fills.reverse()) behind = over(f, behind)
    const fg = toRgba(getComputedStyle(el).color)
    const drawn = over([fg[0], fg[1], fg[2], alpha * fg[3]], behind)
    const [hi, lo] = [lum(drawn), lum(behind)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }))
}

/** The open row's words stay legible in both themes (WCAG AA for text, 4.5:1). */
async function expectReadable(page: Page, id: string): Promise<void> {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    expect(await titleContrast(page, id), `${theme} theme`).toBeGreaterThanOrEqual(4.5)
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme })
}

test('Recent lists what was opened, newest first, flat, and greys what is open now', async ({ page, baseURL }) => {
  const a = await createTask(`Recent open alpha ${STAMP}`)
  const b = await createTask(`Recent open bravo ${STAMP}`)
  const c = await createTask(`Recent open charlie ${STAMP}`)
  const d = await createTask(`Recent opened last delta ${STAMP}`)
  const mine = [a, b, c, d]
  await openHome(page, baseURL!, 90_000)
  // Nothing opened yet in this browser: the list says what it is for. (An empty Recent stays on
  // the tab bar under "Hide empty tabs": tests/web/tab-bar-model.test.ts; this fixture shows no bar.)
  await chooseViewOption(page, 'recent')
  await expect(page.getByTestId('todo-recent-empty')).toHaveText('Tasks you open show up here, newest first.')
  await chooseViewOption(page, 'all')

  // Open three, the way the person does: a row click in the tiers, a task link (the
  // locate every link and notification uses), and the task's details from its menu.
  await expect(tierCard(page, a)).toBeVisible({ timeout: 20_000 })
  await tierCard(page, a).click()
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('main:locate-task', { detail: { taskId: id } })), c)
  await tierCard(page, b).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.locator('.task-detail-modal-overlay')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal-overlay')).toHaveCount(0)

  await chooseViewOption(page, 'recent')
  // Newest open first; the task not opened yet is not there.
  await expect.poll(() => recentRows(page, mine), { timeout: 20_000 }).toEqual([b, c, a])
  // One flat list: no status sections, no project labels.
  await expect(page.locator('[data-testid^="status-section-"]')).toHaveCount(0)
  await expect(page.locator('.todo-pinned-list-recent .tier-project-label')).toHaveCount(0)
  // The row's time is the open time.
  await expect(recentCard(page, b).locator('.todo-recent-ago')).toHaveAttribute('title', /^Opened /)

  // An agent's update does not move a row; completing one keeps it in the list.
  await api('PATCH', `/api/tasks/${a}`, { title: `Recent open alpha renamed ${STAMP}` })
  await api('POST', `/api/tasks/${c}/complete`)
  await expect(recentCard(page, a)).toContainText('renamed')
  await expect.poll(() => recentRows(page, mine)).toEqual([b, c, a])

  // The Display menu says how the list is ordered instead of offering dead Sort/Group rows.
  await openDisplayMenu(page)
  await expect(displayMenu(page).locator('[data-view-option="sort"]')).toContainText('Newest opened first')
  await expect(displayMenu(page).locator('[data-view-option="group"]')).toContainText('Newest opened first')
  await closeDisplayMenu(page)

  // Open in this window = greyed: a's details are open, the rest are not.
  await expect(page.locator('.todo-recent-card-open')).toHaveCount(0)
  await recentCard(page, a).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.locator('.task-detail-modal-overlay')).toBeVisible()
  await expect(recentCard(page, a)).toHaveClass(/todo-recent-card-open/)
  await expect(recentCard(page, b)).not.toHaveClass(/todo-recent-card-open/)
  // Opened from the list, it stays where it is: nothing moves under the pointer.
  await expect.poll(() => recentRows(page, mine)).toEqual([b, c, a])
  await page.screenshot({ path: `${SHOTS}/recent-greyed-open.png` })
  await page.keyboard.press('Escape')
  await expect(recentCard(page, a)).not.toHaveClass(/todo-recent-card-open/)

  // A click on a Recent row is an open too; the list takes the new order on its next visit.
  // c has no session (and is completed by now): the click opens its details, never only a highlight.
  await recentCard(page, c).click()
  await expect(page.locator('.task-detail-modal-overlay')).toBeVisible()
  await expect(recentCard(page, c)).toHaveClass(/todo-recent-card-open/)
  // Open and selected (the blue fill): greyed, yet readable (2026-11-09: a faded title on the
  // selected row's blue read as barely there).
  await expect(recentCard(page, c)).toHaveClass(/todo-pinned-card-active/)
  await expectReadable(page, c)
  await recentCard(page, c).screenshot({ path: `${SHOTS}/recent-open-selected-row.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal-overlay')).toHaveCount(0)
  await expect.poll(() => recentRows(page, mine)).toEqual([b, c, a])
  // A session started from a row (its ▶) opens a column for the task: the row greys while
  // the column is open (a new-session draft bound to the task, as here, or the session itself).
  await recentCard(page, b).hover()
  await recentCard(page, b).getByRole('button', { name: 'Start a session for this task' }).click()
  await expect(recentCard(page, b)).toHaveClass(/todo-recent-card-open/, { timeout: 15_000 })
  await expect(recentCard(page, a)).not.toHaveClass(/todo-recent-card-open/)
  await page.screenshot({ path: `${SHOTS}/recent-greyed-column.png` })
  // Greyed is still readable on the selected row's fill (2026-11-09: a faded title on the
  // selected blue read as barely there). Every open row, selected or not, keeps its words legible.
  await expectReadable(page, b)
  await expect.poll(() => recentRows(page, mine)).toEqual([b, c, a])
  // An open made elsewhere while the list is on screen comes in on top.
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('main:locate-task', { detail: { taskId: id } })), d)
  await expect.poll(() => recentRows(page, mine)).toEqual([d, b, c, a])
  // A row opened from the list earlier, opened again from elsewhere (a chat link), goes to the top.
  await page.waitForTimeout(2_500)
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('main:locate-task', { detail: { taskId: id } })), a)
  await expect.poll(() => recentRows(page, mine)).toEqual([a, d, b, c])
  await chooseViewOption(page, 'all')
  await chooseViewOption(page, 'recent')
  await expect.poll(() => recentRows(page, mine)).toEqual([a, d, b, c])
  await page.locator('.todo-panel').screenshot({ path: `${SHOTS}/recent-flat.png` })

  // A reload brings the list back as it was, and restoring the focused task is not an open.
  await page.reload()
  await expect(page.locator('.todo-pinned-list-recent')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => recentRows(page, mine), { timeout: 20_000 }).toEqual([a, d, b, c])
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as Array<{ id: string }>, KEY)
  expect(stored.map((e) => e.id).filter((id) => mine.includes(id))).toEqual([a, d, b, c])

  // A task deleted elsewhere leaves the list while it is on screen (its copy is never shown again).
  expect((await fetch(`${API}/api/tasks/${c}`, { method: 'DELETE' })).ok).toBe(true)
  await expect.poll(() => recentRows(page, mine), { timeout: 15_000 }).toEqual([a, d, b])
})

test('an open made on another device joins the list when this window comes back', async ({ page, baseURL }) => {
  const here = await createTask(`Recent here ${STAMP}`)
  const phone = await createTask(`Recent on the phone ${STAMP}`)
  const mine = [here, phone]
  // The server's copy holds the phone's open, newer than this window's.
  let serverValue = '[]'
  await page.route(/\/api\/ui-prefs\?key=/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: { [KEY]: { v: serverValue, ts: 2 } } }) })
  })
  await openHome(page, baseURL!, 90_000)
  await expect(tierCard(page, here)).toBeVisible({ timeout: 20_000 })
  await tierCard(page, here).click()
  await chooseViewOption(page, 'recent')
  await expect.poll(() => recentRows(page, mine), { timeout: 20_000 }).toEqual([here])

  serverValue = JSON.stringify([{ id: phone, at: new Date(Date.now() + 60_000).toISOString() }])
  // The window comes back to the front (the pull waits 15 s between two looks).
  await page.waitForTimeout(15_500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => recentRows(page, mine), { timeout: 20_000 }).toEqual([phone, here])
})
