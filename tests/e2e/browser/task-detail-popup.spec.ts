import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startTimeFixture, type TimeFixture } from './time-app-fixture'

/**
 * The task details popup (TaskDetailPane in TaskDetailModal), redesigned 2026-10-06:
 * a header (project, title, status, priority, tags), then the main column (Sessions,
 * Parent, Subtasks, Description, Note) beside one rail of facts (Start, Due, plugin
 * facts, Source, Created, Updated, ID). A narrow popup stacks the rail above the main
 * column.
 *
 * The fixture (time-app-server.ts with PW_TIME_APP_SLOTS=1 and PW_TIME_APP_DETAIL=1)
 * gives one task four sessions (a CJK title, a title long enough to truncate, an
 * untitled one), a parent, three subtasks (one done), tags, both dates and
 * a Markdown description and note, plus a task with none of it.
 *
 * What it pins: every part is plain rows under a small label, never a box per part;
 * a session is its title and never its id; rows lead where they say (a subtask, the
 * parent, a session: each a task reference, so Home with the popup gone, useOpenTask);
 * the rail's dates are editable in place and reach the
 * server; the empty task says so in one line; both layouts hold in both engines.
 */

const SHOTS = '/tmp/task-detail-redesign'
const TASK = 't-time-slots'

let fixture: TimeFixture | null = null
let stopFixture: (() => Promise<void>) | null = null

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 860 } })

const base = () => `http://127.0.0.1:${fixture!.port}`

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  ;({ fixture, stop: stopFixture } = await startTimeFixture({ PW_TIME_APP_SLOTS: '1', PW_TIME_APP_DETAIL: '1' }))
})

test.afterAll(async () => { await stopFixture?.() })

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function loadHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
      localStorage.removeItem('open-walnut-layout:home-columns')
    } catch { /* storage off */ }
  })
  await page.goto(`${base()}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
}

async function openDetails(page: Page, taskId: string, search: string): Promise<Locator> {
  // Typed again until the row shows: a list that hydrates late can reset the box.
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]:visible`).first()
  await expect(async () => {
    await page.locator('.todo-search-input').fill(search)
    await expect(row).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 40_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

const factLabels = (modal: Locator) => modal.locator('.tdp-rail .tdp-fact:visible .tdp-fact-k').allTextContents()
const exactly = (label: string) => new RegExp(`^${label}\\s*\\d*$`)
const fact = (modal: Locator, label: string) => modal.locator('.tdp-rail .tdp-fact').filter({ has: modal.page().locator('.tdp-fact-k', { hasText: exactly(label) }) })
const section = (modal: Locator, label: string) => modal.locator('.tdp-section').filter({ has: modal.page().locator('.tdp-label', { hasText: exactly(label) }) })

test('a busy task reads as one header, a main column of rows and a rail of facts', async ({ page, browserName }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const modal = await openDetails(page, TASK, 'Time slots fixture')

  // Header: where it lives, what it is, its state.
  await expect(modal.locator('.todo-detail-project')).toHaveText('Console')
  await expect(modal.locator('.todo-detail-title')).toHaveText('Time slots fixture task')
  const badges = modal.locator('.todo-detail-badges')
  // Its user status: IN_PROGRESS with no turn running reads Waiting (taskStatusLabel).
  await expect(badges).toContainText('Waiting')
  await expect(badges.locator('[data-testid="tag-editor"]')).toContainText('review')

  // Session: the task's one session, its three earlier ones folded under it (one session per
  // task, d9942deb9); opened, four rows, each its title, never its id.
  const sessions = section(modal, 'Session')
  const earlier = sessions.getByRole('button', { name: 'Earlier sessions (3)' })
  await expect(earlier).toHaveAttribute('aria-expanded', 'false')
  await expect(sessions.locator('.todo-detail-session-item')).toHaveCount(1)
  await earlier.click()
  const rows = sessions.locator('.todo-detail-session-item')
  await expect(rows).toHaveCount(4, { timeout: 20_000 })
  await expect(rows.filter({ hasText: 'Rename the time grid \u91cd\u547d\u540d' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Untitled session' })).toHaveCount(1)
  expect(await modal.innerText()).not.toContain('sess-time-slots')
  // A long title stays one line; the hover text has all of it.
  const long = rows.filter({ hasText: 'Review the day-by-day list' })
  expect((await long.locator('.tdp-row-title').boundingBox())!.height).toBeLessThanOrEqual(22)
  await expect(long).toHaveAttribute('title', /a title long enough to truncate/)

  // Parent and subtasks: rows, the done one struck through.
  await expect(section(modal, 'Parent')).toContainText('Time tracking epic')
  const subtasks = section(modal, 'Subtasks')
  await expect(subtasks.locator('.tdp-label-count')).toHaveText('3')
  await expect(subtasks.locator('.tdp-task-row')).toHaveCount(3)
  await expect(subtasks.locator('.tdp-task-row.is-done')).toHaveText(/Collect the agent clock/)

  // Description and Note: the shared rich editor (TaskFieldEditor), its Markdown drawn as text,
  // not a card per part.
  const description = section(modal, 'Description')
  const note = section(modal, 'Note')
  await expect(description.locator('.ProseMirror h2')).toHaveText('What this is')
  await expect(note.locator('.ProseMirror h3')).toHaveText('Next')
  const doc = await note.locator('.ProseMirror').evaluate((el) => {
    const cs = getComputedStyle(el)
    return { border: cs.borderTopWidth, background: cs.backgroundColor, width: el.getBoundingClientRect().width }
  })
  expect(doc.border).toBe('0px')
  expect(doc.background).toBe('rgba(0, 0, 0, 0)')
  // It stays inside the main column (a fixed pixel cap broke when the editor took the field).
  expect(doc.width).toBeLessThanOrEqual((await modal.locator('.tdp-main').boundingBox())!.width + 0.5)

  // The parts in reading order.
  const tops = await Promise.all(['Session', 'Parent', 'Subtasks', 'Description', 'Note'].map(async (label) => (await section(modal, label).boundingBox())!.y))
  expect([...tops].sort((a, b) => a - b)).toEqual(tops)

  // The rail: one fact per row, to the right of the main column.
  await expect(fact(modal, 'Time')).toBeVisible({ timeout: 60_000 })
  expect(await factLabels(modal)).toEqual(['Start', 'Due', 'Time', 'Source', 'Created', 'Updated', 'ID'])
  await expect(fact(modal, 'Source')).toContainText('Local')
  await expect(fact(modal, 'ID')).toContainText(TASK)
  const [main, rail] = await Promise.all([modal.locator('.tdp-main').boundingBox(), modal.locator('.tdp-rail').boundingBox()])
  expect(rail!.x).toBeGreaterThan(main!.x + main!.width)
  expect(Math.abs(rail!.y - main!.y)).toBeLessThan(4)
  await page.waitForTimeout(300)
  await modal.screenshot({ path: `${SHOTS}/after-${browserName}-wide.png`, animations: 'disabled' })
  expect(errors).toEqual([])
})

test('rows lead where they say, and the rail\'s dates change in place', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const modal = await openDetails(page, TASK, 'Time slots fixture')

  // A subtask row opens that task on Home (a task reference, useOpenTask, 2026-11-13): the popup
  // goes and Home's list has the task selected, never a second popup. The Parent row the same.
  const located = (title: string) => page.locator('#home-task-navigation').locator('.task-focused, .todo-pinned-card-active').filter({ hasText: title })
  await section(modal, 'Subtasks').locator('.tdp-task-row').filter({ hasText: 'Draw the day by day page' }).click()
  await expect(modal).toHaveCount(0)
  await expect(located('Draw the day by day page')).toHaveCount(1, { timeout: 20_000 })
  await openDetails(page, TASK, 'Time slots fixture')
  await section(modal, 'Parent').locator('.tdp-task-row').click()
  await expect(modal).toHaveCount(0)
  await expect(located('Time tracking epic')).toHaveCount(1, { timeout: 20_000 })
  await openDetails(page, TASK, 'Time slots fixture')

  // Due: the picker on the rail. Escape closes the picker alone, not the popup under it.
  const due = fact(modal, 'Due')
  await due.locator('.dp-trigger').click()
  await expect(page.locator('.dp-content')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.dp-content')).toHaveCount(0)
  await expect(modal).toBeVisible()
  // A day pill, and the server has it; the picker closes on the pick.
  await due.locator('.dp-trigger').click()
  const pill = page.locator('.dp-content .dp-pills').nth(1).locator('.dp-pill').first()
  const day = (await pill.getAttribute('data-date'))!
  await pill.click()
  await expect.poll(async () => {
    const res = await page.request.get(`${base()}/api/tasks/${TASK}`)
    const body = await res.json() as { task?: { due_date?: string }; due_date?: string }
    return (body.task ?? body).due_date ?? ''
  }, { timeout: 15_000 }).toContain(day)
  await expect(page.locator('.dp-content')).toHaveCount(0)
  await expect(modal).toBeVisible()
  await expect(due.locator('.dp-trigger')).not.toHaveText('Set date')

  // A session row opens that session's column, and the popup goes.
  const sid = fixture!.slots.sessionIds[0]!
  await modal.locator(`.todo-detail-session-item[data-session-id="${sid}"]`).click()
  await expect(page.locator(`.main-page-session-column[data-column-id="${sid}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(modal).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a narrow popup puts the facts first, then the main column', async ({ page, browserName }) => {
  const errors = watchErrors(page)
  // A desktop window just wide enough not to be the phone app (768 px and below, 7e7f280b6,
  // where the popup is a full-screen page): the popup is then under its 720 px container width.
  await page.setViewportSize({ width: 790, height: 900 })
  await loadHome(page)
  const modal = await openDetails(page, TASK, 'Time slots fixture')
  expect((await modal.locator('.tdp').boundingBox())!.width).toBeLessThanOrEqual(720)
  // The earlier sessions, folded under the task's one session, hold the long title.
  await modal.getByRole('button', { name: 'Earlier sessions (3)' }).click()
  await expect(modal.locator('.todo-detail-session-item')).toHaveCount(4, { timeout: 20_000 })
  // The long session title stays on one line, and one too long for it is cut with an ellipsis
  // (at the narrowest desktop width it still fits, so the rule is read, not a cut seen).
  const cut = await modal.locator('.todo-detail-session-item').filter({ hasText: 'Review the day-by-day list' })
    .locator('.tdp-row-title').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { overflow: cs.textOverflow, wrap: cs.whiteSpace, hidden: cs.overflow, height: el.getBoundingClientRect().height }
    })
  expect(cut).toMatchObject({ overflow: 'ellipsis', wrap: 'nowrap', hidden: 'hidden' })
  expect(cut.height).toBeLessThanOrEqual(22)
  const [main, rail] = await Promise.all([modal.locator('.tdp-main').boundingBox(), modal.locator('.tdp-rail').boundingBox()])
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(main!.y)
  expect(Math.abs(rail!.width - main!.width)).toBeLessThan(2)
  // Nothing spills sideways.
  const overflow = await modal.locator('.todo-detail-pane').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.waitForTimeout(300)
  await modal.screenshot({ path: `${SHOTS}/after-${browserName}-narrow.png`, animations: 'disabled' })
  expect(errors).toEqual([])
})

test('a task with nothing yet shows only its empty description and note, with its facts beside it', async ({ page, browserName }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const modal = await openDetails(page, fixture!.slots.emptyTaskId, 'Time empty fixture')
  // Nothing to list: no Session, Parent or Subtasks part; Description and Note are the empty
  // editors to write in (the one-line empty state went with 6b0d0b5cb).
  for (const label of ['Session', 'Parent', 'Subtasks']) await expect(section(modal, label)).toHaveCount(0)
  for (const label of ['Description', 'Note']) await expect(section(modal, label).locator('.ProseMirror')).toHaveText('')
  await expect(fact(modal, 'Start').locator('.dp-trigger')).toHaveText('Set date')
  await expect(fact(modal, 'Due').locator('.dp-trigger')).toHaveText('Set date')
  await page.waitForTimeout(500)
  const labels = await factLabels(modal)
  expect(labels.slice(0, 3)).toEqual(['Start', 'Due', 'Source'])
  expect(labels.at(-1)).toBe('ID')
  expect(labels).not.toContain('Time')
  await modal.screenshot({ path: `${SHOTS}/after-${browserName}-empty.png`, animations: 'disabled' })
  expect(errors).toEqual([])
})
