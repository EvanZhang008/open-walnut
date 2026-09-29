/**
 * Task status you can see and change, and snoozing until something happens
 * (user asks 2026-09-28, second round: "status is status", Status collapsed by
 * default, and Snooze until holds both kinds of snooze):
 *
 *  1. The task menu has ONE collapsed Status row ("Status: To Do"); a click opens
 *     all four statuses, the lit one is the current status, a click sets another.
 *     The Start row reads "Start / Snooze until".
 *  2. The detail pane's status badge is a button that opens the same four.
 *  3. Start / Snooze until holds the times AND "Something happens…". A snoozed
 *     task stays a plain To Do in the list; the collapsed row says what it waits
 *     for, and the open row (and the detail pane) has Unsnooze. Need Action ends it.
 *     The row carries a SNOOZED pill (the TRIGGER pill's shape, amber) that opens
 *     what it waits for, Unsnooze and the trigger behind it (user ask 2026-09-29).
 *  5. A message does not end the snooze: the session panel says it still holds,
 *     above the composer, with Unsnooze; the turn the message starts ends quietly.
 *  4. "Something happens…" never asks the human to fill a form: it starts a
 *     message to the task's AI that names the skill (/walnut-trigger), and the AI
 *     writes the trigger. With a session it leads that session's composer (menu
 *     row and the composer's "+" menu, both idempotent); without one it opens a
 *     draft bound to the task, seeded the same way.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { DRAFT_PANEL } from './draft-helpers'
import { composerTextarea, openPanels, openPlusMenu } from './engine-settings-popover-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/snooze-trigger/shots'
const PREFIX = '/walnut-trigger Snooze this task until: '

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })

const litterTasks: string[] = []
const litterRoutines: string[] = []

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
  await page.setViewportSize({ width: 1280, height: 860 })
})

test.afterEach(async () => {
  for (const id of litterRoutines.splice(0)) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of litterTasks.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

async function shot(target: Page | Locator, name: string, browserName: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${browserName}-${name}.png` })
}

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const body = await api('POST', '/api/tasks', { title: uniqueTitle, source: 'local' })
  litterTasks.push(body.task.id)
  return body.task
}

async function taskOf(id: string): Promise<any> {
  return (await api('GET', `/api/tasks/${id}`)).task
}

async function openRowKebab(page: Page, task: { id: string; title: string }): Promise<Locator> {
  await page.locator('.todo-search-input').fill(task.title)
  const row = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  return menu
}

async function openDetail(page: Page, task: { id: string; title: string }): Promise<Locator> {
  const menu = await openRowKebab(page, task)
  await menu.getByText('Details', { exact: true }).click()
  const detail = page.locator('.todo-detail-pane').filter({ hasText: task.title })
  await expect(detail).toBeVisible()
  return detail
}

const statusPill = (scope: Locator, label: string): Locator => scope.getByRole('radio', { name: label, exact: true })

const ROW_PARTS = {
  'task-status-row': { toggle: '.task-kebab-status-toggle', label: '.task-kebab-status-value' },
  'task-snooze-row': { toggle: '.task-kebab-date-toggle', label: '.task-kebab-date-label' },
} as const
type RowId = keyof typeof ROW_PARTS

/** Open one of the menu's collapsed rows (Status, Start / Snooze until) and return it. */
async function expandRow(menu: Locator, testId: RowId): Promise<Locator> {
  const row = menu.getByTestId(testId)
  const toggle = row.locator(ROW_PARTS[testId].toggle)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return row
}
const statusRow = (menu: Locator) => expandRow(menu, 'task-status-row')
const snoozeRow = (menu: Locator) => expandRow(menu, 'task-snooze-row')
/** The collapsed row's words (the caret glyph sits outside them). */
const toggleOf = (menu: Locator, testId: RowId) => menu.getByTestId(testId).locator(ROW_PARTS[testId].label)

async function expectInViewport(page: Page, box: Locator): Promise<void> {
  const b = await box.boundingBox()
  const vp = page.viewportSize()!
  expect(b).toBeTruthy()
  expect(b!.y).toBeGreaterThanOrEqual(0)
  expect(b!.x).toBeGreaterThanOrEqual(0)
  expect(b!.y + b!.height).toBeLessThanOrEqual(vp.height + 1)
  expect(b!.x + b!.width).toBeLessThanOrEqual(vp.width + 1)
}

test('the task menu shows and sets the status; Start reads "Start / Snooze until"', async ({ page, browserName }) => {
  const task = await createTask('Status row')
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  let menu = await openRowKebab(page, task)
  // Collapsed by default: one row that says the status, no options until clicked.
  // It is not a date row: the menu still has exactly two (Start / Snooze until, Due).
  await expect(menu.locator('.task-kebab-date-toggle')).toHaveCount(2)
  await expect(toggleOf(menu, 'task-status-row')).toHaveText(/^Status: To Do/)
  await expect(menu.getByTestId('task-status-row').getByRole('radio')).toHaveCount(0)
  await expect(toggleOf(menu, 'task-snooze-row')).toHaveText(/^Start \/ Snooze until$/)
  await expect(menu.getByTestId('task-wait-until')).toHaveCount(0)
  await expect(menu.getByTestId('task-waiting-line')).toHaveCount(0)
  await shot(menu, 'menu-collapsed', browserName)

  let row = await statusRow(menu)
  await expect(row.getByRole('radio')).toHaveText(['To Do', 'In Progress', 'Need Action', 'Complete'])
  await expect(statusPill(row, 'To Do')).toHaveAttribute('aria-checked', 'true')
  await expect(statusPill(row, 'Need Action')).toHaveAttribute('aria-checked', 'false')
  await expectInViewport(page, menu)
  await shot(menu, 'menu-status-row', browserName)
  // Clicking the row again folds it back.
  await toggleOf(menu, 'task-status-row').click()
  await expect(row.getByRole('radio')).toHaveCount(0)

  row = await statusRow(menu)
  await statusPill(row, 'Need Action').click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('NEED_ACTION')

  // Reopened: the row says the new status, and it is the lit one.
  menu = await openRowKebab(page, task)
  await expect(toggleOf(menu, 'task-status-row')).toHaveText(/^Status: Need Action/)
  row = await statusRow(menu)
  await expect(statusPill(row, 'Need Action')).toHaveAttribute('aria-checked', 'true')
  await statusPill(row, 'In Progress').click()
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('IN_PROGRESS')

  // A lit pill is a no-op that only closes the menu.
  menu = await openRowKebab(page, task)
  await statusPill(await statusRow(menu), 'In Progress').click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  expect((await taskOf(task.id)).phase).toBe('IN_PROGRESS')

  // Complete from the menu, then back to To Do: a completed task cannot snooze on an event.
  menu = await openRowKebab(page, task)
  await statusPill(await statusRow(menu), 'Complete').click()
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('COMPLETE')
  menu = await openRowKebab(page, task)
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-wait-until')).toHaveCount(0)
  await statusPill(await statusRow(menu), 'To Do').click()
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('TODO')
})

test('the detail pane badge shows the status and changes it', async ({ page, browserName }) => {
  const task = await createTask('Status badge')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const detail = await openDetail(page, task)
  const badge = detail.getByTestId('task-status-badge')
  await expect(badge).toHaveText(/To Do/)
  await expect(badge).toHaveAttribute('aria-expanded', 'false')

  await badge.click()
  const menu = page.locator('.task-status-menu')
  await expect(menu).toBeVisible()
  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('radio')).toHaveCount(4)
  await expectInViewport(page, menu)
  await shot(detail.locator('.todo-detail-meta'), 'detail-badge', browserName)
  await shot(page, 'detail-badge-menu', browserName)

  await statusPill(menu, 'In Progress').click()
  await expect(menu).toHaveCount(0)
  await expect(badge).toHaveText(/In Progress/, { timeout: 10_000 })
  // The badge is optimistic; the write lands a beat later.
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('IN_PROGRESS')

  // Escape and an outside click both close it without a change.
  await badge.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // Escape closed the status menu only, not the detail around it.
  await expect(detail).toBeVisible()
  await badge.click()
  await expect(menu).toBeVisible()
  await detail.locator('.todo-detail-title').click()
  await expect(menu).toHaveCount(0)
  expect((await taskOf(task.id)).phase).toBe('IN_PROGRESS')
})

test('a snoozed task stays in the list, says what it waits for, and Unsnooze ends it', async ({ page, browserName }) => {
  const task = await createTask('Waiting on review')
  const trigger = await api('POST', '/api/v1/routines/trigger', {
    run: 'bash ~/.open-walnut/triggers/cr/check.sh', every: '5m', session: task.id,
    prompt: 'Tell the user what the review said.',
    description: 'Checks CR 1234 every 5 minutes; fires once when it is approved.',
  })
  litterRoutines.push(trigger.job.id)
  await api('POST', `/api/v1/tasks/${task.id}/wait`, { condition: 'CR 1234 is approved', routine_id: trigger.job.id })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // Still a To Do in the list, with no red dot.
  const menu = await openRowKebab(page, task)
  // Collapsed, the row already says what the task waits for; the status is To Do.
  await expect(toggleOf(menu, 'task-snooze-row')).toHaveText(/^Start \/ Snooze until: CR 1234 is approved/)
  await expect(toggleOf(menu, 'task-status-row')).toHaveText(/^Status: To Do/)
  await expect(menu.getByTestId('task-waiting-line')).toHaveCount(0)
  await snoozeRow(menu)
  const line = menu.getByTestId('task-waiting-line')
  await expect(line).toContainText('Snoozed until: CR 1234 is approved')
  await expect(line.getByRole('button', { name: 'Unsnooze' })).toBeVisible()
  await expect(menu.getByTestId('task-wait-until')).toHaveCount(0)
  await expectInViewport(page, menu)
  await shot(menu, 'menu-waiting', browserName)
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
  const rowEl = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`)
  await expect(rowEl).toBeVisible()
  await expect(rowEl.locator('.task-unread-dot')).toHaveCount(0)

  // The row says it is snoozed the way a time-snoozed one shows its date: one
  // SNOOZED pill (not SNOOZED and TRIGGER for the same trigger).
  const pill = rowEl.getByTestId('task-trigger-pill')
  await expect(pill).toHaveCount(1)
  await expect(pill).toHaveText('SNOOZED')
  await expect(pill).toHaveAttribute('data-snoozed', 'true')
  await expect(pill).toHaveAttribute('title', /^Snoozed until: CR 1234 is approved/)
  await shot(rowEl, 'row-snoozed-pill', browserName)
  await pill.click()
  const flyout = page.getByTestId('trigger-jobs-flyout')
  await expect(flyout).toBeVisible()
  await expect(flyout.getByTestId('trigger-jobs-snooze')).toContainText('Snoozed until: CR 1234 is approved')
  await expect(flyout.getByTestId('trigger-jobs-snooze').getByRole('button', { name: 'Unsnooze' })).toBeVisible()
  // The trigger behind it, with its own description, under the snooze.
  await expect(flyout).toContainText('Checks CR 1234 every 5 minutes')
  await expectInViewport(page, flyout)
  await shot(flyout, 'row-snoozed-flyout', browserName)
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)

  const detail = await openDetail(page, task)
  const detailLine = detail.getByTestId('task-waiting-line')
  await expect(detailLine).toContainText('Snoozed until: CR 1234 is approved')
  // The backstop (a week, none given): if the trigger never fires, the task comes back then.
  await expect(detailLine).toContainText('· back by ')
  await shot(detail.locator('.todo-detail-meta'), 'detail-waiting', browserName)

  await detailLine.getByRole('button', { name: 'Unsnooze' }).click()
  await expect(detail.getByTestId('task-waiting-line')).toHaveCount(0, { timeout: 10_000 })
  const after = await taskOf(task.id)
  expect(after.waiting).toBeUndefined()
  expect(after.phase).toBe('TODO')
  const routine = await fetch(`${API}/api/routines/${trigger.job.id}`)
  expect(routine.status).toBe(404)
})

test('a long condition truncates in the menu instead of widening it', async ({ page, browserName }) => {
  const task = await createTask('Long wait')
  const trigger = await api('POST', '/api/v1/routines/trigger', {
    run: 'bash ~/.open-walnut/triggers/long/check.sh', every: '5m', session: task.id,
    prompt: 'Tell the user QA signed off.',
    description: 'Checks for the QA sign-off file every 5 minutes; fires once when it appears.',
  })
  litterRoutines.push(trigger.job.id)
  const condition = 'QA signs off on release 1.2, which is when the file /tmp/qa/release-1.2/signed-off exists on the build host'
  await api('POST', `/api/v1/tasks/${task.id}/wait`, { condition, routine_id: trigger.job.id })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The same menu with nothing to say is the width to keep, closed and open (an
  // open date row has its own width: WebKit's date field is wider than Chromium's).
  const plain = await createTask('Long wait baseline')
  let menu = await openRowKebab(page, plain)
  const baseWidth = (await menu.boundingBox())!.width
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-wait-until')).toBeVisible()
  const baseOpenWidth = (await menu.boundingBox())!.width
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)

  menu = await openRowKebab(page, task)
  const toggle = menu.getByTestId('task-snooze-row').locator('.task-kebab-date-toggle')
  await expect(toggle).toHaveAttribute('title', `Start / Snooze until: ${condition}`)
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(baseWidth + 1)
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-waiting-line')).toContainText('Snoozed until:')
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(baseOpenWidth + 1)
  await expectInViewport(page, menu)
  await shot(menu, 'menu-long-condition', browserName)
})

test('setting Need Action ends the wait, and the menu says so at once', async ({ page }) => {
  const task = await createTask('Waiting then started')
  const trigger = await api('POST', '/api/v1/routines/trigger', {
    run: 'bash ~/.open-walnut/triggers/deploy/check.sh', every: '5m', session: task.id,
    prompt: 'Tell the user the deploy finished.',
    description: 'Checks the deploy every 5 minutes; fires once when it finishes.',
  })
  litterRoutines.push(trigger.job.id)
  await api('POST', `/api/v1/tasks/${task.id}/wait`, { condition: 'the deploy finishes', routine_id: trigger.job.id })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  let menu = await openRowKebab(page, task)
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-waiting-line')).toBeVisible()
  await statusPill(await statusRow(menu), 'Need Action').click()
  await expect.poll(async () => (await taskOf(task.id)).waiting?.woke_reason, { timeout: 10_000 }).toBe('status-changed')
  menu = await openRowKebab(page, task)
  await expect(toggleOf(menu, 'task-snooze-row')).toHaveText(/^Start \/ Snooze until$/)
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-waiting-line')).toHaveCount(0)
  await expect(menu.getByTestId('task-wait-until')).toBeVisible()
  await expect.poll(async () => (await api('GET', `/api/routines/${trigger.job.id}`)).job.enabled, { timeout: 10_000 }).toBe(false)
})

test('"Something happens…" on a task with no session opens a draft bound to it, seeded with the skill', async ({ page, browserName }) => {
  const task = await createTask('Wait no session')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const menu = await openRowKebab(page, task)
  await snoozeRow(menu)
  await expect(menu.getByTestId('task-wait-until')).toHaveText('Something happens…')
  await shot(menu, 'menu-snooze-open', browserName)
  await menu.getByTestId('task-wait-until').click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)

  const draft = page.locator(DRAFT_PANEL).last()
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft).toContainText(task.title)
  const box = draft.locator('.chat-input-textarea')
  await expect(box).toHaveValue(PREFIX)
  await expect(box).toBeFocused()
  await page.keyboard.type('CR 1234 is approved')
  await expect(box).toHaveValue(`${PREFIX}CR 1234 is approved`)
  await shot(draft, 'draft-seeded', browserName)
})

test('"Snooze until something happens" leads the task session\'s composer, from the task menu and from "+"', async ({ page, request, browserName }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-wait-until-'))
  const started = await request.post('/api/sessions/quick-start', { data: { cwd, message: '' } })
  expect(started.ok(), await started.text()).toBeTruthy()
  const { sessionId: sid, taskId } = await started.json() as { sessionId: string; taskId: string }
  litterTasks.push(taskId)
  const task = await taskOf(taskId)

  const [panel] = await openPanels(page, [sid])
  const box = composerTextarea(panel)
  await box.fill('ship it')

  // From the task row's menu.
  let menu = await openRowKebab(page, { id: taskId, title: task.title })
  await snoozeRow(menu)
  await menu.getByTestId('task-wait-until').click()
  await expect(box).toHaveValue(`${PREFIX}ship it`)
  await expect(box).toBeFocused()
  // Twice does not stack the words.
  menu = await openRowKebab(page, { id: taskId, title: task.title })
  await snoozeRow(menu)
  await menu.getByTestId('task-wait-until').click()
  await expect(box).toHaveValue(`${PREFIX}ship it`)

  // From the composer's "+" menu, next to "Set up a trigger or cron job".
  await box.fill('the build is green')
  const plus = await openPlusMenu(panel)
  const row = plus.getByRole('menuitem', { name: 'Snooze until something happens…' })
  await expect(row).toBeVisible()
  await expect(plus.getByRole('menuitem', { name: 'Set up a trigger or cron job' })).toBeVisible()
  await shot(plus, 'plus-menu', browserName)
  await row.click()
  await expect(plus).toBeHidden()
  await expect(box).toHaveValue(`${PREFIX}the build is green`)
  await expect(box).toBeFocused()
  await (await openPlusMenu(panel)).getByRole('menuitem', { name: 'Snooze until something happens…' }).click()
  await expect(box).toHaveValue(`${PREFIX}the build is green`)
  await shot(panel.locator('.chat-input-container'), 'composer-seeded', browserName)
  await box.fill('')
})

test('a message does not end the snooze: the session says it still holds, and Unsnooze there ends it', async ({ page, request, browserName }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-snoozed-session-'))
  const started = await request.post('/api/sessions/quick-start', { data: { cwd, message: '' } })
  expect(started.ok(), await started.text()).toBeTruthy()
  const { sessionId: sid, taskId } = await started.json() as { sessionId: string; taskId: string }
  litterTasks.push(taskId)
  // One call: the trigger and the snooze (trigger_create with wait_until).
  const armed = await api('POST', '/api/v1/routines/trigger', {
    run: 'bash ~/.open-walnut/triggers/build/check.sh', every: '5m', session: taskId,
    prompt: 'Tell the user the build result.',
    description: 'Checks the build every 5 minutes; fires once when it is green.',
    wait_until: 'the build is green', wait_ttl: '2h',
  })
  litterRoutines.push(armed.job.id)
  expect(armed.task.waiting.condition).toBe('the build is green')

  const [panel] = await openPanels(page, [sid])
  const notice = panel.getByTestId('session-snoozed-notice')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toContainText('Snoozed until: the build is green · back by ')
  await expect(notice).toContainText("· Messages here don't cancel it")
  // The header's pill says it too.
  await expect(panel.getByTestId('task-trigger-pill')).toHaveText('SNOOZED')
  await shot(panel.locator('.session-panel-input'), 'session-snoozed-notice', browserName)

  // A message: the session answers, and the snooze holds (To Do, no red dot).
  const box = composerTextarea(panel)
  await box.fill('how is it going?')
  await box.press('Enter')
  await expect(panel.getByText(/I processed your message: how is it going\?/).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await taskOf(taskId)).phase, { timeout: 30_000 }).toBe('TODO')
  const held = await taskOf(taskId)
  expect(held.unread).toBeFalsy()
  expect(held.waiting).toMatchObject({ condition: 'the build is green', routine_id: armed.job.id })
  expect(held.waiting.woke_at).toBeUndefined()
  await expect(notice).toBeVisible()
  await shot(panel, 'session-after-message', browserName)

  // Unsnooze from the notice: the wait and its trigger are gone, the task stays To Do.
  await notice.getByRole('button', { name: 'Unsnooze' }).click()
  await expect(notice).toHaveCount(0, { timeout: 10_000 })
  await expect(panel.getByTestId('task-trigger-pill')).toHaveCount(0)
  const after = await taskOf(taskId)
  expect(after.waiting).toBeUndefined()
  expect(after.phase).toBe('TODO')
  expect((await fetch(`${API}/api/routines/${armed.job.id}`)).status).toBe(404)
})
