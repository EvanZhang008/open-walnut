/**
 * The Org page's Watching (src/core/org/org-pins.ts, web/src/components/org/org-task-tabs.ts).
 * 2026-11-02, the user: "if it watching then concideras pinnedl rename this to watching", then
 * "same wathcing as regular home pannel". One list, Home's Watch (Task.watched_at):
 *   - the rail's first tab is Watching; the eye on a row (in the tabs and on an ask) watches the
 *     task at once, the same write Home's eye makes, and the server keeps it
 *   - the Watching tab lists the node's watched work in watch order, each with its own state's dot
 *   - the Org list shows them under the node's chat row; a click opens the task beside the page,
 *     × (or Delete) stops watching it there
 *   - Home's Watching lists what the Org page watches; a watch made elsewhere (Home, an agent)
 *     shows on the Org page without a reload
 *   - a refused watch goes back
 *   - a task whose session panel is locked (beside the Org page, or on Home) hangs under its row
 *     too, each row saying why with an eye, a lock, or both; unlocked and not watched, it goes
 *     ("if a taks is lock also show here, show icon of watch or lock")
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { lockLeftmostPanel } from './draft-helpers'
import { openTasksBy, showTasks } from './org-view-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org watch ${STAMP}`
const made: string[] = []
const ids = { lead: '', a: '', b: '', c: '', d: '', dSid: '' }
const NODE = `project:${PROJECT.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
}

async function watchedAt(request: APIRequestContext, id: string): Promise<string | null> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { watched_at?: string } | undefined
  return task?.watched_at ?? null
}

async function openNode(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
  // A lead opens on its Threads (2026-11-04); its tasks are in Tasks.
  await showTasks(page)
}

const railTab = (page: Page, tab: string) => page.getByTestId('org-rail').locator(`[data-testid="org-task-tab"][data-tab="${tab}"]`)
const listWatched = (page: Page, node: string) => page.locator(`[data-testid="org-watched"][data-key="${node}"] [data-testid="org-watched-item"]`)
const railItem = (page: Page, id: string) => page.getByTestId('org-rail').locator(`.org-task-item:has([data-testid="org-task-row"][data-task-id="${id}"])`)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  ids.a = await createTask(request, `Prune the pear trees ${STAMP}`)
  ids.b = await createTask(request, `Order new ladders ${STAMP}`)
  ids.c = await createTask(request, `Count the hives ${STAMP}`)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  // A task with a session, so its panel can be locked (the mock CLI answers it); the others wait.
  ids.d = await createTask(request, `Mend the fence ${STAMP}`)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.dSid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Fence ready ${STAMP}`, taskId: ids.d })).sessionId
})

test.afterAll(async ({ request }) => {
  if (ids.dSid) await request.post(`/api/v1/sessions/${ids.dSid}/terminate`, { data: { force: true } })
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('a row\'s eye watches it; the Watching tab lists them first, in order; the list shows them under the chat; Home lists them too', async ({ page, request }) => {
  test.setTimeout(180_000)
  await openNode(page)
  // Watching is the first tab, under Home's name, and the node still opens on Needs you.
  const tabs = page.getByTestId('org-rail').getByTestId('org-task-tab')
  await expect(tabs.first()).toHaveAttribute('data-tab', 'watching')
  await expect(tabs.first()).toContainText('Watching')
  await expect(page.getByTestId('org-rail')).not.toContainText('Pinned')
  await expect(railTab(page, 'needs')).toHaveAttribute('aria-selected', 'true')
  await railTab(page, 'watching').click()
  await expect(page.getByTestId('org-rail').getByTestId('org-task-empty')).toContainText('Nothing watched here')

  // Nobody started the tasks (no session yet): watch two from the Not started tab.
  await railTab(page, 'notstarted').click()
  for (const id of [ids.b, ids.a]) {
    const item = railItem(page, id)
    await item.hover()
    const toggle = item.getByTestId('org-watch-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAccessibleName(/^Watch /)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toHaveAccessibleName(/^Stop watching /)
  }
  await expect.poll(() => watchedAt(request, ids.a)).toBeTruthy()
  await expect.poll(() => watchedAt(request, ids.b)).toBeTruthy()
  await expect(railTab(page, 'watching')).toContainText('2')

  // Watching: in watch order, each with its own state.
  await railTab(page, 'watching').click()
  const rows = page.getByTestId('org-rail').locator('[data-testid="org-task-list"][data-tab="watching"] [data-testid="org-task-row"]')
  await expect(rows).toHaveCount(2)
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))).toEqual([ids.b, ids.a])
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual(['waiting', 'waiting'])

  // The list: the same tasks under the node's row, a little in from the row's own name.
  const children = listWatched(page, NODE)
  await expect(children).toHaveCount(2)
  await expect(children.first()).toContainText(`Order new ladders ${STAMP}`)
  const rowBox = (await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).boundingBox())!
  const nameBox = (await page.locator(`[data-testid="org-channel"][data-key="${NODE}"] .org-channel-name`).boundingBox())!
  const childBox = (await children.first().locator('.org-watched-title').boundingBox())!
  expect(childBox.x).toBeGreaterThan(rowBox.x + 8)
  expect(childBox.x).toBeLessThan(nameBox.x)
  expect(childBox.y).toBeGreaterThan(rowBox.y + rowBox.height - 4)
  // Under its VP only, never a second time under the CEO.
  await expect(page.locator(`[data-testid="org-watched"][data-key="main"] [data-task-id="${ids.a}"]`)).toHaveCount(0)
  await page.locator('.org-list').screenshot({ path: `test-results/org-watching-list-${test.info().project.name}.png` })
  await page.getByTestId('org-rail').screenshot({ path: `test-results/org-watching-rail-${test.info().project.name}.png` })

  // A click opens the task beside the page; the Org page stays.
  await children.first().getByTestId('org-watched-open').click()
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/org\?/)

  // Home's Watching lists the same two.
  await page.locator('.sidebar-home-group a').first().click()
  const panel = page.locator('.todo-panel').first()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await setStatusSectionOpen(panel, 'watching', true)
  for (const id of [ids.a, ids.b]) await showSectionCard(panel, 'watching', id)
})

test('× in the list stops watching; a watch made elsewhere shows without a reload; a refused watch goes back', async ({ page, request }) => {
  test.setTimeout(180_000)
  await openNode(page)
  const children = listWatched(page, NODE)
  await expect(children).toHaveCount(2, { timeout: 30_000 })
  const first = children.first()
  await first.hover()
  await first.getByTestId('org-watched-stop').click()
  await expect(children).toHaveCount(1)
  await expect.poll(() => watchedAt(request, ids.b)).toBeNull()
  await expect(railTab(page, 'watching')).toContainText('1')

  // Home's eye (another window) watches one: the node's tab and its row show it at once.
  const res = await request.patch(`/api/v1/tasks/${ids.c}`, { data: { watched_at: new Date().toISOString() } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect(page.locator(`[data-testid="org-watched"][data-key="${NODE}"] [data-testid="org-watched-item"][data-task-id="${ids.c}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(railTab(page, 'watching')).toContainText('2')

  // A refused watch shows on the click, then goes back.
  await page.route(`**/api/tasks/${ids.b}`, (route) => (route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused"}' })
    : route.fallback()))
  await railTab(page, 'notstarted').click()
  const item = railItem(page, ids.b)
  await item.hover()
  await item.getByTestId('org-watch-toggle').click()
  await expect(item.getByTestId('org-watch-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })
  await expect(children).toHaveCount(2)
  await page.unroute(`**/api/tasks/${ids.b}`)

  // Stop one from the Watching tab: it leaves the tab and the list.
  await railTab(page, 'watching').click()
  const last = railItem(page, ids.a)
  await last.hover()
  await last.getByTestId('org-watch-toggle').click()
  await expect(children).toHaveCount(1)
  await expect.poll(() => watchedAt(request, ids.a)).toBeNull()

  // From the keyboard: a watched task in the list is an option; Delete stops watching it.
  const item_c = page.locator(`[data-testid="org-watched"][data-key="${NODE}"] [data-testid="org-watched-item"][data-task-id="${ids.c}"] [data-testid="org-watched-open"]`)
  await expect(item_c).toHaveAttribute('role', 'option')
  await item_c.focus()
  await page.keyboard.press('Delete')
  await expect(item_c).toHaveCount(0)
  await expect(page.getByTestId('org-rail').getByTestId('org-task-empty')).toContainText('Nothing watched here')
  await expect(page.locator(`[data-testid="org-watched"][data-key="${NODE}"]`)).toHaveCount(0)
  await expect.poll(() => watchedAt(request, ids.c)).toBeNull()
})

test('a locked session panel hangs its task under the row with a lock; eye and lock when both; unlocked, it goes', async ({ page, request }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await openNode(page)
  const kept = page.locator(`[data-testid="org-watched"][data-key="${NODE}"] [data-testid="org-watched-item"][data-task-id="${ids.d}"]`)
  await expect(kept).toHaveCount(0)

  // Beside the Org page: open the task and lock its panel.
  await openTasksBy(page, 'team')
  const side = page.getByTestId('org-side')
  await expect(async () => {
    await page.locator(`[data-testid="org-team-item"][data-task-id="${ids.d}"]`).click()
    await expect(side).toHaveAttribute('data-session-id', ids.dSid, { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await side.locator('.session-panel-lock').click()
  await expect(side).toHaveClass(/is-locked/)
  await expect(kept).toHaveCount(1)
  await expect(kept).toHaveAttribute('data-locked', 'true')
  const why = kept.getByTestId('org-watched-why')
  await expect(why).toHaveAttribute('data-why', 'lock')
  // Open beside the page: a light tint of the selected row's accent, and never a frame.
  await expect(kept).toHaveAttribute('data-open', 'true')
  const look = await kept.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, outline: c.outlineStyle, border: c.borderTopStyle } })
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(look.outline).toBe('none')
  expect(look.border).toBe('none')
  // Only a watch has a ×: a lock is undone where it was made.
  await expect(kept.getByTestId('org-watched-stop')).toHaveCount(0)
  // The reason sits on the row's guide line, before the state dot, small and apart from it; the
  // title keeps its place a little in from the row's name.
  const [whyBox, dot, title, group, name] = await Promise.all([
    why.boundingBox(), kept.locator('.org-watched-open > i').boundingBox(), kept.locator('.org-watched-title').boundingBox(),
    page.locator(`[data-testid="org-watched"][data-key="${NODE}"]`).boundingBox(),
    page.locator(`[data-testid="org-channel"][data-key="${NODE}"] .org-channel-name`).boundingBox(),
  ])
  expect(whyBox!.x + whyBox!.width).toBeLessThanOrEqual(dot!.x)
  expect(whyBox!.height).toBeLessThanOrEqual(16)
  expect(Math.abs(whyBox!.x + whyBox!.width / 2 - group!.x)).toBeLessThanOrEqual(2)
  expect(title!.x).toBeLessThan(name!.x)

  // Watched too: the eye and the lock in one glyph, and × stops only the watch.
  const res = await request.patch(`/api/v1/tasks/${ids.d}`, { data: { watched_at: new Date().toISOString() } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect(why).toHaveAttribute('data-why', 'both', { timeout: 30_000 })
  await kept.hover()
  await kept.getByTestId('org-watched-stop').click()
  await expect.poll(() => watchedAt(request, ids.d)).toBeNull()
  await expect(why).toHaveAttribute('data-why', 'lock')
  await expect(kept).toHaveCount(1)

  // Unlocked and not watched: gone at once.
  await side.locator('.session-panel-lock').click()
  await expect(kept).toHaveCount(0)

  // On Home: a locked column of the task's session hangs it under its row the same way.
  // One column of the task's session on Home (the saved layout record, written once).
  await page.evaluate((sid) => localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id: sid, locked: false }] })), ids.dSid)
  await page.reload()
  await page.locator('.sidebar-home-group a').first().click()
  const column = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.dSid}"]`)
  await expect(column).toBeVisible({ timeout: 30_000 })
  await lockLeftmostPanel(page)
  await expect(column.locator('.session-panel-lock.is-locked')).toBeVisible()
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(kept).toHaveCount(1, { timeout: 30_000 })
  await expect(why).toHaveAttribute('data-why', 'lock')
  await page.locator('.sidebar-home-group a').first().click()
  await column.locator('.session-panel-lock').click()
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)).toBeVisible()
  await expect(kept).toHaveCount(0)
})
