/**
 * The session header's Board tab is a lead's (2026-10-26, the user: "for non
 * leader, please don't show board, confused people"). Only a task with open
 * subtasks, or one that keeps a Board of its own with something in it, gets the
 * tab; every other task, a worker included, gets none.
 *
 * Scenario matrix (real fixture server, mock CLI sessions, real WS events):
 *  A. a plain task: no tab, and none on the phone kebab either;
 *  B. a lead with an open subtask: the tab, and it opens the Board;
 *  C. a plain task whose FIRST subtask arrives while its session is open: the
 *     tab appears without a reload;
 *  D. a lead whose Board is open when its last open subtask completes and it
 *     keeps no Board of its own: the tab goes and the view closes to the chat;
 *  E. a lead whose subtasks are all done but who keeps a Board: the tab stays;
 *  F. a worker under a lead with a Board: no tab;
 *  G. a plain task whose Board is created while its session is open: the tab
 *     appears without a reload;
 *  H. a plain task whose board file holds only a "seen" marker: no tab;
 *  I. a lead that writes its Board while it still has an open subtask keeps
 *     the tab, and its open Board, when that last subtask finishes.
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
// Each test opens Home through a real link and waits for the owner read: give it room on a loaded box.
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
  keeper = await withSession('Lead that keeps a Board')
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

/** The panel's owner read for a task, as the page makes it (useBoardTab). */
let ownerRead: Promise<unknown> = Promise.resolve()
const watchOwnerRead = (page: Page, id: string) => {
  // A lead may never make the read (its open subtasks decide): never an unhandled rejection.
  const read = page.waitForResponse((r) => r.url().includes(`/api/v1/tasks/${id}/board/owner?tab=1`), { timeout: 60_000 })
  read.catch(() => undefined)
  ownerRead = read
}

/** Real navigation (a link click, never page.goto), then the task's row opens its session. */
async function openSession(page: Page, t: Made): Promise<Locator> {
  watchOwnerRead(page, t.id)
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

/** Absent, and still absent once the owner read has answered and rendered. */
async function expectNoTab(panel: Locator): Promise<void> {
  await ownerRead
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

test('D. an open Board closes to the chat when the last open subtask finishes and there is no Board of its own', async ({ page }) => {
  const panel = await openSession(page, closing)
  await expect(chip(panel)).toBeEnabled({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
  await complete(closingWorker)
  await pollUntil('owner says no lead', () => owner(closing.id), (o) => !o.own_board && o.open_subtasks === 0)
  await expect(chip(panel)).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('task-board-pane')).toHaveCount(0)
  await expect(panel.locator('.session-history')).toBeVisible()
  await shoot(page, panel, 'd-closed-to-chat')
})

test('E. a lead whose subtasks are all done but that keeps a Board keeps the tab', async ({ page }) => {
  const panel = await openSession(page, keeper)
  await expect(chip(panel)).toBeVisible({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
})

test('F. a worker under a lead with a Board has no tab', async ({ page }) => {
  const panel = await openSession(page, worker)
  await expectNoTab(panel)
  // The worker still names its leader on the title row.
  expect(teamLead).toBeTruthy()
})

test('G. a Board created while the session is open brings the tab, no reload', async ({ page }) => {
  const panel = await openSession(page, boarded)
  await expectNoTab(panel)
  await putBoard(boarded.id, '<h1>A page for this task</h1>')
  await expect(chip(panel)).toBeVisible({ timeout: 15_000 })
})

test('H. a board file holding only a seen marker brings no tab', async ({ page }) => {
  const panel = await openSession(page, looked)
  await expectNoTab(panel)
})

test('I. a Board written while leading keeps the tab and the open Board when the last subtask finishes', async ({ page }) => {
  const panel = await openSession(page, writer)
  await expect(chip(panel)).toBeEnabled({ timeout: 15_000 })
  await chip(panel).click()
  await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 30_000 })
  await putBoard(writer.id, '<h1>Written while leading</h1>')
  await complete(writerWorker)
  await pollUntil('owner says it keeps a Board', () => owner(writer.id), (o) => o.own_board && o.open_subtasks === 0)
  await page.waitForTimeout(2000)
  await expect(chip(panel)).toBeVisible()
  await expect(page.getByTestId('task-board-pane')).toBeVisible()
})

test('phone: no Board row in the kebab for a plain task, one for a lead', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [t, rows] of [[plain, 0], [lead, 1]] as const) {
    if (!rows) watchOwnerRead(page, t.id)
    await isolateUiPrefs(page)
    await page.setContent(`<a href="${api.base}/?s1=${t.sid}">Open session</a>`)
    await page.getByRole('link', { name: 'Open session', exact: true }).click()
    const bar = page.locator('.phone-topbar')
    await expect(bar.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 60_000 })
    // Let the record and the owner read land before the menu is judged.
    if (!rows) await ownerRead
    await page.waitForTimeout(500)
    await bar.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByTestId('phone-row-files')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('phone-row-board')).toHaveCount(rows)
    await page.keyboard.press('Escape')
  }
})
