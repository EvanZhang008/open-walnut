/**
 * The Directors under a VP (web/src/components/org/OrgLeaders.tsx, the `org_leaders` experiment).
 * 2026-11-20, the user: "show the leaders under VP, also leader below them ... also in org chart, but
 * by default it should be collapsed", then: leaders sit under their project, and a watched leader
 * keeps its watched row when the leaders open. Checked here:
 *   - off: no line anywhere
 *   - on: one folded "N leaders" line under the VP's row; opened, the project's name, then each
 *     leader (eye when watched, "leads N"); the leader under a leader behind its own fold; the
 *     watched row stays; the folds are kept across a reload; a leader opens beside the page;
 *     a search for a leader shows it
 *   - the chart's card has the same line, and a leader there opens beside the page
 *   - a right-click on a Director: Open chat, Open task, Remove from Directors (it leaves at once,
 *     the task stores director 'no'); the task kebab's Team row makes a task with no subtasks one;
 *     a VP's right-click "New Director…" opens the fold on a name input, Enter makes the task (a
 *     Director, not started) and opens it beside the page
 *   - Settings: the "In their own section" layout lists every Director under DIRECTORS; project names off
 *     drops the fold's project headings; both are kept on the server (GET /api/v1/org/settings)
 *   - off: none of the Director actions or settings show
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import fs from 'node:fs/promises'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org leaders ${STAMP}`
const NODE = `project:${PROJECT.trim().toLowerCase()}`
const FLAG = 'org_leaders'
const made: string[] = []
const ids = { team: '', sub: '', solo: '' }
let flagsBefore: Record<string, boolean> | null = null
const SHOTS = `${process.env.WALNUT_TASK_DIR || 'test-results'}/shots`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string, parent?: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  if (parent) {
    const res = await request.patch(`/api/tasks/${task.id}`, { data: { parent_task_id: parent } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  return task.id
}

async function setFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const now = { ...(cfg.config?.experimental ?? {}) }
  if (flagsBefore === null) flagsBefore = { ...now }
  const res = await request.put('/api/config', { data: { experimental: { ...now, [FLAG]: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function openOrg(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`)).toBeVisible()
}

const listLeaders = (page: Page) => page.locator(`.org-list [data-testid="org-leaders"][data-key="${NODE}"]`)
const leaderRow = (scope: ReturnType<typeof listLeaders>, id: string) => scope.locator(`[data-testid="org-leader"][data-task-id="${id}"]`)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and settings: run them on a test server, never production')
  ids.team = await createTask(request, `Beds team ${STAMP}`)
  await createTask(request, `Bed one ${STAMP}`, ids.team)
  ids.sub = await createTask(request, `Bed two lead ${STAMP}`, ids.team)
  await createTask(request, `Bed two worker ${STAMP}`, ids.sub)
  ids.solo = await createTask(request, `Solo task ${STAMP}`)
  const watched = await request.patch(`/api/tasks/${ids.team}`, { data: { watched_at: new Date().toISOString() } })
  expect(watched.ok(), await watched.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  await request.put('/api/v1/org/settings', { data: { directorsLayout: 'fold', directorsShowProjects: true } })
  for (const id of [...made].reverse()) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('off, nothing changes: no leaders line in the list or the chart', async ({ page, request }) => {
  await setFlag(request, false)
  await openOrg(page)
  // The watched task hangs under the row as before.
  await expect(page.locator(`[data-testid="org-watched"][data-key="${NODE}"] [data-testid="org-watched-item"][data-task-id="${ids.team}"]`)).toBeVisible()
  await expect(page.getByTestId('org-leaders')).toHaveCount(0)
  await page.getByTestId('org-open-chart').click()
  await expect(page.getByTestId('org-chart')).toBeVisible()
  await expect(page.getByTestId('org-leaders')).toHaveCount(0)
})

test('on: folded by default; opened, the project, its leader with eye and count, the leader under it, the watched row kept', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  await openOrg(page)
  const box = listLeaders(page)
  const toggle = box.getByTestId('org-leaders-toggle')
  await expect(toggle).toHaveText(/1 director$/)
  await expect(toggle).toHaveAttribute('data-open', 'false')
  await expect(box.getByTestId('org-leaders-list')).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('data-open', 'true')
  await expect(box.getByTestId('org-leaders-project')).toHaveText(PROJECT)
  const team = leaderRow(box, ids.team)
  await expect(team.getByTestId('org-leader-leads')).toHaveText('leads 2')
  await expect(team.getByTestId('org-leader-eye')).toBeVisible()
  // A task with no team of its own is no leader.
  await expect(leaderRow(box, ids.solo)).toHaveCount(0)
  // The watched row stays where it was (2026-11-20, the user: it must not disappear).
  await expect(page.locator(`[data-testid="org-watched"][data-key="${NODE}"] [data-testid="org-watched-item"][data-task-id="${ids.team}"]`)).toBeVisible()

  // The leader under it is folded too; its own fold opens it.
  await expect(leaderRow(box, ids.sub)).toHaveCount(0)
  await team.getByTestId('org-leader-fold').click()
  const sub = leaderRow(box, ids.sub)
  await expect(sub).toHaveAttribute('data-depth', '1')
  await expect(sub.getByTestId('org-leader-leads')).toHaveText('leads 1')

  // Kept across a reload.
  await page.reload()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(listLeaders(page).getByTestId('org-leaders-toggle')).toHaveAttribute('data-open', 'true')
  await expect(leaderRow(listLeaders(page), ids.sub)).toBeVisible()

  // Keyboard: Left folds the line, Right opens it again.
  const again = listLeaders(page).getByTestId('org-leaders-toggle')
  await again.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(again).toHaveAttribute('data-open', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(again).toHaveAttribute('data-open', 'true')

  // Up and Down walk the leaders in the order drawn, and back to the line.
  await page.keyboard.press('ArrowDown')
  await expect(leaderRow(listLeaders(page), ids.team).getByTestId('org-leader-open')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(again).toBeFocused()

  // A leader opens beside the page.
  await leaderRow(listLeaders(page), ids.sub).getByTestId('org-leader-open').click()
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })

  // Folded again, it stays folded.
  await again.click()
  await expect(again).toHaveAttribute('data-open', 'false')
  await expect(listLeaders(page).getByTestId('org-leaders-list')).toHaveCount(0)
})

test('a search for a leader shows its VP with the leaders open', async ({ page, request }) => {
  await setFlag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(`Bed two lead ${STAMP}`)
  const box = listLeaders(page)
  await expect(box.getByTestId('org-leaders-toggle')).toHaveAttribute('data-open', 'true')
  await expect(leaderRow(box, ids.team)).toBeVisible()
  // The match is a leader under a leader: its fold shows open too.
  await expect(leaderRow(box, ids.sub)).toBeVisible()
  // A click on a fold the search opened closes it for this search.
  await box.getByTestId('org-leaders-toggle').click()
  await expect(box.getByTestId('org-leaders-toggle')).toHaveAttribute('data-open', 'false')
  await expect(box.getByTestId('org-leaders-list')).toHaveCount(0)
  // Cleared, the search leaves the fold as it was (folded).
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(box.getByTestId('org-leaders-toggle')).toHaveAttribute('data-open', 'false')
})

test('the chart card has the same folded line; a leader there opens beside the page', async ({ page, request }) => {
  await setFlag(request, true)
  await openOrg(page)
  await page.getByTestId('org-open-chart').click()
  const card = page.locator(`[data-testid="org-chart-vp"][data-project="${PROJECT}"]`)
  const toggle = card.getByTestId('org-leaders-toggle')
  await expect(toggle).toHaveAttribute('data-open', 'false')
  // The projects are still there, as before.
  await expect(card.locator(`[data-testid="org-chart-project"][data-project="${PROJECT}"]`)).toBeVisible()
  await toggle.click()
  await expect(card.getByTestId('org-leaders-project')).toHaveText(PROJECT)
  await card.locator(`[data-testid="org-leader"][data-task-id="${ids.team}"] [data-testid="org-leader-open"]`).click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })
})

const taskOf = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { director?: string; session_id?: string; session_ids?: string[]; title: string } }).task

async function openFold(page: Page) {
  const toggle = listLeaders(page).getByTestId('org-leaders-toggle')
  if ((await toggle.getAttribute('data-open')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('data-open', 'true')
  return toggle
}

test('a right-click on a Director: Open chat, Open task, Remove from Directors; removed, it leaves at once', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  const rm = await createTask(request, `Removable team ${STAMP}`)
  await createTask(request, `Removable worker ${STAMP}`, rm)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openOrg(page)
  const toggle = await openFold(page)
  await expect(toggle).toHaveText(/2 directors$/)
  await fs.mkdir(SHOTS, { recursive: true })
  await page.locator('.org-list').screenshot({ path: `${SHOTS}/web-fold.png` })
  await leaderRow(listLeaders(page), rm).click({ button: 'right' })
  const menu = page.getByTestId('org-director-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open chat', 'Open task', 'Remove from Directors'])
  await page.screenshot({ path: `${SHOTS}/web-menu.png`, clip: { x: 0, y: 0, width: 760, height: 800 } })
  await menu.getByRole('menuitem', { name: 'Remove from Directors' }).click()
  // At once (the store applies it before the server answers), and stored.
  await expect(leaderRow(listLeaders(page), rm)).toHaveCount(0, { timeout: 2_000 })
  await expect(toggle).toHaveText(/1 director$/)
  await expect.poll(async () => (await taskOf(request, rm)).director).toBe('no')
  // Its team is untouched: the worker still hangs under it.
  await page.reload()
  await page.getByTestId('org-search').fill(PROJECT)
  await expect(listLeaders(page).getByTestId('org-leaders-toggle')).toHaveText(/1 director$/)
})

test('the task kebab\'s Team row makes a task with no subtasks a Director; it shows under its VP', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: PROJECT })
  await loadHome(page)
  const row = page.locator(`.todo-panel [data-task-id="${ids.solo}"]`).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.getByRole('button', { name: 'More actions', exact: true }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await menu.getByTestId('kebab-team-toggle').click()
  await menu.getByTestId('kebab-director-make').click()
  await expect.poll(async () => (await taskOf(request, ids.solo)).director).toBe('yes')
  // The collapsed row says so, and the entry turns into its undo.
  await row.getByRole('button', { name: 'More actions', exact: true }).click()
  await expect(menu.getByTestId('kebab-team-toggle')).toContainText('Team: Director')
  await menu.getByTestId('kebab-team-toggle').click()
  await expect(menu.getByTestId('kebab-director-remove')).toHaveText(/Remove from Directors/)
  await page.keyboard.press('Escape')
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await openFold(page)
  await expect(leaderRow(listLeaders(page), ids.solo).getByTestId('org-leader-leads')).toHaveText('leads 0')
})

test('a VP\'s right-click New Director… opens the fold on a name input; Enter makes a Director, not started, and opens it', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openOrg(page)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click({ button: 'right' })
  const rowMenu = page.getByTestId('org-channel-menu')
  await rowMenu.getByRole('menuitem', { name: 'New Director…' }).click()
  const input = listLeaders(page).getByTestId('org-new-director-input')
  await expect(input).toBeFocused()
  const title = `Night shift ${STAMP}`
  await input.fill(title)
  await page.locator('.org-list').screenshot({ path: `${SHOTS}/web-new.png` })
  await input.press('Enter')
  const made1 = listLeaders(page).locator('[data-testid="org-leader"]', { hasText: title })
  await expect(made1).toBeVisible()
  // Shown at once under a temporary id, then under the server's.
  await expect(made1).not.toHaveAttribute('data-task-id', /^tmp-/)
  const id = (await made1.getAttribute('data-task-id'))!
  made.push(id)
  await expect(page.getByTestId('org-side')).toHaveAttribute('data-target', `task:${id}`, { timeout: 30_000 })
  const t = await taskOf(request, id)
  expect(t.director).toBe('yes')
  // In the VP's own project, never the Inbox.
  expect(t.project).toBe(PROJECT)
  expect(t.session_id ?? '').toBe('')
  expect(t.session_ids ?? []).toEqual([])
  // The fold keeps "+ New Director" as its last row; Escape closes the input it opens.
  await listLeaders(page).getByTestId('org-new-director').click()
  await expect(listLeaders(page).getByTestId('org-new-director-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(listLeaders(page).getByTestId('org-new-director-form')).toHaveCount(0)
  await expect(listLeaders(page).getByTestId('org-new-director')).toBeVisible()
})

test('settings: In their own section lists every Director as a row under DIRECTORS; project names off drops the fold\'s headings', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openOrg(page)
  await page.getByTestId('org-settings').click()
  const panel = page.getByTestId('org-settings-menu')
  await expect(panel.getByTestId('org-settings-directors')).toBeVisible()
  await panel.getByTestId('directors-layout-sections').click()
  await expect.poll(async () => ((await (await request.get('/api/v1/org/settings')).json()) as { directorsLayout?: string }).directorsLayout).toBe('sections')
  await page.keyboard.press('Escape')
  const section = page.locator('.org-list [data-testid="org-directors"]')
  await expect(section).toBeVisible()
  await expect(page.locator('.org-list [data-testid="org-leaders"]')).toHaveCount(0)
  // team, the leader under it (one level, no indent), solo (made one above), the New Director.
  for (const id of [ids.team, ids.sub, ids.solo]) {
    await expect(section.locator(`[data-testid="org-director-row"][data-task-id="${id}"] [data-testid="org-director-line"]`)).toContainText(' · ')
  }
  await expect(section.getByTestId('org-directors-head')).toHaveText(/Directors · \d+/)
  await page.locator('.org-list').screenshot({ path: `${SHOTS}/web-p1.png` })
  // Its menu is the fold's.
  await section.locator(`[data-testid="org-director-row"][data-task-id="${ids.sub}"]`).click({ button: 'right' })
  await expect(page.getByTestId('org-director-menu').getByRole('menuitem')).toHaveText(['Open chat', 'Open task', 'Remove from Directors'])
  await page.keyboard.press('Escape')

  // Back to the fold, with the project names off.
  await page.getByTestId('org-settings').click()
  await panel.getByTestId('directors-layout-fold').click()
  await panel.getByTestId('org-settings-directors-projects').click()
  await expect.poll(async () => ((await (await request.get('/api/v1/org/settings')).json()) as { directorsShowProjects?: boolean }).directorsShowProjects).toBe(false)
  await page.keyboard.press('Escape')
  await expect(section).toHaveCount(0)
  await openFold(page)
  await expect(listLeaders(page).getByTestId('org-leaders-project')).toHaveCount(0)
  await expect(leaderRow(listLeaders(page), ids.team)).toBeVisible()
  await page.locator('.org-list').screenshot({ path: `${SHOTS}/web-no-projects.png` })
  await request.put('/api/v1/org/settings', { data: { directorsLayout: 'fold', directorsShowProjects: true } })
})

test('the chart: a card\'s menu has New Director…, its input\'s Escape stays in the sheet; a Director there has its menu', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  await openOrg(page)
  await page.getByTestId('org-open-chart').click()
  const card = page.locator(`[data-testid="org-chart-vp"][data-project="${PROJECT}"]`)
  await card.click({ button: 'right', position: { x: 40, y: 16 } })
  await page.getByTestId('org-chart-node-menu').getByRole('menuitem', { name: 'New Director…' }).click()
  const input = card.getByTestId('org-new-director-input')
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(card.getByTestId('org-new-director-form')).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  // Enter makes it: the sheet closes, so the new task opens in sight, beside the page.
  await card.click({ button: 'right', position: { x: 40, y: 16 } })
  await page.getByTestId('org-chart-node-menu').getByRole('menuitem', { name: 'New Director…' }).click()
  await card.getByTestId('org-new-director-input').fill(`Chart director ${STAMP}`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(page.getByTestId('org-side')).toHaveAttribute('data-target', /^task:/, { timeout: 30_000 })
  const chartMade = (await page.getByTestId('org-side').getAttribute('data-target'))!.slice('task:'.length)
  made.push(chartMade)
  expect((await taskOf(request, chartMade)).project).toBe(PROJECT)
  await page.getByTestId('org-open-chart').click()
  await card.locator(`[data-testid="org-leader"][data-task-id="${ids.team}"]`).click({ button: 'right' })
  await expect(page.getByTestId('org-director-menu').getByRole('menuitem')).toHaveText(['Open chat', 'Open task', 'Remove from Directors'])
  await page.getByTestId('org-director-menu').getByRole('menuitem', { name: 'Open task' }).click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(page.getByTestId('org-side')).toHaveAttribute('data-target', `task:${ids.team}`, { timeout: 30_000 })
})

test('off: no New Director in a VP\'s menu, no Director entry in the task kebab, no Directors settings', async ({ page, request }) => {
  await setFlag(request, false)
  await openOrg(page)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click({ button: 'right' })
  await expect(page.getByTestId('org-channel-menu')).toBeVisible()
  await expect(page.getByTestId('org-channel-menu').getByRole('menuitem', { name: 'New Director…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('org-settings').click()
  await expect(page.getByTestId('org-settings-menu')).toBeVisible()
  await expect(page.getByTestId('org-settings-directors')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: PROJECT })
  await loadHome(page)
  const row = page.locator(`.todo-panel [data-task-id="${ids.solo}"]`).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.getByRole('button', { name: 'More actions', exact: true }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu.getByTestId('kebab-team-toggle')).not.toContainText('Director')
  await menu.getByTestId('kebab-team-toggle').click()
  await expect(menu.getByTestId('kebab-adopt-worker')).toBeVisible()
  await expect(menu.locator('[data-testid^="kebab-director-"]')).toHaveCount(0)
})
