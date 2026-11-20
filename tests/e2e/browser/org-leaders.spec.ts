/**
 * The leaders under a VP (web/src/components/org/OrgLeaders.tsx, the `org_leaders` experiment).
 * 2026-11-20, the user: "show the leaders under VP, also leader below them ... also in org chart, but
 * by default it should be collapsed", then: leaders sit under their project, and a watched leader
 * keeps its watched row when the leaders open. Checked here:
 *   - off: no line anywhere
 *   - on: one folded "N leaders" line under the VP's row; opened, the project's name, then each
 *     leader (eye when watched, "leads N"); the leader under a leader behind its own fold; the
 *     watched row stays; the folds are kept across a reload; a leader opens beside the page;
 *     a search for a leader shows it
 *   - the chart's card has the same line, and a leader there opens beside the page
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org leaders ${STAMP}`
const NODE = `project:${PROJECT.trim().toLowerCase()}`
const FLAG = 'org_leaders'
const made: string[] = []
const ids = { team: '', sub: '', solo: '' }
let flagsBefore: Record<string, boolean> | null = null

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
  await expect(toggle).toHaveText(/1 leader$/)
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
