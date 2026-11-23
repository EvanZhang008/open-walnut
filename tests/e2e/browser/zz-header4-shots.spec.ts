// Temporary: screenshots of the Org node header (design 4) for review. Not committed.
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const OUT = `${process.env.WALNUT_TASK_DIR}/shots/header4`
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const PROJECT = 'Shots'
const made: string[] = []
const routines: string[] = []
test.setTimeout(300_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function headShot(page: Page, name: string) {
  const head = page.locator('.org-detail-head')
  await expect(head).toBeVisible()
  await page.waitForTimeout(800)
  const box = (await head.boundingBox())!
  const w = await page.getByTestId('org-detail').evaluate((el) => el.getBoundingClientRect().width)
  fs.writeFileSync(`${OUT}/${name}.txt`, `column ${w}px, header ${box.width}x${box.height}\n`)
  await head.screenshot({ path: `${OUT}/${name}.png` })
}

test.afterAll(async ({ request }) => {
  for (const id of routines) await request.delete(`/api/v1/routines/${id}`).catch(() => undefined)
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

test('header 4 shots', async ({ page, request }) => {
  fs.mkdirSync(OUT, { recursive: true })
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title: 'Shot seed', project: PROJECT, source: 'local' })).task.id)
  made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title: 'Shot seed two', project: PROJECT, source: 'local' })).task.id)
  const lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(lead)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: lead })
  // Its team: a few not started, a few waiting.
  for (let i = 0; i < 7; i++) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Shot work ${i}`, project: PROJECT, source: 'local', parent_task_id: lead })
    made.push(task.id)
    if (i < 4) await request.patch(`/api/tasks/${task.id}`, { data: { phase: 'WAITING' } })
  }
  const { job } = await post<{ job: { id: string } }>(request, '/api/v1/routines/trigger', {
    name: 'Header shots watch', description: 'Watches nothing.', run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: lead,
  })
  routines.push(job.id)
  await request.patch(`/api/tasks/${lead}`, { data: { add_tags: ['shots-a', 'shots-b', 'shots-c'] } })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')

  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1512, height: 900 })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`).click()
  await expect(page.getByTestId('org-detail-counts')).toBeVisible({ timeout: 30_000 })
  const kebab = page.getByTestId('org-detail-chat-tools').locator('.task-kebab-btn')
  await expect(kebab).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('org-detail-chat-tools').locator('[data-header-pill]').first()).toBeVisible({ timeout: 30_000 }).catch(() => undefined)
  await headShot(page, 'h4-1512')
  await page.setViewportSize({ width: 1280, height: 800 })
  await headShot(page, 'h4-1280')
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('task-kebab-watch')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(400)
  const hb = (await page.locator('.org-detail-head').boundingBox())!
  const mb = (await menu.boundingBox())!
  const x = Math.max(0, 1280 - 700)
  await page.screenshot({ path: `${OUT}/h4-1280-menu.png`, clip: { x, y: hb.y, width: 700, height: Math.min(800 - hb.y, mb.y + mb.height - hb.y + 12) } })
  // The Tags row opens the tag list under the kebab.
  await menu.getByTestId('session-menu-tags').click()
  await expect(page.locator('[data-testid="session-header-labels-flyout"]:visible')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/h4-1280-tags.png`, clip: { x, y: hb.y, width: 700, height: 260 } })
  await page.getByTestId('org-detail-title').click()
  await kebab.click()
  await kebab.click()
  await expect(menu).toHaveCount(0)
  // A ~560 px column: narrow the window until the node is about 560 wide.
  for (const vw of [1000, 960, 920, 900, 880, 860, 840, 820, 800, 780, 760, 740, 720]) {
    await page.setViewportSize({ width: vw, height: 800 })
    await page.waitForTimeout(300)
    const w = await page.getByTestId('org-detail').evaluate((el) => el.getBoundingClientRect().width)
    if (w <= 575) break
  }
  await headShot(page, 'h4-560')
  await page.setViewportSize({ width: 420, height: 800 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/h4-phone.png`, clip: { x: 0, y: 0, width: 420, height: 200 } })
})
