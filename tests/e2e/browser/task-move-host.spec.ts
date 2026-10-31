/**
 * "Move to another host" in the session ⋮ menu (MoveHostMenuItems): the same task, its
 * conversation and its own work go to another host (POST /api/v1/tasks/:id/move).
 *
 * The first test reads the fixture server's real GET /api/v1/hosts/load (this Mac only)
 * and its real sessions route. The second cans the hosts (one with room, one over a cap)
 * and answers the POST here, asserting the body the UI sent: a real move needs a second
 * host (tests/core/sessions/task-move.test.ts moves real work between two). Run under
 * WebKit too: PW_WEBKIT=1 bun x playwright test tests/e2e/browser/task-move-host.spec.ts --project webkit
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openKebabGroup } from './kebab-group-helpers'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/task-move-host'
mkdirSync(SHOTS, { recursive: true })
test.describe.configure({ timeout: 120_000 })

const HOSTS = {
  hosts: [
    { host: '__local__', label: 'this Mac', known: true, busy: true, reasons: ['load 600 on 14 CPUs (42.86 per CPU, cap 3)'], loadPerCpu: 42.86, cpus: 14, diskFreeBytes: 20 * 1024 ** 3, running: 14, runningLimit: 7, score: 0 },
    { host: 'clouddev', label: 'clouddev', known: true, busy: false, reasons: [], loadPerCpu: 0.06, cpus: 48, diskFreeBytes: 2000 * 1024 ** 3, running: 1, runningLimit: 20, score: 40 },
    { host: 'devbox', label: 'devbox', known: false, busy: true, reasons: ['its load is unknown (not connected)'], running: 0, runningLimit: 20, score: 0 },
  ],
}

async function openMoveRow(page: Page) {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.locator('.session-panel-title-meta .task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu:visible')
  await openKebabGroup(menu, 'kebab-group-move')
  const toggle = menu.getByTestId('kebab-move-host-toggle')
  await expect(toggle).toHaveText(/Move to another host/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return menu
}

test('the real server: a Walnut with no other host says so', async ({ page }) => {
  const loads: number[] = []
  page.on('response', (r) => { if (r.url().includes('/api/v1/hosts/load')) loads.push(r.status()) })
  const menu = await openMoveRow(page)
  await expect(menu.getByText('No other host is set up')).toBeVisible({ timeout: 15_000 })
  expect(loads).toEqual([200])
})

test('each other host shows its room or why it is busy; a click moves the task there', async ({ page }) => {
  await page.route('**/api/v1/hosts/load', (route) => route.fulfill({ json: HOSTS }))
  const posted: Array<Record<string, unknown>> = []
  await page.route(`**/api/v1/tasks/${TASK_ID}/move`, async (route) => {
    posted.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 202, json: { state: 'moving', taskId: TASK_ID, host: 'clouddev' } })
  })
  const menu = await openMoveRow(page)
  // The task's own host (this Mac, from the real sessions route) is not offered.
  await expect(menu.getByTestId('kebab-move-host-__local__')).toHaveCount(0)
  const cloud = menu.getByTestId('kebab-move-host-clouddev')
  await expect(cloud).toContainText('Move to clouddev')
  await expect(cloud).toContainText('room · load 0.06/CPU · 1 working · 2000 GB free')
  await expect(cloud).toHaveAttribute('title', 'Has room: load 0.06 per CPU on 48 CPUs, 1 of 20 sessions in a turn')
  const devbox = menu.getByTestId('kebab-move-host-devbox')
  await expect(devbox).toContainText('load unknown')
  await menu.screenshot({ path: `${SHOTS}/move-rows.png` })
  await cloud.click()
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0]).toEqual({ host: 'clouddev', wait_ms: 0 })
  // The menu closes on the click.
  await expect(page.locator('.task-kebab-menu:visible')).toHaveCount(0)
})
