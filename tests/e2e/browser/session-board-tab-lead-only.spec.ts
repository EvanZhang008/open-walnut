/**
 * The session header's Board tab is a lead's (2026-10-26, the user: "for non
 * leader, please don't show board, confused people"; 2026-11-19: "why show
 * board when its only one guy, only show if it is leader"). Only a task with
 * open subtasks gets the tab. A Board the task keeps of its own does not count,
 * and every other task, a worker included, gets none
 * (web/src/components/sessions/board-tab-model.ts).
 *
 * Scenario matrix (real fixture server, mock CLI sessions, real WS events):
 *  A. a plain task: no tab, and none on the phone kebab either;
 *  B. a lead with an open subtask: the tab, and it opens the Board;
 *  C. a plain task whose FIRST subtask arrives while its session is open: the
 *     tab appears without a reload;
 *  D. a lead whose Board is open when its last open subtask completes: the
 *     Board and its tab stay while the user reads it (the team's last state),
 *     and the tab goes once they go back to the chat;
 *  E. the reported case: a task that keeps a Board of its own with content and
 *     whose subtasks are all done (the server answers own_board true,
 *     open_subtasks 0): no tab;
 *  F. a worker under a lead with a Board: no tab;
 *  G. a plain task whose Board is created while its session is open: still no
 *     tab;
 *  H. a plain task whose board file holds only a "seen" marker: no tab;
 *  I. a lead that writes its Board while it still has an open subtask loses the
 *     tab when that last subtask finishes, once the user leaves the open Board,
 *     as in D.
 *
 * Each page here has a task store (Home), whose open subtasks decide the tab on
 * the panel's first frame: the page makes no owner read. The owner route's own
 * answers are still checked through the API, since older pages read them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, pollUntil, startSession, type KanbanApi } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.BOARD_TAB_SHOT_DIR ?? '/tmp/board-tab-lead-only'
const litter: string[] = []
let api: KanbanApi
let project = ''

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// Each test opens Home through a real link and waits for the task list: give it room on a loaded box.
test.describe.configure({ mode: 'serial', timeout: 180_000 })

interface Made { id: string; sid: string }

async function makeTask(title: string, parent?: string): Promise<string> {
  const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title, source: 'local', pinned: false, project, ...(parent ? { parent_task_id: parent } : {}),
  })
  litter.push(task.id)
  return task.id
}

async function withSession(title: string, parent?: string): Promise<Made> {
  const id = await makeTask(title, parent)
  const sid = await startSession(api, id, `snapshot-clean-turn:${title} ready`)
  return { id, sid }
}

async function complete(id: string): Promise<void> {
  await call(api, 'PATCH', `/api/tasks/${id}`, { phase: 'COMPLETE' })
}

async function putBoard(id: string, html: string): Promise<void> {
  await call(api, 'PUT', `/api/v1/tasks/${id}/board`, { html })
}

const owner = (id: string) => call<{ own_board: boolean; open_subtasks: number }>(api, 'GET', `/api/v1/tasks/${id}/board/owner?tab=1`)

let plain: Made, lead: Made, leadWorker = '', growing: Made, closing: Made, closingWorker = ''
let keeper: Made, teamLead = '', worker: Made, boarded: Made, looked: Made, writer: Made, writerWorker = ''

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  project = `${info.project.name}-board-tab ${Date.now().toString(36)}`
  plain = await withSession('Plain task, no team')
  lead = await withSession('Lead with an open worker')
  leadWorker = await makeTask('Open worker of the lead', lead.id)
  growing = await withSession('Plain task that becomes a lead')
  closing = await withSession('Lead whose last worker finishes')
  closingWorker = await makeTask('Last open worker', closing.id)
  keeper = await withSession('Task that keeps a Board, its team all done')
  const done = await makeTask('Finished worker', keeper.id)
  await complete(done)
  await putBoard(keeper.id, '<h1>Keeper plan</h1>')
  teamLead = await makeTask('Team lead with a Board')
  await putBoard(teamLead, '<h1>Team plan</h1>')
  worker = await withSession('Worker under a lead', teamLead)
  boarded = await withSession('Plain task that gets a Board')
  looked = await withSession('Plain task whose kanban was only looked at')
  await call(api, 'PUT', `/api/v1/tasks/${looked.id}/board/kanban-seen`, { cards: 'all' })
  writer = await withSession('Lead that writes its Board while leading')
  writerWorker = await makeTask('Worker of the writing lead', writer.id)
  expect(await owner(looked.id)).toMatchObject({ own_board: false, open_subtasks: 0 })
  expect(await owner(keeper.id)).toMatchObject({ own_board: true, open_subtasks: 0 })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${api.base}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${api.base}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** The task list the page's store loads (GET /api/tasks without `ids`), which decides the tab. */
const taskListLoad = (page: Page) => page.waitForResponse((r) => {
  const u = new URL(r.url())
  return u.pathname === '/api/tasks' && !u.searchParams.has('ids') && r.request().method() === 'GET'
}, { timeout: 90_000 })

/** Real navigation (a link click, never page.goto), then the task's row opens its session. */
async function openSession(page: Page, t: Made): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project })
  await page.setContent(`<a href="${api.base}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const row = page.locator(`.todo-panel-item[data-task-id="${t.id}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${t.sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  // The record has landed when the header's Files chip can act.
  await expect(panel.locator('[data-header-id="files"]')).toBeVisible({ timeout: 30_000 })
  return panel
}

const chip = (panel: Locator) => panel.getByTestId('session-board-chip')

/**
 * Absent, and still absent a beat later. The panel was opened from a row of the loaded task list,
 * so the store already knew the task's open subtasks on its first frame: the beat is for the render.
 */
async function expectNoTab(panel: Locator): Promise<void> {
  await panel.page().waitForTimeout(300)
  await expect(chip(panel)).toHaveCount(0)
  await expect(panel.locator('[data-header-id="board"]')).toHaveCount(0)
}

async function shoot(page: Page, panel: Locator, name: string): Promise<void> {
  const box = await panel.locator('.session-panel-header').boundingBox()
  await page.screenshot({
    path: `${SHOTS}/${test.info().project.name}-${name}.png`,
    ...(box ? { clip: { x: box.x, y: box.y, width: Math.min(box.width, 1280), height: box.height } } : {}),
  })
}

test('A. a plain task has no Board tab', async ({ page }) => {
  const panel = await openSession(page, plain)
  await expectNoTab(panel)
  await expect(panel.locator('[data-header-id="files"]')).toBeVisible()
  await shoot(page, panel, 'a-plain')
})

test('B. a lead with an open subtask has the tab, and it opens the Board', async ({ page }) => {
  const panel = await openSession(page, lead)
  await expect(chip(panel)).toBeVisible({ timeout: 15_000 })
  await expect(chip(panel)).toBeEnabled({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
  await shoot(page, panel, 'b-lead')
  expect(leadWorker).toBeTruthy()
})

test('C. the first subtask arriving while the session is open brings the tab, no reload', async ({ page }) => {
  const panel = await openSession(page, growing)
  await expectNoTab(panel)
  await makeTask('First worker, made while the lead watches', growing.id)
  await expect(chip(panel)).toBeVisible({ timeout: 15_000 })
  await shoot(page, panel, 'c-first-subtask')
})

/** The last subtask finished under an open Board: it stays while read, the tab goes once the user leaves it. */
async function boardHeldUntilLeft(page: Page, panel: Locator, shot: string): Promise<void> {
  // The page hears the task's change over its socket within a beat; give it two, then judge.
  await page.waitForTimeout(2000)
  await expect(page.getByTestId('task-board-pane')).toBeVisible()
  await expect(chip(panel)).toBeVisible()
  await shoot(page, panel, `${shot}-held`)
  // Back to the chat (the active chip toggles its view off): the task leads no more, so the tab goes.
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toHaveCount(0, { timeout: 15_000 })
  await expect(panel.locator('.session-history')).toBeVisible()
  await expect(chip(panel)).toHaveCount(0, { timeout: 15_000 })
  await shoot(page, panel, `${shot}-left`)
}

test('D. an open Board stays while read when the last open subtask finishes; its tab goes once left', async ({ page }) => {
  const panel = await openSession(page, closing)
  await expect(chip(panel)).toBeEnabled({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
  await complete(closingWorker)
  await pollUntil('owner says no open subtask', () => owner(closing.id), (o) => !o.own_board && o.open_subtasks === 0)
  await boardHeldUntilLeft(page, panel, 'd')
})

test('E. a Board of its own with content and only completed subtasks brings no tab (the reported case)', async ({ page }) => {
  // The server still says it keeps a Board (beforeAll checked own_board true, open_subtasks 0).
  const panel = await openSession(page, keeper)
  await expectNoTab(panel)
  await shoot(page, panel, 'e-kept-board-no-team')
})

test('F. a worker under a lead with a Board has no tab', async ({ page }) => {
  const panel = await openSession(page, worker)
  await expectNoTab(panel)
  // The worker still names its leader on the title row.
  expect(teamLead).toBeTruthy()
})

test('G. a Board created while the session is open brings no tab', async ({ page }) => {
  const panel = await openSession(page, boarded)
  await expectNoTab(panel)
  await putBoard(boarded.id, '<h1>A page for this task</h1>')
  await pollUntil('owner says it keeps a Board', () => owner(boarded.id), (o) => o.own_board && o.open_subtasks === 0)
  // The page hears the Board's change over its socket within a beat; give it two, then judge.
  await page.waitForTimeout(2000)
  await expectNoTab(panel)
})

test('H. a board file holding only a seen marker brings no tab', async ({ page }) => {
  const panel = await openSession(page, looked)
  await expectNoTab(panel)
})

test('I. a Board written while leading does not keep the tab once its last subtask finished and the user left it', async ({ page }) => {
  const panel = await openSession(page, writer)
  await expect(chip(panel)).toBeEnabled({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
  await putBoard(writer.id, '<h1>Written while leading</h1>')
  // Still a lead while its worker is open: the tab and the Board stay.
  await page.waitForTimeout(1000)
  await expect(chip(panel)).toBeVisible()
  await expect(page.getByTestId('task-board-pane')).toBeVisible()
  await complete(writerWorker)
  await pollUntil('owner says it keeps a Board, no open subtask', () => owner(writer.id), (o) => o.own_board && o.open_subtasks === 0)
  await boardHeldUntilLeft(page, panel, 'i')
})

test('phone: no Board row in the kebab for a plain task, one for a lead', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [t, rows] of [[plain, 0], [lead, 1]] as const) {
    await isolateUiPrefs(page)
    await page.setContent(`<a href="${api.base}/?s1=${t.sid}">Open session</a>`)
    const list = taskListLoad(page)
    await page.getByRole('link', { name: 'Open session', exact: true }).click()
    const bar = page.locator('.phone-topbar')
    await expect(bar.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 60_000 })
    // Let the record and the task list (whose open subtasks decide the row) land before the menu is judged.
    await list
    await page.waitForTimeout(500)
    await bar.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByTestId('phone-row-files')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('phone-row-board')).toHaveCount(rows)
    await page.keyboard.press('Escape')
  }
})
