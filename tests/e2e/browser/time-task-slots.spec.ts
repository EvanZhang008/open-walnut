import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * How long a task took, where the task is: the walnut-time plugin's two slots
 * (`walnut.ui.slot`) and the task page they lead to.
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
 * (Total / Today / 7 days), and session A reads 50m · 3h 02m.
 *
 * What it pins: the numbers on both slots are those (two lanes, never summed); each
 * slot leads to the task page, the chip with its session already chosen; the page
 * lists the days newest first with each session's share and the time outside any
 * session, names sessions by title and never by id; a narrow column moves the chip
 * into the header's "..." menu and it still opens from there; the end of a turn (a
 * real session:result on the server's bus) refreshes the chip; and disabling the
 * plugin takes both slots away without a reload.
 */

const SHOTS = '/tmp/time-task-slots'
const TASK = 't-time-slots'
const SID_A = 'sess-time-slots-a'

interface Fixture {
  port: number
  home: string
  slots: { taskId: string; sessionIds: string[]; today: string }
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

async function openDetails(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill('Time slots fixture')
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK}"]:visible`).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

const cell = (slot: Locator, name: string) => slot.locator(`[data-cell="${name}"]`)
const column = (page: Page, sid: string) => page.locator(`.main-page-session-column[data-column-id="${sid}"]`)

async function openColumnFromDetails(page: Page, sid: string): Promise<Locator> {
  const modal = await openDetails(page)
  await modal.locator(`.todo-detail-session-item[title="${sid}"]`).click()
  const col = column(page, sid)
  await expect(col).toBeVisible({ timeout: 30_000 })
  // Opening a session from the details leaves them open over its column; put them away.
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await expect(col.getByText('slots answer 12')).toBeVisible({ timeout: 30_000 })
  return col
}

test('the task details carry the time, and lead to the task\'s days', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const modal = await openDetails(page)
  const slot = modal.getByTestId('time-task-slot')
  await expect(slot).toBeVisible({ timeout: 30_000 })

  // The 200-day-old 20 minutes arrive with the history read, a moment after boot; the
  // slot asks again until the server says it has every day.
  await expect(cell(slot, 'you-total')).toHaveText('1h 34m', { timeout: 60_000 })
  await expect(cell(slot, 'you-today')).toHaveText('29m')
  await expect(cell(slot, 'you-week')).toHaveText('59m')
  await expect(cell(slot, 'agent-total')).toHaveText('3h 19m')
  await expect(cell(slot, 'agent-today')).toHaveText('1h 12m')
  await expect(cell(slot, 'agent-week')).toHaveText('3h 12m')
  await expect(slot).toHaveAttribute('aria-label', /You: 1h 34m total, 29m today, 59m in 7 days/)
  // A table inside the details, not a block that overflows them.
  const [slotBox, modalBox] = await Promise.all([slot.boundingBox(), modal.boundingBox()])
  expect(slotBox!.x + slotBox!.width).toBeLessThanOrEqual(modalBox!.x + modalBox!.width + 0.5)
  await modal.screenshot({ path: `${SHOTS}/task-detail-slot.png` })
  // The open details are part of Home's address (written a moment after they open).
  await expect(page).toHaveURL(new RegExp(`/\\?task=${TASK}$`))

  await slot.click()
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
  const dates = await days.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.date ?? ''))
  expect(dates[0]).toBe(today)
  expect([...dates].sort().reverse()).toEqual(dates)

  // Today is open: each session's share, then the time on the task outside any session.
  const todayRow = days.first()
  await expect(todayRow).toContainText('Rename the time grid \u91cd\u547d\u540d')
  await expect(todayRow).toContainText('You 20m')
  await expect(todayRow).toContainText('Agent 1h 02m')
  await expect(todayRow.locator('.is-other')).toContainText('Outside a session')
  await expect(todayRow.locator('.is-other')).toContainText('You 4m')
  // A second day opens on click.
  await days.nth(1).locator('.wt-task-day-row').click()
  await expect(days.nth(1).locator('.wt-task-day-sessions')).toContainText('Agent 2h 00m')

  // Every session by its title; the untitled one by the day it last ran. Never an id.
  const tabs = page.getByTestId('time-task-session')
  await expect(tabs).toHaveCount(3)
  await expect(tabs.filter({ hasText: 'Untitled session (' })).toHaveCount(1)
  expect(await view.innerText()).not.toContain('sess-time-slots')
  await page.screenshot({ path: `${SHOTS}/task-page.png` })

  // Narrowed to one session: its own totals and only its days.
  await tabs.filter({ hasText: 'Rename the time grid' }).click()
  await expect(page).toHaveURL(new RegExp(`/task/${TASK}\\?session=${SID_A}$`))
  await expect(total).toContainText('50m')
  await expect(total).toContainText('3h 02m')
  await expect(days).toHaveCount(2)
  await page.screenshot({ path: `${SHOTS}/task-page-session.png` })

  // Back is where the click came from: Home, with the same details open again.
  await page.getByTestId('time-task-back').click()
  await expect(page).toHaveURL(new RegExp(`/\\?task=${TASK}$`))
  await expect(page.locator('.task-detail-modal').getByTestId('time-task-slot')).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('the session header carries a chip that opens the task page on that session', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  const chip = col.getByTestId('time-session-chip')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip.locator('.is-human')).toHaveText('50m')
  await expect(chip.locator('.is-agent')).toHaveText('3h 02m')
  await expect(chip).toHaveAttribute('title', /You: 50m total, 20m today, 50m in 7 days/)
  await expect(chip).toHaveAttribute('title', /Agent: 3h 02m total, 1h 02m today, 3h 02m in 7 days/)
  // One line, the height of the row's own chips.
  const [chipBox, filesBox] = await Promise.all([
    chip.boundingBox(),
    col.locator('[data-header-id="files"]').boundingBox(),
  ])
  if (filesBox) expect(Math.abs(chipBox!.height - filesBox.height)).toBeLessThanOrEqual(3)
  const headBox = (await col.boundingBox())!
  await page.screenshot({ path: `${SHOTS}/session-chip.png`, clip: { x: headBox.x, y: headBox.y, width: headBox.width, height: 140 } })

  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/task/${TASK}\\?session=${SID_A}$`))
  await expect(page.getByTestId('time-task-session').filter({ hasText: 'Rename the time grid' }))
    .toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('time-task-back').click()
  await expect(column(page, SID_A)).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('a narrow column moves the chip into the "..." menu, and it opens from there', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  // Columns side by side: the crowded case, where each column is narrow. A last, so
  // the panel count (which evicts the oldest column) keeps it.
  const modal = await openDetails(page)
  for (const sid of [...fixture!.slots.sessionIds].reverse()) {
    await modal.locator(`.todo-detail-session-item[title="${sid}"]`).click()
    await expect(column(page, sid)).toBeVisible({ timeout: 30_000 })
  }
  await expect(page.locator('.main-page-session-column').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  const col = column(page, SID_A)
  const wrapper = col.locator('[data-header-id^="slot:"]')
  await expect(wrapper).toHaveAttribute('data-header-name', 'Time', { timeout: 30_000 })

  // Narrow the window (never into the phone layout) until the chip leaves the row.
  let width = 1280
  while ((await wrapper.getAttribute('data-hidden')) !== 'true' && width > 800) {
    width -= 40
    await page.setViewportSize({ width, height: 860 })
    await page.waitForTimeout(150)
  }
  await expect(wrapper).toHaveAttribute('data-hidden', 'true')
  // It is the first chip to leave: the host's own chips are still on the row.
  await expect(col.locator('[data-header-id="files"]')).not.toHaveAttribute('data-hidden', 'true')

  await col.locator('[data-header-more]').click()
  const item = page.locator('.session-header-more-menu [role="menuitem"]', { hasText: 'Time' })
  await expect(item).toBeVisible()
  // The menu says what the chip said.
  await expect(item.locator('.session-header-more-value')).toHaveText('50m · 3h 02m')
  await page.screenshot({ path: `${SHOTS}/session-chip-in-more.png` })
  await item.click()
  await expect(page).toHaveURL(new RegExp(`/task/${TASK}\\?session=${SID_A}$`))
  await expect(page.getByTestId('time-task-page')).toBeVisible()
  expect(errors).toEqual([])
})

test('the end of a turn refreshes the chip', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  const chip = col.getByTestId('time-session-chip')
  await expect(chip.locator('.is-agent')).toHaveText('3h 02m', { timeout: 30_000 })

  // A five-minute turn of session A ends. The fixture emits the server's real
  // session:result: the agent-time collector banks it, and the server forwards the
  // event to the browser, where the plugin asks again a moment later.
  await fs.writeFile(`${fixture!.home}/end-turn.json`, JSON.stringify({
    sessionId: SID_A, taskId: TASK, turnGen: 101, duration: 5 * 60_000,
  }))
  await expect(chip.locator('.is-agent')).toHaveText('3h 07m', { timeout: 15_000 })
  // Well before the 60s poll: it was the turn's end that refreshed it.
  expect(errors).toEqual([])
})

/* LAST: it disables the plugin, and the fixture is shared by the whole file. */
test('disabling the plugin takes both slots away without a reload', async ({ page }) => {
  const errors = watchErrors(page)
  await loadHome(page)
  const col = await openColumnFromDetails(page, SID_A)
  await expect(col.getByTestId('time-session-chip')).toBeVisible({ timeout: 30_000 })
  const modal = await openDetails(page)
  await expect(modal.getByTestId('time-task-slot')).toBeVisible({ timeout: 30_000 })

  const disabled = await page.request.post(`${base()}/api/plugin-runtime/walnut-time/disable`)
  expect(disabled.ok(), await disabled.text()).toBe(true)

  await expect(modal.getByTestId('time-task-slot')).toHaveCount(0, { timeout: 60_000 })
  await expect(modal.locator('.todo-detail-plugin-slots')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(col.getByTestId('time-session-chip')).toHaveCount(0)
  await expect(col.locator('[data-header-id^="slot:"]')).toHaveCount(0)
  // The rest of the row is untouched.
  await expect(col.locator('[data-header-more], [data-header-id="files"]').first()).toBeVisible()
  expect(errors).toEqual([])
})
