import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * How long a task took, where the task is: the walnut-time plugin's two Time facts
 * (`walnut.ui.slot` 'task.meta' and 'session.meta') and the task page they lead to.
 *
 * The fixture (time-app-server.ts with PW_TIME_APP_SLOTS=1) links the real plugin and
 * seeds one task with three sessions and time on four days: today, 3 days ago, 10 days
 * ago (outside the 7 days) and 200 days ago (outside the server's 90-day hydrate
 * window, so it only arrives through the background history read). Minutes:
 *
 *   day     session A        session B       session C   outside a session
 *   today   you 20, agent 62  you 5, agent 10                 you 4
 *   -3      you 30, agent 120
 *   -10                       you 15          agent 7
 *   -200                                                      you 20
 *
 * so the task reads You 1h 34m / 29m / 59m and Agent 3h 19m / 1h 12m / 3h 12m
 * (Total / Today / 7 days), and session A reads 50m and 3h 02m. A fourth session and
 * a second task have nothing recorded.
 *
 * What it pins: each fact is ONE short value with its surface's own facts (the task
 * details' metadata line, the top of the session menu), never a block and never a chip
 * on the session header's row; the hover text carries all six numbers; each leads to
 * the task page, the session's with that session chosen; the page lists the days newest
 * first with each session's share and the time outside any session, names sessions by
 * title and never by id; nothing recorded means no fact and no stray label; the end of
 * a turn (a real session:result on the server's bus) refreshes the open menu; and
 * disabling the plugin takes both facts away without a reload.
 */

const SHOTS = '/tmp/time-task-slots'
const TASK = 't-time-slots'
const SID_A = 'sess-time-slots-a'

interface Fixture {
  port: number
  home: string
  slots: { taskId: string; emptyTaskId: string; sessionIds: string[]; today: string }
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 860 } })

const base = () => `http://127.0.0.1:${fixture!.port}`

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Time fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /TIME_APP_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as Fixture)
      } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Time fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/time-app-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_TIME_APP_PORT: String(port), PW_TIME_APP_SLOTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
  ])
  if (!graceful) child.kill('SIGKILL')
})

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
    } catch { /* storage off */ }
  })
  await page.goto(`${base()}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
}

async function openDetails(page: Page, taskId = TASK, search = 'Time slots fixture'): Promise<Locator> {
  await page.locator('.todo-search-input').fill(search)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]:visible`).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

const cell = (slot: Locator, name: string) => slot.locator(`[data-cell="${name}"]`)
const column = (page: Page, sid: string) => page.locator(`.main-page-session-column[data-column-id="${sid}"]`)

async function openMenu(page: Page, col: Locator): Promise<Locator> {
  await col.locator('.session-panel-header').getByRole('button', { name: 'More actions' }).first().click()
  const menu = page.locator('.task-kebab-menu:visible').first()
  await expect(menu).toBeVisible()
  return menu
}

/** Wait for the plugin's answer about one object, so an absence is a real one. */
const answered = (page: Page, path: string) =>
  page.waitForResponse((r) => r.url().includes(path) && r.status() === 200, { timeout: 30_000 })

async function openColumnFromDetails(page: Page, sid: string): Promise<Locator> {
  const modal = await openDetails(page)
  await modal.locator(`.todo-detail-session-item[title="${sid}"]`).click()
  const col = column(page, sid)
  await expect(col).toBeVisible({ timeout: 30_000 })
  // Opening a session from the details leaves them open over its column; put them away.
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await expect(col.getByText('slots answer 12').first()).toBeVisible({ timeout: 30_000 })
  return col
}

test('the task details carry the time as one fact, and lead to the task\'s days', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const modal = await openDetails(page)
  const dates = modal.locator('.todo-detail-dates')
  const fact = dates.getByTestId('time-task-fact')

  // The 200-day-old 20 minutes arrive with the history read, a moment after boot; the
  // fact asks again until the server says it has every day.
  await expect(cell(fact, 'you-total')).toHaveText('1h 34m', { timeout: 60_000 })
  await expect(cell(fact, 'agent-total')).toHaveText('3h 19m')
  await expect(fact).toHaveText('You 1h 34m \u00b7 Agent 3h 19m')
  // One labelled fact on the metadata line, and the hover text holds all six numbers.
  await expect(dates).toContainText('Time You 1h 34m \u00b7 Agent 3h 19m')
  await expect(fact).toHaveAttribute('title', /You: 1h 34m total, 29m today, 59m in 7 days/)
  await expect(fact).toHaveAttribute('title', /Agent: 3h 19m total, 1h 12m today, 3h 12m in 7 days/)
  // Never a block of its own: the old table and its wrapper are gone.
  await expect(modal.locator('.wt-slot-task, .todo-detail-plugin-slots')).toHaveCount(0)
  const [factBox, idBox] = await Promise.all([fact.boundingBox(), dates.boundingBox()])
  expect(factBox!.height).toBeLessThanOrEqual(idBox!.height + 0.5)
  await dates.screenshot({ path: `${SHOTS}/task-detail-fact.png` })
  // The open details are part of Home's address (written a moment after they open).
  await expect(page).toHaveURL(new RegExp(`/\\?task=${TASK}$`))

  await fact.click()
  await expect(page).toHaveURL(new RegExp(`/apps/walnut-time~main/task/${TASK}$`))
  // The details float over Home; going somewhere else closes them, or they would cover the page.
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  const view = page.getByTestId('time-task-page')
  await expect(view).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-task-title')).toHaveText('Time slots fixture task')
  const total = view.locator('[data-total="Total"]')
  await expect(total).toContainText('1h 34m')
  await expect(total).toContainText('3h 19m')

  // Newest first, only the days with time, the long-ago day included.
  const today = fixture!.slots.today
  const days = page.getByTestId('time-task-day')
  await expect(days).toHaveCount(4)
  const dayDates = await days.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.date ?? ''))
  expect(dayDates[0]).toBe(today)
  expect([...dayDates].sort().reverse()).toEqual(dayDates)

  // Today is open: each session's share, then the time on the task outside any session.
  const todayRow = days.first()
  await expect(todayRow).toContainText('Rename the time grid \u91cd\u547d\u540d')
  await expect(todayRow).toContainText('You 20m')
  await expect(todayRow).toContainText('Agent 1h 02m')
  await expect(todayRow.locator('.is-other')).toContainText('Outside a session')
  await expect(todayRow.locator('.is-other')).toContainText('You 4m')
  await days.nth(1).locator('.wt-task-day-row').click()
  await expect(days.nth(1).locator('.wt-task-day-sessions')).toContainText('Agent 2h 00m')

  // Every session with time by its title; the untitled one by the day it last ran. Never an id.
  const tabs = page.getByTestId('time-task-session')
  await expect(tabs).toHaveCount(3)
  await expect(tabs.filter({ hasText: 'Untitled session (' })).toHaveCount(1)
  expect(await view.innerText()).not.toContain('sess-time-slots')
  await page.screenshot({ path: `${SHOTS}/task-page.png` })

  await tabs.filter({ hasText: 'Rename the time grid' }).click()
  await expect(page).toHaveURL(new RegExp(`/task/${TASK}\\?session=${SID_A}$`))
  await expect(total).toContainText('50m')
  await expect(total).toContainText('3h 02m')
  await expect(days).toHaveCount(2)

  // Back is where the click came from: Home, with the same details open again.
  await page.getByTestId('time-task-back').click()
  await expect(page).toHaveURL(new RegExp(`/\\?task=${TASK}$`))
  await expect(page.locator('.task-detail-modal').getByTestId('time-task-fact')).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('a session\'s time is a fact in its menu, never a chip on the header row', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  // The header row is the host's own tools, and nothing else.
  await expect(col.locator('.session-panel-header').getByTestId('time-session-fact')).toHaveCount(0)
  await expect(col.locator('[data-header-id^="slot:"], .wt-slot-chip')).toHaveCount(0)

  const menu = await openMenu(page, col)
  const fact = menu.getByTestId('time-session-fact')
  await expect(cell(fact, 'you-total')).toHaveText('50m', { timeout: 30_000 })
  await expect(cell(fact, 'agent-total')).toHaveText('3h 02m')
  // A labelled row at the top of the menu, right under Panels, seen without scrolling.
  const row = menu.locator('.task-kebab-fact')
  await expect(row).toHaveText('Time You 50m \u00b7 Agent 3h 02m')
  await expect(fact).toHaveAttribute('title', /You: 50m total, 20m today, 50m in 7 days/)
  await expect(fact).toHaveAttribute('title', /Agent: 3h 02m total, 1h 02m today, 3h 02m in 7 days/)
  const [rowBox, menuBox, panelsBox] = await Promise.all([
    row.boundingBox(), menu.boundingBox(),
    menu.locator('.task-kebab-tier').filter({ hasText: 'Panels' }).boundingBox(),
  ])
  expect(rowBox!.y).toBeGreaterThan(panelsBox!.y)
  expect(rowBox!.y - menuBox!.y).toBeLessThan(120)
  expect(rowBox!.height).toBeLessThanOrEqual(panelsBox!.height + 1)
  await page.screenshot({ path: `${SHOTS}/session-menu-fact.png`, clip: { x: menuBox!.x, y: menuBox!.y, width: menuBox!.width, height: 220 } })

  await fact.click()
  await expect(page).toHaveURL(new RegExp(`/task/${TASK}\\?session=${SID_A}$`))
  await expect(page.locator('.task-kebab-menu:visible')).toHaveCount(0)
  await expect(page.getByTestId('time-task-session').filter({ hasText: 'Rename the time grid' }))
    .toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('time-task-back').click()
  await expect(column(page, SID_A)).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('nothing recorded means no Time fact and no stray label', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const emptyTask = fixture!.slots.emptyTaskId
  const taskAnswer = answered(page, `/api/time/task/${emptyTask}`)
  const modal = await openDetails(page, emptyTask, 'Time empty fixture')
  await taskAnswer
  await page.waitForTimeout(300)
  await expect(modal.getByTestId('time-task-fact')).toHaveCount(0)
  await expect(modal.locator('.todo-detail-dates')).not.toContainText('Time')
  await page.keyboard.press('Escape')

  const SID_D = fixture!.slots.sessionIds[3]!
  const col = await openColumnFromDetails(page, SID_D)
  const sessionAnswer = answered(page, `/api/time/session/${SID_D}`)
  const menu = await openMenu(page, col)
  await sessionAnswer
  await page.waitForTimeout(300)
  await expect(menu.getByTestId('time-session-fact')).toHaveCount(0)
  await expect(menu.locator('.task-kebab-fact')).toBeHidden()
  expect(await menu.locator('.task-kebab-tier-label').allTextContents()).not.toContain('Time')
  expect(errors).toEqual([])
})

test('the end of a turn refreshes the open menu', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  const menu = await openMenu(page, col)
  const fact = menu.getByTestId('time-session-fact')
  await expect(cell(fact, 'agent-total')).toHaveText('3h 02m', { timeout: 30_000 })

  // A five-minute turn of session A ends. The fixture emits the server's real
  // session:result: the agent-time collector banks it, and the server forwards the
  // event to the browser, where the plugin asks again a moment later.
  await fs.writeFile(`${fixture!.home}/end-turn.json`, JSON.stringify({
    sessionId: SID_A, taskId: TASK, turnGen: 101, duration: 5 * 60_000,
  }))
  await expect(cell(fact, 'agent-total')).toHaveText('3h 07m', { timeout: 15_000 })
  // Well before the 60s poll: it was the turn's end that refreshed it.
  expect(errors).toEqual([])
})

/* LAST: it disables the plugin, and the fixture is shared by the whole file. */
test('disabling the plugin takes both facts away without a reload', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  const modal = await openDetails(page)
  await expect(modal.getByTestId('time-task-fact')).toBeVisible({ timeout: 30_000 })

  const disabled = await page.request.post(`${base()}/api/plugin-runtime/walnut-time/disable`)
  expect(disabled.ok(), await disabled.text()).toBe(true)

  await expect(modal.getByTestId('time-task-fact')).toHaveCount(0, { timeout: 60_000 })
  await expect(modal.locator('.todo-detail-dates')).not.toContainText('Time')
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  const menu = await openMenu(page, col)
  await expect(menu.locator('.task-kebab-tier').filter({ hasText: 'Panels' })).toBeVisible()
  await expect(menu.getByTestId('time-session-fact')).toHaveCount(0)
  await expect(menu.locator('.task-kebab-fact')).toHaveCount(0)
  expect(errors).toEqual([])
})
