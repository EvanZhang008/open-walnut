/**
 * Pins on an Org node (src/core/org/org-pins.ts). 2026-10-31, the user picked "B: a Pinned tab
 * first" in the node's Task view, and, translated: "under a chat ... however many you pin, they all
 * show in there ... you can also unpin in there ... indent a little less ... they are all its children":
 *   - a row's pin (in the rail's tabs and on an ask) pins it to this node at once, and the server keeps it
 *   - the Pinned tab, first, lists the node's pins in pin order, each with its own state's dot
 *   - the Org list shows the same pins under the node's chat row, a little indented; a click opens
 *     the task beside the page, × takes the pin off there
 *   - an agent's pin (the API) shows under the CEO's row without a reload
 *   - a refused pin goes back, and the page says so
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org pins ${STAMP}`
const made: string[] = []
const ids = { lead: '', a: '', b: '', c: '' }
const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`
const NODE = rowKey(PROJECT)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
}

async function pinsOf(request: APIRequestContext, id: string): Promise<string[]> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { org_pins?: Array<{ node: string }> } | undefined
  return (task?.org_pins ?? []).map((p) => p.node)
}

async function openNode(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
}

const railTab = (page: Page, tab: string) => page.getByTestId('org-rail').locator(`[data-testid="org-task-tab"][data-tab="${tab}"]`)
const listPins = (page: Page, node: string) => page.locator(`[data-testid="org-pins"][data-key="${node}"] [data-testid="org-pin"]`)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  ids.a = await createTask(request, `Prune the pear trees ${STAMP}`)
  ids.b = await createTask(request, `Order new ladders ${STAMP}`)
  ids.c = await createTask(request, `Count the hives ${STAMP}`)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('a row\'s pin pins it here; the Pinned tab lists the pins first, in order; the list shows them under the chat', async ({ page, request }) => {
  await openNode(page)
  // Pinned is the first tab, and the node still opens on Needs you.
  const tabs = page.getByTestId('org-rail').getByTestId('org-task-tab')
  await expect(tabs.first()).toHaveAttribute('data-tab', 'pinned')
  await expect(railTab(page, 'needs')).toHaveAttribute('aria-selected', 'true')
  await railTab(page, 'pinned').click()
  await expect(page.getByTestId('org-rail').getByTestId('org-task-empty')).toContainText('Nothing pinned here')

  // The tasks wait (no session yet): pin two from the Waiting tab.
  await railTab(page, 'waiting').click()
  for (const id of [ids.b, ids.a]) {
    const item = page.getByTestId('org-rail').locator(`.org-task-item:has([data-testid="org-task-row"][data-task-id="${id}"])`)
    await item.hover()
    const toggle = item.getByTestId('org-pin-toggle')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  }
  await expect.poll(() => pinsOf(request, ids.a)).toEqual([NODE])
  await expect.poll(() => pinsOf(request, ids.b)).toEqual([NODE])
  await expect(railTab(page, 'pinned')).toContainText('2')

  // Pinned: in pin order, each with its own state.
  await railTab(page, 'pinned').click()
  const pinnedRows = page.getByTestId('org-rail').locator('[data-testid="org-task-list"][data-tab="pinned"] [data-testid="org-task-row"]')
  await expect(pinnedRows).toHaveCount(2)
  expect(await pinnedRows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))).toEqual([ids.b, ids.a])
  expect(await pinnedRows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual(['waiting', 'waiting'])

  // The list: the same pins under the node's row, a little in from the row's own name.
  const children = listPins(page, NODE)
  await expect(children).toHaveCount(2)
  await expect(children.first()).toContainText(`Order new ladders ${STAMP}`)
  const rowBox = (await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).boundingBox())!
  const nameBox = (await page.locator(`[data-testid="org-channel"][data-key="${NODE}"] .org-channel-name`).boundingBox())!
  const childBox = (await children.first().locator('.org-pin-title').boundingBox())!
  expect(childBox.x).toBeGreaterThan(rowBox.x + 8)
  expect(childBox.x).toBeLessThan(nameBox.x)
  expect(childBox.y).toBeGreaterThan(rowBox.y + rowBox.height - 4)
  await page.locator('.org-list').screenshot({ path: `test-results/org-pins-list-${test.info().project.name}.png` })
  await page.getByTestId('org-rail').screenshot({ path: `test-results/org-pins-rail-${test.info().project.name}.png` })

  // A click opens the task beside the page; the Org page stays.
  await children.first().getByTestId('org-pin-open').click()
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/org\?/)
})

test('× in the list takes the pin off; an agent\'s pin shows under the CEO without a reload; a refused pin goes back', async ({ page, request }) => {
  await openNode(page)
  const children = listPins(page, NODE)
  await expect(children).toHaveCount(2, { timeout: 30_000 })
  const first = children.first()
  await first.hover()
  await first.getByTestId('org-pin-unpin').click()
  await expect(children).toHaveCount(1)
  await expect.poll(() => pinsOf(request, ids.b)).toEqual([])
  await expect(railTab(page, 'pinned')).toContainText('1')

  // An agent (or another window) pins to the CEO: the CEO's row shows it at once.
  const res = await request.put(`/api/v1/org/pins/${ids.c}`, { data: { node: 'CEO' } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect(page.locator(`[data-testid="org-pins"][data-key="main"] [data-testid="org-pin"][data-task-id="${ids.c}"]`)).toBeVisible({ timeout: 30_000 })

  // A refused pin shows on the click, then goes back, and the page says why.
  await page.route('**/api/v1/org/pins/**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused"}' }))
  await railTab(page, 'waiting').click()
  const item = page.getByTestId('org-rail').locator(`.org-task-item:has([data-testid="org-task-row"][data-task-id="${ids.b}"])`)
  await item.hover()
  await item.getByTestId('org-pin-toggle').click()
  await expect(item.getByTestId('org-pin-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })
  await expect(children).toHaveCount(1)
  await page.unroute('**/api/v1/org/pins/**')

  // The last pin off from the Pinned tab: the tab is empty and the list group goes.
  await railTab(page, 'pinned').click()
  const last = page.getByTestId('org-rail').locator(`.org-task-item:has([data-testid="org-task-row"][data-task-id="${ids.a}"])`)
  await last.hover()
  await last.getByTestId('org-pin-toggle').click()
  await expect(page.getByTestId('org-rail').getByTestId('org-task-empty')).toContainText('Nothing pinned here')
  await expect(page.locator(`[data-testid="org-pins"][data-key="${NODE}"]`)).toHaveCount(0)
  await expect.poll(() => pinsOf(request, ids.a)).toEqual([])

  // From the keyboard: a pin in the list is an option; Delete takes it off.
  const ceoPin = page.locator(`[data-testid="org-pins"][data-key="main"] [data-testid="org-pin"][data-task-id="${ids.c}"] [data-testid="org-pin-open"]`)
  await expect(ceoPin).toHaveAttribute('role', 'option')
  await ceoPin.focus()
  await page.keyboard.press('Delete')
  await expect(ceoPin).toHaveCount(0)
  await expect.poll(() => pinsOf(request, ids.c)).toEqual([])
})
