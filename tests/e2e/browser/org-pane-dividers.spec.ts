/**
 * The Org page's own dividers (web/src/components/org/OrgPaneHandle.tsx, OrgPage.tsx), 2026-11-02,
 * the user, pointing at the line between a node and a task opened beside it: "this line need ot move the bar".
 *   - the line before an opened task drags its width, kept across a reload; double-click resets it
 *   - the node between keeps 480px, an opened task 340px
 *   - the list's right edge drags too: 200 to 480px, kept, double-click back to 300px
 *   - a window too narrow for a column lays the task over the node, with no divider
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openTaskFromRail } from './org-view-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Org dividers ${STAMP}`
const NODE = `project:${PROJECT.toLowerCase()}`
const SIDE_KEY = 'open-walnut-org-side-w'
const LIST_KEY = 'open-walnut-org-list-w'
const made: string[] = []
let alpha = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function openNode(page: Page): Promise<void> {
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
}

async function openAlphaBeside(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await openNode(page)
  await openTaskFromRail(page, alpha, () => expect(page.getByTestId('org-side')).toBeVisible({ timeout: 3_000 }))
}

const widthOf = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!.width

/** Drag a divider by dx (negative = to the left). */
async function drag(page: Page, testId: string, dx: number): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + Math.min(300, box.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y)
  await page.mouse.up()
}

test.beforeAll(async ({ request }) => {
  // Two tasks: a project of one would read that task as its lead.
  for (const title of [`Divider alpha ${STAMP}`, `Divider beta ${STAMP}`]) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
    made.push(task.id)
  }
  alpha = made[0]
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  made.push(contact.task.id)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`)
})

test('the line before an opened task drags its width, kept across a reload; double-click resets it', async ({ page }) => {
  // Wide enough that the task's own default (at most 560px) is not already capped by the node's 480px.
  await page.setViewportSize({ width: 1800, height: 860 })
  await openAlphaBeside(page)
  const handle = page.getByTestId('org-side-handle')
  await expect(handle).toBeVisible()
  await expect(handle).toHaveAttribute('role', 'separator')
  const before = await widthOf(page, '.org-side-strip')

  await drag(page, 'org-side-handle', -120)
  const wider = await widthOf(page, '.org-side-strip')
  expect(wider).toBeGreaterThan(before + 100)
  expect(wider).toBeLessThan(before + 140)
  expect(Number(await page.evaluate((k) => localStorage.getItem(k), SIDE_KEY))).toBeGreaterThan(0)
  await page.screenshot({ path: `test-results/org-side-divider-${test.info().project.name}.png` })

  // Kept across a reload (the opened task comes back with the page).
  await page.reload()
  await expect(page.getByTestId('org-side')).toBeVisible()
  await expect.poll(() => widthOf(page, '.org-side-strip')).toBeGreaterThan(wider - 3)
  expect(await widthOf(page, '.org-side-strip')).toBeLessThan(wider + 3)

  await page.getByTestId('org-side-handle').dblclick()
  await expect.poll(() => widthOf(page, '.org-side-strip')).toBeLessThan(before + 3)
  expect(await widthOf(page, '.org-side-strip')).toBeGreaterThan(before - 3)
  expect(await page.evaluate((k) => localStorage.getItem(k), SIDE_KEY)).toBeNull()
})

test('neither the node nor the opened task gets unreadable; the keys move it; a narrow window has no divider', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 860 })
  await openAlphaBeside(page)
  await drag(page, 'org-side-handle', -2000)
  expect(await widthOf(page, '.org-detail-pane')).toBeGreaterThanOrEqual(479)
  await drag(page, 'org-side-handle', 2000)
  const narrow = await widthOf(page, '.org-side-strip')
  expect(narrow).toBeGreaterThanOrEqual(339)
  expect(narrow).toBeLessThan(350)
  // Left widens it (it is right of the divider).
  await page.getByTestId('org-side-handle').focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => widthOf(page, '.org-side-strip')).toBeGreaterThan(narrow + 10)
  await page.getByTestId('org-side-handle').dblclick()

  await page.setViewportSize({ width: 1100, height: 860 })
  await expect(page.getByTestId('org-side')).toBeVisible()
  await expect(page.getByTestId('org-side-handle')).toBeHidden()
})

test('the list\'s edge drags too: 200 to 480px, kept; double-click puts back 300px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 })
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await openNode(page)
  const handle = page.getByTestId('org-list-handle')
  await expect(handle).toBeVisible()
  const before = await widthOf(page, '.org-list')
  expect(Math.abs(before - 300)).toBeLessThan(2)
  // A click that never moves sets nothing.
  await handle.click()
  expect(await page.evaluate((k) => localStorage.getItem(k), LIST_KEY)).toBeNull()

  await drag(page, 'org-list-handle', 80)
  const wider = await widthOf(page, '.org-list')
  expect(wider).toBeGreaterThan(370)
  expect(wider).toBeLessThan(390)
  expect(Number(await page.evaluate((k) => localStorage.getItem(k), LIST_KEY))).toBeGreaterThan(0)
  await page.reload()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await expect.poll(() => widthOf(page, '.org-list')).toBeGreaterThan(wider - 3)

  await drag(page, 'org-list-handle', 1000)
  expect(await widthOf(page, '.org-list')).toBeLessThanOrEqual(481)
  await drag(page, 'org-list-handle', -1000)
  expect(await widthOf(page, '.org-list')).toBeGreaterThanOrEqual(199)
  expect(await widthOf(page, '.org-list')).toBeLessThan(210)
  await page.getByTestId('org-list-handle').dblclick()
  await expect.poll(() => widthOf(page, '.org-list')).toBeLessThan(302)
  expect(await widthOf(page, '.org-list')).toBeGreaterThan(298)
  expect(await page.evaluate((k) => localStorage.getItem(k), LIST_KEY)).toBeNull()
})
