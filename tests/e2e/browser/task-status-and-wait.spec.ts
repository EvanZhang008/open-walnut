/**
 * Task status you can see and change, Waiting as one of them, and "Snooze until
 * something happens" (user asks 2026-09-28 to 2026-09-30):
 *
 *  1. The task menu has ONE collapsed Status row ("Status: To Do"); a click opens
 *     the five statuses, the lit one is the current status, a click sets another.
 *     The Start row reads "Start / Snooze until".
 *  2. The detail pane's status badge is a button that opens the same five.
 *  3. Waiting IS a status (2026-09-30). Picking it keeps the menu open and shows an
 *     optional "Until" row (the date picker the date rows use); the collapsed row
 *     says "Status: Waiting · until <time>", the task row swaps its circle for an
 *     hourglass and carries an "until" chip, the detail pane says "Waiting until",
 *     and the session's composer has one line about it. A Waiting task stays in
 *     its board tier (Focus stays Focus). A message into the session moves it to
 *     In Progress, and the turn ends as Need Action like any other. Picking a
 *     status by hand ends it and drops the time.
 *  4. The TRIGGER pill is a plain trigger pill again (no SNOOZED mode); the
 *     board's `wait` tier reads "Parked".
 *  5. "Something happens…" never asks the human to fill a form: it starts a
 *     message to the task's AI that names the skill (/walnut-trigger), and the AI
 *     writes the trigger and sets the task to Waiting. With a session it leads
 *     that session's composer (menu row and the composer's "+" menu, both
 *     idempotent); without one it opens a draft bound to the task, seeded the
 *     same way.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { DRAFT_PANEL } from './draft-helpers'
import { composerTextarea, openPanels, openPlusMenu } from './engine-settings-popover-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/waiting-status/shots'
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
  await expect(menu.getByTestId('task-status-until')).toHaveCount(0)
  await shot(menu, 'menu-collapsed', browserName)

  let row = await statusRow(menu)
  await expect(row.getByRole('radio')).toHaveText(['To Do', 'Waiting', 'In Progress', 'Need Action', 'Complete'])
  // The until row belongs to Waiting alone.
  await expect(row.getByTestId('task-status-until')).toHaveCount(0)
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
  await expect(menu.getByRole('radio')).toHaveCount(5)
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

test('Waiting from the menu: the until row, the collapsed row, the task row and the detail pane all say it', async ({ page, browserName }) => {
  const task = await createTask('Waiting on review')
  // Pinned to Focus: a Waiting task stays where it is.
  await api('POST', `/api/focus/tasks/${task.id}`)
  await api('PUT', `/api/focus/tasks/${task.id}/tier`, { tier: 'focus' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  let menu = await openRowKebab(page, task)
  let row = await statusRow(menu)
  await statusPill(row, 'Waiting').click()
  // The menu stays open for the optional time; the status is already written.
  await expect(menu).toBeVisible()
  await expect(statusPill(row, 'Waiting')).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('WAITING')
  // No time named: the server (and the optimistic row) put the default clock on
  // it, 3 days out, and the until row already shows it with the no-limit button.
  const until = row.getByTestId('task-status-until')
  await expect(until).toBeVisible()
  await expect(until.getByTestId('task-status-until-toggle')).toHaveText(/^Until: /)
  await expect(until.getByTestId('task-status-until-clear')).toHaveText('No limit')
  await expect.poll(async () => (await taskOf(task.id)).wait_until, { timeout: 10_000 }).toBeTruthy()
  const parked = await taskOf(task.id)
  const daysAhead = (Date.parse(parked.wait_until) - Date.now()) / 86_400_000
  expect(daysAhead).toBeGreaterThan(2.99)
  expect(daysAhead).toBeLessThan(3.01)
  await expectInViewport(page, menu)
  await shot(menu, 'menu-waiting-open', browserName)

  // Pick a time: 2 hours from now, through the same picker the date rows use.
  await until.getByTestId('task-status-until-toggle').click()
  await expect(until.locator('.dp-content')).toBeVisible()
  await expectInViewport(page, menu)
  await shot(menu, 'menu-waiting-picker', browserName)
  await until.locator('.dp-pill', { hasText: /^2h$/ }).click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect.poll(async () => (await taskOf(task.id)).wait_until, { timeout: 10_000 }).toBeTruthy()
  const waiting = await taskOf(task.id)
  expect(waiting.phase).toBe('WAITING')
  expect(waiting.unread).toBeFalsy()
  const hoursAhead = (Date.parse(waiting.wait_until) - Date.now()) / 3_600_000
  expect(hoursAhead).toBeGreaterThan(1.9)
  expect(hoursAhead).toBeLessThan(2.1)
  // Still pinned to Focus: the status did not move it.
  expect(waiting.pinned).toBe(true)
  expect(waiting.focus_tier).toBe('focus')

  // The row: an hourglass instead of the circle, no red dot, an until chip.
  const rowEl = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`)
  await expect(rowEl).toBeVisible()
  await expect(rowEl.locator('.task-unread-dot')).toHaveCount(0)
  await expect(rowEl.getByTitle('Waiting: click to complete')).toBeVisible()
  await expect(rowEl.getByTestId('task-row-wait-until')).toHaveText(/^until /)
  await expect(rowEl.getByTestId('task-trigger-pill')).toHaveCount(0)
  await shot(rowEl, 'row-waiting', browserName)

  // Reopened: the collapsed row says the status and the time; "No limit" drops
  // the clock on purpose (an explicit empty value, not the default again).
  menu = await openRowKebab(page, task)
  await expect(toggleOf(menu, 'task-status-row')).toHaveText(/^Status: Waiting · until /)
  row = await statusRow(menu)
  await expect(row.getByTestId('task-status-until-toggle')).toHaveText(/^Until: /)
  await shot(menu, 'menu-waiting-until', browserName)
  await row.getByTestId('task-status-until-clear').click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect.poll(async () => (await taskOf(task.id)).wait_until, { timeout: 10_000 }).toBeUndefined()
  expect((await taskOf(task.id)).phase).toBe('WAITING')
  await expect(rowEl.getByTestId('task-row-wait-until')).toHaveCount(0)
  menu = await openRowKebab(page, task)
  row = await statusRow(menu)
  await expect(row.getByTestId('task-status-until-toggle')).toHaveText(/^Until: no time limit/)
  await page.keyboard.press('Escape')

  // The detail pane: the badge reads Waiting; with a time it says so in the meta line.
  await api('PATCH', `/api/tasks/${task.id}`, { wait_until: new Date(Date.now() + 3 * 3_600_000).toISOString() })
  const detail = await openDetail(page, task)
  await expect(detail.getByTestId('task-status-badge')).toHaveText(/Waiting/)
  await expect(detail.getByTestId('task-detail-wait-until')).toContainText('Waiting until', { timeout: 10_000 })
  await shot(detail.locator('.todo-detail-meta'), 'detail-waiting', browserName)

  // Picking another status by hand ends the wait and drops the time.
  await detail.getByTestId('task-status-badge').click()
  await statusPill(page.locator('.task-status-menu'), 'To Do').click()
  await expect.poll(async () => (await taskOf(task.id)).phase, { timeout: 10_000 }).toBe('TODO')
  expect((await taskOf(task.id)).wait_until).toBeUndefined()
  await expect(detail.getByTestId('task-detail-wait-until')).toHaveCount(0)
})

test('Waiting tasks are out of the list and the tiers by default; "Show waiting" brings them back; parking a card fades it out', async ({ page, browserName }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // Both are born pinned (Satellite) like every interactive create; the parked
  // one moves to Focus: a Waiting pin keeps its tier but is not drawn there.
  const parked = await createTask(`Hidewait ${stamp} parked`)
  const plain = await createTask(`Hidewait ${stamp} plain`)
  await api('PUT', `/api/focus/tasks/${parked.id}/tier`, { tier: 'focus' })
  await api('PATCH', `/api/tasks/${parked.id}`, { phase: 'WAITING' })
  expect((await taskOf(parked.id)).focus_tier).toBe('focus')
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const anyParked = page.locator(`[data-task-id="${parked.id}"]`)
  const plainCard = page.locator(`.todo-pinned-card[data-task-id="${plain.id}"]`)
  await expect(plainCard).toBeVisible({ timeout: 15_000 })
  await expect(anyParked).toHaveCount(0)
  await shot(page.locator('.todo-panel'), 'show-waiting-off', browserName)

  // The footer under the list says what the view hides; one click reveals it,
  // in its own tier, with the hourglass. (The Focus tier draws rows, Satellite
  // draws cards: match on the task id alone.)
  const footer = page.getByTestId('todo-filter-footer')
  const waitingChip = footer.getByTestId('todo-filter-footer-waiting')
  await expect(waitingChip).toHaveText(/^\d+ waiting hidden$/)
  await expect(footer.getByTestId('todo-filter-footer-completed')).toHaveText(/^\d+ completed hidden$/)
  await shot(footer, 'filter-footer', browserName)
  await waitingChip.click()
  await expect(waitingChip).toHaveText(/^\d+ waiting shown$/)
  await expect(waitingChip).toHaveClass(/\bon\b/)
  await expect(anyParked).toHaveCount(1, { timeout: 15_000 })
  await expect(anyParked).toBeVisible()
  await expect(anyParked.getByTitle('Waiting: click to complete')).toBeVisible()
  await shot(page.locator('.todo-panel'), 'show-waiting-on', browserName)
  // View options carries the same switch (now on); unchecking it hides them again.
  await page.getByRole('button', { name: 'View options' }).click()
  const showWaiting = page.locator('.vd-footer').getByTestId('vd-show-waiting')
  await expect(showWaiting.locator('input')).toBeChecked()
  await showWaiting.locator('input').uncheck()
  await page.keyboard.press('Escape')
  await expect(anyParked).toHaveCount(0)
  await expect(waitingChip).toHaveText(/^\d+ waiting hidden$/)

  // Search always finds it (search ignores every view toggle).
  await page.locator('.todo-search-input').fill(`Hidewait ${stamp}`)
  await expect(page.locator(`.todo-panel-item[data-task-id="${parked.id}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(footer).toHaveCount(0)
  await page.locator('.todo-search-input').fill('')
  await expect(anyParked).toHaveCount(0)
  await expect(footer).toBeVisible()

  // Parking a visible card from its menu: it holds for the grace, fades, then leaves.
  await plainCard.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  const row = await statusRow(menu)
  await statusPill(row, 'Waiting').click()
  await expect(plainCard).toBeVisible()
  await expect.poll(async () => (await taskOf(plain.id)).phase, { timeout: 10_000 }).toBe('WAITING')
  await page.keyboard.press('Escape')
  // Held for the grace window (the same 3s a completed row gets), then gone.
  // (The fade class itself lives for ~600ms, too short to assert through polling.)
  await page.waitForTimeout(1_200)
  await expect(plainCard).toBeVisible()
  await expect(plainCard).toHaveCount(0, { timeout: 8_000 })
  // A message-free way back: the status by hand.
  await api('PATCH', `/api/tasks/${plain.id}`, { phase: 'TODO' })
  await expect(plainCard).toBeVisible({ timeout: 15_000 })
})

test('the footer counts the current view: a tier tab counts its own tier, and "Show completed" reveals a tier\'s done pin in place', async ({ page, browserName }) => {
  // Every tier tab on the bar, so the view can be switched by clicking. "Hide empty
  // tabs" stays at its default (on): a tier whose only tasks are parked is not empty.
  await page.addInitScript(() => {
    localStorage.setItem('walnut-todo-quick-views-visible', 'true')
    localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
  })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // Born pinned (Satellite): one parked there, one parked in Focus, one done in Focus.
  const parkedSat = await createTask(`Scopewait ${stamp} satellite`)
  const parkedFocus = await createTask(`Scopewait ${stamp} focus`)
  const doneFocus = await createTask(`Scopewait ${stamp} done`)
  await api('PUT', `/api/focus/tasks/${parkedFocus.id}/tier`, { tier: 'focus' })
  await api('PUT', `/api/focus/tasks/${doneFocus.id}/tier`, { tier: 'focus' })
  await api('PATCH', `/api/tasks/${parkedSat.id}`, { phase: 'WAITING' })
  await api('PATCH', `/api/tasks/${parkedFocus.id}`, { phase: 'WAITING' })
  await api('PATCH', `/api/tasks/${doneFocus.id}`, { phase: 'COMPLETE' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const tab = (name: string) => page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
  const footer = page.getByTestId('todo-filter-footer')
  const waitingChip = footer.getByTestId('todo-filter-footer-waiting')
  const completedChip = footer.getByTestId('todo-filter-footer-completed')
  const countOf = async (chip: Locator): Promise<number> => {
    await expect(chip).toBeVisible({ timeout: 15_000 })
    return Number((await chip.textContent())!.trim().split(' ')[0])
  }
  // The board shares the fixture with other specs, so the assertions are relative:
  // All counts both parked tasks, the tiers count only their own.
  const allWaiting = await countOf(waitingChip)
  expect(allWaiting).toBeGreaterThanOrEqual(2)

  await tab('Focus').click()
  await expect(tab('Focus')).toHaveAttribute('aria-selected', 'true')
  const focusWaiting = await countOf(waitingChip)
  expect(focusWaiting).toBeGreaterThanOrEqual(1)
  expect(focusWaiting).toBeLessThanOrEqual(allWaiting - 1)
  await shot(page.locator('.todo-panel'), 'footer-scope-focus', browserName)
  // Reveal: the Focus pin appears, the Satellite pin does not (it is not in this view).
  await waitingChip.click()
  await expect(page.locator(`[data-task-id="${parkedFocus.id}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(`[data-task-id="${parkedSat.id}"]`)).toHaveCount(0)
  await waitingChip.click()
  await expect(page.locator(`[data-task-id="${parkedFocus.id}"]`)).toHaveCount(0)
  // The done Focus pin: counted here, and "Show completed" draws it in the tier itself.
  const doneCard = page.locator(`[data-task-id="${doneFocus.id}"]`)
  await expect(doneCard).toHaveCount(0)
  expect(await countOf(completedChip)).toBeGreaterThanOrEqual(1)
  await completedChip.click()
  await expect(completedChip).toHaveText(/^\d+ completed shown$/)
  await expect(doneCard).toBeVisible({ timeout: 15_000 })
  await shot(page.locator('.todo-panel'), 'footer-scope-focus-completed', browserName)
  await completedChip.click()
  await expect(doneCard).toHaveCount(0)

  await tab('Satellite').click()
  await expect(tab('Satellite')).toHaveAttribute('aria-selected', 'true')
  const satWaiting = await countOf(waitingChip)
  expect(satWaiting).toBeGreaterThanOrEqual(1)
  expect(satWaiting).toBeLessThanOrEqual(allWaiting - 1)
  expect(focusWaiting + satWaiting).toBeLessThanOrEqual(allWaiting)
  await waitingChip.click()
  await expect(page.locator(`[data-task-id="${parkedSat.id}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(`[data-task-id="${parkedFocus.id}"]`)).toHaveCount(0)
  await waitingChip.click()

  // Back on All the whole board is counted again.
  await tab('All').click()
  await expect(tab('All')).toHaveAttribute('aria-selected', 'true')
  expect(await countOf(waitingChip)).toBe(allWaiting)
})

test('the Projects view minibar has a Waiting toggle with the hidden count', async ({ page, browserName }) => {
  // The minibar lives on the Projects view of the tab bar (off by default in this fixture).
  await page.addInitScript(() => localStorage.setItem('walnut-todo-quick-views-visible', 'true'))
  await presetPanelView(page, { section: 'tasks' })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const parked = await createTask(`Minibarwait ${stamp}`)
  await api('PATCH', `/api/tasks/${parked.id}`, { phase: 'WAITING' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const rowEl = page.locator(`.todo-panel-item[data-task-id="${parked.id}"]`)
  const toggle = page.getByTestId('todo-minibar-waiting')
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  await expect(toggle).toHaveText(/^⧗ Waiting \(\d+\)$/)
  await expect(rowEl).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveClass(/\bon\b/)
  await expect(toggle).toHaveText('⧗ Waiting')
  await expect(rowEl).toBeVisible({ timeout: 15_000 })
  await shot(page.locator('.todo-minibar'), 'minibar-waiting-on', browserName)
  await toggle.click()
  await expect(rowEl).toHaveCount(0)
})

test('the Phase filter can show only Waiting tasks; a Waiting task keeps a plain TRIGGER pill', async ({ page, browserName }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const waiting = await createTask(`Waitfilter ${stamp} hit`)
  const plain = await createTask(`Waitfilter ${stamp} miss`)
  await api('PATCH', `/api/tasks/${waiting.id}`, { phase: 'WAITING' })
  const trigger = await api('POST', '/api/v1/routines/trigger', {
    run: 'bash ~/.open-walnut/triggers/cr/check.sh', every: '5m', session: waiting.id,
    prompt: 'Tell the user what the review said.',
    description: 'Checks CR 1234 every 5 minutes; fires once when it is approved.',
  })
  litterRoutines.push(trigger.job.id)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const rowEl = page.locator(`.todo-panel-item[data-task-id="${waiting.id}"]`)
  const plainRow = page.locator(`.todo-panel-item[data-task-id="${plain.id}"]`)
  await page.locator('.todo-search-input').fill(`Waitfilter ${stamp}`)
  await expect(rowEl).toBeVisible({ timeout: 15_000 })
  await expect(plainRow).toBeVisible()
  const pill = rowEl.getByTestId('task-trigger-pill')
  await expect(pill).toHaveText('TRIGGER')
  await expect(pill).not.toHaveAttribute('data-snoozed', 'true')
  await shot(rowEl, 'row-waiting-trigger', browserName)

  // The Phase (exact) filter offers Waiting and, during a search, shows the parked
  // task only. (The toolbar's legacy single-value Phase segment also lists it, but
  // that segment folds into the plain list, not into search mode, for every phase.)
  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-rail-btn[data-rail-section="quick"]').click()
  await expect(page.locator('.vd-panel .vd-seg-btn[data-phase-value="WAITING"]')).toHaveText('Waiting')
  await page.locator('.vd-rail-btn[data-rail-section="q-phase"]').click()
  const waitingChip = page.locator('.vd-panel .vd-cat[data-filter-value="WAITING"]')
  await expect(waitingChip).toHaveText('Waiting')
  await waitingChip.click()
  await page.keyboard.press('Escape')
  await expect(rowEl).toBeVisible({ timeout: 15_000 })
  await expect(plainRow).toHaveCount(0)
  await shot(page.locator('.todo-panel'), 'filter-waiting-only', browserName)
  // Chip off: both again.
  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-rail-btn[data-rail-section="q-phase"]').click()
  await page.locator('.vd-panel .vd-cat[data-filter-value="WAITING"]').click()
  await page.keyboard.press('Escape')
  await expect(rowEl).toBeVisible({ timeout: 15_000 })
  await expect(plainRow).toBeVisible()
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

test('the composer of a Waiting task says so, and a message moves it to In Progress, then Need Action', async ({ page, request, browserName }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-waiting-session-'))
  const started = await request.post('/api/sessions/quick-start', { data: { cwd, message: '' } })
  expect(started.ok(), await started.text()).toBeTruthy()
  const { sessionId: sid, taskId } = await started.json() as { sessionId: string; taskId: string }
  litterTasks.push(taskId)
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString()
  await api('PATCH', `/api/tasks/${taskId}`, { phase: 'WAITING', wait_until: until })

  const [panel] = await openPanels(page, [sid])
  const line = panel.getByTestId('session-waiting-line')
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(line).toContainText('Waiting until ')
  await expect(line).toContainText('· a message here moves it to In Progress')
  await expect(line.getByRole('button')).toHaveCount(0)
  await shot(panel.locator('.session-panel-input'), 'session-waiting-line', browserName)

  // A message: In Progress at once, the line goes, and the turn ends as Need Action.
  const box = composerTextarea(panel)
  await box.fill('how is it going?')
  await box.press('Enter')
  await expect.poll(async () => (await taskOf(taskId)).phase, { timeout: 30_000 }).not.toBe('WAITING')
  await expect(line).toHaveCount(0, { timeout: 15_000 })
  await expect(panel.getByText(/I processed your message: how is it going\?/).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await taskOf(taskId)).phase, { timeout: 30_000 }).toBe('NEED_ACTION')
  const after = await taskOf(taskId)
  expect(after.unread).toBe(true)
  expect(after.wait_until).toBeUndefined()
  await shot(panel, 'session-after-message', browserName)

  // Parked again with no time named: the default 3-day clock shows; an explicit
  // "" (no limit) is the one way to a wait with no time at all, and the line says so.
  await api('PATCH', `/api/tasks/${taskId}`, { phase: 'WAITING' })
  await expect(line).toContainText(/^Waiting until \S/, { timeout: 15_000 })
  await expect(line).not.toContainText('something happens')
  await api('PATCH', `/api/tasks/${taskId}`, { wait_until: '' })
  await expect(line).toContainText('Waiting until something happens', { timeout: 15_000 })
})
