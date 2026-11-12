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
 *  3. the side bar's tabs: Tasks with its count, Brief, Threads; Tasks as All tasks or Board (two
 *     ways only), kept per node across a reload, an older build's Status or Team opening All tasks;
 *     All tasks is one list of sections, Watching / Needs you / Working open and the rest folded by
 *     default, each fold kept per node; a node with no Board offers no Board, in the side bar or the kebab;
 *  4. widen: the side bar takes most of the node, the chat keeps its room beside it, no drag handle;
 *     back to its own width; kept per node across a reload;
 *  5. close and back from the header's switch, which is dotted while closed with news;
 *  6. a narrow window stacks the side bar above the chat, with no widen;
 *  7. an old link naming a tab (?tab=team) opens the side bar on All tasks, then lets go of it;
 *  8. Quote on an ask in the side bar puts it into the chat beside it, focused;
 *  9. Minimize in the header puts the node's chat on the app's taskbar; its chip selects the node again.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openKebabGroup } from './kebab-group-helpers'
import { kebabRow } from './session-kebab-helpers'
import { openAllSections, openSection, taskSection, type OrgSectionTab } from './org-view-helpers'

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
    const res = await request.delete(`/api/tasks/${id}?force=true`)
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

test('one header: the name once, the chat\'s labels and kebab on its right, no Chat / Team / Board tabs', async ({ page }) => {
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
  // The chat's state pills (the wait, Cron, Trigger, Worker, Leader), its folded link tags and its
  // kebab are in the node's header, as on a session's title row; Changed, Files and Terminal are
  // not on it, and neither is a run status (Running, Idle): SessionPanel headerPills.
  const tools = detail.getByTestId('org-detail-chat-tools')
  await expect(tools.locator('.task-kebab-btn')).toBeVisible({ timeout: 30_000 })
  await expect(tools.locator('.session-panel-badge:not([data-header-pill]), .task-tag-pills')).toHaveCount(0)
  expect(await tools.innerText()).not.toMatch(/\b(Running|Idle|Stopped)\b/)
  const kinds = await tools.evaluate((el) => Array.from(el.children).map((c) =>
    c.matches('[data-testid="session-header-labels"]') ? 'labels'
      : c.querySelector('.task-kebab-btn') ? 'kebab'
      : c.matches('.thread-mode-pill') ? 'thread-mode'
      : c.matches('.session-panel-minimize') ? 'minimize'
      : c.matches('.task-row-pill, .task-waiting-chip, [data-header-pill]') ? 'pill'
      : `UNKNOWN:${c.className}`))
  expect(kinds.filter((k) => k.startsWith('UNKNOWN')), `header tools: ${kinds}`).toEqual([])
  // The app's taskbar is global (2026-11-08): the node's chat minimizes too, from its header.
  expect(kinds, `header tools: ${kinds}`).toContain('minimize')
  // Its Watch is no header button since 2026-11-09 (the user: "this 2 put iot in the drop down"):
  // it is the kebab's task row (the Watch test below).
  await expect(tools.locator('[data-header-id="watch"], [data-testid="session-panel-watch"], [data-header-id="locate"], [data-testid="session-panel-locate"]')).toHaveCount(0)
  // The pills come before the tags control, and the kebab is last.
  const order = kinds.filter((k) => k !== 'thread-mode')
  expect(order.lastIndexOf('pill') < Math.max(order.indexOf('labels'), order.indexOf('kebab')), `header tools: ${kinds}`).toBe(true)
  expect(order[order.length - 1], `header tools: ${kinds}`).toBe('kebab')
  await expect(detail.locator('.org-detail-head').getByText('Changed', { exact: true })).toHaveCount(0)
  await expect(detail.locator('.org-detail-head').getByText('Files', { exact: true })).toHaveCount(0)
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(chat.getByText('I processed your message: snapshot-clean-turn:Started.').or(chat.getByText('Started.')).first()).toBeVisible({ timeout: 60_000 })
  await shot(page, 'header')
})

/** A beat a person can follow, only while recording (PW_VIDEO, walnut-dev webkit --video). */
const beat = (page: Page) => (process.env.PW_VIDEO ? page.waitForTimeout(1200) : Promise.resolve())

test('Minimize in the node\'s header puts its chat on the taskbar; the chip brings the node back from another one', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  const chip = page.locator(`.session-taskbar-chip[data-session-id="${ids.leadSid}"]`)
  await expect(chip).toHaveCount(0)
  await beat(page)
  await detail.getByTestId('org-detail-chat-tools').getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(chip).toBeVisible()
  await beat(page)
  // Off to another node: the chip stays on the bar.
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PLAIN)}"]`).click()
  await expect(detail).toHaveAttribute('data-key', rowKey(PLAIN))
  await expect(chip).toBeVisible()
  await beat(page)
  // The chip selects its node (never a second copy of its chat beside the page) and leaves the bar.
  await chip.locator('.session-taskbar-open').click()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(chat).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`[data-testid="org-side"][data-session-id="${ids.leadSid}"]`)).toHaveCount(0)
  await expect(chip).toHaveCount(0)
  await beat(page)
})

test('Watch in the node\'s header kebab reads Stop watching while the node\'s task is watched, and a second click ends it', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const tools = page.getByTestId('org-detail-chat-tools')
  const menu = page.locator('.task-kebab-menu')
  let watch = await kebabRow(tools, 'task-kebab-watch')
  await expect(watch).toHaveText('Watch')
  await beat(page)
  await watch.click()
  await expect(menu).toHaveCount(0)
  watch = await kebabRow(tools, 'task-kebab-watch')
  await expect(watch).toHaveText('Stop watching')
  await beat(page)
  await watch.click()
  await expect(menu).toHaveCount(0)
  await expect(await kebabRow(tools, 'task-kebab-watch')).toHaveText('Watch')
  await tools.locator('.task-kebab-btn').click()
  await expect(menu).toHaveCount(0)
})

test('the kebab\'s Open group holds Changed, Files, Terminal and Board: Files opens beside the chat, Board opens the side bar on it', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  let menu = await openKebab(page)
  await openKebabGroup(menu, 'session-kebab-open')
  await expect(menu.getByTestId('session-menu-changed')).toBeVisible()
  await expect(menu.getByTestId('session-menu-files')).toBeVisible()
  await expect(menu.getByTestId('session-menu-terminal')).toBeVisible()
  await expect(menu.getByTestId('session-menu-board')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/org-side-bar-kebab-${test.info().project.name}.png`, clip: { x: 700, y: 0, width: 740, height: 520 } })
  // Files opens full-screen with the chat beside it, as a session column's Files does; the panel's
  // own header is back there, so its Files chip (or Escape) closes it again.
  await menu.getByTestId('session-menu-files').click()
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
  await openKebabGroup(menu, 'session-kebab-open')
  await menu.getByTestId('session-menu-board').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(detail.getByTestId('org-task-mode-board')).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.getByTestId('org-rail-board')).toBeVisible()
  await expect(chat).toBeVisible()
  await detail.getByTestId('org-rail-board').getByTestId('board-view-custom').click()
  await expect(detail.getByTestId('org-rail-board').frameLocator('iframe').first().getByText(BOARD_TEXT)).toBeVisible({ timeout: 30_000 })
  await shot(page, 'board')
})

test('Tasks as All tasks or Board, kept per node; sections fold by default; an old Status or Team opens All tasks; a node with no Board offers none', async ({ page }) => {
  await isolateUiPrefs(page)
  // What an older build kept: the lead left on Team, the plain lead on Status (once per tab, so the
  // picks this spec makes survive its reload).
  await page.addInitScript(([key, value]) => {
    if (sessionStorage.getItem('pw-old-task-mode')) return
    sessionStorage.setItem('pw-old-task-mode', '1')
    try { localStorage.setItem(key, value) } catch { /* storage off */ }
  }, ['open-walnut-view:org.node.taskMode', JSON.stringify([[rowKey(LED), 'team'], [rowKey(PLAIN), 'status']])] as const)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-task').click()
  await expect(detail.getByTestId('org-top-task')).toHaveText('Tasks2')
  // Two ways only (2026-11-12, the user: "under tasks, just show all taks, and then board").
  await expect.poll(() => detail.getByTestId('org-task-modes').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))), { timeout: 30_000 })
    .toEqual(['org-task-mode-all', 'org-task-mode-board'])
  await expect(detail.getByTestId('org-task-modes').getByRole('button')).toHaveText(['All tasks', 'Board'])
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  await expect(detail.getByTestId('org-task-mode-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.getByTestId('org-task-tabs')).toHaveCount(0)
  await expect(detail.getByTestId('org-rail').getByTestId('org-team')).toHaveCount(0)
  // One list: each section open or folded by its default (what is in front of the user now open,
  // what waits and what is done folded). The team's work nobody started is under Not started, folded.
  const OPEN_BY_DEFAULT = ['watching', 'needs', 'working']
  const sections = detail.getByTestId('org-task-section')
  await expect(taskSection(detail, 'notstarted')).toBeVisible({ timeout: 30_000 })
  for (const tab of await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-tab') ?? ''))) {
    const open = OPEN_BY_DEFAULT.includes(tab)
    await expect(taskSection(detail, tab as OrgSectionTab), tab).toHaveAttribute('data-open', open ? '1' : '0')
    await expect(taskSection(detail, tab as OrgSectionTab).getByTestId('org-task-section-head'), tab).toHaveAttribute('aria-expanded', String(open))
  }
  const sideWork = detail.getByTestId('org-rail').locator('[data-testid="org-task-row"]', { hasText: `Side work ${STAMP}` })
  await expect(sideWork).toHaveCount(0)
  await openSection(detail, 'notstarted')
  await expect(sideWork).toBeVisible()
  await shot(page, 'all-tasks')
  // Board, kept across a reload; back on All tasks the opened section is still open.
  await detail.getByTestId('org-task-mode-board').click()
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'board')
  await page.reload()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'board')
  await detail.getByTestId('org-task-mode-all').click()
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  await expect(taskSection(detail, 'notstarted')).toHaveAttribute('data-open', '1')
  await expect(sideWork).toBeVisible()

  // The plain lead keeps no Board: All tasks only, with no switch (its old Status read as All tasks), and no Board
  // row in its kebab.
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PLAIN)}"]`).click()
  await expect(detail).toHaveAttribute('data-key', rowKey(PLAIN))
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  // One way to draw its work, so no switch at all.
  await expect(detail.getByTestId('org-task-modes')).toHaveCount(0)
  // Folds are per node: the led node's opened Not started leaves the plain lead's sections at their
  // defaults (its one task may have started by now, so read whichever sections it shows).
  const plainSections = detail.getByTestId('org-task-section')
  await expect(plainSections.first()).toBeVisible()
  for (const sec of await plainSections.all()) {
    const tab = await sec.getAttribute('data-tab')
    await expect(sec).toHaveAttribute('data-open', ['watching', 'needs', 'working'].includes(tab ?? '') ? '1' : '0')
  }
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.plainSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  const menu = await openKebab(page)
  await openKebabGroup(menu, 'session-kebab-open')
  await expect(menu.getByTestId('session-menu-files')).toBeVisible()
  await expect(menu.getByTestId('session-menu-board')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('full screen is the pop-up sheet with margins, kept across a reload; close and back from the header', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const rail = detail.getByTestId('org-rail')
  const box = async () => (await rail.boundingBox())!
  await expect(rail).toBeVisible()
  const railBefore = await box()
  await expect(detail.getByTestId('org-rail-handle')).toHaveCount(1)
  await detail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await expect(rail).toHaveClass(/open-walnut-fullscreen/)
  // The session panel's sheet: over the page area beside the sidebar, a margin on every side
  // (about a tenth of the area left and right), the backdrop around it. Never the whole window.
  const area = await page.evaluate(() => {
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fullscreen-left')) || 0
    return { left, width: window.innerWidth - left, height: window.innerHeight }
  })
  await expect.poll(async () => (await box()).width).toBeGreaterThan(railBefore.width + 300)
  const sheet = await box()
  const leftGap = sheet.x - area.left
  const rightGap = area.left + area.width - (sheet.x + sheet.width)
  expect(leftGap).toBeGreaterThan(area.width * 0.05)
  expect(Math.abs(leftGap - rightGap)).toBeLessThan(4)
  expect(sheet.y).toBeGreaterThanOrEqual(8)
  expect(area.height - (sheet.y + sheet.height)).toBeGreaterThanOrEqual(8)
  expect(sheet.height).toBeGreaterThan(area.height * 0.9)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toBeVisible()
  // Every view of the side bar works in the sheet, Threads included.
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await shot(page, 'fullscreen')
  // Back to Tasks, so the Threads dot below is not read away by a Threads view on show.
  await detail.getByTestId('org-top-task').click()
  // One state of the tab: a reload keeps it.
  await page.reload()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toBeVisible()
  // Esc leaves it, and the rail is back beside the chat at its own width.
  await page.keyboard.press('Escape')
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect.poll(async () => Math.abs((await box()).width - railBefore.width)).toBeLessThan(20)
  await expect(detail.getByTestId('org-rail-handle')).toHaveCount(1)
  // A click on the backdrop leaves it too, and a reload then stays out of it.
  await detail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  const s2 = await box()
  await page.mouse.click(area.left + (s2.x - area.left) / 2, area.height / 2)
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')
  await page.reload()
  await expect(rail).toBeVisible()
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')
  // The × of a full-screen side bar closes it and its sheet: back from the header, it is beside the chat.
  await detail.getByTestId('org-rail-fullscreen').click()
  await detail.getByTestId('org-rail-close').click()
  await expect(rail).toHaveCount(0)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await detail.getByTestId('org-rail-toggle').click()
  await expect(rail).toBeVisible()
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')

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

  // In the sheet, Esc in a thread's Follow up closes the Follow up, not the sheet; the next Esc does.
  await detail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await detail.getByTestId('org-thread-follow-open').first().click()
  await expect(detail.getByTestId('org-thread-follow-input')).toBeVisible()
  await detail.getByTestId('org-thread-follow-input').press('Escape')
  await expect(detail.getByTestId('org-thread-follow-input')).toHaveCount(0)
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await page.keyboard.press('Escape')
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')

  // A task opened from the sheet opens beside the page with the sheet gone, never under it.
  await detail.getByTestId('org-top-task').click()
  await detail.getByTestId('org-task-mode-all').click()
  await detail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await openAllSections(detail)
  await detail.getByTestId('org-task-row').first().click()
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(page.getByTestId('org-side')).toBeVisible()
})

test('a narrow window stacks the side bar above the chat, with no widen; a link naming Team opens All tasks once', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, PLAIN)
  const detail = page.getByTestId('org-detail')
  // An old link to the team (a row's "Open tasks" still says team): the side bar opens on All tasks,
  // and the URL lets go of the tab.
  await page.evaluate((key) => {
    const url = new URL(window.location.href)
    url.searchParams.set('node', key)
    url.searchParams.set('tab', 'team')
    window.history.replaceState(window.history.state, '', url.toString())
  }, rowKey(LED))
  await page.reload()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  await expect(page).not.toHaveURL(/tab=/)

  await page.setViewportSize({ width: 900, height: 900 })
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-placement', 'top')
  // Above the chat the side bar opens into the same sheet.
  await detail.getByTestId('org-rail-fullscreen').click()
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-fullscreen', '1')
  await page.keyboard.press('Escape')
  await expect(detail.getByTestId('org-rail')).not.toHaveAttribute('data-fullscreen', '1')
  await expect(detail.locator('[data-testid="org-chat"] .session-panel')).toBeVisible()
  await shot(page, 'narrow')
})

test('Quote on an ask in the side bar puts it into the chat beside it', async ({ page, request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const id = await createTask(request, `Side lease ${STAMP}`, LED)
  const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Ready.', taskId: id })
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': sessionId },
    data: { subject: `Sign the side lease ${STAMP}`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions: [{ id: 'yes', label: 'Yes' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.source ?? ''), { timeout: 60_000 }).toBe('letter')

  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-task').click()
  await detail.getByTestId('org-task-mode-all').click()
  await openSection(detail, 'needs')
  const row = detail.locator(`[data-testid="org-alert"][data-task-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 60_000 })
  const composer = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"] .chat-input-textarea`)
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await row.getByTestId('org-alert-quote').click()
  await expect(composer).toHaveValue(new RegExp(`^> Side lease ${STAMP}: `), { timeout: 30_000 })
  await expect(composer).toBeFocused()
  await expect(detail.getByTestId('org-rail')).toBeVisible()
})
