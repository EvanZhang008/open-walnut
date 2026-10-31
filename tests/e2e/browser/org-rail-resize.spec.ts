/**
 * The divider between an Org node's chat and its side rail (Task / Brief), 2026-10-31, the user:
 * translated, "this sidebar can't be adjusted, we want all of it customizable; can't this bar's width be changed?":
 *   - a drag sets the rail's width; it is kept across a reload and reaches the synced prefs
 *     (every window and device), per surface: the CEO's and a VP's are their own
 *   - neither side gets unreadable: the rail stops at 300px, the chat at 420px
 *   - double-click resets it; a narrow window puts the rail above the chat, with no divider, and
 *     the width comes back with the room
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org rail width ${STAMP}`
const NODE = `project:${PROJECT.toLowerCase()}`
const VP_KEY = 'open-walnut-org-rail-w-vp'
const MAIN_KEY = 'open-walnut-org-rail-w-main'
const made: string[] = []

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

async function openOrg(page: Page): Promise<void> {
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
}

const width = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!.width
const railWidth = (page: Page) => width(page, 'org-rail')

/** Drag the divider by dx (negative = to the left, which widens the rail). */
async function drag(page: Page, dx: number): Promise<void> {
  const box = (await page.getByTestId('org-rail-handle').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + Math.min(200, box.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y)
  await page.mouse.up()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  // Two teams: the project gets its VP on first contact.
  for (const title of [`Wide enough ${STAMP}`, `Narrow enough ${STAMP}`]) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
    made.push(task.id)
  }
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  made.push(contact.task.id)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}`)
})

test('a drag sets the rail\'s width, kept per surface across a reload and in the synced prefs; double-click resets it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await isolateUiPrefs(page)
  await openOrg(page)
  await openNode(page)
  const handle = page.getByTestId('org-rail-handle')
  await expect(handle).toBeVisible()
  await expect(handle).toHaveAttribute('role', 'separator')
  const before = await railWidth(page)

  // Wider by about the drag.
  const synced = page.waitForRequest((r) => r.url().includes('/api/ui-prefs') && r.method() === 'PUT' && (r.postData() ?? '').includes(VP_KEY), { timeout: 15_000 })
  await drag(page, -120)
  const wider = await railWidth(page)
  expect(wider).toBeGreaterThan(before + 100)
  expect(wider).toBeLessThan(before + 140)
  expect(Number(await page.evaluate((k) => localStorage.getItem(k), VP_KEY))).toBeGreaterThan(0)
  await synced
  await page.screenshot({ path: `test-results/org-rail-resize-${test.info().project.name}.png` })

  // Kept across a reload.
  await page.reload()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await openNode(page)
  await expect.poll(() => railWidth(page)).toBeGreaterThan(wider - 3)
  expect(await railWidth(page)).toBeLessThan(wider + 3)

  // The CEO's rail is its own surface: it keeps its default.
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', 'main')
  await expect(page.getByTestId('org-rail')).toBeVisible()
  expect(Math.abs((await railWidth(page)) - before)).toBeLessThan(3)
  expect(await page.evaluate((k) => localStorage.getItem(k), MAIN_KEY)).toBeNull()

  // Double-click resets the VP's.
  await openNode(page)
  await page.getByTestId('org-rail-handle').dblclick()
  await expect.poll(() => railWidth(page)).toBeLessThan(before + 3)
})

test('neither side gets unreadable; a narrow window stacks the rail with no divider, and the width comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await isolateUiPrefs(page)
  await openOrg(page)
  await openNode(page)
  const chat = page.locator('.org-detail-col')
  // As wide as it goes: the chat keeps 420px.
  await drag(page, -1000)
  expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(419)
  // As narrow as it goes: the rail keeps 300px.
  await drag(page, 1000)
  expect(await railWidth(page)).toBeGreaterThanOrEqual(299)
  expect(await railWidth(page)).toBeLessThan(310)
  // One step back from the edge: a drag starts where the rail shows, with no dead zone.
  await drag(page, -60)
  const set = await railWidth(page)
  expect(set).toBeGreaterThan(350)

  await page.setViewportSize({ width: 900, height: 800 })
  await expect(page.getByTestId('org-rail')).toHaveAttribute('data-placement', 'top')
  await expect(page.getByTestId('org-rail-handle')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('org-rail')).toHaveAttribute('data-placement', 'side')
  await expect.poll(() => railWidth(page)).toBeGreaterThan(set - 3)
  // Keyboard: the divider takes the arrow keys.
  await page.getByTestId('org-rail-handle').focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => railWidth(page)).toBeGreaterThan(set + 10)
  // End: as wide as it goes; Home: as narrow. The divider says the width that shows, in pixels.
  const handle = page.getByTestId('org-rail-handle')
  await page.keyboard.press('End')
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeLessThan(425)
  expect(Math.abs(Number(await handle.getAttribute('aria-valuenow')) - await railWidth(page))).toBeLessThan(3)
  await page.keyboard.press('Home')
  await expect.poll(() => railWidth(page)).toBeLessThan(303)
  expect(Number(await handle.getAttribute('aria-valuemin'))).toBe(300)
  await handle.dblclick()
})
