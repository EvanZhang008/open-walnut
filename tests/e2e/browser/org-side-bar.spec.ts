/**
 * The Org node's one header and the side bar beside its chat (2026-11-02, the user picked design 1 of
 * the side-bar round: "1, also good choice on the changed files, terminal and board to be on top
 * right, but I think they are not actually relevant, hide all of them in the drop down button").
 * web/src/components/org/OrgNodeDetail.tsx, OrgTaskRail.tsx, SessionPanel's headerSlot.
 *
 * Scenario matrix:
 *  1. one header: the node's name once (the chat draws no header of its own), no Chat / Team / Board
 *     tabs; on its right the chat's status, the side bar's switch and the chat's kebab;
 *  2. the kebab holds Changed, Files, Terminal and Board: Files opens beside the chat (the chat
 *     stays), Board opens the side bar's Tasks on the lead's Board;
 *  3. the side bar's tabs: Tasks with its count, Brief, Threads; Tasks by Status, Team or Board,
 *     kept per node across a reload; a node with no Board offers no Board, in the side bar or the kebab;
 *  4. widen: the side bar takes most of the node, the chat keeps its room beside it, no drag handle;
 *     back to its own width; kept per node across a reload;
 *  5. close and back from the header's switch, which is dotted while closed with news;
 *  6. a narrow window stacks the side bar above the chat, with no widen;
 *  7. an old link naming a tab (?tab=team) opens the side bar on Team, then lets go of it.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Side bar led ${STAMP}`
const PLAIN = `Side bar plain ${STAMP}`
const BOARD_TEXT = `Side board ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', plain: '', plainSid: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string, project: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
  made.push(task.id)
  return task.id
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function lead(request: APIRequestContext, project: string, cwd: string): Promise<{ id: string; sid: string }> {
  const id = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(id)
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: id })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  return { id, sid: (await (await request.get(`/api/tasks/${id}`)).json()).task.session_id }
}

async function openNode(page: Page, project: string): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(project))
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-detail').screenshot({ path: `${SHOTS}/org-side-bar-${name}-${test.info().project.name}.png` })
}

/** The chat's kebab, now in the node's header. */
async function openKebab(page: Page) {
  const tools = page.getByTestId('org-detail-chat-tools')
  await tools.locator('.task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  return menu
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  await createTask(request, `Side work ${STAMP}`, LED)
  await createTask(request, `Side review ${STAMP}`, LED)
  await createTask(request, `Plain work ${STAMP}`, PLAIN)
  const a = await lead(request, LED, cwd)
  ids.lead = a.id; ids.leadSid = a.sid
  const b = await lead(request, PLAIN, cwd)
  ids.plain = b.id; ids.plainSid = b.sid
  const board = await request.put(`/api/v1/tasks/${ids.lead}/board`, { data: { html: `<h1>Side</h1><p>${BOARD_TEXT}</p>` } })
  expect(board.ok(), await board.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('one header: the name once, the chat\'s status and kebab on its right, no Chat / Team / Board tabs', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  await expect(chat).toHaveClass(/has-host-header/)
  // The chat's own header takes no room: the node's name shows once.
  expect((await chat.locator('> .session-panel-header').boundingBox())?.height ?? 0).toBeLessThanOrEqual(1)
  await expect(detail.getByText(`${LED} VP`, { exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(detail.locator('[data-testid^="org-tab-"]')).toHaveCount(0)
  // The chat's status and its kebab are in the node's header; Changed, Files and Terminal are not on it.
  const tools = detail.getByTestId('org-detail-chat-tools')
  await expect(tools.locator('.task-kebab-btn')).toBeVisible({ timeout: 30_000 })
  await expect(detail.locator('.org-detail-head').getByText('Changed', { exact: true })).toHaveCount(0)
  await expect(detail.locator('.org-detail-head').getByText('Files', { exact: true })).toHaveCount(0)
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(chat.getByText('I processed your message: snapshot-clean-turn:Started.').or(chat.getByText('Started.')).first()).toBeVisible({ timeout: 60_000 })
  await shot(page, 'header')
})

test('the kebab holds Changed, Files, Terminal and Board: Files opens beside the chat, Board opens the side bar on it', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  let menu = await openKebab(page)
  await expect(menu.getByTestId('phone-row-changed')).toBeVisible()
  await expect(menu.getByTestId('phone-row-files')).toBeVisible()
  await expect(menu.getByTestId('phone-row-terminal')).toBeVisible()
  await expect(menu.getByTestId('phone-row-board')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/org-side-bar-kebab-${test.info().project.name}.png`, clip: { x: 700, y: 0, width: 740, height: 520 } })
  // Files opens full-screen with the chat beside it, as a session column's Files does; the panel's
  // own header is back there, so its Files chip (or Escape) closes it again.
  await menu.getByTestId('phone-row-files').click()
  await expect(chat).toHaveClass(/is-changed-open/)
  await expect(chat.locator('.chat-input-textarea')).toBeVisible()
  await expect(chat).not.toHaveClass(/has-host-header/)
  await shot(page, 'files')
  await chat.locator('.session-action-chip[data-header-id="files"]').click()
  await expect(chat).not.toHaveClass(/is-changed-open/)
  // Its view closed, it stays full screen on the chat (the user's 2026-10-27 rule); Esc leaves it,
  // and the node's header holds the chat's controls again.
  await page.keyboard.press('Escape')
  await expect(chat).toHaveClass(/has-host-header/)
  await expect(page.getByTestId('org-detail-chat-tools').locator('.task-kebab-btn')).toBeVisible()

  // Board: the side bar's Tasks on the lead's Board, the chat still beside it.
  await detail.getByTestId('org-top-threads').click()
  menu = await openKebab(page)
  await menu.getByTestId('phone-row-board').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(detail.getByTestId('org-task-mode-board')).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.getByTestId('org-rail-board')).toBeVisible()
  await expect(chat).toBeVisible()
  await detail.getByTestId('org-rail-board').getByTestId('board-view-custom').click()
  await expect(detail.getByTestId('org-rail-board').frameLocator('iframe').first().getByText(BOARD_TEXT)).toBeVisible({ timeout: 30_000 })
  await shot(page, 'board')
})

test('Tasks by Status, Team or Board, kept per node; a node with no Board offers none', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-task').click()
  await expect(detail.getByTestId('org-top-task')).toHaveText('Tasks2')
  await detail.getByTestId('org-task-mode-team').click()
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'team')
  await expect(detail.getByTestId('org-rail').getByTestId('org-team')).toBeVisible()
  await expect(detail.getByTestId('org-rail').locator('[data-testid="org-team-item"]', { hasText: `Side work ${STAMP}` })).toBeVisible()
  await shot(page, 'team')
  await page.reload()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'team')
  await detail.getByTestId('org-task-mode-status').click()
  await expect(detail.getByTestId('org-task-tabs')).toBeVisible()

  // The plain lead keeps no Board: Status and Team only, and no Board row in its kebab.
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PLAIN)}"]`).click()
  await expect(detail).toHaveAttribute('data-key', rowKey(PLAIN))
  await expect(detail.getByTestId('org-task-mode-team')).toBeVisible()
  await expect(detail.getByTestId('org-task-mode-board')).toHaveCount(0)
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'status')
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.plainSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  const menu = await openKebab(page)
  await expect(menu.getByTestId('phone-row-files')).toBeVisible()
  await expect(menu.getByTestId('phone-row-board')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('widen beside the chat and back, kept per node; close and back from the header', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const width = async (sel: string) => (await detail.locator(sel).first().boundingBox())?.width ?? 0
  await expect(detail.getByTestId('org-rail')).toBeVisible()
  const railBefore = await width('[data-testid="org-rail"]')
  await expect(detail.getByTestId('org-rail-handle')).toHaveCount(1)
  await detail.getByTestId('org-rail-wide').click()
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-wide', '1')
  await expect.poll(() => width('[data-testid="org-rail"]')).toBeGreaterThan(railBefore + 150)
  // The chat keeps its room beside it.
  expect(await width('.org-detail-col')).toBeGreaterThanOrEqual(419)
  await expect(detail.getByTestId('org-rail-handle')).toHaveCount(0)
  await shot(page, 'wide')
  await page.reload()
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-wide', '1')
  await detail.getByTestId('org-rail-wide').click()
  await expect(detail.getByTestId('org-rail')).not.toHaveAttribute('data-wide', '1')
  await expect.poll(() => width('[data-testid="org-rail"]')).toBeLessThan(railBefore + 20)

  // Close: the chat takes the node; the header's switch brings it back.
  await detail.getByTestId('org-rail-close').click()
  await expect(detail.getByTestId('org-rail')).toHaveCount(0)
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'false')
  // News while closed: the switch is dotted.
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const at = new Date().toISOString()
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${ids.lead}.json`, JSON.stringify({ version: 1, taskId: ids.lead, threads: [
    { id: 'th-00000000c001', title: 'Side bar news', titled: true, state: 'answered', reply: 'Done and live', createdAt: at, updatedAt: at,
      messages: [{ id: 'tm-00000000c001', at, text: 'is it live?', via: 'chat', answer: { at, text: 'Yes.' } }] },
  ] }))
  await page.reload()
  await expect(detail.getByTestId('org-rail-toggle-new')).toBeVisible({ timeout: 30_000 })
  await shot(page, 'closed')
  await detail.getByTestId('org-rail-toggle').click()
  await expect(detail.getByTestId('org-rail')).toBeVisible()
  await expect(detail.getByTestId('org-top-threads')).toContainText('1')
  await expect(detail.getByTestId('org-top-threads-new')).toBeVisible()
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top-threads-new')).toHaveCount(0)
  // The toggle closes it too.
  await detail.getByTestId('org-rail-toggle').click()
  await expect(detail.getByTestId('org-rail')).toHaveCount(0)
  await expect(detail.getByTestId('org-rail-toggle-new')).toHaveCount(0)
  await detail.getByTestId('org-rail-toggle').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
})

test('a narrow window stacks the side bar above the chat, with no widen; a link naming Team opens it once', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, PLAIN)
  const detail = page.getByTestId('org-detail')
  // An old link to the team: the side bar opens on Tasks by team, and the URL lets go of the tab.
  await page.evaluate((key) => {
    const url = new URL(window.location.href)
    url.searchParams.set('node', key)
    url.searchParams.set('tab', 'team')
    window.history.replaceState(window.history.state, '', url.toString())
  }, rowKey(LED))
  await page.reload()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'team')
  await expect(page).not.toHaveURL(/tab=/)

  await page.setViewportSize({ width: 900, height: 900 })
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-placement', 'top')
  await expect(detail.getByTestId('org-rail-wide')).toHaveCount(0)
  await expect(detail.locator('[data-testid="org-chat"] .session-panel')).toBeVisible()
  await shot(page, 'narrow')
})
