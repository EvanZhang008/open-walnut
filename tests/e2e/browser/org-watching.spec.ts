/**
 * The Org page's Watching (src/core/org/org-pins.ts, web/src/components/org/org-task-tabs.ts).
 * 2026-11-02, the user: "if it watching then concideras pinnedl rename this to watching", then
 * "same wathcing as regular home pannel". One list, Home's Watch (Task.watched_at):
 *   - All tasks' first section is Watching (shown while it has something); the eye on a row (in a
 *     section and on an ask) watches the task at once, the same write Home's eye makes, and the
 *     server keeps it
 *   - the Watching section lists the node's watched work in watch order, each with its own state's
 *     dot, and a watched open task is drawn there only, not again in its state's section
 *   - the Org list hangs nothing under a node's row (2026-11-22, the user: "We need to be super
 *     simple"): the row is its avatar and its name; a watched task opens beside the page from Watching
 *   - Home's Watching lists what the Org page watches; a watch made elsewhere (Home, an agent)
 *     shows on the Org page without a reload
 *   - a refused watch goes back
 *   - a task whose session panel is locked (beside the Org page, or on Home) stands beside its node,
 *     locked; on a narrow window it waits as a tab at the edge
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { lockLeftmostPanel } from './draft-helpers'
import { openSection, openTaskFromRail, sectionCount, showTasks, taskRow, taskSection } from './org-view-helpers'

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

const rail = (page: Page) => page.getByTestId('org-rail')
/** The Org list draws no task under a row: no kept rows anywhere in it. */
const listKept = (page: Page) => page.locator('.org-list [data-testid="org-watched"], .org-list [data-testid="org-watched-item"]')
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

test('a row\'s eye watches it; the Watching section lists them first, in order; the list stays one plain row; Home lists them too', async ({ page, request }) => {
  test.setTimeout(180_000)
  await openNode(page)
  // Nothing watched yet: no Watching section (an empty section is left out), and no "Pinned" anywhere.
  await expect(taskSection(rail(page), 'notstarted')).toBeVisible({ timeout: 30_000 })
  await expect(taskSection(rail(page), 'watching')).toHaveCount(0)
  await expect(rail(page)).not.toContainText('Pinned')

  // Nobody started the tasks (no session yet): watch two from the Not started section (folded by default).
  await openSection(rail(page), 'notstarted')
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

  // Watching is the first section, under Home's name, open by default: in watch order, each with its
  // own state; a watched task leaves its state's section (drawn once).
  const watching = taskSection(rail(page), 'watching')
  await expect(rail(page).getByTestId('org-task-section').first()).toHaveAttribute('data-tab', 'watching')
  await expect(watching.getByTestId('org-task-section-head')).toContainText('Watching')
  await expect(watching).toHaveAttribute('data-open', '1')
  await expect(sectionCount(rail(page), 'watching')).toHaveText('2')
  const rows = rail(page).locator('[data-testid="org-task-list"][data-tab="watching"] [data-testid="org-task-row"]')
  await expect(rows).toHaveCount(2)
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))).toEqual([ids.b, ids.a])
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual(['waiting', 'waiting'])
  for (const id of [ids.a, ids.b]) await expect(taskRow(rail(page), id)).toHaveCount(1)
  await expect(taskRow(rail(page), ids.c, 'notstarted')).toBeVisible()

  // The list: nothing hangs under the node's row; the row is its name (and a dot only for threads).
  await expect(listKept(page)).toHaveCount(0)
  await expect(page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)).toHaveText(new RegExp(`^${PROJECT}( VP)?$`))
  await page.locator('.org-list').screenshot({ path: `test-results/org-watching-list-${test.info().project.name}.png` })
  await page.getByTestId('org-rail').screenshot({ path: `test-results/org-watching-rail-${test.info().project.name}.png` })

  // A watched task opens beside the page from the node's Tasks; the Org page stays.
  await openTaskFromRail(page, ids.b, () => expect(page.getByTestId('org-side')).toBeVisible({ timeout: 3_000 }))
  await expect(page).toHaveURL(/\/org\?/)

  // Home's Watching lists the same two.
  await page.locator('.sidebar-home-group a').first().click()
  const panel = page.locator('.todo-panel').first()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await setStatusSectionOpen(panel, 'watching', true)
  for (const id of [ids.a, ids.b]) await showSectionCard(panel, 'watching', id)
})

test('Watching\'s eye stops watching; a watch made elsewhere shows without a reload; a refused watch goes back', async ({ page, request }) => {
  test.setTimeout(180_000)
  await openNode(page)
  await expect(sectionCount(rail(page), 'watching')).toHaveText('2', { timeout: 30_000 })
  const first = railItem(page, ids.b)
  await first.hover()
  await first.getByTestId('org-watch-toggle').click()
  await expect.poll(() => watchedAt(request, ids.b)).toBeNull()
  await expect(sectionCount(rail(page), 'watching')).toHaveText('1')

  // Home's eye (another window) watches one: the node's section shows it at once.
  const res = await request.patch(`/api/v1/tasks/${ids.c}`, { data: { watched_at: new Date().toISOString() } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect(sectionCount(rail(page), 'watching')).toHaveText('2', { timeout: 30_000 })
  await expect(taskRow(rail(page), ids.c, 'watching')).toBeVisible()

  // A refused watch shows on the click, then goes back.
  await page.route(`**/api/tasks/${ids.b}`, (route) => (route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused"}' })
    : route.fallback()))
  await openSection(rail(page), 'notstarted')
  const item = railItem(page, ids.b)
  await item.hover()
  await item.getByTestId('org-watch-toggle').click()
  await expect(item.getByTestId('org-watch-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })
  await expect(sectionCount(rail(page), 'watching')).toHaveText('2')
  await page.unroute(`**/api/tasks/${ids.b}`)

  // Stop the rest from the Watching section: each goes back under Not started.
  for (const id of [ids.a, ids.c]) {
    const row = railItem(page, id)
    await row.hover()
    await row.getByTestId('org-watch-toggle').click()
    await expect.poll(() => watchedAt(request, id)).toBeNull()
  }
  await expect(taskRow(rail(page), ids.a, 'notstarted')).toBeVisible()
  // Nothing watched now: the Watching section is gone, and the list never had a row for them.
  await expect(taskSection(rail(page), 'watching')).toHaveCount(0)
  await expect(listKept(page)).toHaveCount(0)
})

test('a locked session panel stands beside its node, from the Org page or Home; unlocked, it goes', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await openNode(page)
  // The list hangs nothing under a row, locked or watched (2026-11-22): the strip is where a lock shows.
  const kept = listKept(page)
  await expect(kept).toHaveCount(0)

  // Beside the Org page: open the task and lock its panel.
  // Its row in All tasks, or its card under Needs you once its turn ended (whichever its state draws).
  const side = page.getByTestId('org-side')
  await openTaskFromRail(page, ids.d, () => expect(side).toHaveAttribute('data-session-id', ids.dSid, { timeout: 3_000 }))
  await side.locator('.session-panel-lock').click()
  await expect(side).toHaveClass(/is-locked/)
  await expect(kept).toHaveCount(0)

  // Unlocked: it stays open beside the node, no longer locked.
  await side.locator('.session-panel-lock').click()
  await expect(side).not.toHaveClass(/is-locked/)
  // Closed: a panel left open beside the node would come back with it (org-free-panel-kept.spec.ts);
  // from here on the panel beside the node is the one Home locks.
  await side.locator('.session-panel-close').first().click()
  await expect(side).toHaveCount(0)

  // On Home: a locked column of the task's session stands beside its node the same way.
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
  await expect(page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(kept).toHaveCount(0)
  // The node shows the panel Home locked beside its chat, locked, whatever was clicked before
  // (2026-11-04, the user: "when i clcik [the VP], the lcok view is not there, the lock should always
  // show for that vp"): its row, another node and back, a reload.
  const nodeRow = page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)
  const homePanel = page.locator(`[data-testid="org-side-strip"] [data-testid="org-side"][data-session-id="${ids.dSid}"]`)
  await nodeRow.click()
  await expect(homePanel).toBeVisible({ timeout: 30_000 })
  await expect(homePanel).toHaveClass(/is-locked/)
  await nodeRow.click()
  await expect(homePanel).toBeVisible()
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', 'main')
  await expect(homePanel).toHaveCount(0)
  await page.getByTestId('org-search').fill(PROJECT)
  await nodeRow.click()
  await expect(homePanel).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', NODE, { timeout: 30_000 })
  await expect(homePanel).toBeVisible({ timeout: 30_000 })
  await expect(homePanel).toHaveClass(/is-locked/)
  // A window that lays side panels over the node never covers the chat with it unasked: it waits as a
  // tab at the right edge, and a click opens it; wide again, it stands beside the chat, locked.
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(homePanel).toHaveCount(0)
  const dockItem = page.locator(`[data-testid="org-locked-dock-item"][data-id="session:${ids.dSid}"]`)
  await expect(dockItem).toBeVisible()
  await dockItem.click()
  await expect(homePanel).toBeVisible()
  await expect(dockItem).toHaveCount(0)
  await homePanel.locator('.session-panel-close, [data-testid="org-side-close"]').first().click()
  await expect(homePanel).toHaveCount(0)
  await expect(dockItem).toBeVisible()
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(homePanel).toBeVisible()
  await expect(homePanel).toHaveClass(/is-locked/)
  // Unlocked here it leaves this page at once, while Home keeps its lock.
  await homePanel.locator('.session-panel-lock').click()
  await expect(homePanel).toHaveCount(0)
  await expect(kept).toHaveCount(0)
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', 'main')
  await page.getByTestId('org-search').fill(PROJECT)
  await nodeRow.click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', NODE)
  await expect(homePanel).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-layout:home-columns'))).toMatch(/"locked":true/)
  await expect(kept).toHaveCount(0)
  // Locked on Home again, it stands beside the node again (2026-11-05: one unlock here kept it away
  // for good, whatever Home did after; org-side-columns releaseHomeTakeoff).
  await page.locator('.sidebar-home-group a').first().click()
  await column.locator('.session-panel-lock').click()
  await expect(column.locator('.session-panel-lock.is-locked')).toHaveCount(0)
  await column.locator('.session-panel-lock').click()
  await expect(column.locator('.session-panel-lock.is-locked')).toBeVisible()
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await nodeRow.click()
  await expect(homePanel).toBeVisible({ timeout: 30_000 })
  await expect(homePanel).toHaveClass(/is-locked/)
  // At phone width the Org page shows its node alone, and the phone's top bar is its own, never the
  // title of the Home column behind it (2026-11-05: it wore Home's session title and a second back).
  await page.setViewportSize({ width: 620, height: 900 })
  await expect(page.locator('.phone-topbar-title-text')).toBeVisible()
  await expect(page.locator('.phone-topbar-title-text')).not.toHaveText(`Mend the fence ${STAMP}`)
  await expect(page.locator('.phone-topbar-back')).toHaveCount(0)
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(homePanel).toBeVisible()
  // Unlocked on Home, it leaves the node too.
  await page.locator('.sidebar-home-group a').first().click()
  await column.locator('.session-panel-lock').click()
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)).toBeVisible()
  await expect(kept).toHaveCount(0)
})
