/**
 * No title is cut on the main screens (standard.md, "Text that does not fit"; text-fit.css).
 *
 * 2026-11-21, the UI audit on the user's own data: task titles in the task panel and search
 * results lost the part that tells tasks apart while the small icons and the time beside them kept
 * their room; Org names were cut at every tree level while right-edge counts stayed; notification
 * titles were cut above a smaller cut source line. This scan walks those screens with long titles
 * at the user's window (1512), a laptop (1280), a small window (1024) and the Org list dragged to
 * its narrowest, and fails when a title, name, subject or summary is cut while metadata in its row
 * kept its room, or when more than 5% of one is hidden. A new view that cuts its title fails here
 * (and its CSS fails cutTitle in tests/web/ui-standard-ratchet.test.ts).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { findCutTitles, violations } from './text-fit-helpers'
import { openHome } from './home-navigation-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = Date.now().toString(36)
// Long enough to wrap in every column; the end of each is what tells the tasks apart.
const LATIN = [
  `Garden watering watch leader (shed box): the pumps, the timers and the hose workers, north bed ${STAMP}`,
  `Resolver group ticket triage with the weekly report, the escalation list and the handover notes ${STAMP}`,
]
// Test data only (language rule): a long CJK title, as the user's own task titles are.
const CJK = `新任务按 project 开：选 project 不选文件夹，自动开新工作区、做完自己收尾并报告结果 ${STAMP}`
// A VP's name is at most 60 characters.
const VP = `Garden operations planning office ${STAMP}`
const LETTER = `A letter with a full-length subject: review the garden schedule, the tool inventory and the next steps ${STAMP}`

const made: { tasks: string[]; letters: string[] } = { tasks: [], letters: [] }

// One seed for every width.
test.describe.configure({ mode: 'serial' })

async function createTask(request: APIRequestContext, title: string): Promise<void> {
  const res = await request.post('/api/tasks', { data: { title, source: 'local', project: 'Garden', pinned: false } })
  expect(res.ok(), await res.text()).toBe(true)
  made.tasks.push(((await res.json()) as { task: { id: string } }).task.id)
}

test.beforeAll(async ({ request }) => {
  for (const t of [...LATIN, CJK]) await createTask(request, t)
  const vp = await request.post('/api/v1/org/vps', { data: { name: VP } })
  expect(vp.ok(), await vp.text()).toBe(true)
  made.tasks.push(((await vp.json()) as { task: { id: string } }).task.id)
  const letter = await request.post('/api/v1/human-inbox', { data: { subject: LETTER, type: 'review', markdown: 'The garden group needs a reply about the whole schedule.' } })
  expect(letter.status()).toBe(201)
  made.letters.push((await letter.json()).id)
})

test.afterAll(async ({ request }) => {
  for (const id of made.letters) await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  for (const id of made.tasks) await request.delete(`/api/tasks/${id}?force=true`)
})

async function expectNoCutTitle(page: Page, scopes: string[], where: string): Promise<void> {
  // Rows draw after the list's first answer; give a late row its chance before measuring.
  await page.waitForTimeout(400)
  const bad = violations(await findCutTitles(page, scopes))
  expect(bad.map((b) => `${where}: .${b.className.split(' ')[0]} hides ${Math.round(b.hidden * 100)}%${b.metaKeptRoom ? ' while metadata kept its room' : ''}: "${b.text}"`), 'A title is cut. Make it .wn-title (web/src/styles/text-fit.css) and cut metadata instead').toEqual([])
}

for (const [width, height] of [[1512, 920], [1280, 800], [1024, 768]] as const) {
  test(`no title is cut on Home, search, Org and Notifications at ${width}`, async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    const panel = '.home-navigation-scroll'
    await page.locator(panel).getByText(/^All/).first().click()
    await expect(page.locator(panel).getByText(LATIN[0])).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, [panel], `Home All ${width}`)

    const search = page.locator('input[placeholder^="Search tasks"]').first()
    await search.click()
    await search.fill(STAMP)
    await expect(page.locator(panel).getByText(CJK)).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, [panel], `Search ${width}`)
    await search.fill('')

    await page.getByTestId('sidebar-org').click()
    await expect(page.getByTestId('org-page')).toBeVisible()
    await expect(page.getByTestId('org-page').getByText(VP).first()).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['[data-testid="org-page"] .org-list'], `Org list ${width}`)

    await page.getByRole('button', { name: /^Notifications/ }).first().click()
    const drawer = page.locator('.notification-panel')
    await drawer.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await expect(drawer.getByText(LETTER).first()).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['.notification-panel'], `Notifications ${width}`)
    await page.keyboard.press('Escape')
  })
}

test('the Org list dragged to its narrowest still cuts no name', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await page.getByTestId('sidebar-org').click()
  const list = page.locator('[data-testid="org-page"] .org-list')
  await expect(list.getByText(VP).first()).toBeVisible({ timeout: 20_000 })
  const handle = page.locator('.org-list-handle').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 600, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const width = (await list.boundingBox())!.width
  expect(width).toBeLessThan(260)
  await expectNoCutTitle(page, ['[data-testid="org-page"] .org-list'], `Org list at ${Math.round(width)} px`)
})
