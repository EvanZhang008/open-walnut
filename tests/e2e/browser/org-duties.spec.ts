/**
 * A VP's duty switches in its Memory & instructions panel (web/src/components/org/NodeDuties.tsx;
 * 2026-11-19, the user: "each VP can turn on some capability, we need to make it generic", then the
 * name "duty"):
 *   - the panel lists every duty the server's registry holds, each off for a new VP
 *   - a click turns it on: the server keeps it, and the panel says who turned it and when
 *   - closing and opening the panel again, and a reload, still show it on
 *   - a second click turns it off again, on the server too
 * The fixture is shared, so this file makes its own VP and removes it.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const NAME = `Lagoon ${STAMP}`
let vpId = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1280, height: 800 } })

const dutyOf = async (request: APIRequestContext): Promise<{ on: boolean } | undefined> =>
  ((await (await request.get(`/api/tasks/${vpId}`)).json()).task?.org_duties ?? {}).reflection

test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/v1/org/vps', { data: { name: NAME } })
  expect(res.ok(), await res.text()).toBe(true)
  vpId = ((await res.json()) as { task: { id: string } }).task.id
})

test.afterAll(async ({ request }) => {
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${vpId}?force=true`)
    if (res.ok() || res.status() === 404) break
    await new Promise((r) => setTimeout(r, 500))
  }
  await request.delete(`/api/v1/projects/${encodeURIComponent(NAME)}`).catch(() => undefined)
})

async function openPanel(page: Page) {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(STAMP)
  const channel = page.getByTestId('org-channel').filter({ hasText: STAMP }).first()
  await channel.click()
  await expect(channel).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('org-detail-chat-tools').locator('.task-kebab-btn').click()
  await page.locator('.task-kebab-menu').getByTestId('kebab-memory-instructions').click()
  const panel = page.getByTestId('agent-memory-panel')
  await expect(panel).toBeVisible()
  return panel
}

test('a VP\'s reflection duty turns on and off from its Memory & instructions panel, and stays as set', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  let panel = await openPanel(page)
  const duties = panel.getByTestId('am-duties')
  await expect(duties).toBeVisible()
  const registry = ((await (await request.get('/api/v1/org/duties')).json()) as { duties: Array<{ id: string; name: string; roles: string[] }> }).duties
  for (const d of registry.filter((x) => x.roles.includes('lead'))) {
    await expect(duties.getByTestId(`am-duty-${d.id}`)).toContainText(d.name)
  }
  const sw = panel.getByTestId('am-duty-reflection-switch')
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(panel.getByTestId('am-duty-reflection-stamp')).toHaveText('Off until you turn it on.')

  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await dutyOf(request))?.on).toBe(true)
  await expect(panel.getByTestId('am-duty-reflection-stamp')).toContainText('Turned on by you')

  // Closed and opened again, then after a reload: still on.
  await panel.getByRole('button', { name: 'Close' }).first().click()
  await expect(panel).toHaveCount(0)
  panel = await openPanel(page)
  await expect(panel.getByTestId('am-duty-reflection-switch')).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.keyboard.press('Escape')
  panel = await openPanel(page)
  const again = panel.getByTestId('am-duty-reflection-switch')
  await expect(again).toHaveAttribute('aria-checked', 'true')

  await again.click()
  await expect(again).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await dutyOf(request))?.on).toBe(false)
  await expect(panel.getByTestId('am-duty-reflection-stamp')).toContainText('Turned off by you')
})
